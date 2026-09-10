import * as MP4Box from "mp4box";
import { buildCreationTimeFallbackMapping, buildTimeMapping, getMappingDiagnostics } from "./absolute-time-resolver.js";

export const PHASE2A_STAGES = [
  "MP4情報を確認",
  "telemetry trackを探索",
  "gpmd sampleを抽出",
  "GPMFを解析",
  "GPSデータを検証"
];

const CHUNK_SIZE = 4 * 1024 * 1024;
const PHASE2A_TARGET_SAMPLES = 10;
const PHASE2A_BATCH_SAMPLES = 1;
const PHASE2A_PROBE_TIMES_SEC = [0, 30, 60, 300, 900, 1500];
const PHASE2A_SAMPLES_PER_PROBE = 3;
const PHASE2A_EXTENDED_PROBE_MAX_SAMPLES = 50;
const PHASE2A_ENABLE_EXTENDED_PROBE = false;
const MAX_REPEATED_OFFSET = 48;
const MAX_APPENDS_WITHOUT_SAMPLES = 4096;
const GPS9_EPOCH_MS = Date.UTC(2000, 0, 1, 0, 0, 0, 0);

export class Phase2AError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "Phase2AError";
    this.code = code;
  }
}

export async function analyzeGoProMp4ForPhase2A(file, { signal, onStage, onLog, onProgress } = {}) {
  const notifyStage = (index, state = "running") => onStage?.({ index, state });
  const log = (line) => onLog?.(line);
  const probeState = {
    gpmdSamplesInspected: 0,
    gps9RecordsInspected: 0,
    noFixRecordsSkipped: 0,
    firstValid: null
  };

  const context = {
    gpmdSampleCount: 0,
    firstGpmdSampleMeta: null,
    gpmfKeys: new Set(),
    gpmfTreePreview: [],
    trackSummaries: [],
    gpsPoints: [],
    quality: {
      gpsfValues: [],
      gpspValues: []
    },
    timing: {
      gpsuRawValues: [],
      mappingNotes: []
    },
    gpsMeta: {
      firstRawValues: null,
      firstTypedValues: null,
      firstScaledValues: null,
      firstRawBytesHex: null,
      firstScalValues: null,
      firstSiunValues: null,
      firstTypeDefinition: null,
      firstFieldMap: null,
      firstFix: null,
      firstDop: null,
      firstTimestampSource: null,
      firstMp4CreationDeltaMs: null,
      recordsInspected: 0,
      invalidNoFixRecordsSkipped: 0,
      firstValidGps9Index: null,
      gpmdSamplesInspected: 0,
      probeLimitGpmdSamples: PHASE2A_PROBE_TIMES_SEC.length * PHASE2A_SAMPLES_PER_PROBE,
      probeStatusCode: null,
      probeStatusMessage: null,
      decodedGps9RecordCount: 0,
      validGpsSampleCount: 0,
      noFixRecordCount: 0,
      firstValidGpsSample: null,
      probeHistory: [],
      timeAlignmentComparisons: [],
      absoluteTimeAlignmentStatus: "pending",
      absoluteTimeAlignmentMessage: "未検証"
    },
    file: {
      name: file.name,
      size: file.size
    },
    quickProof: {
      hasPayload: false,
      hasKlv: false,
      hasGpsDataKey: false,
      hasScal: false,
      hasFirstCoords: false,
      hasTimeInfo: false
    },
    timeMapping: null,
    fallbackTimeMapping: null
  };

  notifyStage(0, "running");

  let didLogInfo = false;
  let didLogTelemetry = false;
  let extractionResult = null;
  const allSampleBundles = [];
  const probeHistory = [];
  const usedProbeTimes = new Set();

  const runSingleProbe = async (probeTimeSec, samplesPerProbe, label) => {
    log(`[Probe ${label}] target time: ${probeTimeSec.toFixed(3)} sec`);

    const result = await parseMp4AndExtractGpmd(file, {
      signal,
      targetSamples: samplesPerProbe,
      batchSamples: PHASE2A_BATCH_SAMPLES,
      seekTimeSec: probeTimeSec,
      onInfo: (info) => {
        const durationSec = safeDivide(info.duration, info.timescale);
        context.file.durationSec = durationSec;
        context.file.creationTime = toIsoOrNull(info.created);
        context.trackSummaries = summarizeTracks(info.tracks || []);

        if (!didLogInfo) {
          log(`File: ${file.name} (${formatBytes(file.size)})`);
          log(`Duration: ${durationSec == null ? "unknown" : durationSec.toFixed(3)} sec`);
          log(`creation_time: ${context.file.creationTime || "unknown"}`);
          log("Track一覧:");
          for (const track of context.trackSummaries) {
            log(
              `- id=${track.id} type=${track.type || "?"} codec=${track.codec || "?"} handler=${track.handler || "?"} timescale=${track.timescale || "?"} sampleCount=${track.sampleCount ?? "?"}`
            );
          }
          notifyStage(0, "done");
          notifyStage(1, "running");
          didLogInfo = true;
        }
      },
      onTelemetryDetected: (telemetryTrack) => {
        if (!didLogTelemetry) {
          notifyStage(1, "done");
          notifyStage(2, "running");
          log(`Telemetry track detected: id=${telemetryTrack.id}, codec=${telemetryTrack.codec || "?"}, handler=${telemetryTrack.handler || "?"}`);
          log(`gpmd sample count reported by track metadata: ${telemetryTrack.sampleCount ?? "unknown"}`);
          didLogTelemetry = true;
        }
      },
      onProgress: (progress) => {
        onProgress?.(progress);
      },
      onSample: (sample) => {
        context.gpmdSampleCount += 1;
        if (!context.firstGpmdSampleMeta) {
          context.firstGpmdSampleMeta = sample;
        }
      },
      shouldStop: (sample) => {
        probeState.gpmdSamplesInspected += 1;
        context.gpsMeta.gpmdSamplesInspected = probeState.gpmdSamplesInspected;

        try {
          const gpmfResult = parseGpmfSample(sample.data);
          context.quickProof.hasKlv = true;
          context.quickProof.hasGpsDataKey =
            context.quickProof.hasGpsDataKey || gpmfResult.keys.has("GPS9") || gpmfResult.keys.has("GPS5");
          context.quickProof.hasScal = context.quickProof.hasScal || gpmfResult.keys.has("SCAL");

          const gpsRows = projectGpsRowsFromSample({
            gpmfResult,
            sample,
            fileCreationTimeMs: toEpochMs(context.file.creationTime)
          });

          const sampleDtsSec = safeDivide(sample.dts, sample.timescale);
          const gps9Records = gpsRows.points.filter((point) => point.gpsKind === "GPS9");
          const fixValues = gps9Records.map((point) => point.fix).filter((value) => Number.isFinite(value));
          const gps9NodeInStream = gpmfResult.streams
            .map((stream) => ({
              stream,
              gps9Node: findFirstStreamNode(stream, "GPS9"),
              stmpNode: findFirstStreamNode(stream, "STMP"),
              tsmpNode: findFirstStreamNode(stream, "TSMP")
            }))
            .find((item) => item.gps9Node);

          const stmpValues = gps9NodeInStream?.stmpNode ? nodeToValueList(gps9NodeInStream.stmpNode) : [];
          const tsmpValues = gps9NodeInStream?.tsmpNode ? nodeToValueList(gps9NodeInStream.tsmpNode) : [];
          const stmpRaw = gps9NodeInStream?.stmpNode ? bytesToHex(gps9NodeInStream.stmpNode.raw) : null;
          const tsmpRaw = gps9NodeInStream?.tsmpNode ? bytesToHex(gps9NodeInStream.tsmpNode.raw) : null;
          const gps9Repeat = gps9NodeInStream?.gps9Node?.repeat ?? 0;

          log(`[Probe ${label}] actual gpmd DTS: ${Number.isFinite(sampleDtsSec) ? sampleDtsSec.toFixed(3) : "unknown"} sec`);
          log(`[Probe ${label}] GPS9 fix values: [${fixValues.join(", ")}]`);
          log(`[Probe ${label}] STMP raw: ${stmpRaw || "-"}`);
          log(`[Probe ${label}] STMP value: ${stmpValues.length ? stmpValues.join(", ") : "-"}`);
          log(`[Probe ${label}] TSMP raw: ${tsmpRaw || "-"}`);
          log(`[Probe ${label}] TSMP value: ${tsmpValues.length ? tsmpValues.join(", ") : "-"}`);
          log(`[Probe ${label}] gpmd sample duration: ${Number.isFinite(sample.duration) ? sample.duration : "unknown"} (timescale=${sample.timescale ?? "unknown"})`);
          log(`[Probe ${label}] GPS9 repeat: ${gps9Repeat || gps9Records.length}`);

          if (gps9Records.length) {
            const firstRecord = gps9Records[0];
            const lastRecord = gps9Records[gps9Records.length - 1];
            log(`[Probe ${label}] GPS9 first record time: ${firstRecord.timestampIso || "unknown"}`);
            log(`[Probe ${label}] GPS9 last record time: ${lastRecord.timestampIso || "unknown"}`);

            const secondSeries = gps9Records
              .map((point) => point.secondsSinceMidnight)
              .filter((value) => Number.isFinite(value));
            if (secondSeries.length >= 2) {
              const deltas = [];
              for (let i = 1; i < secondSeries.length; i += 1) {
                deltas.push(Number((secondSeries[i] - secondSeries[i - 1]).toFixed(3)));
              }
              log(`[Probe ${label}] secondsSinceMidnight deltas: [${deltas.join(", ")}]`);
            }
          }

          let probeValid = null;

          for (const point of gps9Records) {
            probeState.gps9RecordsInspected += 1;
            if (isGpsFixValid(point.fix) && isFiniteLatLng(point.latitude, point.longitude)) {
              const fileCreationEpochMs = toEpochMs(context.file.creationTime);
              const expectedFromMp4Ms =
                Number.isFinite(sampleDtsSec) && Number.isFinite(fileCreationEpochMs)
                  ? fileCreationEpochMs + sampleDtsSec * 1000
                  : null;
              const deltaFromMp4Ms =
                expectedFromMp4Ms != null && Number.isFinite(point.timestampMs)
                  ? point.timestampMs - expectedFromMp4Ms
                  : null;

              probeValid = {
                probeTimeSec,
                telemetrySampleIndex: point.telemetrySampleIndex,
                recordIndex: point.indexInTelemetrySample,
                sampleDtsSec,
                fix: point.fix,
                latitude: point.latitude,
                longitude: point.longitude,
                altitude: point.altitude,
                speed2D: point.speed2D,
                speed3D: point.speed3D,
                daysSince2000: point.daysSince2000,
                secondsSinceMidnight: point.secondsSinceMidnight,
                dop: point.dop,
                timestampIso: point.timestampIso,
                mp4ExpectedTimestampIso: expectedFromMp4Ms == null ? null : new Date(expectedFromMp4Ms).toISOString(),
                mp4TimeDeltaMs: deltaFromMp4Ms
              };

              context.gpsMeta.timeAlignmentComparisons.push({
                id: `probe-${label}`,
                probeTimeSec,
                mediaTimeSec: point.relativeSec,
                gpmdDtsSec: sampleDtsSec,
                gpsAbsoluteTimeMs: point.timestampMs,
                gps9TimestampIso: point.timestampIso,
                mp4CreationPlusDtsIso: expectedFromMp4Ms == null ? null : new Date(expectedFromMp4Ms).toISOString(),
                differenceMs: deltaFromMp4Ms,
                stmpRaw,
                stmpValues,
                tsmpRaw,
                tsmpValues,
                gps9Repeat,
                secondsSinceMidnightDeltas: gps9Records
                  .map((r) => r.secondsSinceMidnight)
                  .filter((v) => Number.isFinite(v))
                  .map((v, idx, arr) => (idx === 0 ? null : Number((v - arr[idx - 1]).toFixed(3))))
                  .filter((v) => v != null)
              });

              if (!probeState.firstValid) {
                probeState.firstValid = probeValid;
              }
              break;
            }
            probeState.noFixRecordsSkipped += 1;
          }

          context.gpsMeta.recordsInspected = probeState.gps9RecordsInspected;
          context.gpsMeta.invalidNoFixRecordsSkipped = probeState.noFixRecordsSkipped;

          log(`gpmd samples inspected: ${probeState.gpmdSamplesInspected} / ${context.gpsMeta.probeLimitGpmdSamples}`);
          log(`GPS9 records inspected: ${probeState.gps9RecordsInspected}`);
          log(`no-fix records skipped: ${probeState.noFixRecordsSkipped}`);

          if (probeValid) {
            log("VALID GPS9 FIX FOUND");
            log(`probe time: ${probeValid.probeTimeSec.toFixed(3)} sec`);
            log(`gpmd DTS: ${Number.isFinite(probeValid.sampleDtsSec) ? probeValid.sampleDtsSec.toFixed(3) : "unknown"} sec`);
            log(`gpmd sample index: ${probeValid.telemetrySampleIndex}`);
            log(`GPS9 record index: ${probeValid.recordIndex}`);
            log(`fix: ${probeValid.fix}`);
            log(`latitude: ${probeValid.latitude}`);
            log(`longitude: ${probeValid.longitude}`);
            log(`altitude: ${probeValid.altitude}`);
            log(`speed2D: ${probeValid.speed2D}`);
            log(`speed3D: ${probeValid.speed3D}`);
            log(`daysSince2000: ${probeValid.daysSince2000}`);
            log(`secondsSinceMidnight: ${probeValid.secondsSinceMidnight}`);
            log(`DOP: ${probeValid.dop}`);
            log(`timestamp: ${probeValid.timestampIso || "unknown"}`);
            log(`expected from MP4: ${probeValid.mp4ExpectedTimestampIso || "unknown"}`);
            log(`difference: ${Number.isFinite(probeValid.mp4TimeDeltaMs) ? `${probeValid.mp4TimeDeltaMs.toFixed(0)} ms` : "unknown"}`);
            return true;
          }

          return false;
        } catch {
          return false;
        }
      }
    });

    const samplesInProbe = result.processedSamples;
    probeHistory.push({
      label,
      targetTimeSec: probeTimeSec,
      processedSamples: samplesInProbe,
      doneReason: result.doneReason,
      seekOffset: result.progress?.seekOffset ?? null
    });
    allSampleBundles.push(...result.sampleBundles);

    if (!context.telemetryTrack && result.telemetryTrack) {
      context.telemetryTrack = result.telemetryTrack;
    }

    context.scan = {
      ...result.progress,
      trackId: result.telemetryTrack?.id ?? null,
      fullFileScanned: result.fullFileScanned,
      doneReason: result.doneReason,
      probeHistory
    };

    extractionResult = result;
    return result;
  };

  for (let i = 0; i < PHASE2A_PROBE_TIMES_SEC.length; i += 1) {
    const probeTimeSec = PHASE2A_PROBE_TIMES_SEC[i];
    if (context.file.durationSec != null && probeTimeSec > context.file.durationSec) {
      continue;
    }
    if (usedProbeTimes.has(probeTimeSec)) {
      continue;
    }
    usedProbeTimes.add(probeTimeSec);
    await runSingleProbe(probeTimeSec, PHASE2A_SAMPLES_PER_PROBE, `${i + 1}`);
  }

  if (
    PHASE2A_ENABLE_EXTENDED_PROBE &&
    !probeState.firstValid &&
    probeState.gpmdSamplesInspected < PHASE2A_EXTENDED_PROBE_MAX_SAMPLES &&
    context.file.durationSec != null
  ) {
    const extraProbeCount = Math.ceil((PHASE2A_EXTENDED_PROBE_MAX_SAMPLES - probeState.gpmdSamplesInspected) / PHASE2A_SAMPLES_PER_PROBE);
    const extraTimes = buildExtraProbeTimes(context.file.durationSec, extraProbeCount, usedProbeTimes);
    for (let i = 0; i < extraTimes.length; i += 1) {
      const probeTimeSec = extraTimes[i];
      usedProbeTimes.add(probeTimeSec);
      await runSingleProbe(probeTimeSec, PHASE2A_SAMPLES_PER_PROBE, `extra-${i + 1}`);
      if (probeState.firstValid) {
        break;
      }
      if (probeState.gpmdSamplesInspected >= PHASE2A_EXTENDED_PROBE_MAX_SAMPLES) {
        break;
      }
    }
  }

  if (!context.telemetryTrack) {
    context.telemetryTrack = extractionResult?.telemetryTrack || null;
  }

  if (!context.telemetryTrack) {
    throw new Phase2AError("NO_GPMD_TRACK", "この動画にはGoPro telemetryデータがありません");
  }

  if (allSampleBundles.length === 0) {
    throw new Phase2AError("NO_GPMD_SAMPLES", `gpmd sampleを取得できませんでした (reason: ${extractionResult?.doneReason || "other"})`);
  }

  context.gpsMeta.probeHistory = probeHistory;

  notifyStage(2, "done");
  notifyStage(3, "running");

  const fileCreationTimeMs = toEpochMs(context.file.creationTime);

  for (let i = 0; i < allSampleBundles.length; i += 1) {
    const sampleBundle = allSampleBundles[i];
    const gpmfResult = parseGpmfSample(sampleBundle.sample.data);

    if (i < 2) {
      const treeText = formatGpmfTree(gpmfResult.nodes, i);
      context.gpmfTreePreview.push(treeText);
      log(treeText);
    }

    for (const key of gpmfResult.keys) {
      context.gpmfKeys.add(key);
    }
    context.timing.gpsuRawValues.push(...gpmfResult.gpsuRawValues);

    const gpsRows = projectGpsRowsFromSample({
      gpmfResult,
      sample: sampleBundle.sample,
      fileCreationTimeMs
    });

    context.gpsPoints.push(...gpsRows.points);
    context.quality.gpsfValues.push(...gpsRows.gpsfValues);
    context.quality.gpspValues.push(...gpsRows.gpspValues);
    context.timing.mappingNotes.push(...gpsRows.mappingNotes);

    if (!context.gpsMeta.firstRawValues && gpsRows.firstMeta) {
      context.gpsMeta.firstRawValues = gpsRows.firstMeta.rawValues;
      context.gpsMeta.firstTypedValues = gpsRows.firstMeta.typedValues;
      context.gpsMeta.firstScaledValues = gpsRows.firstMeta.scaledValues;
      context.gpsMeta.firstRawBytesHex = gpsRows.firstMeta.rawBytesHex;
      context.gpsMeta.firstScalValues = gpsRows.firstMeta.scalValues;
      context.gpsMeta.firstSiunValues = gpsRows.firstMeta.siunValues;
      context.gpsMeta.firstTypeDefinition = gpsRows.firstMeta.typeDefinition;
      context.gpsMeta.firstFieldMap = gpsRows.firstMeta.fieldMap;
      context.gpsMeta.firstFix = gpsRows.firstMeta.fix;
      context.gpsMeta.firstDop = gpsRows.firstMeta.dop;
      context.gpsMeta.firstTimestampSource = gpsRows.firstMeta.timestampSource;
      context.gpsMeta.firstMp4CreationDeltaMs = gpsRows.firstMeta.mp4CreationDeltaMs;

      if (gpsRows.firstMeta.gpsKind === "GPS9") {
        log("GPS9 record #0");
        log(`raw bytes: ${gpsRows.firstMeta.rawBytesHex || "unknown"}`);
        log(`TYPE: ${gpsRows.firstMeta.typeDefinition || "unknown"}`);
        log(`typed: [${(gpsRows.firstMeta.typedValues || []).join(", ")}]`);
        log(`SCAL: [${(gpsRows.firstMeta.scalValues || []).join(", ")}]`);
        log(`scaled: [${(gpsRows.firstMeta.scaledValues || []).join(", ")}]`);
        log(`UNIT/SIUN: [${(gpsRows.firstMeta.siunValues || []).join(", ")}]`);
        log(`field map: ${formatFieldMap(gpsRows.firstMeta.fieldMap)}`);
      }
    }
  }

  notifyStage(3, "done");
  notifyStage(4, "running");

  const flags = {
    GPS5: context.gpmfKeys.has("GPS5"),
    GPS9: context.gpmfKeys.has("GPS9"),
    SCAL: context.gpmfKeys.has("SCAL"),
    TYPE: context.gpmfKeys.has("TYPE"),
    UNIT: context.gpmfKeys.has("UNIT"),
    SIUN: context.gpmfKeys.has("SIUN"),
    GPSU: context.gpmfKeys.has("GPSU"),
    GPSF: context.gpmfKeys.has("GPSF"),
    GPSP: context.gpmfKeys.has("GPSP")
  };

  if (!flags.GPS5 && !flags.GPS9) {
    throw new Phase2AError("NO_GPS_DATA", "GPMF内にGPS5/GPS9が見つかりませんでした");
  }

  if (!flags.SCAL) {
    throw new Phase2AError("NO_SCAL", "GPSデータに対応するSCALが見つかりませんでした");
  }

  if (flags.GPS9) {
    const gps9Records = context.gpsPoints.filter((point) => point.gpsKind === "GPS9");
    const validGps9Records = gps9Records.filter((point) => isGpsFixValid(point.fix) && isFiniteLatLng(point.latitude, point.longitude));
    context.gpsMeta.recordsInspected = gps9Records.length;
    context.gpsMeta.decodedGps9RecordCount = gps9Records.length;
    context.gpsMeta.gpmdSamplesInspected = context.gpmdSampleCount;

    const firstValidIndex = gps9Records.findIndex(
      (point) => isGpsFixValid(point.fix) && isFiniteLatLng(point.latitude, point.longitude)
    );
    const skipped = gps9Records.length - validGps9Records.length;

    context.gpsMeta.firstValidGps9Index = firstValidIndex >= 0 ? firstValidIndex : null;
    context.gpsMeta.invalidNoFixRecordsSkipped = skipped;
    context.gpsMeta.noFixRecordCount = skipped;
    context.gpsMeta.validGpsSampleCount = validGps9Records.length;

    if (firstValidIndex < 0) {
      if (context.gpsMeta.probeHistory.length >= PHASE2A_PROBE_TIMES_SEC.length) {
        context.gpsMeta.probeStatusCode = "NO_VALID_GPS_FIX_IN_FILE_PROBE";
        context.gpsMeta.probeStatusMessage = "スポットprobe全地点で有効なGPS9 fixを検出できませんでした (GPS lock未取得の可能性)";
        log(`${context.gpsMeta.probeStatusCode}: ${context.gpsMeta.probeStatusMessage}`);
      } else {
        context.gpsMeta.probeStatusCode = "INSUFFICIENT_PROBE_FOR_FIX";
        context.gpsMeta.probeStatusMessage = `有効GPS9 fix未検出 (inspected ${context.gpmdSampleCount} gpmd samples)`;
        log(`${context.gpsMeta.probeStatusCode}: ${context.gpsMeta.probeStatusMessage}`);
      }
    } else {
      context.gpsMeta.probeStatusCode = "VALID_GPS9_FIX_FOUND";
      context.gpsMeta.probeStatusMessage = "最初の有効GPS9 fixを検出しました";
      context.gpsMeta.firstValidGpsSample = gps9Records[firstValidIndex] || null;
    }

    const requiredProbeTimes = [300, 900, 1500].filter(
      (t) => context.file.durationSec == null || t <= context.file.durationSec
    );
    const coveredProbeTimes = requiredProbeTimes.filter((t) =>
      context.gpsMeta.timeAlignmentComparisons.some((item) => Math.round(item.probeTimeSec) === t)
    );

    context.gpsMeta.absoluteTimeAlignmentStatus = "pending";
    context.gpsMeta.absoluteTimeAlignmentMessage = `時刻整合の確定判定は保留 (${coveredProbeTimes.length}/${requiredProbeTimes.length} probe comparisons collected)`;

    for (const t of requiredProbeTimes) {
      const hit = context.gpsMeta.timeAlignmentComparisons.find((item) => Math.round(item.probeTimeSec) === t);
      if (!hit) {
        log(`[TimeAudit ${t}s] data: not found`);
        continue;
      }
      log(`[TimeAudit ${t}s] gpmd DTS: ${Number.isFinite(hit.gpmdDtsSec) ? hit.gpmdDtsSec.toFixed(3) : "unknown"} sec`);
      log(`[TimeAudit ${t}s] GPS9 timestamp: ${hit.gps9TimestampIso || "unknown"}`);
      log(`[TimeAudit ${t}s] creation_time + DTS: ${hit.mp4CreationPlusDtsIso || "unknown"}`);
      log(`[TimeAudit ${t}s] difference: ${Number.isFinite(hit.differenceMs) ? `${(hit.differenceMs / 1000).toFixed(3)} sec` : "unknown"}`);
    }
  }

  const gps9Anchors = context.gpsMeta.timeAlignmentComparisons.map((item) => ({
    id: item.id,
    probeTimeSec: item.probeTimeSec,
    mediaTimeSec: item.mediaTimeSec,
    gpsAbsoluteTimeMs: item.gpsAbsoluteTimeMs,
    gpmdDtsSec: item.gpmdDtsSec,
    stmpValues: item.stmpValues,
    tsmpValues: item.tsmpValues,
    metadata: {
      gps9Repeat: item.gps9Repeat,
      differenceMsVsCreationTime: item.differenceMs,
      mp4CreationPlusDtsIso: item.mp4CreationPlusDtsIso,
      stmpRaw: item.stmpRaw,
      tsmpRaw: item.tsmpRaw
    }
  }));

  context.timeMapping = buildTimeMapping(gps9Anchors);
  context.fallbackTimeMapping = buildCreationTimeFallbackMapping(toEpochMs(context.file.creationTime));

  const mappingDiagnostics = getMappingDiagnostics(context.timeMapping);
  if (mappingDiagnostics) {
    log(`Time mapping source: ${mappingDiagnostics.source}`);
    log(`Time mapping status: ${mappingDiagnostics.status}`);
    log(`Time mapping anchors: ${mappingDiagnostics.anchorCount}`);
    log(`Time mapping intercept: ${mappingDiagnostics.interceptIso || "unknown"}`);
    log(`Time mapping slope(ms/sec): ${Number.isFinite(mappingDiagnostics.slopeMsPerSec) ? mappingDiagnostics.slopeMsPerSec.toFixed(6) : "unknown"}`);
    log(`Time mapping clock drift(ppm): ${Number.isFinite(mappingDiagnostics.clockDriftPpm) ? mappingDiagnostics.clockDriftPpm.toFixed(3) : "unknown"}`);
    log(`Time mapping max residual(ms): ${Number.isFinite(mappingDiagnostics.maxResidualMs) ? mappingDiagnostics.maxResidualMs.toFixed(3) : "unknown"}`);
    log(`Time mapping RMS residual(ms): ${Number.isFinite(mappingDiagnostics.rmsResidualMs) ? mappingDiagnostics.rmsResidualMs.toFixed(3) : "unknown"}`);
  }

  if (context.gpsPoints.length === 0) {
    throw new Phase2AError("EMPTY_GPS", "GPSサンプルを構築できませんでした");
  }

  const validation = validateGpsPoints(context.gpsPoints);
  notifyStage(4, validation.ok ? "done" : "error");

  const result = buildResult(context, validation, flags);

  if (result.phase2a?.validGpsFixFound && !result.gps.timestampsConstructed) {
    throw new Phase2AError("NO_GPS_TIMESTAMP", "GPS時刻を構築できませんでした");
  }

  if (!validation.ok) {
    throw new Phase2AError("GPS_VALIDATION_FAILED", validation.messages.join(" / "));
  }

  return result;
}

async function parseMp4AndExtractGpmd(file, { signal, targetSamples, batchSamples, seekTimeSec, onInfo, onTelemetryDetected, onSample, shouldStop, onProgress }) {
  return new Promise((resolve, reject) => {
    const mp4boxfile = MP4Box.createFile();
    let settled = false;
    let telemetryTrack = null;
    let expectedSamples = null;
    let processedSamples = 0;
    const sampleBundles = [];

    let isReady = false;
    let startCalled = false;
    let stopRequested = false;
    let doneReason = "other";

    let bytesRead = 0;
    let chunkIndex = 0;
    let requestedOffset = 0;
    let sliceStart = 0;
    let sliceEnd = 0;
    let fileStart = 0;
    let nextFileStart = 0;
    let onSamplesCalls = 0;
    let lastSampleDts = null;
    let seekOffset = null;
    let seekApplied = false;

    const repeatedOffsetCounter = new Map();

    const snapshotProgress = () => ({
      bytesRead,
      totalBytes: file.size,
      ratio: file.size > 0 ? Math.min(1, bytesRead / file.size) : 0,
      chunkIndex,
      requestedOffset,
      sliceStart,
      sliceEnd,
      fileStart,
      nextFileStart,
      onReadyCalled: isReady,
      startCalled,
      onSamplesCalls,
      extractedSamples: processedSamples,
      expectedSamples,
      lastSampleDts,
      seekTimeSec: Number.isFinite(seekTimeSec) ? seekTimeSec : null,
      seekOffset,
      seekApplied
    });

    const emitProgress = () => onProgress?.(snapshotProgress());

    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        mp4boxfile.stop();
      } catch {
        // noop
      }
      resolve(result);
    };

    const fail = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        mp4boxfile.stop();
      } catch {
        // noop
      }
      reject(error);
    };

    signal?.addEventListener("abort", () => {
      doneReason = "other";
      fail(new Phase2AError("ANALYSIS_CANCELED", "解析キャンセル"));
    });

    mp4boxfile.onError = (message) => {
      doneReason = "mp4box-error";
      fail(new Phase2AError("MP4_PARSE_FAILED", `MP4として解析できません: ${message}`));
    };

    const handleSamples = (trackId, _user, samples) => {
      if (settled || !telemetryTrack || trackId !== telemetryTrack.id) {
        return;
      }

      onSamplesCalls += 1;

      for (const sample of samples) {
        processedSamples += 1;
        const sampleMeta = {
          index: processedSamples - 1,
          dts: sample.dts,
          cts: sample.cts,
          duration: sample.duration,
          timescale: sample.timescale,
          size: sample.size
        };
        lastSampleDts = sampleMeta.dts;

        try {
          const normalized = normalizeSample(sample, sampleMeta);
          sampleBundles.push({ sample: normalized });
          onSample?.(normalized);

          const proofDone = shouldStop?.(normalized) === true;
          if (proofDone) {
            stopRequested = true;
            doneReason = "phase2a-proof-satisfied";
          }
        } catch (error) {
          fail(error);
          return;
        }

        if (!stopRequested && Number.isFinite(targetSamples) && processedSamples >= targetSamples) {
          stopRequested = true;
          doneReason = "target-sample-limit-reached";
        }

        try {
          mp4boxfile.releaseUsedSamples(trackId, processedSamples);
        } catch {
          // noop
        }

        if (stopRequested) {
          break;
        }
      }

      emitProgress();

      if (stopRequested && !settled) {
        finish({
          telemetryTrack,
          processedSamples,
          sampleBundles,
          fullFileScanned: false,
          doneReason,
          progress: snapshotProgress()
        });
      }
    };

    mp4boxfile.onReady = (info) => {
      if (settled) {
        return;
      }
      isReady = true;
      onInfo?.(info);

      telemetryTrack = detectTelemetryTrack(summarizeTracks(info.tracks || []));
      if (!telemetryTrack) {
        doneReason = "other";
        finish({
          telemetryTrack: null,
          processedSamples: 0,
          sampleBundles: [],
          fullFileScanned: false,
          doneReason,
          progress: snapshotProgress()
        });
        return;
      }

      expectedSamples = telemetryTrack.sampleCount ?? null;
      onTelemetryDetected?.(telemetryTrack);

      mp4boxfile.onSamples = handleSamples;
      mp4boxfile.setExtractionOptions(telemetryTrack.id, null, {
        nbSamples: Math.max(1, batchSamples || PHASE2A_BATCH_SAMPLES),
        rapAlignement: false
      });
      mp4boxfile.start();
      startCalled = true;

      if (Number.isFinite(seekTimeSec) && seekTimeSec >= 0) {
        const requestedSeek = mp4boxfile.seek(seekTimeSec, true);
        if (Number.isFinite(requestedSeek) && requestedSeek >= 0) {
          seekOffset = requestedSeek;
        }
      }

      emitProgress();
    };

    (async () => {
      try {
        let offset = 0;

        while (!settled && !stopRequested) {
          if (signal?.aborted) {
            throw new Phase2AError("ANALYSIS_CANCELED", "解析キャンセル");
          }

          if (!Number.isFinite(offset) || offset < 0 || offset > file.size) {
            doneReason = "invalid-offset";
            break;
          }

          if (!seekApplied && Number.isFinite(seekOffset)) {
            offset = seekOffset;
            seekApplied = true;
          }

          if (offset === file.size) {
            doneReason = "eof";
            break;
          }

          const repeatCount = (repeatedOffsetCounter.get(offset) || 0) + 1;
          repeatedOffsetCounter.set(offset, repeatCount);
          if (repeatCount > MAX_REPEATED_OFFSET) {
            doneReason = "repeated-range";
            break;
          }

          requestedOffset = offset;
          fileStart = offset;
          sliceStart = offset;
          sliceEnd = Math.min(offset + CHUNK_SIZE, file.size);

          const chunk = await file.slice(sliceStart, sliceEnd).arrayBuffer();
          chunk.fileStart = fileStart;
          chunkIndex += 1;
          bytesRead += chunk.byteLength;

          const nextOffset = mp4boxfile.appendBuffer(chunk);
          nextFileStart = nextOffset;
          emitProgress();

          if (!Number.isFinite(nextOffset)) {
            doneReason = "invalid-offset";
            break;
          }

          offset = nextOffset;

          if (onSamplesCalls === 0 && chunkIndex >= MAX_APPENDS_WITHOUT_SAMPLES) {
            doneReason = "no-progress";
            break;
          }
        }

        if (!isReady) {
          fail(new Phase2AError("MP4_PARSE_FAILED", "MP4のメタデータを取得できませんでした"));
          return;
        }

        if (stopRequested && !settled) {
          finish({
            telemetryTrack,
            processedSamples,
            sampleBundles,
            fullFileScanned: false,
            doneReason,
            progress: snapshotProgress()
          });
          return;
        }

        if (doneReason === "eof") {
          mp4boxfile.flush();
          await waitForExtractionDrain(() => processedSamples, expectedSamples);
        }

        if (!settled) {
          finish({
            telemetryTrack,
            processedSamples,
            sampleBundles,
            fullFileScanned: doneReason === "eof",
            doneReason,
            progress: snapshotProgress()
          });
        }
      } catch (error) {
        if (error instanceof Phase2AError) {
          fail(error);
          return;
        }
        doneReason = "other";
        fail(new Phase2AError("MP4_PARSE_FAILED", error?.message || String(error)));
      }
    })();
  });
}

function detectTelemetryTrack(trackSummaries) {
  let best = null;
  let bestScore = -1;

  for (const track of trackSummaries) {
    const codec = (track.codec || "").toLowerCase();
    const type = (track.type || "").toLowerCase();
    const handler = (track.handler || "").toLowerCase();

    let score = 0;
    if (codec.includes("gpmd")) score += 10;
    if (handler.includes("gopro met")) score += 8;
    if (handler.includes("metadata") || handler.includes("meta")) score += 4;
    if (type.includes("meta")) score += 3;

    if (score > bestScore) {
      bestScore = score;
      best = track;
    }
  }

  return bestScore > 0 ? best : null;
}

function summarizeTracks(tracks) {
  return tracks.map((track) => ({
    id: track.id ?? null,
    type: coalesce(track.type, track.kind?.schemeURI, track.kind?.value, ""),
    codec: track.codec ?? "",
    handler: coalesce(track.name, track.handler, track.hdlr, ""),
    timescale: numberOrNull(track.timescale),
    duration: numberOrNull(track.duration),
    movieDuration: numberOrNull(track.movie_duration),
    sampleCount: numberOrNull(track.nb_samples)
  }));
}

function normalizeSample(sample, sampleMeta) {
  let payload = null;
  if (sample.data instanceof Uint8Array) {
    payload = sample.data;
  } else if (sample.data instanceof ArrayBuffer) {
    payload = new Uint8Array(sample.data);
  } else if (sample.data?.buffer instanceof ArrayBuffer) {
    payload = new Uint8Array(sample.data.buffer, sample.data.byteOffset || 0, sample.data.byteLength || 0);
  }

  if (!payload) {
    throw new Phase2AError("GPMD_SAMPLE_EXTRACTION_FAILED", "gpmd sample payloadを取得できませんでした");
  }

  return {
    ...sampleMeta,
    data: payload
  };
}

function parseGpmfSample(data) {
  const keys = new Set();
  const gpsuRawValues = [];

  const nodes = parseGpmfNodes(data, 0, data.byteLength, keys);

  const streams = [];
  for (const node of nodes) {
    if (node.key === "DEVC") {
      streams.push(...extractStreamsFromNode(node));
      continue;
    }
    if (node.key === "STRM") {
      streams.push(buildStreamBundle(node));
    }
  }

  for (const stream of streams) {
    const gpsuNode = findFirstStreamNode(stream, "GPSU");
    if (gpsuNode?.value?.kind === "string") {
      gpsuRawValues.push(...gpsuNode.value.items);
    }
  }

  return {
    nodes,
    streams,
    keys,
    gpsuRawValues
  };
}

function parseGpmfNodes(data, start, end, keys) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const nodes = [];
  let offset = start;

  while (offset + 8 <= end) {
    const key = readFourCC(view, offset);
    const typeCode = view.getUint8(offset + 4);
    const structSize = view.getUint8(offset + 5);
    const repeat = view.getUint16(offset + 6, false);
    const payloadSize = structSize * repeat;
    const payloadStart = offset + 8;
    const payloadEnd = payloadStart + payloadSize;

    if (payloadEnd > end) {
      throw new Phase2AError("GPMF_PARSE_FAILED", `GPMF構造解析失敗: invalid payload for key ${key}`);
    }

    const node = {
      key,
      typeCode,
      typeChar: String.fromCharCode(typeCode),
      structSize,
      repeat,
      payloadSize,
      payloadStart,
      payloadEnd,
      raw: data.subarray(payloadStart, payloadEnd),
      children: [],
      value: null
    };

    keys.add(key);

    if (isContainerNode(node)) {
      node.children = parseGpmfNodes(data, payloadStart, payloadEnd, keys);
    } else {
      node.value = decodeGpmfValue(node.raw, node.typeCode, node.structSize, node.repeat);
    }

    nodes.push(node);
    offset = payloadStart + align4(payloadSize);
  }

  return nodes;
}

function isContainerNode(node) {
  return node.typeCode === 0 || node.key === "DEVC" || node.key === "STRM";
}

function extractStreamsFromNode(devcNode) {
  const streams = [];
  for (const child of devcNode.children) {
    if (child.key === "STRM") {
      streams.push(buildStreamBundle(child));
    }
  }
  return streams;
}

function buildStreamBundle(strmNode) {
  const values = {};
  for (const child of strmNode.children) {
    if (!values[child.key]) {
      values[child.key] = [];
    }
    values[child.key].push(coerceNodeValue(child));
  }

  return {
    stnm: firstString(flattenStringNodes(strmNode.children, "STNM")),
    values,
    nodes: strmNode.children
  };
}

function flattenStringNodes(nodes, key) {
  const target = nodes.filter((node) => node.key === key && node.value?.kind === "string");
  return target.flatMap((node) => node.value.items || []);
}

function coerceNodeValue(node) {
  if (node.value == null) {
    return null;
  }
  if (node.value.kind === "string") {
    return node.value.items;
  }
  if (node.value.kind === "numeric") {
    return node.value.records;
  }
  return node.value.items;
}

function projectGpsRowsFromSample({ gpmfResult, sample, fileCreationTimeMs }) {
  const points = [];
  const gpsfValues = [];
  const gpspValues = [];
  const mappingNotes = [];
  let firstMeta = null;

  const sampleStartSec = safeDivide(sample.dts, sample.timescale) ?? 0;
  const sampleDurationSec = safeDivide(sample.duration, sample.timescale) ?? 0;

  for (const stream of gpmfResult.streams) {
    const streamRows = projectGpsRowsFromStream({
      stream,
      sample,
      sampleStartSec,
      sampleDurationSec,
      fileCreationTimeMs
    });

    points.push(...streamRows.points);
    gpsfValues.push(...streamRows.gpsfValues);
    gpspValues.push(...streamRows.gpspValues);
    mappingNotes.push(...streamRows.mappingNotes);
    if (!firstMeta && streamRows.firstMeta) {
      firstMeta = streamRows.firstMeta;
    }
  }

  return {
    points,
    gpsfValues,
    gpspValues,
    mappingNotes,
    firstMeta
  };
}

function projectGpsRowsFromStream({ stream, sample, sampleStartSec, sampleDurationSec, fileCreationTimeMs }) {
  const points = [];
  const mappingNotes = [];
  const gpsfValues = flattenNumbers(firstOf(stream.values.GPSF));
  const gpspValues = flattenNumbers(firstOf(stream.values.GPSP));
  const gpsuStrings = flattenStringNodes(stream.nodes, "GPSU");
  const gpsuTimes = gpsuStrings.map(parseGpsuUtc).filter((value) => value != null);

  const scalNode = findFirstStreamNode(stream, "SCAL");
  const scalVector = nodeToNumericVector(scalNode);
  const unitNode = findFirstStreamNode(stream, "UNIT") || findFirstStreamNode(stream, "SIUN");
  const unitValues = normalizeUnitValues(nodeToStringList(unitNode));
  const typeNode = findFirstStreamNode(stream, "TYPE");
  const typeDefinition = parseTypeDefinition(typeNode);

  const gps9Node = findFirstStreamNode(stream, "GPS9");
  const gps5Node = findFirstStreamNode(stream, "GPS5");
  const gpsNode = gps9Node || gps5Node;
  let fieldMap = null;

  if (scalNode) {
    const primitiveByteSize = primitiveTypeSize(scalNode.typeChar);
    const elementsPerStruct =
      primitiveByteSize > 0 && scalNode.structSize % primitiveByteSize === 0
        ? scalNode.structSize / primitiveByteSize
        : null;
    const expectedElementCount = elementsPerStruct == null ? null : elementsPerStruct * scalNode.repeat;
    const actualDecodedElementCount = scalVector.length;

    mappingNotes.push("SCAL:");
    mappingNotes.push(`type=${scalNode.typeChar}`);
    mappingNotes.push(`structSize=${scalNode.structSize}`);
    mappingNotes.push(`repeat=${scalNode.repeat}`);
    mappingNotes.push(`payloadBytes=${scalNode.payloadSize}`);
    mappingNotes.push(`primitiveByteSize=${primitiveByteSize || "unknown"}`);
    mappingNotes.push(`elementsPerStruct=${elementsPerStruct ?? "unknown"}`);
    mappingNotes.push(`expectedElementCount=${expectedElementCount ?? "unknown"}`);
    mappingNotes.push(`actualDecodedElementCount=${actualDecodedElementCount}`);
    mappingNotes.push(`SCAL expected count=${expectedElementCount ?? "unknown"}`);
    mappingNotes.push(`SCAL actual count=${actualDecodedElementCount}`);
    mappingNotes.push(`values=[${scalVector.join(", ")}]`);

    if (expectedElementCount != null && actualDecodedElementCount !== expectedElementCount) {
      throw new Phase2AError(
        "SCAL_DECODE_MISMATCH",
        `SCAL repeat(${scalNode.repeat}) と decoded count(${actualDecodedElementCount})が一致しません`
      );
    }
  }

  if (unitNode) {
    const primitiveByteSize = primitiveTypeSize(unitNode.typeChar);
    const elementsPerStruct =
      primitiveByteSize > 0 && unitNode.structSize % primitiveByteSize === 0
        ? unitNode.structSize / primitiveByteSize
        : null;
    const expectedDecodedCount = unitNode.repeat;
    const actualDecodedCount = unitValues.length;

    mappingNotes.push("UNIT:");
    mappingNotes.push(`type=${unitNode.typeChar}`);
    mappingNotes.push(`structSize=${unitNode.structSize}`);
    mappingNotes.push(`repeat=${unitNode.repeat}`);
    mappingNotes.push(`payloadBytes=${unitNode.payloadSize}`);
    mappingNotes.push(`primitiveByteSize=${primitiveByteSize || "unknown"}`);
    mappingNotes.push(`elementsPerStruct=${elementsPerStruct ?? "unknown"}`);
    mappingNotes.push(`expectedDecodedCount=${expectedDecodedCount}`);
    mappingNotes.push(`actualDecodedCount=${actualDecodedCount}`);
    mappingNotes.push(`UNIT expected count=${expectedDecodedCount}`);
    mappingNotes.push(`UNIT actual count=${actualDecodedCount}`);
    mappingNotes.push(`values=[${unitValues.join(", ")}]`);

    for (let i = 0; i < unitNode.repeat; i += 1) {
      const start = i * unitNode.structSize;
      const end = Math.min(start + unitNode.structSize, unitNode.raw.byteLength);
      const rawBytes = unitNode.raw.subarray(start, end);
      mappingNotes.push(`UNIT[${i}] raw bytes: ${bytesToHex(rawBytes) || ""}`);
      mappingNotes.push(`UNIT[${i}] decoded: ${unitValues[i] ?? ""}`);
    }

    if (actualDecodedCount !== expectedDecodedCount) {
      throw new Phase2AError(
        "UNIT_DECODE_MISMATCH",
        `UNIT repeat(${unitNode.repeat}) と decoded count(${actualDecodedCount})が一致しません`
      );
    }
  }

  let rows = [];
  let keyUsed = null;

  if (gps9Node) {
    fieldMap = deriveFieldMap("GPS9", unitValues, typeDefinition);
    rows = decodeGpsRowsFromNode({
      node: gps9Node,
      scalVector,
      typeDefinition,
      gpsKind: "GPS9",
      fieldMap
    });
    keyUsed = "GPS9";
  } else if (gps5Node) {
    fieldMap = deriveFieldMap("GPS5", unitValues, typeDefinition);
    rows = decodeGpsRowsFromNode({
      node: gps5Node,
      scalVector,
      typeDefinition,
      gpsKind: "GPS5",
      fieldMap
    });
    keyUsed = "GPS5";
  }

  if (!rows.length) {
    return {
      points,
      gpsfValues,
      gpspValues,
      mappingNotes,
      firstMeta: null
    };
  }

  mappingNotes.push(
    `sample#${sample.index}: ${keyUsed}=${rows.length}, GPSU=${gpsuTimes.length}, SCAL=${scalVector.length}, TYPE=${typeDefinition?.signature || "-"}, UNIT/SIUN=${unitValues.join("|") || "-"}`
  );

  let firstMeta = null;
  const firstRecordRawBytesHex = gpsNode ? bytesToHex(gpsNode.raw.subarray(0, gpsNode.structSize)) : null;

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const relativeSec = computeRelativeSec(sampleStartSec, sampleDurationSec, rows.length, i);

    const timestampInfo = resolveTimestampForPoint({
      gpsuTimes,
      relativeSec,
      sampleStartSec,
      sampleDurationSec,
      indexInSample: i,
      countInSample: rows.length,
      fileCreationTimeMs,
      gps9Days: row.daysSince2000,
      gps9Seconds: row.secondsSinceMidnight
    });

    const point = {
      sampleIndex: points.length,
      telemetrySampleIndex: sample.index,
      indexInTelemetrySample: i,
      timestampMs: timestampInfo.timestampMs,
      timestampIso: timestampInfo.timestampMs == null ? null : new Date(timestampInfo.timestampMs).toISOString(),
      timestampSource: timestampInfo.source,
      relativeSec,
      latitude: row.latitude,
      longitude: row.longitude,
      altitude: row.altitude,
      speed2D: row.speed2D,
      speed3D: row.speed3D,
      daysSince2000: row.daysSince2000,
      secondsSinceMidnight: row.secondsSinceMidnight,
      dop: row.dop,
      fix: row.fix,
      fixValid: keyUsed === "GPS9" ? isGpsFixValid(row.fix) : null,
      rawValues: row.rawValues,
      scaledValues: row.scaledValues,
      scalValues: scalVector,
      typeDefinition: typeDefinition?.signature || null,
      siunValues: unitValues,
      gpsKind: keyUsed,
      streamName: stream.stnm || null,
      gpsf: gpsfValues.length ? gpsfValues[0] : null,
      gpsp: gpspValues.length ? gpspValues[0] : null,
      timestampTrusted: keyUsed === "GPS9" ? isGpsFixValid(row.fix) : timestampInfo.timestampMs != null,
      mp4CreationDeltaMs:
        fileCreationTimeMs != null && timestampInfo.timestampMs != null && (keyUsed !== "GPS9" || isGpsFixValid(row.fix))
          ? timestampInfo.timestampMs - fileCreationTimeMs
          : null,
      mp4CreationDeltaSec:
        fileCreationTimeMs != null && timestampInfo.timestampMs != null && (keyUsed !== "GPS9" || isGpsFixValid(row.fix))
          ? (timestampInfo.timestampMs - fileCreationTimeMs) / 1000
          : null
    };

    points.push(point);

    if (!firstMeta) {
      firstMeta = {
        gpsKind: keyUsed,
        rawBytesHex: firstRecordRawBytesHex,
        rawValues: row.rawValues,
        typedValues: row.rawValues,
        scaledValues: row.scaledValues,
        scalValues: scalVector,
        siunValues: unitValues,
        typeDefinition: typeDefinition?.signature || null,
        fieldMap,
        fix: row.fix,
        dop: row.dop,
        timestampSource: point.timestampSource,
        mp4CreationDeltaMs: point.mp4CreationDeltaMs
      };
    }
  }

  return {
    points,
    gpsfValues,
    gpspValues,
    mappingNotes,
    firstMeta
  };
}

function decodeGpsRowsFromNode({ node, scalVector, typeDefinition, gpsKind, fieldMap }) {
  const matrix = decodeNodeRecords(node, typeDefinition);
  if (!matrix.length) {
    return [];
  }

  const rows = [];
  for (const rawValues of matrix) {
    const scaledValues = applyScal(rawValues, scalVector);

    const latitude = pickScaled(scaledValues, fieldMap.latitude);
    const longitude = pickScaled(scaledValues, fieldMap.longitude);
    const altitude = pickScaled(scaledValues, fieldMap.altitude);
    const speed2D = pickScaled(scaledValues, fieldMap.speed2D);
    const speed3D = pickScaled(scaledValues, fieldMap.speed3D);

    let daysSince2000 = pickScaled(scaledValues, fieldMap.daysSince2000);
    let secondsSinceMidnight = pickScaled(scaledValues, fieldMap.secondsSinceMidnight);
    let dop = pickScaled(scaledValues, fieldMap.dop);
    let fix = pickScaled(scaledValues, fieldMap.fix);

    if (gpsKind !== "GPS9") {
      daysSince2000 = null;
      secondsSinceMidnight = null;
      dop = null;
      fix = null;
    }

    rows.push({
      rawValues,
      scaledValues,
      latitude,
      longitude,
      altitude,
      speed2D,
      speed3D,
      daysSince2000,
      secondsSinceMidnight,
      dop,
      fix
    });
  }

  return rows;
}

function decodeNodeRecords(node, typeDefinition) {
  if (node.value?.kind === "numeric") {
    return normalizeMatrix(node.value.records);
  }

  const typeChar = node.typeChar;
  if (typeChar === "?" && typeDefinition?.fields?.length) {
    return decodeComplexRecords(node.raw, typeDefinition.fields, node.repeat, node.structSize);
  }

  return [];
}

function decodeComplexRecords(raw, fields, repeat, structSize) {
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const records = [];

  for (let i = 0; i < repeat; i += 1) {
    const base = i * structSize;
    const row = [];
    let cursor = 0;

    for (const field of fields) {
      const size = primitiveTypeSize(field.type);
      if (!size || cursor + size > structSize) {
        return [];
      }
      row.push(readTypedValue(view, base + cursor, field.type));
      cursor += size;
    }

    records.push(row);
  }

  return records;
}

function parseTypeDefinition(typeNode) {
  if (!typeNode || typeNode.value?.kind !== "string" || !typeNode.value.items.length) {
    return null;
  }

  const signature = typeNode.value.items.join("");
  const chars = signature.split("").filter((ch) => primitiveTypeSize(ch) > 0);
  const fields = chars.map((ch, index) => ({
    index,
    type: ch
  }));

  return {
    signature,
    fields
  };
}

function deriveFieldMap(gpsKind, unitValues, typeDefinition) {
  if (gpsKind === "GPS5") {
    return {
      latitude: 0,
      longitude: 1,
      altitude: 2,
      speed2D: 3,
      speed3D: 4,
      daysSince2000: null,
      secondsSinceMidnight: null,
      dop: null,
      fix: null
    };
  }

  if (gpsKind === "GPS9") {
    return {
      latitude: 0,
      longitude: 1,
      altitude: 2,
      speed2D: 3,
      speed3D: 4,
      daysSince2000: 5,
      secondsSinceMidnight: 6,
      dop: 7,
      fix: 8
    };
  }

  const units = Array.isArray(unitValues) ? unitValues.map((v) => String(v).toLowerCase()) : [];
  const findIndex = (predicate, skip = new Set()) => {
    for (let i = 0; i < units.length; i += 1) {
      if (skip.has(i)) continue;
      if (predicate(units[i])) return i;
    }
    return null;
  };

  const used = new Set();
  const latitude = findIndex((u) => u.includes("deg"), used);
  if (latitude != null) used.add(latitude);
  const longitude = findIndex((u) => u.includes("deg"), used);
  if (longitude != null) used.add(longitude);
  const altitude = findIndex((u) => u.includes("m") && !u.includes("/"), used);
  if (altitude != null) used.add(altitude);
  const speed2D = findIndex((u) => u.includes("m/s") || u.includes("mps"), used);
  if (speed2D != null) used.add(speed2D);
  const speed3D = findIndex((u) => u.includes("m/s") || u.includes("mps"), used);
  if (speed3D != null) used.add(speed3D);
  const daysSince2000 = findIndex((u) => u.includes("day"), used);
  if (daysSince2000 != null) used.add(daysSince2000);
  const secondsSinceMidnight = findIndex((u) => u === "s" || u.includes("sec"), used);
  if (secondsSinceMidnight != null) used.add(secondsSinceMidnight);
  const dop = findIndex((u) => u.includes("dop") || u.includes("pdop") || u.includes("hdop"), used);
  if (dop != null) used.add(dop);
  const fix = findIndex((u) => u.includes("fix"), used);

  return {
    latitude,
    longitude,
    altitude,
    speed2D,
    speed3D,
    daysSince2000,
    secondsSinceMidnight,
    dop,
    fix
  };
}

function formatFieldMap(fieldMap) {
  if (!fieldMap) {
    return "unknown";
  }
  const entries = Object.entries(fieldMap).map(([k, v]) => `${k}:${Number.isInteger(v) ? v : "unknown"}`);
  return entries.join(", ");
}

function pickScaled(values, index) {
  if (!Number.isInteger(index)) return null;
  const value = values[index];
  return Number.isFinite(value) ? value : null;
}

function normalizeUnitValues(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return [];
  }

  // Normal case: parser already returned one string per record.
  if (values.length > 1) {
    return values.map((item) => String(item).replace(/\u0000+$/g, ""));
  }

  // Backward-compatible fallback for packed single-string variants.
  const packed = String(values[0] ?? "").replace(/\u0000+$/g, "");
  if (!packed) {
    return [""];
  }

  if (packed.includes(",") || packed.includes("|")) {
    return packed.split(/[|,]/g).map((item) => item.replace(/\u0000+$/g, ""));
  }

  return [packed];
}

function flattenNumbers(value) {
  if (value == null) {
    return [];
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? [value] : [];
  }
  if (ArrayBuffer.isView(value)) {
    return Array.from(value).map(Number).filter((v) => Number.isFinite(v));
  }
  if (Array.isArray(value)) {
    return value.flat(Infinity).map(Number).filter((v) => Number.isFinite(v));
  }
  return [];
}

function bytesToHex(bytes) {
  if (!bytes || !bytes.length) {
    return null;
  }
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ");
}

function resolveTimestampForPoint({ gpsuTimes, relativeSec, sampleStartSec, sampleDurationSec, indexInSample, countInSample, fileCreationTimeMs, gps9Days, gps9Seconds }) {
  if (Number.isFinite(gps9Days) && Number.isFinite(gps9Seconds)) {
    const timestampMs = GPS9_EPOCH_MS + gps9Days * 86400 * 1000 + gps9Seconds * 1000;
    return {
      timestampMs,
      source: "GPS9 days+seconds"
    };
  }

  if (gpsuTimes.length === countInSample) {
    return {
      timestampMs: gpsuTimes[indexInSample],
      source: "GPSU direct"
    };
  }

  if (gpsuTimes.length === 1) {
    const offsetMs = countInSample <= 1 ? 0 : (sampleDurationSec * 1000 * indexInSample) / (countInSample - 1);
    return {
      timestampMs: gpsuTimes[0] + offsetMs,
      source: "GPSU + sample duration interpolation"
    };
  }

  if (fileCreationTimeMs != null) {
    return {
      timestampMs: fileCreationTimeMs + relativeSec * 1000,
      source: "MP4 creation_time + gpmd sample offset"
    };
  }

  if (Number.isFinite(sampleStartSec)) {
    return {
      timestampMs: Math.round(relativeSec * 1000),
      source: "relative timeline only"
    };
  }

  return {
    timestampMs: null,
    source: "unresolved"
  };
}

function isGpsFixValid(fix) {
  return Number.isFinite(fix) && (fix === 2 || fix === 3);
}

function isFiniteLatLng(latitude, longitude) {
  return Number.isFinite(latitude) && Number.isFinite(longitude);
}

function validateGpsPoints(points) {
  const messages = [];

  const filtered = points.filter((point) => {
    if (point.gpsKind !== "GPS9") {
      return true;
    }
    return isGpsFixValid(point.fix);
  });

  if (!filtered.length && points.length === 0) {
    messages.push("GPS sample countが0です");
  }

  for (let i = 0; i < filtered.length; i += 1) {
    const point = filtered[i];

    if (!Number.isFinite(point.latitude) || point.latitude < -90 || point.latitude > 90) {
      messages.push(`latitude範囲外 at index ${i}`);
      break;
    }

    if (!Number.isFinite(point.longitude) || point.longitude < -180 || point.longitude > 180) {
      messages.push(`longitude範囲外 at index ${i}`);
      break;
    }

    const values = [point.latitude, point.longitude, point.altitude, point.speed2D, point.speed3D];
    if (values.some((value) => value != null && !Number.isFinite(value))) {
      messages.push(`NaN/Infinity検出 at index ${i}`);
      break;
    }
  }

  for (let i = 1; i < filtered.length; i += 1) {
    const prev = filtered[i - 1].timestampMs;
    const curr = filtered[i].timestampMs;
    if (prev == null || curr == null) {
      continue;
    }
    if (curr < prev) {
      messages.push(`timestampが単調増加していません at index ${i}`);
      break;
    }
  }

  return {
    ok: messages.length === 0,
    messages
  };
}

function buildResult(context, validation, flags) {
  const gpsPoints = context.gpsPoints;
  const decodedGps9Records = gpsPoints.filter((point) => point.gpsKind === "GPS9");
  const validGpsSamples = decodedGps9Records.filter(
    (point) => point.gpsKind === "GPS9" && isGpsFixValid(point.fix) && isFiniteLatLng(point.latitude, point.longitude)
  );
  const firstDecodedGps9 = decodedGps9Records[0] || null;
  const firstValidGps9 = validGpsSamples[0] || null;
  const firstGps = firstValidGps9 || firstDecodedGps9 || gpsPoints[0] || null;
  const lastGps = gpsPoints[gpsPoints.length - 1] || null;
  const fullFileScanned = Boolean(context.scan?.fullFileScanned);
  const hasAbsoluteTimestamp = gpsPoints.some(
    (point) => point.timestampMs != null && point.timestampTrusted === true && point.timestampSource !== "relative timeline only"
  );
  const gpmfDecodeSuccess = Boolean(context.telemetryTrack) && (flags.GPS9 || flags.GPS5) && flags.SCAL;
  const gps9DecodeSuccess = flags.GPS9 && decodedGps9Records.length > 0;
  const validGpsFixFound = validGpsSamples.length > 0;
  const gps9AbsoluteTimeSuccess = validGpsSamples.some((point) => point.timestampTrusted === true && point.timestampMs != null);
  const mappingDiagnostics = getMappingDiagnostics(context.timeMapping);
  const mappingSuccess = mappingDiagnostics?.status === "success";
  const phase2aSuccess =
    gpmfDecodeSuccess && gps9DecodeSuccess && validGpsFixFound && validation.ok && hasAbsoluteTimestamp && gps9AbsoluteTimeSuccess && mappingSuccess;
  const phase2aState = !gps9DecodeSuccess
    ? "decode-failed"
    : !validGpsFixFound
      ? "decode-success/no-valid-fix"
      : !mappingSuccess
        ? "decode-success/valid-fix/mapping-pending"
        : "success";

  return {
    file: {
      name: context.file.name,
      size: context.file.size,
      durationSec: context.file.durationSec ?? null,
      creationTime: context.file.creationTime || null,
      tracks: context.trackSummaries
    },
    telemetry: {
      detected: Boolean(context.telemetryTrack),
      trackId: context.telemetryTrack?.id ?? null,
      sampleCount: context.gpmdSampleCount,
      firstSample: context.firstGpmdSampleMeta,
      expectedTotalSamples: context.scan?.expectedSamples ?? null,
      extractionMode: "phase2a-fast",
      doneReason: context.scan?.doneReason ?? null
    },
    gpmf: {
      GPS5: flags.GPS5,
      GPS9: flags.GPS9,
      SCAL: flags.SCAL,
      TYPE: flags.TYPE,
      UNIT: flags.UNIT,
      SIUN: flags.SIUN,
      GPSU: flags.GPSU,
      GPSF: flags.GPSF,
      GPSP: flags.GPSP,
      detectedKeys: [...context.gpmfKeys].sort(),
      keyTreePreview: context.gpmfTreePreview
    },
    gps: {
      sampleCount: validGpsSamples.length,
      decodedGps9RecordCount: decodedGps9Records.length,
      validGpsSampleCount: validGpsSamples.length,
      noFixRecordCount: Math.max(0, decodedGps9Records.length - validGpsSamples.length),
      firstTimestamp: firstValidGps9?.timestampIso || null,
      lastTimestamp: fullFileScanned ? lastGps?.timestampIso || null : null,
      firstSample: firstGps,
      firstDecodedGps9Record: firstDecodedGps9,
      firstValidSample: firstValidGps9,
      lastSample: fullFileScanned ? lastGps : null,
      lastSampleFromScanned: lastGps,
      top10: gpsPoints.slice(0, 10),
      timestampsConstructed: hasAbsoluteTimestamp,
      fullFileScanned
    },
    timing: {
      gpsuRawValues: context.timing.gpsuRawValues.slice(0, 12),
      mappingNotes: uniqueStrings(context.timing.mappingNotes).slice(0, 60)
    },
    quality: {
      gpsfPresent: context.gpmfKeys.has("GPSF"),
      gpspPresent: context.gpmfKeys.has("GPSP"),
      gpsfValues: uniqueNumbers(context.quality.gpsfValues),
      gpspValues: uniqueNumbers(context.quality.gpspValues)
    },
    gpsMeta: context.gpsMeta,
    scan: context.scan,
    timeMapping: mappingDiagnostics,
    timeMappingFallback: getMappingDiagnostics(context.fallbackTimeMapping),
    phase2a: {
      state: phase2aState,
      success: phase2aSuccess,
      gpmfDecodeSuccess,
      gps9DecodeSuccess,
      validGpsFixFound,
      coordinatesSuccess: validGpsFixFound,
      gps9AbsoluteTimeSuccess,
      mediaToUtcMappingSuccess: mappingSuccess,
      absoluteTimeAlignment: mappingSuccess ? "success" : context.gpsMeta.absoluteTimeAlignmentStatus || "pending",
      absoluteTimeAlignmentMessage: mappingSuccess
        ? "GPS9 valid fix anchorsからmedia-to-UTC mappingを構築しました"
        : context.gpsMeta.absoluteTimeAlignmentMessage || "未検証",
      message: phase2aSuccess ? "success" : phase2aState
    },
    quickProof: context.quickProof,
    validation
  };
}

function decodeGpmfValue(raw, typeCode, structSize, repeat) {
  const type = String.fromCharCode(typeCode);
  const elementSize = primitiveTypeSize(type);

  if (type === "c" || type === "U") {
    const decoder = new TextDecoder("ascii");
    const items = [];
    for (let i = 0; i < repeat; i += 1) {
      const start = i * structSize;
      const end = Math.min(start + structSize, raw.byteLength);
      // Keep one decoded string per record and strip only trailing NUL padding.
      const text = decoder.decode(raw.subarray(start, end)).replace(/\u0000+$/g, "");
      items.push(text);
    }
    return { kind: "string", items };
  }

  if (!elementSize || structSize % elementSize !== 0) {
    return { kind: "raw", items: [raw] };
  }

  const components = structSize / elementSize;
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const records = [];

  for (let i = 0; i < repeat; i += 1) {
    const record = [];
    for (let c = 0; c < components; c += 1) {
      const at = i * structSize + c * elementSize;
      record.push(readTypedValue(view, at, type));
    }
    records.push(record);
  }

  return { kind: "numeric", records };
}

function readTypedValue(view, offset, type) {
  switch (type) {
    case "b":
      return view.getInt8(offset);
    case "B":
      return view.getUint8(offset);
    case "s":
      return view.getInt16(offset, false);
    case "S":
      return view.getUint16(offset, false);
    case "l":
      return view.getInt32(offset, false);
    case "L":
      return view.getUint32(offset, false);
    case "f":
      return view.getFloat32(offset, false);
    case "d":
      return view.getFloat64(offset, false);
    case "j": {
      const value = view.getBigInt64(offset, false);
      const numberValue = Number(value);
      return Number.isFinite(numberValue) ? numberValue : null;
    }
    case "J": {
      const value = view.getBigUint64(offset, false);
      const numberValue = Number(value);
      return Number.isFinite(numberValue) ? numberValue : null;
    }
    default:
      return null;
  }
}

function primitiveTypeSize(type) {
  switch (type) {
    case "b":
    case "B":
    case "c":
    case "U":
      return 1;
    case "s":
    case "S":
      return 2;
    case "l":
    case "L":
    case "f":
      return 4;
    case "j":
    case "J":
    case "d":
      return 8;
    default:
      return 0;
  }
}

function applyScal(values, scal) {
  const output = [];
  for (let i = 0; i < values.length; i += 1) {
    const divisor = Number(scal[i] ?? scal[scal.length - 1] ?? 1);
    const base = Number(values[i]);
    if (!Number.isFinite(base)) {
      output.push(null);
      continue;
    }
    if (!Number.isFinite(divisor) || divisor === 0) {
      output.push(base);
      continue;
    }
    output.push(base / divisor);
  }
  return output;
}

function normalizeMatrix(value) {
  if (!value || !Array.isArray(value) || !value.length || !Array.isArray(value[0])) {
    return [];
  }
  return value.map((row) => row.map((cell) => Number(cell)));
}

function parseGpsuUtc(text) {
  if (!text) return null;
  const compact = text.replace(/[^0-9.]/g, "");
  const match = compact.match(/^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.(\d{1,3}))?/);
  if (!match) {
    const direct = Date.parse(text);
    return Number.isFinite(direct) ? direct : null;
  }

  const year2 = Number(match[1]);
  const year = year2 >= 80 ? 1900 + year2 : 2000 + year2;
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const millisecond = Number((match[7] || "0").padEnd(3, "0"));
  return Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
}

function computeRelativeSec(sampleStartSec, sampleDurationSec, count, index) {
  if (!Number.isFinite(sampleDurationSec) || sampleDurationSec <= 0) {
    return sampleStartSec;
  }
  if (count <= 1) {
    return sampleStartSec + sampleDurationSec / 2;
  }
  return sampleStartSec + (sampleDurationSec * index) / (count - 1);
}

function formatGpmfTree(nodes, sampleIndex) {
  const lines = [`GPMF tree sample#${sampleIndex}:`];
  const walk = (list, depth) => {
    for (const node of list) {
      const indent = "  ".repeat(depth);
      lines.push(
        `${indent}${node.key} (type=${node.typeChar}, struct=${node.structSize}, repeat=${node.repeat}, payload=${node.payloadSize})`
      );
      if (node.children?.length) {
        walk(node.children, depth + 1);
      }
    }
  };
  walk(nodes, 0);
  return lines.join("\n");
}

async function waitForExtractionDrain(getProcessedCount, expected) {
  const started = performance.now();
  let lastCount = getProcessedCount();
  let lastChangedAt = started;

  while (performance.now() - started < 4000) {
    await delay(50);
    const count = getProcessedCount();
    if (count !== lastCount) {
      lastCount = count;
      lastChangedAt = performance.now();
    }

    if (expected != null && count >= expected) {
      return;
    }

    if (performance.now() - lastChangedAt > 200) {
      return;
    }
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildExtraProbeTimes(durationSec, count, usedProbeTimes) {
  if (!Number.isFinite(durationSec) || durationSec <= 0 || !Number.isFinite(count) || count <= 0) {
    return [];
  }

  const times = [];
  const step = durationSec / (count + 1);
  for (let i = 1; i <= count; i += 1) {
    const value = Math.max(0, Math.min(durationSec, Math.round(step * i)));
    if (!usedProbeTimes.has(value)) {
      times.push(value);
    }
  }
  return times;
}

function readFourCC(view, offset) {
  return String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3));
}

function align4(value) {
  return (value + 3) & ~3;
}

function numberOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function toIsoOrNull(value) {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? value.toISOString() : null;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }
  return null;
}

function toEpochMs(iso) {
  if (!iso) return null;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : null;
}

function safeDivide(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) {
    return null;
  }
  return a / b;
}

function coalesce(...values) {
  for (const value of values) {
    if (value != null && value !== "") return value;
  }
  return "";
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "unknown";
  const unit = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < unit.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(i === 0 ? 0 : 2)} ${unit[i]}`;
}

function firstOf(value) {
  if (!Array.isArray(value)) return null;
  return value[0] ?? null;
}

function firstString(value) {
  if (!Array.isArray(value)) return null;
  return value[0] ?? null;
}

function uniqueStrings(values) {
  return [...new Set(values.filter((v) => typeof v === "string" && v.length > 0))];
}

function uniqueNumbers(values) {
  return [...new Set(values.filter((v) => Number.isFinite(v)))];
}

function findFirstStreamNode(stream, key) {
  return stream.nodes.find((node) => node.key === key) || null;
}

function nodeToNumericVector(node) {
  if (!node || node.value?.kind !== "numeric") {
    return [];
  }
  const matrix = normalizeMatrix(node.value.records);
  return matrix.flatMap((row) => row);
}

function nodeToStringList(node) {
  if (!node || node.value?.kind !== "string") {
    return [];
  }
  return node.value.items || [];
}

function nodeToValueList(node) {
  if (!node || !node.value) {
    return [];
  }
  if (node.value.kind === "numeric") {
    return nodeToNumericVector(node);
  }
  if (node.value.kind === "string") {
    return nodeToStringList(node);
  }
  return [];
}

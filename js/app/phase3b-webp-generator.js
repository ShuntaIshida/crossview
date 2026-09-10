import { utcToMediaTime } from "./absolute-time-resolver.js";
import { openVideoFrameSource, Phase3AError } from "./phase3a-frame-probe.js";

export const PHASE3B_STAGES = [
  "WebP生成計画を作成",
  "Segmentごとに抽出時刻を解決",
  "MP4からWebPを生成",
  "Route画像セットを確定"
];

const FILE_TIME_EPSILON_MS = 5;
const GPS_MATCH_MAX_DELTA_MS = 1000;

export class Phase3BError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "Phase3BError";
    this.code = code;
    this.details = details;
  }
}

export async function generateRouteWebpSet({ routeDraft, sourceFiles, frameIntervalSec, signal, onStage, onLog, onProgress } = {}) {
  if (!routeDraft) {
    throw new Phase3BError("ROUTE_DRAFT_MISSING", "Route draftがありません");
  }
  if (!Array.isArray(sourceFiles) || sourceFiles.length === 0) {
    throw new Phase3BError("SOURCE_FILES_MISSING", "元MP4ファイル参照がありません");
  }
  if (!Number.isFinite(frameIntervalSec) || frameIntervalSec <= 0) {
    throw new Phase3BError("FRAME_INTERVAL_INVALID", "画像抽出間隔が不正です");
  }

  const notifyStage = (index, state = "running") => onStage?.({ index, state });
  const log = (line) => onLog?.(line);

  notifyStage(0, "running");
  const fileMap = new Map(sourceFiles.map((file) => [buildFileKey(file.name, file.size), file]));
  const plan = buildGenerationPlan(routeDraft, frameIntervalSec, fileMap);
  notifyStage(0, "done");

  notifyStage(1, "running");
  log(`生成予定枚数: ${plan.totalPlannedFrames}`);
  log(`対象Segment数: ${plan.segmentPlans.length}`);
  notifyStage(1, "done");

  notifyStage(2, "running");

  const segmentFrameMap = new Map();
  let currentFileKey = null;
  let currentSource = null;
  let generatedCount = 0;
  let totalBytes = 0;
  let errorCount = 0;
  const startedAt = performance.now();

  try {
    for (let segmentIndex = 0; segmentIndex < plan.segmentPlans.length; segmentIndex += 1) {
      const segmentPlan = plan.segmentPlans[segmentIndex];
      log(`Segment開始: ${segmentPlan.segmentId} (${segmentPlan.frames.length}枚予定)`);

      for (let frameIndex = 0; frameIndex < segmentPlan.frames.length; frameIndex += 1) {
        throwIfAborted(signal);
        const framePlan = segmentPlan.frames[frameIndex];

        if (framePlan.sourceFileKey !== currentFileKey) {
          currentSource?.cleanup();
          currentSource = null;
          currentFileKey = framePlan.sourceFileKey;
          const file = fileMap.get(currentFileKey);
          if (!file) {
            throw new Phase3BError("SOURCE_FILE_NOT_FOUND", `元MP4を解決できませんでした: ${framePlan.sourceFileName}`);
          }
          currentSource = await openVideoFrameSource(file, {
            signal,
            onLog: (line) => log(`[${file.name}] ${line}`)
          });
        }

        const frameResult = await currentSource.extractWebpFrame(framePlan.mediaTimeSec);
        const matchedGpsSample = framePlan.nearestGpsSample || null;
        const frameRecord = {
          id: `frame-${crypto.randomUUID()}`,
          routeId: routeDraft.routeId,
          segmentId: framePlan.segmentId,
          sourceFileName: framePlan.sourceFileName,
          mediaTimeSec: frameResult.actualCurrentTimeSec,
          absoluteUtc: framePlan.absoluteUtc,
          width: frameResult.frameWidth,
          height: frameResult.frameHeight,
          blob: frameResult.blob,
          mimeType: frameResult.mimeType,
          blobSize: frameResult.blobSize,
          nearestGpsSampleId: matchedGpsSample?.sampleId || null,
          lat: matchedGpsSample?.lat ?? null,
          lng: matchedGpsSample?.lng ?? null,
          altitudeM: matchedGpsSample?.altitudeM ?? null,
          gpsTimestamp: matchedGpsSample?.gpsTimestamp || null,
          gpsFix: matchedGpsSample?.gpsFix ?? null,
          gpsDop: matchedGpsSample?.gpsDop ?? null,
          gpsTimeDeltaMs: Number.isFinite(framePlan.gpsTimeDeltaMs) ? framePlan.gpsTimeDeltaMs : null,
          gpsStatus: matchedGpsSample ? "matched" : "missing"
        };

        const list = segmentFrameMap.get(framePlan.segmentId) || [];
        list.push(frameRecord);
        segmentFrameMap.set(framePlan.segmentId, list);

        generatedCount += 1;
        totalBytes += frameResult.blobSize;

        onProgress?.({
          currentFileName: framePlan.sourceFileName,
          currentSegmentLabel: framePlan.segmentId,
          currentAbsoluteUtc: framePlan.absoluteUtc,
          currentMediaTimeSec: frameResult.actualCurrentTimeSec,
          webpDone: generatedCount,
          webpTotal: plan.totalPlannedFrames,
          overallProgress: plan.totalPlannedFrames > 0 ? Math.min(99, 10 + (generatedCount / plan.totalPlannedFrames) * 85) : 99
        });

        log(
          `WebP ${generatedCount}/${plan.totalPlannedFrames}: ${framePlan.sourceFileName} ${framePlan.absoluteUtc} media=${frameResult.actualCurrentTimeSec.toFixed(3)} size=${frameResult.blobSize}`
        );
      }
    }
  } catch (error) {
    errorCount += 1;
    currentSource?.cleanup();
    throw normalizePhase3BError(error, {
      plannedCount: plan.totalPlannedFrames,
      generatedCount,
      totalBytes,
      errorCount,
      elapsedMs: roundMs(performance.now() - startedAt)
    });
  }

  currentSource?.cleanup();
  notifyStage(2, "done");

  notifyStage(3, "running");
  const routeWithFrames = {
    ...routeDraft,
    segments: routeDraft.segments.map((segment) => ({
      ...segment,
      frames: (segmentFrameMap.get(segment.segmentId) || []).slice()
    })),
    imageSetStats: {
      plannedCount: plan.totalPlannedFrames,
      generatedCount,
      errorCount,
      elapsedMs: roundMs(performance.now() - startedAt),
      averageWebpSizeBytes: generatedCount > 0 ? Math.round(totalBytes / generatedCount) : 0,
      estimatedTotalBytes: totalBytes,
      frameIntervalSec
    }
  };
  notifyStage(3, "done");

  onProgress?.({
    webpDone: generatedCount,
    webpTotal: plan.totalPlannedFrames,
    overallProgress: 100
  });

  return {
    routeDraft: routeWithFrames,
    stats: routeWithFrames.imageSetStats,
    plan
  };
}

function buildGenerationPlan(routeDraft, frameIntervalSec, fileMap) {
  const intervalMs = frameIntervalSec * 1000;
  const segmentPlans = routeDraft.segments.map((segment) => {
    const frames = [];
    const segmentStartMs = toEpochMs(segment.startTime);
    const segmentEndMs = toEpochMs(segment.endTime);
    const segmentGpsSamples = buildSegmentGpsSamples(segment);

    if (!Number.isFinite(segmentStartMs) || !Number.isFinite(segmentEndMs) || segmentEndMs < segmentStartMs) {
      throw new Phase3BError("SEGMENT_TIME_INVALID", `Segment時刻範囲が不正です: ${segment.segmentId}`);
    }

    for (let absoluteUtcMs = segmentStartMs; absoluteUtcMs <= segmentEndMs + 0.5; absoluteUtcMs += intervalMs) {
      const sourceMeta = resolveSourceFileMeta(segment.files || [], absoluteUtcMs);
      if (!sourceMeta) {
        throw new Phase3BError(
          "SEGMENT_SOURCE_FILE_UNRESOLVED",
          `absolute UTCから対象MP4を解決できませんでした: ${segment.segmentId} ${toIsoOrNull(absoluteUtcMs)}`
        );
      }

      const sourceFileKey = buildFileKey(sourceMeta.fileName, sourceMeta.sizeBytes);
      if (!fileMap.has(sourceFileKey)) {
        throw new Phase3BError("SOURCE_FILE_NOT_FOUND", `元MP4を解決できませんでした: ${sourceMeta.fileName}`);
      }

      const mediaTimeSec = utcToMediaTime(
        {
          interceptMs: sourceMeta.interceptMs,
          slopeMsPerSec: sourceMeta.slopeMsPerSec
        },
        absoluteUtcMs
      );

      if (!Number.isFinite(mediaTimeSec)) {
        throw new Phase3BError("MEDIA_TIME_UNRESOLVED", `media timeを解決できませんでした: ${sourceMeta.fileName}`);
      }

      const clampedMediaTimeSec = Math.max(0, Math.min(sourceMeta.durationSec, mediaTimeSec));
      const nearestGpsSample = findNearestGpsSample(segmentGpsSamples, absoluteUtcMs);
      frames.push({
        routeId: routeDraft.routeId,
        segmentId: segment.segmentId,
        sourceFileKey,
        sourceFileName: sourceMeta.fileName,
        absoluteUtcMs,
        absoluteUtc: toIsoOrNull(absoluteUtcMs),
        mediaTimeSec: clampedMediaTimeSec,
        nearestGpsSample: nearestGpsSample?.sample || null,
        gpsTimeDeltaMs: nearestGpsSample?.deltaMs ?? null
      });
    }

    return {
      segmentId: segment.segmentId,
      frames
    };
  });

  return {
    frameIntervalSec,
    totalPlannedFrames: segmentPlans.reduce((sum, segmentPlan) => sum + segmentPlan.frames.length, 0),
    segmentPlans
  };
}

function resolveSourceFileMeta(segmentFiles, absoluteUtcMs) {
  return (segmentFiles || []).find((fileMeta) => {
    if (!Number.isFinite(fileMeta.fileStartUtcMs) || !Number.isFinite(fileMeta.fileEndUtcMs)) {
      return false;
    }
    return absoluteUtcMs >= fileMeta.fileStartUtcMs - FILE_TIME_EPSILON_MS && absoluteUtcMs <= fileMeta.fileEndUtcMs + FILE_TIME_EPSILON_MS;
  }) || null;
}

function buildSegmentGpsSamples(segment) {
  const startMs = toEpochMs(segment.startTime);
  const endMs = toEpochMs(segment.endTime);
  const sourceSamples = Array.isArray(segment.gpsSamples) && segment.gpsSamples.length
    ? segment.gpsSamples
    : (segment.files || []).flatMap((file) => file.gpsSamples || []);

  return sourceSamples
    .filter((sample) => Number.isFinite(sample?.gpsTimestampMs) && Number.isFinite(sample?.lat) && Number.isFinite(sample?.lng))
    .filter((sample) => {
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
        return true;
      }
      return sample.gpsTimestampMs >= startMs && sample.gpsTimestampMs <= endMs;
    })
    .slice()
    .sort((a, b) => a.gpsTimestampMs - b.gpsTimestampMs || String(a.sampleId).localeCompare(String(b.sampleId)));
}

function findNearestGpsSample(samples, targetUtcMs) {
  if (!Array.isArray(samples) || !samples.length || !Number.isFinite(targetUtcMs)) {
    return null;
  }

  const index = findLowerBound(samples, targetUtcMs);
  const candidates = [];

  if (index < samples.length) {
    candidates.push(samples[index]);
  }
  if (index > 0) {
    candidates.push(samples[index - 1]);
  }

  let bestSample = null;
  let bestDeltaMs = Infinity;
  let bestSignedDeltaMs = Infinity;

  for (const candidate of candidates) {
    const deltaMs = candidate.gpsTimestampMs - targetUtcMs;
    const absDeltaMs = Math.abs(deltaMs);
    if (absDeltaMs < bestDeltaMs || (absDeltaMs === bestDeltaMs && deltaMs < bestSignedDeltaMs)) {
      bestSample = candidate;
      bestDeltaMs = absDeltaMs;
      bestSignedDeltaMs = deltaMs;
    }
  }

  if (!bestSample || bestDeltaMs > GPS_MATCH_MAX_DELTA_MS) {
    return null;
  }

  return {
    sample: bestSample,
    deltaMs: bestSignedDeltaMs
  };
}

function findLowerBound(samples, targetUtcMs) {
  let low = 0;
  let high = samples.length;

  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (samples[mid].gpsTimestampMs < targetUtcMs) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  return low;
}

function normalizePhase3BError(error, stats) {
  if (error instanceof Phase3BError) {
    error.details = {
      ...(error.details || {}),
      stats
    };
    return error;
  }
  if (error instanceof Phase3AError) {
    return new Phase3BError(error.code, error.message, {
      phase3a: error.details || null,
      stats
    });
  }
  return new Phase3BError("PHASE3B_FAILED", error?.message || String(error), { stats });
}

function buildFileKey(fileName, sizeBytes) {
  return `${fileName}::${sizeBytes}`;
}

function toEpochMs(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toIsoOrNull(timestampMs) {
  return Number.isFinite(timestampMs) ? new Date(timestampMs).toISOString() : null;
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw new Phase3BError("ANALYSIS_CANCELED", "Phase 3Bをキャンセルしました");
  }
}

function roundMs(value) {
  return Math.round(value * 1000) / 1000;
}

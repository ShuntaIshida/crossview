import { mediaTimeToUtc } from "./absolute-time-resolver.js";
import { analyzeGoProMp4ForPhase2A, Phase2AError } from "./phase2a-analyzer.js";

export const PHASE2B_STAGES = [
  "MP4一覧を確認",
  "各MP4のGPMF/GPS9を解析",
  "各MP4のmedia-to-UTC mappingを構築",
  "absolute UTC順に整列",
  "ファイル間の連続性を判定",
  "Segmentを生成",
  "Route構造を確定"
];

export const CONTINUITY_TOLERANCE_SEC = 1.0;

export async function analyzeRouteFilesForPhase2B(files, { tempRouteId, routeLabel, signal, onStage, onLog, onProgress } = {}) {
  const fileList = Array.from(files || []);
  if (!fileList.length) {
    throw new Phase2AError("NO_FILES_SELECTED", "MP4ファイルを選択してください");
  }

  const notifyStage = (index, state = "running") => onStage?.({ index, state });
  const log = (line) => onLog?.(line);

  const successfulFiles = [];
  const failedFiles = [];

  notifyStage(0, "running");
  log(`選択ファイル数: ${fileList.length}`);
  notifyStage(0, "done");

  notifyStage(1, "running");
  notifyStage(2, "running");

  for (let i = 0; i < fileList.length; i += 1) {
    const file = fileList[i];
    let currentExtractionRatio = 0;

    const pushProgress = () => {
      const analyzedPortion = i + currentExtractionRatio;
      const analysisRatio = analyzedPortion / fileList.length;
      const overallProgress = Math.min(70, 5 + analysisRatio * 65);
      onProgress?.({
        currentFileName: file.name,
        fileIndex: i + 1,
        fileTotal: fileList.length,
        fileProgressPercent: Math.round(currentExtractionRatio * 1000) / 10,
        overallProgress,
        successCount: successfulFiles.length,
        failedCount: failedFiles.length
      });
    };

    pushProgress();
    log(`解析開始: ${file.name}`);

    try {
      const phase2aResult = await analyzeGoProMp4ForPhase2A(file, {
        signal,
        onLog: (line) => log(`[${file.name}] ${line}`),
        onProgress: (snapshot) => {
          currentExtractionRatio = Number.isFinite(snapshot?.ratio) ? Math.max(0, Math.min(1, snapshot.ratio)) : 0;
          onProgress?.({ extraction: snapshot });
          pushProgress();
        }
      });

      const routeFileMeta = buildRouteFileMeta(file, phase2aResult);
      const failureReason = validateRouteFileMeta(routeFileMeta);

      if (failureReason) {
        throw new Phase2AError("FILE_TIMING_NOT_RESOLVED", failureReason);
      }

      successfulFiles.push({
        routeFileMeta,
        phase2aResult
      });

      log(
        `解析成功: ${file.name} start=${routeFileMeta.fileStartUtc || "-"} end=${routeFileMeta.fileEndUtc || "-"} source=${routeFileMeta.mappingSource} quality=${routeFileMeta.mappingQuality}`
      );
    } catch (error) {
      const errorCode = error instanceof Phase2AError ? error.code : "UNEXPECTED_ERROR";
      const errorMessage = error instanceof Phase2AError ? error.message : error?.message || String(error);

      failedFiles.push({
        fileName: file.name,
        sizeBytes: file.size,
        errorCode,
        errorMessage
      });

      log(`解析失敗: ${file.name} code=${errorCode} message=${errorMessage}`);
    }

    currentExtractionRatio = 1;
    pushProgress();
  }

  notifyStage(1, "done");
  notifyStage(2, "done");

  if (failedFiles.length > 0) {
    return {
      ok: false,
      routeLabel,
      tempRouteId,
      successfulFiles: successfulFiles.map((item) => item.routeFileMeta),
      failedFiles,
      stage: "file-analysis-failed",
      continuityToleranceSec: CONTINUITY_TOLERANCE_SEC,
      timeSourceAudit: buildTimeSourceAuditSummary(successfulFiles)
    };
  }

  notifyStage(3, "running");
  const sortedFiles = successfulFiles.map((item) => item.routeFileMeta).sort((a, b) => a.fileStartUtcMs - b.fileStartUtcMs);
  notifyStage(3, "done");
  onProgress?.({ overallProgress: 80 });

  notifyStage(4, "running");
  const continuity = buildContinuityDiagnostics(sortedFiles, CONTINUITY_TOLERANCE_SEC);
  notifyStage(4, "done");
  onProgress?.({ overallProgress: 90 });

  notifyStage(5, "running");
  const segments = buildSegments({ tempRouteId, sortedFiles, continuityLinks: continuity.links });
  notifyStage(5, "done");
  onProgress?.({ overallProgress: 96 });

  notifyStage(6, "running");
  const routeDraft = {
    routeId: tempRouteId,
    displayName: routeLabel,
    color: null,
    visible: true,
    files: sortedFiles,
    segments,
    gpsStats: {
      sampleCount: 0,
      startTime: segments[0]?.startTime || null,
      endTime: segments[segments.length - 1]?.endTime || null
    }
  };
  notifyStage(6, "done");
  onProgress?.({ overallProgress: 100 });

  return {
    ok: true,
    routeLabel,
    tempRouteId,
    routeDraft,
    files: sortedFiles,
    sortedOrder: sortedFiles.map((fileMeta, index) => ({
      order: index + 1,
      fileName: fileMeta.fileName,
      fileStartUtc: fileMeta.fileStartUtc,
      fileEndUtc: fileMeta.fileEndUtc
    })),
    continuity,
    segments,
    failedFiles,
    successfulFiles: sortedFiles,
    continuityToleranceSec: CONTINUITY_TOLERANCE_SEC,
    timeSourceAudit: buildTimeSourceAuditSummary(successfulFiles)
  };
}

function validateRouteFileMeta(fileMeta) {
  if (!fileMeta.hasGpmd) {
    return "gpmd trackが検出されませんでした";
  }
  if (fileMeta.gpsFormat === "none") {
    return "GPSフォーマットが見つかりませんでした";
  }
  if (!Number.isFinite(fileMeta.durationSec) || fileMeta.durationSec <= 0) {
    return "動画durationを取得できませんでした";
  }
  if (!fileMeta.fileStartUtc || !fileMeta.fileEndUtc) {
    return "fileStartUtc/fileEndUtcを計算できませんでした";
  }
  return null;
}

function buildRouteFileMeta(file, phase2aResult) {
  const primaryMapping = phase2aResult.timeMapping || null;
  const fallbackMapping = phase2aResult.timeMappingFallback || null;
  const mappingDecision = chooseMapping(primaryMapping, fallbackMapping);

  const durationSec = Number(phase2aResult.file?.durationSec);
  const startUtcMs = Number.isFinite(durationSec) ? mediaTimeToUtc(mappingDecision.mapping, 0) : null;
  const endUtcMs = Number.isFinite(durationSec) ? mediaTimeToUtc(mappingDecision.mapping, durationSec) : null;

  const gpsFormat = phase2aResult.gpmf?.GPS9 ? "GPS9" : phase2aResult.gpmf?.GPS5 ? "GPS5" : "none";

  return {
    fileName: file.name,
    sizeBytes: file.size,
    durationSec: Number.isFinite(durationSec) ? durationSec : null,
    creationTime: phase2aResult.file?.creationTime || null,
    fileStartUtc: toIsoOrNull(startUtcMs),
    fileEndUtc: toIsoOrNull(endUtcMs),
    fileStartUtcMs: Number.isFinite(startUtcMs) ? startUtcMs : null,
    fileEndUtcMs: Number.isFinite(endUtcMs) ? endUtcMs : null,
    hasGpmd: Boolean(phase2aResult.telemetry?.detected),
    gpsFormat,
    mappingSource: mappingDecision.mappingSource,
    mappingSourceReason: mappingDecision.mappingSourceReason,
    mappingQuality: mappingDecision.mappingQuality,
    anchorCount: numberOrNull(primaryMapping?.anchorCount ?? mappingDecision.mapping?.anchorCount),
    slopeMsPerSec: numberOrNull(mappingDecision.mapping?.slopeMsPerSec),
    interceptMs: numberOrNull(mappingDecision.mapping?.interceptMs),
    interceptIso: mappingDecision.mapping?.interceptIso || toIsoOrNull(mappingDecision.mapping?.interceptMs),
    clockDriftPpm: numberOrNull(mappingDecision.mapping?.clockDriftPpm),
    maxResidualMs: numberOrNull(mappingDecision.mapping?.maxResidualMs),
    rmsResidualMs: numberOrNull(mappingDecision.mapping?.rmsResidualMs),
    phase2aState: phase2aResult.phase2a?.state || null,
    phase2aSuccess: Boolean(phase2aResult.phase2a?.success)
  };
}

function chooseMapping(primaryMapping, fallbackMapping) {
  if (isMappingUsable(primaryMapping)) {
    return {
      mapping: primaryMapping,
      mappingSource: "gps9-valid-fix-anchors",
      mappingSourceReason: `GPS9 anchor mappingを使用 (status=${primaryMapping.status || "unknown"})`,
      mappingQuality: classifyGpsAnchorMappingQuality(primaryMapping)
    };
  }

  if (isMappingUsable(fallbackMapping)) {
    return {
      mapping: fallbackMapping,
      mappingSource: "creation-time-fallback",
      mappingSourceReason:
        "GPS9 anchor mappingが不足/不成立のため、MP4 creation_timeを基準にnominal slope(1000ms/sec)を適用",
      mappingQuality: "fallback"
    };
  }

  throw new Phase2AError("MAPPING_NOT_AVAILABLE", "media-to-UTC mappingを構築できませんでした");
}

function classifyGpsAnchorMappingQuality(mapping) {
  const anchorCount = Number(mapping?.anchorCount || 0);
  const maxResidualMs = Number(mapping?.maxResidualMs);
  const rmsResidualMs = Number(mapping?.rmsResidualMs);

  if (mapping?.status === "success") {
    if (anchorCount >= 5 && Number.isFinite(maxResidualMs) && maxResidualMs <= 120 && Number.isFinite(rmsResidualMs) && rmsResidualMs <= 80) {
      return "high";
    }
    if (anchorCount >= 3 && Number.isFinite(maxResidualMs) && maxResidualMs <= 350 && Number.isFinite(rmsResidualMs) && rmsResidualMs <= 220) {
      return "medium";
    }
    return "low";
  }

  if (mapping?.status === "limited") {
    return "low";
  }

  return "fallback";
}

function isMappingUsable(mapping) {
  return Boolean(mapping && Number.isFinite(mapping.interceptMs) && Number.isFinite(mapping.slopeMsPerSec));
}

function buildContinuityDiagnostics(sortedFiles, toleranceSec) {
  const links = [];
  const issues = [];

  for (let i = 0; i < sortedFiles.length - 1; i += 1) {
    const current = sortedFiles[i];
    const next = sortedFiles[i + 1];

    const gapSec = (next.fileStartUtcMs - current.fileEndUtcMs) / 1000;
    let relation = "real-gap";

    if (Math.abs(gapSec) <= toleranceSec) {
      relation = "continuous";
    } else if (gapSec < -toleranceSec) {
      relation = "overlap";
      issues.push({
        code: "OVERLAPPING_FILE_TIME_RANGE",
        currentFile: current.fileName,
        nextFile: next.fileName,
        currentEndUtc: current.fileEndUtc,
        nextStartUtc: next.fileStartUtc,
        gapSec
      });
    }

    links.push({
      currentFile: current.fileName,
      nextFile: next.fileName,
      currentEndUtc: current.fileEndUtc,
      nextStartUtc: next.fileStartUtc,
      gapSec,
      relation
    });
  }

  return {
    toleranceSec,
    links,
    issues
  };
}

function buildSegments({ tempRouteId, sortedFiles, continuityLinks }) {
  if (!sortedFiles.length) {
    return [];
  }

  const segments = [];
  let currentSegment = createSegment(tempRouteId, segments.length, sortedFiles[0], false);

  for (let i = 0; i < continuityLinks.length; i += 1) {
    const relation = continuityLinks[i].relation;
    const nextFile = sortedFiles[i + 1];

    if (relation === "continuous") {
      appendFileToSegment(currentSegment, nextFile);
      continue;
    }

    segments.push(currentSegment);
    currentSegment = createSegment(tempRouteId, segments.length, nextFile, true);
  }

  segments.push(currentSegment);
  return segments;
}

function createSegment(tempRouteId, index, firstFile, polylineBreakBefore) {
  return {
    segmentId: `segment-${String(index + 1).padStart(2, "0")}`,
    routeId: tempRouteId,
    startTime: firstFile.fileStartUtc,
    endTime: firstFile.fileEndUtc,
    polylineBreakBefore,
    files: [firstFile],
    gpsSamples: [],
    frames: []
  };
}

function appendFileToSegment(segment, routeFileMeta) {
  segment.files.push(routeFileMeta);
  segment.startTime = segment.files[0].fileStartUtc;
  segment.endTime = segment.files[segment.files.length - 1].fileEndUtc;
}

function buildTimeSourceAuditSummary(successfulFiles) {
  const rows = successfulFiles.map((item) => {
    const routeFileMeta = item.routeFileMeta || item;
    return {
      fileName: routeFileMeta.fileName,
      mappingSource: routeFileMeta.mappingSource,
      mappingSourceReason: routeFileMeta.mappingSourceReason,
      mappingQuality: routeFileMeta.mappingQuality
    };
  });

  return {
    note:
      "creation-time-fallbackはMP4 creation_time基準の低精度代替時刻です。GPS9 anchor mappingが利用可能な場合はprimary mappingとしてこちらが使われ、fallbackは診断情報としてのみ保持されます。",
    rows
  };
}

function toIsoOrNull(timestampMs) {
  return Number.isFinite(timestampMs) ? new Date(timestampMs).toISOString() : null;
}

function numberOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

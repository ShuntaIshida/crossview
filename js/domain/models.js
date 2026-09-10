const DEFAULT_FORMAT_VERSION = "1.0.0";
const DEFAULT_ANALYSIS_VERSION = "1.0.0";

export const ANALYSIS_STAGES = [
  "MP4情報を確認",
  "telemetry trackを探索",
  "gpmd sampleを抽出",
  "GPMFを解析",
  "GPSデータを検証"
];

export const PHASE2B_ANALYSIS_STAGES = [
  "MP4一覧を確認",
  "各MP4のGPMF/GPS9を解析",
  "各MP4のmedia-to-UTC mappingを構築",
  "absolute UTC順に整列",
  "ファイル間の連続性を判定",
  "Segmentを生成",
  "Route構造を確定"
];

export function createProject({ name, frameIntervalSec }) {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    name,
    frameIntervalSec,
    formatVersion: DEFAULT_FORMAT_VERSION,
    analysisVersion: DEFAULT_ANALYSIS_VERSION,
    createdAt: now,
    updatedAt: now,
    routes: [],
    mapSettings: {
      mapType: "monochrome"
    }
  };
}

export function createRouteSkeleton({ routeId, displayName, color }) {
  return {
    routeId,
    displayName,
    color,
    visible: true,
    files: [],
    segments: [],
    gpsStats: {
      sampleCount: 0,
      startTime: null,
      endTime: null
    }
  };
}

export function createSegmentSkeleton({ segmentId, routeId }) {
  return {
    segmentId,
    routeId,
    startTime: null,
    endTime: null,
    polylineBreakBefore: false,
    gpsSamples: [],
    frames: []
  };
}

export function createGpsSampleSkeleton({ sampleId, timestamp, lat, lng }) {
  return {
    sampleId,
    timestamp,
    lat,
    lng,
    altitudeM: null,
    speedMps: null,
    fixType: null,
    hdop: null,
    sourceInfo: null
  };
}

export function createFrameSkeleton({ frameId, timestamp, videoOffsetSec, lat, lng }) {
  return {
    frameId,
    timestamp,
    videoOffsetSec,
    lat,
    lng,
    nearestGpsSampleId: null,
    imageRef: null,
    width: null,
    height: null,
    quality: 0.8,
    clusterKey: null
  };
}

export function createAnalysisSession(routeLabel = "") {
  return {
    sessionId: crypto.randomUUID(),
    tempRouteId: `temp-${crypto.randomUUID()}`,
    routeLabel,
    status: "idle",
    startedAt: null,
    cancelRequested: false,
    error: null
  };
}

export function createProgressState(routeLabel = "", options = {}) {
  const stageLabels = Array.isArray(options.stageLabels) && options.stageLabels.length ? options.stageLabels : ANALYSIS_STAGES;
  const phase = options.phase || "phase2a";

  return {
    routeLabel,
    currentFileName: "-",
    fileIndex: 0,
    fileTotal: 0,
    currentStageLabel: stageLabels[0] || "-",
    fileProgressPercent: 0,
    successFileCount: 0,
    failedFileCount: 0,
    overallProgress: null,
    stageIndex: 0,
    webpDone: 0,
    webpTotal: 0,
    canCommitRoute: false,
    phase,
    status: "idle",
    logs: [],
    result: null,
    errorCode: null,
    errorMessage: null,
    warnings: [],
    extraction: {
      bytesRead: 0,
      totalBytes: 0,
      ratio: 0,
      chunkIndex: 0,
      fileStart: 0,
      nextFileStart: 0,
      onSamplesCalls: 0,
      extractedSamples: 0,
      expectedSamples: null,
      lastSampleDts: null
    },
    stageStateList: stageLabels.map((label, index) => ({
      label,
      index,
      state: index === 0 ? "pending" : "pending"
    }))
  };
}

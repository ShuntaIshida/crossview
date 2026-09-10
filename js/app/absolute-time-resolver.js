const NOMINAL_SLOPE_MS_PER_SEC = 1000;

export function buildTimeMapping(anchors) {
  const normalizedAnchors = normalizeAnchors(anchors);

  if (normalizedAnchors.length < 2) {
    return {
      source: "gps9-valid-fix",
      status: "insufficient-anchors",
      anchorCount: normalizedAnchors.length,
      interceptMs: null,
      interceptIso: null,
      slopeMsPerSec: null,
      clockDriftPpm: null,
      maxResidualMs: null,
      rmsResidualMs: null,
      anchorDiagnostics: normalizedAnchors.map((anchor) => ({
        ...anchor,
        predictedAbsoluteTimeMs: null,
        predictedAbsoluteTimeIso: null,
        residualMs: null
      }))
    };
  }

  const meanX = normalizedAnchors.reduce((sum, anchor) => sum + anchor.mediaTimeSec, 0) / normalizedAnchors.length;
  const meanY = normalizedAnchors.reduce((sum, anchor) => sum + anchor.gpsAbsoluteTimeMs, 0) / normalizedAnchors.length;

  let covariance = 0;
  let variance = 0;
  for (const anchor of normalizedAnchors) {
    const dx = anchor.mediaTimeSec - meanX;
    const dy = anchor.gpsAbsoluteTimeMs - meanY;
    covariance += dx * dy;
    variance += dx * dx;
  }

  if (variance === 0) {
    return {
      source: "gps9-valid-fix",
      status: "degenerate-anchors",
      anchorCount: normalizedAnchors.length,
      interceptMs: null,
      interceptIso: null,
      slopeMsPerSec: null,
      clockDriftPpm: null,
      maxResidualMs: null,
      rmsResidualMs: null,
      anchorDiagnostics: normalizedAnchors.map((anchor) => ({
        ...anchor,
        predictedAbsoluteTimeMs: null,
        predictedAbsoluteTimeIso: null,
        residualMs: null
      }))
    };
  }

  const slopeMsPerSec = covariance / variance;
  const interceptMs = meanY - slopeMsPerSec * meanX;
  const clockDriftPpm = ((slopeMsPerSec - NOMINAL_SLOPE_MS_PER_SEC) / NOMINAL_SLOPE_MS_PER_SEC) * 1_000_000;

  const anchorDiagnostics = normalizedAnchors.map((anchor) => {
    const predictedAbsoluteTimeMs = mediaTimeToUtc({ interceptMs, slopeMsPerSec }, anchor.mediaTimeSec);
    const residualMs = anchor.gpsAbsoluteTimeMs - predictedAbsoluteTimeMs;
    return {
      ...anchor,
      predictedAbsoluteTimeMs,
      predictedAbsoluteTimeIso: toIsoOrNull(predictedAbsoluteTimeMs),
      residualMs
    };
  });

  const residualSquares = anchorDiagnostics.map((anchor) => anchor.residualMs * anchor.residualMs);
  const rmsResidualMs = Math.sqrt(residualSquares.reduce((sum, value) => sum + value, 0) / residualSquares.length);
  const maxResidualMs = anchorDiagnostics.reduce((max, anchor) => Math.max(max, Math.abs(anchor.residualMs)), 0);

  return {
    source: "gps9-valid-fix",
    status: normalizedAnchors.length >= 3 ? "success" : "limited",
    anchorCount: normalizedAnchors.length,
    interceptMs,
    interceptIso: toIsoOrNull(interceptMs),
    slopeMsPerSec,
    clockDriftPpm,
    maxResidualMs,
    rmsResidualMs,
    anchorDiagnostics
  };
}

export function mediaTimeToUtc(mapping, mediaTimeSec) {
  if (!mapping || !Number.isFinite(mapping.interceptMs) || !Number.isFinite(mapping.slopeMsPerSec) || !Number.isFinite(mediaTimeSec)) {
    return null;
  }
  return mapping.interceptMs + mapping.slopeMsPerSec * mediaTimeSec;
}

export function utcToMediaTime(mapping, timestamp) {
  const timestampMs = normalizeTimestampMs(timestamp);
  if (!mapping || !Number.isFinite(mapping.interceptMs) || !Number.isFinite(mapping.slopeMsPerSec) || !Number.isFinite(timestampMs) || mapping.slopeMsPerSec === 0) {
    return null;
  }
  return (timestampMs - mapping.interceptMs) / mapping.slopeMsPerSec;
}

export function getMappingDiagnostics(mapping) {
  if (!mapping) {
    return null;
  }
  return {
    source: mapping.source,
    status: mapping.status,
    anchorCount: mapping.anchorCount,
    interceptMs: mapping.interceptMs,
    interceptIso: mapping.interceptIso,
    slopeMsPerSec: mapping.slopeMsPerSec,
    clockDriftPpm: mapping.clockDriftPpm,
    maxResidualMs: mapping.maxResidualMs,
    rmsResidualMs: mapping.rmsResidualMs,
    anchorDiagnostics: mapping.anchorDiagnostics || []
  };
}

export function buildCreationTimeFallbackMapping(creationTimeMs) {
  if (!Number.isFinite(creationTimeMs)) {
    return null;
  }

  return {
    source: "creation-time-fallback",
    status: "low-precision-fallback",
    anchorCount: 1,
    interceptMs: creationTimeMs,
    interceptIso: toIsoOrNull(creationTimeMs),
    slopeMsPerSec: NOMINAL_SLOPE_MS_PER_SEC,
    clockDriftPpm: 0,
    maxResidualMs: null,
    rmsResidualMs: null,
    anchorDiagnostics: []
  };
}

function normalizeAnchors(anchors) {
  if (!Array.isArray(anchors)) {
    return [];
  }

  return anchors
    .filter((anchor) => Number.isFinite(anchor?.mediaTimeSec) && Number.isFinite(anchor?.gpsAbsoluteTimeMs))
    .map((anchor, index) => ({
      id: anchor.id || `anchor-${index + 1}`,
      probeTimeSec: Number.isFinite(anchor.probeTimeSec) ? anchor.probeTimeSec : anchor.mediaTimeSec,
      mediaTimeSec: anchor.mediaTimeSec,
      gpsAbsoluteTimeMs: anchor.gpsAbsoluteTimeMs,
      gpsAbsoluteTimeIso: toIsoOrNull(anchor.gpsAbsoluteTimeMs),
      gpmdDtsSec: Number.isFinite(anchor.gpmdDtsSec) ? anchor.gpmdDtsSec : null,
      stmpValues: Array.isArray(anchor.stmpValues) ? anchor.stmpValues : [],
      tsmpValues: Array.isArray(anchor.tsmpValues) ? anchor.tsmpValues : [],
      metadata: anchor.metadata || null
    }));
}

function normalizeTimestampMs(timestamp) {
  if (typeof timestamp === "number") {
    return Number.isFinite(timestamp) ? timestamp : null;
  }
  if (timestamp instanceof Date) {
    const ms = timestamp.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof timestamp === "string") {
    const parsed = Date.parse(timestamp);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toIsoOrNull(timestampMs) {
  return Number.isFinite(timestampMs) ? new Date(timestampMs).toISOString() : null;
}
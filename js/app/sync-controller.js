import { clearSyncAutoPopups, clearSyncTimelineOverlays, getProjectTimelineRange, updateSyncTimelineOverlays } from "./google-maps-view.js";
import { formatAbsoluteTime } from "./time-format.js";

export function createSyncController() {
  let rootNode = null;
  let shellNode = null;
  let playButtonNode = null;
  let pauseButtonNode = null;
  let currentTimeNode = null;
  let endTimeNode = null;
  let sliderNode = null;
  let imageToggleNode = null;
  let debugNode = null;

  let currentProject = null;
  let currentMode = "async";
  let timelineRange = null;
  let currentUtcMs = null;
  let playing = false;
  let showImages = false;
  let rafHandle = null;
  let playStartPerfMs = 0;
  let playStartUtcMs = 0;
  let lastDiagnostics = null;

  function attach(rootElement) {
    rootNode = rootElement || null;
    shellNode = rootNode?.querySelector("#timelineShell") || null;
    playButtonNode = rootNode?.querySelector("#timelinePlayBtn") || null;
    pauseButtonNode = rootNode?.querySelector("#timelinePauseBtn") || null;
    currentTimeNode = rootNode?.querySelector("#timelineCurrentTime") || null;
    endTimeNode = rootNode?.querySelector("#timelineEndTime") || null;
    sliderNode = rootNode?.querySelector("#timelineTrack") || null;
    imageToggleNode = rootNode?.querySelector("#timelineImageToggle") || null;
    debugNode = rootNode?.querySelector("#timelineDebug") || null;
    syncTimelineUi();
  }

  function syncFromState(state) {
    currentProject = state?.project || null;
    const nextMode = state?.mode || "async";
    const modeChanged = nextMode !== currentMode;
    currentMode = nextMode;

    const nextRange = getProjectTimelineRange(currentProject);
    const rangeChanged = !areRangesEqual(timelineRange, nextRange);
    timelineRange = nextRange;

    if (currentMode !== "sync") {
      if (playing) {
        stopPlayback();
      }
      showImages = false;
      clearSyncAutoPopups("mode-change");
      clearSyncTimelineOverlays();
      lastDiagnostics = null;
      syncTimelineUi();
      return;
    }

    if (modeChanged) {
      playing = false;
      showImages = false;
      currentUtcMs = timelineRange?.startUtcMs ?? null;
      stopPlayback();
    } else if (currentUtcMs == null && timelineRange) {
      currentUtcMs = timelineRange.startUtcMs;
    } else if (rangeChanged && timelineRange && Number.isFinite(currentUtcMs)) {
      currentUtcMs = clampNumber(currentUtcMs, timelineRange.startUtcMs, timelineRange.endUtcMs);
      if (playing) {
        playStartPerfMs = performance.now();
        playStartUtcMs = currentUtcMs;
      }
    }

    if (timelineRange && currentUtcMs == null) {
      currentUtcMs = timelineRange.startUtcMs;
    }

    syncTimelineUi();
    pushSyncFrame(true, modeChanged ? "mode-change" : "state-sync");
  }

  function reset() {
    stopPlayback();
    clearSyncTimelineOverlays();
    lastDiagnostics = null;
    currentProject = null;
    currentMode = "async";
    timelineRange = null;
    currentUtcMs = null;
    playing = false;
    showImages = false;
    syncTimelineUi();
  }

  function play() {
    if (currentMode !== "sync" || !timelineRange) {
      return;
    }
    if (playing) {
      return;
    }
    if (!Number.isFinite(currentUtcMs)) {
      currentUtcMs = timelineRange.startUtcMs;
    }
    currentUtcMs = clampNumber(currentUtcMs, timelineRange.startUtcMs, timelineRange.endUtcMs);
    playing = true;
    playStartPerfMs = performance.now();
    playStartUtcMs = currentUtcMs;
    ensurePlaybackLoop();
    syncTimelineUi();
    pushSyncFrame(true, "start-playback");
  }

  function pause() {
    if (!playing) {
      return;
    }
    updateCurrentUtcFromClock();
    playing = false;
    stopPlayback();
    syncTimelineUi();
    pushSyncFrame(true, "pause");
  }

  function seek(nextUtcMs) {
    if (currentMode !== "sync" || !timelineRange || !Number.isFinite(nextUtcMs)) {
      return;
    }
    currentUtcMs = clampNumber(nextUtcMs, timelineRange.startUtcMs, timelineRange.endUtcMs);
    if (playing) {
      playStartPerfMs = performance.now();
      playStartUtcMs = currentUtcMs;
    }
    syncTimelineUi();
    pushSyncFrame(true, "seek");
  }

  function toggleImages(nextValue) {
    showImages = Boolean(nextValue);
    console.log("[SyncImage] toggle", showImages);
    if (!showImages) {
      const clearedCount = clearSyncAutoPopups("image-toggle-off");
      console.log("[SyncImage] cleared", clearedCount);
      currentUtcMs = Number.isFinite(currentUtcMs) ? currentUtcMs : timelineRange?.startUtcMs ?? null;
    }
    syncTimelineUi();
    pushSyncFrame(true, "toggle-images");
  }

  function getDiagnostics() {
    return lastDiagnostics;
  }

  function ensurePlaybackLoop() {
    if (rafHandle != null) {
      return;
    }
    rafHandle = requestAnimationFrame(stepPlayback);
  }

  function stopPlayback() {
    if (rafHandle != null) {
      cancelAnimationFrame(rafHandle);
      rafHandle = null;
    }
  }

  function stepPlayback(nowMs) {
    rafHandle = null;
    if (!playing || currentMode !== "sync" || !timelineRange) {
      return;
    }

    const nextUtcMs = playStartUtcMs + (nowMs - playStartPerfMs);
    currentUtcMs = clampNumber(nextUtcMs, timelineRange.startUtcMs, timelineRange.endUtcMs);
    syncTimelineUi();
    pushSyncFrame(false, "playback");

    if (currentUtcMs >= timelineRange.endUtcMs) {
      playing = false;
      stopPlayback();
      syncTimelineUi();
      pushSyncFrame(true, "end-of-timeline");
      return;
    }

    ensurePlaybackLoop();
  }

  function updateCurrentUtcFromClock() {
    if (!playing || !timelineRange) {
      return;
    }
    const elapsedMs = performance.now() - playStartPerfMs;
    currentUtcMs = clampNumber(playStartUtcMs + elapsedMs, timelineRange.startUtcMs, timelineRange.endUtcMs);
  }

  function pushSyncFrame(force = false, updateReason = "playback") {
    if (currentMode !== "sync") {
      clearSyncTimelineOverlays();
      lastDiagnostics = null;
      return;
    }

    console.log("[SyncMarker] frame", {
      currentUtc: formatAbsoluteTime(currentUtcMs),
      playing,
      imageDisplayEnabled: showImages,
      isManualSeek: updateReason === "seek"
    });

    const diagnostics = updateSyncTimelineOverlays(currentProject, {
      currentUtcMs,
      playing,
      showImages,
      timelineStartUtcMs: timelineRange?.startUtcMs ?? null,
      timelineEndUtcMs: timelineRange?.endUtcMs ?? null,
      frameIntervalSec: currentProject?.frameIntervalSec ?? null,
      performanceNowMs: performance.now(),
      updateReason
    });

    if (!force && diagnostics && lastDiagnostics) {
      const nextSignature = buildDiagnosticsSignature(diagnostics);
      const previousSignature = buildDiagnosticsSignature(lastDiagnostics);
      if (nextSignature === previousSignature) {
        return;
      }
    }

    lastDiagnostics = diagnostics;
    updateDebugPanel(diagnostics);
  }

  function syncTimelineUi() {
    if (shellNode) {
      shellNode.hidden = currentMode !== "sync";
    }

    const hasRange = Boolean(timelineRange);
    const currentText = formatTimelineInstant(currentUtcMs);
    const endText = formatTimelineInstant(timelineRange?.endUtcMs ?? null);

    if (playButtonNode) {
      playButtonNode.disabled = !hasRange || playing;
    }
    if (pauseButtonNode) {
      pauseButtonNode.disabled = !hasRange || !playing;
    }
    if (currentTimeNode) {
      currentTimeNode.textContent = `現在時刻: ${currentText}`;
    }
    if (endTimeNode) {
      endTimeNode.textContent = `終了時刻: ${endText}`;
    }
    if (sliderNode) {
      sliderNode.disabled = !hasRange;
      sliderNode.min = String(timelineRange?.startUtcMs ?? 0);
      sliderNode.max = String(timelineRange?.endUtcMs ?? 0);
      sliderNode.step = "1000";
      sliderNode.value = String(Number.isFinite(currentUtcMs) ? currentUtcMs : timelineRange?.startUtcMs ?? 0);
    }
    if (imageToggleNode) {
      imageToggleNode.checked = showImages;
      imageToggleNode.disabled = !hasRange;
    }
  }

  function updateDebugPanel(diagnostics) {
    if (!debugNode) {
      return;
    }

    debugNode.textContent = buildDebugText(diagnostics);
  }

  function onSliderInput(value) {
    const nextUtcMs = Number(value);
    seek(nextUtcMs);
  }

  function areRangesEqual(left, right) {
    return Boolean(left && right && left.startUtcMs === right.startUtcMs && left.endUtcMs === right.endUtcMs);
  }

  function buildDiagnosticsSignature(diagnostics) {
    if (!diagnostics) {
      return "no-diagnostics";
    }

    return [
      diagnostics.timelineStartUtcMs ?? "-",
      diagnostics.timelineEndUtcMs ?? "-",
      diagnostics.currentUtcMs ?? "-",
      diagnostics.playing ? "1" : "0",
      diagnostics.visibleRouteCount ?? 0,
      diagnostics.activeRouteCount ?? 0,
      diagnostics.currentMarkerCount ?? 0,
      diagnostics.syncPopupCount ?? 0,
      (diagnostics.routeDiagnostics || [])
        .map((route) => `${route.routeId}:${route.activeSegmentId || "-"}:${route.gpsInterpolationStatus || "-"}:${route.currentMarkerVisible ? 1 : 0}:${route.syncPopupVisible ? 1 : 0}`)
        .join("|")
    ].join(";");
  }

  function buildDebugText(diagnostics) {
    if (!diagnostics) {
      return [
        `timelineStartUtc=${formatDebugValue(null)}`,
        `timelineEndUtc=${formatDebugValue(null)}`,
        `currentUtc=${formatDebugValue(null)}`,
        `playing=${playing}`,
        "visibleRouteCount=0",
        "activeRouteCount=0",
        "currentMarkerCount=0",
        "syncPopupCount=0",
        "routes=-"
      ].join("\n");
    }

    const routeLines = (diagnostics.routeDiagnostics || []).map((route) => {
      return `${route.routeId || "route"}: activeSegmentId=${route.activeSegmentId || "-"} gps=${route.gpsInterpolationStatus || "-"} marker=${route.currentMarkerVisible ? "on" : "off"} popup=${route.syncPopupVisible ? "on" : "off"}`;
    });

    return [
      `timelineStartUtc=${formatDebugValue(diagnostics.timelineStartUtcMs)}`,
      `timelineEndUtc=${formatDebugValue(diagnostics.timelineEndUtcMs)}`,
      `currentUtc=${formatDebugValue(diagnostics.currentUtcMs)}`,
      `playing=${Boolean(diagnostics.playing)}`,
      `visibleRouteCount=${diagnostics.visibleRouteCount ?? 0}`,
      `activeRouteCount=${diagnostics.activeRouteCount ?? 0}`,
      `currentMarkerCount=${diagnostics.currentMarkerCount ?? 0}`,
      `syncPopupCount=${diagnostics.syncPopupCount ?? 0}`,
      `routes=${routeLines.length ? "" : "-"}`,
      ...routeLines
    ].join("\n");
  }

  function formatDebugValue(value) {
    return formatAbsoluteTime(value);
  }

  function formatTimelineInstant(value) {
    return formatAbsoluteTime(value);
  }

  return {
    attach,
    syncFromState,
    reset,
    play,
    pause,
    seek,
    toggleImages,
    onSliderInput,
    getDiagnostics,
    getState() {
      return {
        currentMode,
        currentUtcMs,
        playing,
        showImages,
        timelineRange
      };
    }
  };
}

function clampNumber(value, minValue, maxValue) {
  return Math.min(Math.max(value, minValue), maxValue);
}

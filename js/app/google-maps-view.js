import { formatAbsoluteTime } from "./time-format.js";

const GOOGLE_MAPS_API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY || "";
const GOOGLE_MAPS_MAP_ID = import.meta.env.VITE_GOOGLE_MAPS_MAP_ID || "";
const CLUSTER_DISTANCE_METERS = 5;

const MONOCHROME_STYLE = [
  { elementType: "geometry", stylers: [{ color: "#e6e6e2" }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#5f5f5a" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#f8f8f4" }] },
  { featureType: "administrative", elementType: "geometry", stylers: [{ color: "#b7b7b1" }] },
  { featureType: "poi", elementType: "geometry", stylers: [{ color: "#d9d9d3" }] },
  { featureType: "road", elementType: "geometry", stylers: [{ color: "#cfcfc7" }] },
  { featureType: "road.highway", elementType: "geometry", stylers: [{ color: "#b8b8b0" }] },
  { featureType: "transit", elementType: "geometry", stylers: [{ color: "#d0d0cb" }] },
  { featureType: "water", elementType: "geometry", stylers: [{ color: "#b8c2bf" }] }
];

let mapsApiPromise = null;
let activeMap = null;
let activeCanvas = null;
let activeProject = null;
let activeRenderToken = 0;
let rememberedView = null;
let activeRouteOverlays = [];
let popupSequence = 0;
const popupRegistry = new Map();
const syncMarkerRegistry = new Map();
const syncPopupRegistry = new Map();
const syncRouteRuntimeCache = new Map();
const syncDebugLogThrottle = new Map();
const syncDebugRouteSnapshotLogged = new Set();
let mapInitCount = 0;
let scriptInsertCount = 0;
let mapSyncCount = 0;

export function syncGoogleMapView(surfaceElement, project, options = {}) {
  mapSyncCount += 1;
  const canvasElement = surfaceElement?.querySelector("#mapCanvas");
  const statusElement = surfaceElement?.querySelector("#mapStatus");
  if (!surfaceElement || !canvasElement || !statusElement) {
    return;
  }

  activeProject = project || null;
  const renderToken = ++activeRenderToken;

  if (!project) {
    clearGoogleMapView(statusElement, "プロジェクトがありません");
    return;
  }

  if (!GOOGLE_MAPS_API_KEY) {
    clearGoogleMapView(statusElement, "Google Maps API key が未設定です");
    return;
  }

  statusElement.textContent = "Google Maps を読み込み中...";
  loadGoogleMapsApi()
    .then(() => {
      if (renderToken !== activeRenderToken) {
        return;
      }

      const google = window.google;
      if (!google?.maps) {
        throw new Error("Google Maps JavaScript API を初期化できませんでした");
      }

      const isNewCanvas = !activeMap || activeCanvas !== canvasElement;
      if (isNewCanvas) {
        const initialView = rememberedView || getDefaultView(project);
        activeCanvas = canvasElement;
        activeMap = new google.maps.Map(canvasElement, {
          center: initialView.center,
          zoom: initialView.zoom,
          mapTypeId: getGoogleMapType(project?.mapSettings?.mapType),
          disableDefaultUI: true,
          clickableIcons: false,
          gestureHandling: "greedy",
          styles: project?.mapSettings?.mapType === "monochrome" ? MONOCHROME_STYLE : null,
          ...(GOOGLE_MAPS_MAP_ID ? { mapId: GOOGLE_MAPS_MAP_ID } : {})
        });
        mapInitCount += 1;
        console.info("[GoogleMaps] map initialized", { mapInitCount, mapSyncCount });
        activeMap.addListener("zoom_changed", () => {
          applyPopupZoomScale(activeMap?.getZoom());
        });
      }

      try {
        applyMapStyle(activeMap, project?.mapSettings?.mapType || "monochrome");
        logRenderDiagnostics(project, activeMap);
        renderGoogleMapOverlays(activeMap, project, google, {
          fitBounds: options.fitBounds ?? isNewCanvas
        });
        refreshOpenPopups(project, options.interactionMode || "async");
      } catch (error) {
        console.error("[GoogleMaps] render pipeline failed", {
          routeId: null,
          segmentId: null,
          fileName: null,
          error
        });
        statusElement.textContent = "地図描画中に一部データをスキップしました";
      }
      statusElement.textContent = project.routes?.length ? "" : "表示可能なRouteがありません";
    })
    .catch((error) => {
      clearGoogleMapView(statusElement, error?.message || "Google Mapsの読み込みに失敗しました");
    });
}

export function fitVisibleRoutesToMap() {
  if (!activeMap || !activeProject) {
    return;
  }

  const bounds = buildVisibleRouteBounds(activeProject, window.google?.maps);
  if (!bounds) {
    return;
  }

  activeMap.fitBounds(bounds, 48);
}

export function getProjectTimelineRange(project) {
  const routes = Array.isArray(project?.routes) ? project.routes : [];
  let startUtcMs = null;
  let endUtcMs = null;

  for (const route of routes) {
    for (const file of route?.files || []) {
      startUtcMs = updateMinTimelineMs(startUtcMs, file?.fileStartUtcMs);
      endUtcMs = updateMaxTimelineMs(endUtcMs, file?.fileEndUtcMs);
    }

    for (const segment of route?.segments || []) {
      startUtcMs = updateMinTimelineMs(startUtcMs, normalizeTimelineMs(segment?.startTime));
      endUtcMs = updateMaxTimelineMs(endUtcMs, normalizeTimelineMs(segment?.endTime));

      for (const file of segment?.files || []) {
        startUtcMs = updateMinTimelineMs(startUtcMs, file?.fileStartUtcMs);
        endUtcMs = updateMaxTimelineMs(endUtcMs, file?.fileEndUtcMs);
      }
    }
  }

  if (!Number.isFinite(startUtcMs) || !Number.isFinite(endUtcMs)) {
    return null;
  }

  return { startUtcMs, endUtcMs };
}

export function updateSyncTimelineOverlays(project, syncState = {}) {
  if (!activeMap || !window.google?.maps) {
    clearSyncTimelineOverlays();
    return buildEmptySyncDiagnostics(syncState);
  }

  const google = window.google;
  const currentUtcMs = normalizeTimelineMs(syncState.currentUtcMs);
  const performanceNowMs = Number.isFinite(syncState.performanceNowMs) ? syncState.performanceNowMs : performance.now();
  const updateReason = syncState.updateReason || "playback";
  const showImages = syncState.showImages === true;
  const webpMatchToleranceMs = Number.isFinite(syncState.webpMatchToleranceMs)
    ? syncState.webpMatchToleranceMs
    : Number.isFinite(syncState.frameIntervalSec)
      ? Math.max(500, (syncState.frameIntervalSec * 1000) / 2)
      : 5000;
  const gpsInterpolationGapLimitMs = Number.isFinite(syncState.gpsInterpolationGapLimitMs)
    ? syncState.gpsInterpolationGapLimitMs
    : Number.isFinite(syncState.frameIntervalSec)
      ? Math.min(120000, Math.max(10000, syncState.frameIntervalSec * 1000 * 12))
      : 60000;

  const projectRouteIds = new Set();
  const routeDiagnostics = [];
  let visibleRouteCount = 0;
  let activeRouteCount = 0;
  let currentMarkerCount = 0;
  let syncPopupCount = 0;

  console.log("[SyncMarker] updateSyncTimelineOverlays", {
    currentUtc: formatAbsoluteTime(currentUtcMs),
    playing: Boolean(syncState.playing),
    imageDisplayEnabled: showImages,
    isManualSeek: syncState.updateReason === "seek",
    routeCount: Array.isArray(project?.routes) ? project.routes.length : 0
  });

  for (const route of Array.isArray(project?.routes) ? project.routes : []) {
    const routeId = route?.routeId || null;
    if (!routeId) {
      continue;
    }

    projectRouteIds.add(routeId);
    const routeVisible = route?.visible !== false;
    if (routeVisible) {
      visibleRouteCount += 1;
    }

    const runtime = getSyncRouteRuntime(route);
    const evaluation = evaluateSyncRouteRuntime(runtime, currentUtcMs, webpMatchToleranceMs, gpsInterpolationGapLimitMs);
    const markerEntry = syncMarkerRegistry.get(routeId) || null;
    const popupEntry = syncPopupRegistry.get(routeId) || null;
    const markerPosition = routeVisible ? evaluation.markerPosition : null;
    const shouldShowMarker = routeVisible && Boolean(markerPosition);

    throttleDebugLog(`route:${routeId}:state`, 1000, () => {
      console.log("[SyncMarker] update", {
        routeId,
        currentUtc: formatAbsoluteTime(currentUtcMs),
        segmentId: evaluation.activeSegmentId,
        interpolationStatus: evaluation.gpsInterpolationStatus,
        lat: markerPosition?.lat ?? null,
        lng: markerPosition?.lng ?? null,
        visible: shouldShowMarker
      });
    });

    if (shouldShowMarker) {
      activeRouteCount += 1;
      currentMarkerCount += 1;

      const marker = markerEntry?.marker || createSyncCurrentMarker(google, route.color || "#2563eb");
      marker.setMap(activeMap);
      marker.setVisible(true);
      marker.setPosition(markerPosition);
      marker.setZIndex(3000 + (runtime.segments.length || 0));
      marker.setOptions?.({ optimized: false });
      syncMarkerRegistry.set(routeId, { marker });

      if (!markerEntry?.marker) {
        console.log("[SyncMarker] CREATED", { routeId, lat: markerPosition.lat, lng: markerPosition.lng });
      } else {
        throttleDebugLog(`route:${routeId}:moved`, 1000, () => {
          console.log("[SyncMarker] MOVED", {
            routeId,
            lat: markerPosition.lat,
            lng: markerPosition.lng,
            currentUtc: formatAbsoluteTime(currentUtcMs)
          });
        });
      }
    } else if (markerEntry?.marker) {
      const hiddenReason = evaluation.activeSegmentId == null
        ? "inactive"
        : evaluation.gpsInterpolationStatus === "segment-gap" ? "gap"
          : evaluation.gpsInterpolationStatus === "visibility-off" ? "visibility-off"
            : evaluation.gpsInterpolationStatus === "gps-gap-too-large" || evaluation.gpsInterpolationStatus === "no-gps-samples" || evaluation.gpsInterpolationStatus === "outside-gps-range" ? "no-gps"
              : "invalid-interpolation";
      markerEntry.marker.setVisible(false);
      console.log("[SyncMarker] hidden", { routeId, reason: hiddenReason });
    }

    const currentFrame = evaluation.currentFrame || null;
    const currentFramePosition = createSyncPopupPosition(currentFrame, markerPosition);
    const shouldShowPopup = showImages && routeVisible && Boolean(currentFrame && currentFramePosition);
    if (routeId === "route-01") {
      logSyncRouteSnapshotOnce(route, runtime, currentUtcMs);
      throttleDebugLog(`route:${routeId}:search`, 1000, () => {
        console.log("[SyncDebug] segment search", {
          currentUtcMs,
          segments: evaluation.debug?.segmentSearchRows || []
        });
        console.log("[SyncDebug] GPS search", evaluation.debug?.gpsSearch || null);
        console.log("[SyncDebug] WebP search", evaluation.debug?.webpSearch || null);
      });
    }
    if (showImages) {
      throttleDebugLog(`route:${routeId}:candidate`, 500, () => {
        console.log("[SyncImage] candidate", {
          routeId,
          currentUtc: formatAbsoluteTime(currentUtcMs),
          frameId: currentFrame?.id || null,
          frameUtc: formatAbsoluteTime(currentFrame?.absoluteUtc),
          deltaMs: currentFrame ? Math.abs((normalizeTimelineMs(currentFrame.absoluteUtc) || 0) - (currentUtcMs || 0)) : null
        });
      });
    }
    if (shouldShowPopup) {
      syncPopupCount += 1;
      if (!popupEntry?.popup) {
        const popup = createSyncPopupOverlay({
          google,
          map: activeMap,
          position: currentFramePosition,
          routeColor: route.color || "#2563eb",
          item: currentFrame,
          routeId,
          onClose: () => {
            syncPopupRegistry.delete(routeId);
          }
        });
        syncPopupRegistry.set(routeId, {
          popup,
          popupType: "sync-auto",
          popupSource: "sync-auto",
          currentFrameId: currentFrame.id,
          lastDisplayedFrameId: currentFrame.id,
          displayStartedAtPerformanceMs: performanceNowMs,
          currentFramePosition,
          routeColor: route.color || "#2563eb"
        });
        console.log("[SyncImage] popup created", { routeId, frameId: currentFrame.id });
      } else {
        const popup = popupEntry.popup;
        const candidateFrameId = currentFrame.id;
        const displayedFrameId = popupEntry.lastDisplayedFrameId || popupEntry.currentFrameId || null;
        const elapsedMs = performanceNowMs - (popupEntry.displayStartedAtPerformanceMs || 0);
        const manualUpdate = updateReason === "seek" || updateReason === "toggle-images";
        const shouldAdvanceFrame = manualUpdate || displayedFrameId == null || displayedFrameId === candidateFrameId || elapsedMs >= 5000;

        if (displayedFrameId !== candidateFrameId && shouldAdvanceFrame) {
          popup.setFrame?.(currentFrame, currentFramePosition);
          popup.setPosition(currentFramePosition);
          popupEntry.currentFrameId = candidateFrameId;
          popupEntry.lastDisplayedFrameId = candidateFrameId;
          popupEntry.displayStartedAtPerformanceMs = performanceNowMs;
          popupEntry.currentFramePosition = currentFramePosition;
          console.log("[SyncImage] popup changed", {
            routeId,
            fromFrameId: displayedFrameId,
            toFrameId: candidateFrameId,
            heldMs: elapsedMs
          });
        } else if (displayedFrameId !== candidateFrameId) {
          console.log("[SyncImage] hold", {
            routeId,
            frameId: displayedFrameId,
            elapsedMs
          });
        } else if (displayedFrameId === candidateFrameId) {
          popup.setPosition(currentFramePosition);
        }
      }
    } else if (popupEntry?.popup) {
      popupEntry.popup.close(showImages ? "sync-off" : "image-display-off");
      console.log("[SyncImage] popup removed", {
        routeId,
        reason: showImages ? "sync-off" : "image-display-off"
      });
      popupEntry.lastDisplayedFrameId = null;
      popupEntry.displayStartedAtPerformanceMs = null;
      popupEntry.currentFrameId = null;
      popupEntry.currentFramePosition = null;
      syncPopupRegistry.delete(routeId);
    }

    routeDiagnostics.push({
      routeId,
      visible: routeVisible,
      activeSegmentId: evaluation.activeSegmentId,
      gpsInterpolationStatus: evaluation.gpsInterpolationStatus,
      currentMarkerVisible: shouldShowMarker,
      currentMarkerPosition: shouldShowMarker ? markerPosition : null,
      currentFrameId: currentFrame?.id || null,
      currentFramePosition,
      syncPopupVisible: shouldShowPopup
    });
  }

  for (const [routeId, entry] of syncMarkerRegistry.entries()) {
    if (!projectRouteIds.has(routeId)) {
      entry.marker.setMap(null);
      syncMarkerRegistry.delete(routeId);
    }
  }

  for (const [routeId, entry] of syncPopupRegistry.entries()) {
    if (!projectRouteIds.has(routeId)) {
      entry.popup.close("destroy");
      syncPopupRegistry.delete(routeId);
    }
  }

  return {
    timelineStartUtcMs: Number.isFinite(syncState.timelineStartUtcMs) ? syncState.timelineStartUtcMs : null,
    timelineEndUtcMs: Number.isFinite(syncState.timelineEndUtcMs) ? syncState.timelineEndUtcMs : null,
    currentUtcMs: Number.isFinite(currentUtcMs) ? currentUtcMs : null,
    playing: Boolean(syncState.playing),
    visibleRouteCount,
    activeRouteCount,
    currentMarkerCount,
    syncPopupCount,
    routeDiagnostics
  };
}

export function clearSyncTimelineOverlays() {
  for (const entry of syncMarkerRegistry.values()) {
    entry.marker.setMap(null);
  }
  syncMarkerRegistry.clear();

  clearSyncAutoPopups("destroy");
  syncRouteRuntimeCache.clear();
}

export function clearSyncAutoPopups(reason = "sync-off") {
  let clearedCount = 0;
  for (const [routeId, entry] of syncPopupRegistry.entries()) {
    console.log("[SyncImage] popup removed", {
      routeId,
      reason
    });
    entry.popup.close(reason);
    syncPopupRegistry.delete(routeId);
    clearedCount += 1;
  }
  return clearedCount;
}

export function rememberGoogleMapView() {
  if (!activeMap || !window.google?.maps) {
    return;
  }

  const center = activeMap.getCenter();
  if (!center) {
    return;
  }

  rememberedView = {
    center: { lat: center.lat(), lng: center.lng() },
    zoom: activeMap.getZoom() || 6
  };
}

export function destroyGoogleMapView() {
  rememberGoogleMapView();
  closeAllPopups();
  clearRouteOverlays();
  activeMap = null;
  activeCanvas = null;
  activeProject = null;
}

function loadGoogleMapsApi() {
  if (window.google?.maps) {
    return Promise.resolve(window.google);
  }

  if (mapsApiPromise) {
    return mapsApiPromise;
  }

  mapsApiPromise = new Promise((resolve, reject) => {
    const scriptId = "crossview-google-maps-js";
    const existingScript = document.getElementById(scriptId);
    if (existingScript) {
      existingScript.addEventListener("load", () => resolve(window.google));
      existingScript.addEventListener("error", () => reject(new Error("Google Maps script の読み込みに失敗しました")));
      return;
    }

    const script = document.createElement("script");
    script.id = scriptId;
    script.async = true;
    script.defer = true;
    script.src = buildGoogleMapsScriptUrl();
    scriptInsertCount += 1;
    console.info("[GoogleMaps] script inserted", { scriptInsertCount });
    script.onerror = () => reject(new Error("Google Maps script の読み込みに失敗しました"));
    window.__crossviewGoogleMapsInit = () => resolve(window.google);
    document.head.append(script);
  });

  return mapsApiPromise;
}

function buildGoogleMapsScriptUrl() {
  const params = new URLSearchParams({
    key: GOOGLE_MAPS_API_KEY,
    callback: "__crossviewGoogleMapsInit",
    v: "weekly"
  });

  return `https://maps.googleapis.com/maps/api/js?${params.toString()}`;
}

function renderGoogleMapOverlays(map, project, google, options) {
  const previousOverlays = activeRouteOverlays;
  const nextOverlays = [];
  const interactionMode = options?.interactionMode || "async";

  const routes = Array.isArray(project?.routes) ? project.routes.filter((route) => route?.visible !== false) : [];
  const bounds = new google.maps.LatLngBounds();
  let hasAnyPoint = false;

  for (const route of routes) {
    try {
      const routeBounds = renderRouteOverlays(map, route, google, bounds, nextOverlays, interactionMode);
      hasAnyPoint = hasAnyPoint || routeBounds;
    } catch (error) {
      console.error("[GoogleMaps] route render failed", {
        routeId: route?.routeId || null,
        segmentId: null,
        fileName: route?.files?.[0]?.fileName || null,
        error
      });
    }
  }

  if (hasAnyPoint) {
    if (options.fitBounds !== false) {
      map.fitBounds(bounds, 48);
    }
  }

  clearRouteOverlays(previousOverlays);
  activeRouteOverlays = nextOverlays;
}

function renderRouteOverlays(map, route, google, bounds, overlaySink, interactionMode) {
  let hasPoint = false;

  for (const segment of route.segments || []) {
    try {
      const polylinePath = buildSegmentPolylinePath(segment, google, route.routeId);
      if (polylinePath.length >= 2) {
        const polyline = new google.maps.Polyline({
          map,
          path: polylinePath,
          strokeColor: route.color || "#2563eb",
          strokeOpacity: 0.95,
          strokeWeight: 4,
          clickable: false,
          geodesic: true
        });
        overlaySink.push(polyline);
        for (const point of polylinePath) {
          bounds.extend(point);
          hasPoint = true;
        }
      }
    } catch (error) {
      console.error("[GoogleMaps] segment polyline render failed", {
        routeId: route.routeId,
        segmentId: segment?.segmentId || null,
        fileName: segment?.files?.[0]?.fileName || null,
        error
      });
    }
  }

  const webpFrames = collectVisibleWebpFrames(route);
  const clusters = clusterFramesByDistance(webpFrames, CLUSTER_DISTANCE_METERS);

  for (const cluster of clusters) {
    const markerPosition = cluster.position;
    if (!markerPosition) {
      continue;
    }

    try {
      const marker = new google.maps.Marker({
        map,
        position: markerPosition,
        clickable: interactionMode === "async",
        zIndex: 1000 + cluster.frames.length,
        title: cluster.frames.length > 1 ? `WebP cluster (${cluster.frames.length})` : "WebP point",
        icon: cluster.frames.length > 1 ? createClusterMarkerIcon(route.color || "#2563eb", cluster.frames.length) : createPointMarkerIcon(route.color || "#2563eb")
      });

      if (interactionMode === "async") {
        marker.addListener("click", () => {
          openWebpPopup({
            google,
            map,
            routeId: route.routeId,
            routeColor: route.color || "#2563eb",
            position: markerPosition,
            items: cluster.frames
          });
        });
      }

      overlaySink.push(marker);
      bounds.extend(markerPosition);
      hasPoint = true;
    } catch (error) {
      console.error("[GoogleMaps] webp marker render failed", {
        routeId: route.routeId,
        segmentId: cluster.frames?.[0]?.segmentId || null,
        fileName: cluster.frames?.[0]?.sourceFileName || null,
        error
      });
    }
  }

  return hasPoint;
}

function buildSegmentPolylinePath(segment, google, routeId) {
  return (segment?.gpsSamples || [])
    .filter((sample) => {
      const valid = Number.isFinite(sample?.lat) && Number.isFinite(sample?.lng);
      if (!valid) {
        console.error("[GoogleMaps] invalid segment gps sample skipped", {
          routeId,
          segmentId: segment?.segmentId || null,
          fileName: sample?.sourceFileName || segment?.files?.[0]?.fileName || null,
          sampleId: sample?.sampleId || null,
          sample
        });
      }
      return valid;
    })
    .sort((a, b) => a.gpsTimestampMs - b.gpsTimestampMs || String(a.sampleId).localeCompare(String(b.sampleId)))
    .map((sample) => new google.maps.LatLng(sample.lat, sample.lng));
}

function collectVisibleWebpFrames(route) {
  const frames = [];

  for (const segment of route.segments || []) {
    for (const frame of segment.frames || []) {
      if (frame.gpsStatus === "matched" && Number.isFinite(frame.lat) && Number.isFinite(frame.lng)) {
        frames.push({
          ...frame,
          routeId: route.routeId,
          routeColor: route.color || "#2563eb",
          segmentId: segment.segmentId
        });
      } else if (frame.gpsStatus === "matched") {
        console.error("[GoogleMaps] invalid webp point skipped", {
          routeId: route.routeId,
          segmentId: segment?.segmentId || null,
          fileName: frame?.sourceFileName || segment?.files?.[0]?.fileName || null,
          frameId: frame?.id || null,
          frame
        });
      }
    }
  }

  return frames.sort((a, b) => compareTimelineMs(a.absoluteUtc, b.absoluteUtc) || compareTimelineMs(a.gpsTimestamp, b.gpsTimestamp) || String(a.id).localeCompare(String(b.id)));
}

function clusterFramesByDistance(frames, maxDistanceMeters) {
  const ordered = (Array.isArray(frames) ? frames : []).slice().sort((a, b) => compareTimelineMs(a.absoluteUtc, b.absoluteUtc) || String(a.id).localeCompare(String(b.id)));
  const clusters = [];

  for (const frame of ordered) {
    const position = toLatLngLiteral(frame);
    if (!position) {
      continue;
    }

    const lastCluster = clusters[clusters.length - 1];
    if (!lastCluster) {
      clusters.push(createCluster(frame));
      continue;
    }

    const distanceToCentroid = distanceMeters(position, lastCluster.centroid);
    const distanceToLast = distanceMeters(position, lastCluster.lastPosition);

    if (distanceToCentroid <= maxDistanceMeters && distanceToLast <= maxDistanceMeters) {
      lastCluster.frames.push(frame);
      lastCluster.totalLat += position.lat;
      lastCluster.totalLng += position.lng;
      lastCluster.centroid = {
        lat: lastCluster.totalLat / lastCluster.frames.length,
        lng: lastCluster.totalLng / lastCluster.frames.length
      };
      lastCluster.lastPosition = position;
      continue;
    }

    clusters.push(createCluster(frame));
  }

  return clusters.map((cluster) => ({
    frames: cluster.frames.sort((a, b) => compareTimelineMs(a.absoluteUtc, b.absoluteUtc) || String(a.id).localeCompare(String(b.id))),
    position: cluster.centroid
  }));
}

function createCluster(frame) {
  const position = toLatLngLiteral(frame);
  return {
    frames: [frame],
    totalLat: position.lat,
    totalLng: position.lng,
    centroid: position,
    lastPosition: position
  };
}

function openWebpPopup({ google, map, routeId, routeColor, position, items }) {
  const normalizedItems = (Array.isArray(items) ? items : [])
    .filter((item) => item?.blob)
    .map((item) => ({ ...item }))
    .sort((a, b) => compareTimelineMs(a.absoluteUtc, b.absoluteUtc) || String(a.id).localeCompare(String(b.id)));

  if (!normalizedItems.length) {
    return null;
  }

  const popupId = ++popupSequence;
  const popupState = {
    popupId,
    popupType: "async",
    popupSource: "manual",
    routeId,
    anchorLat: Number(position?.lat),
    anchorLng: Number(position?.lng),
    frameIds: normalizedItems.map((item) => item.id).filter(Boolean),
    currentIndex: 0,
    isFixed: false,
    isOpen: true,
    hiddenByVisibility: false
  };

  const popup = createPopupOverlay({
    google,
    map,
    position,
    routeColor,
    items: normalizedItems,
    initialIndex: popupState.currentIndex,
    onIndexChange: (index) => {
      const entry = popupRegistry.get(popupId);
      if (entry) {
        entry.popupState.currentIndex = index;
      }
    },
    onClose: (reason) => {
      const entry = popupRegistry.get(popupId);
      if (!entry) {
        return;
      }
      entry.popupState.isOpen = false;
      entry.popupState.hiddenByVisibility = reason === "visibility-off";
    }
  });

  popupRegistry.set(popupId, {
    popup,
    routeId,
    items: normalizedItems,
    popupState
  });

  return popup;
}

function createPopupOverlay({ google, map, position, routeColor, items, initialIndex = 0, onIndexChange, onClose }) {
  const overlay = new google.maps.OverlayView();
  let container = null;
  let currentIndex = clamp(initialIndex, 0, items.length - 1);
  let currentItemId = items[currentIndex]?.id || null;
  let currentObjectUrl = null;
  let latLngPosition = toLatLng(position, google);
  let popupMetrics = getPopupMetricsFromZoom(map?.getZoom());
  let removeReason = "user";
  let popupMode = "async";

  function revokeCurrentUrl() {
    if (currentObjectUrl) {
      URL.revokeObjectURL(currentObjectUrl);
      currentObjectUrl = null;
    }
  }

  function renderContent() {
    if (!container) {
      return;
    }

    const currentItem = items[currentIndex];
    const imageElement = container.querySelector("[data-popup-image]");
    const timeElement = container.querySelector("[data-popup-time]");
    const counterElement = container.querySelector("[data-popup-counter]");
    const prevButton = container.querySelector("[data-popup-prev]");
    const nextButton = container.querySelector("[data-popup-next]");
    const navElement = container.querySelector("[data-popup-nav]");

    revokeCurrentUrl();
    currentObjectUrl = URL.createObjectURL(currentItem.blob);

    imageElement.src = currentObjectUrl;
    const currentTimeLabel = formatAbsoluteTime(currentItem.absoluteUtc);
    imageElement.alt = currentTimeLabel === "-" ? "WebP" : currentTimeLabel;
    timeElement.textContent = currentTimeLabel;
    counterElement.textContent = `${currentIndex + 1} / ${items.length}`;

    const hasMultiple = items.length > 1 && popupMode !== "sync";
    navElement.hidden = !hasMultiple;
    if (prevButton) {
      prevButton.disabled = currentIndex <= 0;
    }
    if (nextButton) {
      nextButton.disabled = currentIndex >= items.length - 1;
    }

    onIndexChange?.(currentIndex);
  }

  overlay.onAdd = function onAdd() {
    const panes = this.getPanes();
    if (!panes?.floatPane) {
      return;
    }

    container = document.createElement("div");
    container.className = "webp-popup";
    container.style.setProperty("--route-color", routeColor);
    applyPopupMetricsToElement(container, popupMetrics);
    container.innerHTML = `
      <div class="webp-popup__frame">
        <div class="webp-popup__accent"></div>
        <div class="webp-popup__header">
          <button class="webp-popup__close" type="button" aria-label="閉じる">×</button>
        </div>
        <div class="webp-popup__media-wrap">
          <img class="webp-popup__image" data-popup-image alt="WebP" />
        </div>
        <div class="webp-popup__meta">
          <div class="webp-popup__time" data-popup-time></div>
          <label class="webp-popup__fixed">
            <input type="checkbox" disabled />
            <span>固定</span>
          </label>
        </div>
        <div class="webp-popup__nav" data-popup-nav>
          <button class="webp-popup__nav-btn" data-popup-prev type="button">前へ</button>
          <div class="webp-popup__counter" data-popup-counter></div>
          <button class="webp-popup__nav-btn" data-popup-next type="button">次へ</button>
        </div>
      </div>
    `;

    container.addEventListener("click", (event) => {
      event.stopPropagation();
    });

    container.querySelector(".webp-popup__close")?.addEventListener("click", () => {
      overlay.close("user");
    });

    container.querySelector("[data-popup-prev]")?.addEventListener("click", () => {
      if (currentIndex > 0) {
        currentIndex -= 1;
        renderContent();
      }
    });

    container.querySelector("[data-popup-next]")?.addEventListener("click", () => {
      if (currentIndex < items.length - 1) {
        currentIndex += 1;
        renderContent();
      }
    });

    panes.floatPane.append(container);
    renderContent();
  };

  overlay.draw = function draw() {
    if (!container || !latLngPosition) {
      return;
    }

    const projection = this.getProjection();
    if (!projection) {
      return;
    }

    const point = projection.fromLatLngToDivPixel(latLngPosition);
    if (!point) {
      return;
    }

    container.style.left = `${point.x}px`;
    container.style.top = `${point.y}px`;
  };

  overlay.onRemove = function onRemove() {
    revokeCurrentUrl();
    if (container) {
      container.remove();
      container = null;
    }
    onClose?.(removeReason);
  };

  overlay.setIndex = (nextIndex) => {
    currentIndex = clamp(nextIndex, 0, items.length - 1);
    currentItemId = items[currentIndex]?.id || null;
    renderContent();
  };

  overlay.setItems = (nextItems, nextIndex = 0) => {
    items = (Array.isArray(nextItems) ? nextItems : []).filter((item) => item?.blob);
    currentIndex = clamp(nextIndex, 0, Math.max(0, items.length - 1));
    currentItemId = items[currentIndex]?.id || null;
    renderContent();
  };

  overlay.setFrame = (nextItem, nextPosition) => {
    if (!nextItem?.blob) {
      return;
    }

    if (currentItemId === nextItem.id) {
      if (nextPosition) {
        latLngPosition = toLatLng(nextPosition, google);
        overlay.draw();
      }
      return;
    }

    items = [nextItem];
    currentIndex = 0;
    currentItemId = nextItem.id || null;
    if (nextPosition) {
      latLngPosition = toLatLng(nextPosition, google);
    }
    renderContent();
  };

  overlay.setZoomMetrics = (metrics) => {
    popupMetrics = metrics;
    if (container) {
      applyPopupMetricsToElement(container, popupMetrics);
    }
  };

  overlay.setPosition = (nextPosition) => {
    latLngPosition = toLatLng(nextPosition, google);
    overlay.draw();
  };

  overlay.close = (reason = "user") => {
    removeReason = reason;
    overlay.setMap(null);
  };

  overlay.reopen = (targetMap) => {
    removeReason = "restore";
    overlay.setMap(targetMap);
  };

  overlay.setMode = (mode) => {
    popupMode = mode === "sync" ? "sync" : "async";
    renderContent();
  };

  overlay.setMap(map);
  return overlay;
}

function createSyncPopupOverlay({ google, map, position, routeColor, item, routeId, onClose }) {
  const overlay = createPopupOverlay({
    google,
    map,
    position,
    routeColor,
    items: [item],
    initialIndex: 0,
    mode: "sync"
  });
  overlay.setMode?.("sync");
  if (typeof onClose === "function") {
    const originalClose = overlay.close;
    overlay.close = (reason = "user") => {
      originalClose?.(reason);
      onClose(reason, routeId);
    };
  }
  return overlay;
}

function createSyncPopupPosition(frame, fallbackPosition = null) {
  if (Number.isFinite(frame?.lat) && Number.isFinite(frame?.lng)) {
    return { lat: frame.lat, lng: frame.lng };
  }
  return fallbackPosition;
}

function refreshOpenPopups(project, interactionMode = "async") {
  if (interactionMode !== "async") {
    closeAllPopups();
    return;
  }

  const visibleRouteIds = new Set((project?.routes || []).filter((route) => route?.visible !== false).map((route) => route.routeId));

  for (const entry of popupRegistry.values()) {
    const routeVisible = visibleRouteIds.has(entry.routeId);

    if (!routeVisible && entry.popupState.isOpen) {
      entry.popupState.hiddenByVisibility = true;
      entry.popupState.isOpen = false;
      entry.popup.close("visibility-off");
      continue;
    }

    if (routeVisible && !entry.popupState.isOpen && entry.popupState.hiddenByVisibility) {
      entry.popupState.hiddenByVisibility = false;
      entry.popupState.isOpen = true;
      entry.popup.reopen(activeMap);
    }
  }
}

function logRenderDiagnostics(project, map) {
  for (const route of project?.routes || []) {
    const segments = Array.isArray(route?.segments) ? route.segments : [];
    const segmentSummaries = segments.map((segment) => ({
      segmentId: segment?.segmentId || null,
      fileCount: Array.isArray(segment?.files) ? segment.files.length : 0,
      gpsSampleCount: Array.isArray(segment?.gpsSamples) ? segment.gpsSamples.length : 0
    }));
    const webpCount = segments.reduce((sum, segment) => sum + (Array.isArray(segment?.frames) ? segment.frames.length : 0), 0);
    const validPointCount = segments.reduce(
      (sum, segment) =>
        sum +
        (Array.isArray(segment?.frames)
          ? segment.frames.filter((frame) => frame?.gpsStatus === "matched" && Number.isFinite(frame?.lat) && Number.isFinite(frame?.lng)).length
          : 0),
      0
    );

    console.info("[GoogleMaps] route diagnostics", {
      routeId: route?.routeId || null,
      mp4Count: Array.isArray(route?.files) ? route.files.length : 0,
      segmentCount: segments.length,
      segmentSummaries,
      webpCount,
      validPointCount,
      mapInstanceExists: Boolean(map)
    });
  }
}

function applyPopupZoomScale(zoom) {
  const metrics = getPopupMetricsFromZoom(zoom);
  for (const entry of popupRegistry.values()) {
    entry.popup.setZoomMetrics?.(metrics);
  }
}

function getPopupMetricsFromZoom(zoom) {
  if (zoom >= 17) {
    return { width: 160, imageHeight: 100, radius: 12, padding: 4, fontSize: 10, timeFontSize: 10, buttonHeight: 18, counterFontSize: 10 };
  }
  if (zoom >= 15) {
    return { width: 130, imageHeight: 80, radius: 11, padding: 4, fontSize: 9, timeFontSize: 9, buttonHeight: 16, counterFontSize: 9 };
  }
  if (zoom >= 13) {
    return { width: 105, imageHeight: 65, radius: 10, padding: 3, fontSize: 8, timeFontSize: 8, buttonHeight: 15, counterFontSize: 8 };
  }
  return { width: 80, imageHeight: 50, radius: 9, padding: 2, fontSize: 7, timeFontSize: 7, buttonHeight: 13, counterFontSize: 7 };
}

function applyPopupMetricsToElement(element, metrics) {
  if (!element || !metrics) {
    return;
  }
  element.style.setProperty("--popup-width", `${metrics.width}px`);
  element.style.setProperty("--popup-image-height", `${metrics.imageHeight}px`);
  element.style.setProperty("--popup-radius", `${metrics.radius}px`);
  element.style.setProperty("--popup-padding", `${metrics.padding}px`);
  element.style.setProperty("--popup-font-size", `${metrics.fontSize}px`);
  element.style.setProperty("--popup-time-font-size", `${metrics.timeFontSize}px`);
  element.style.setProperty("--popup-button-height", `${metrics.buttonHeight}px`);
  element.style.setProperty("--popup-counter-font-size", `${metrics.counterFontSize}px`);
}

function closeAllPopups() {
  for (const entry of popupRegistry.values()) {
    entry.popupState.isOpen = false;
    entry.popup.close("destroy");
  }
  popupRegistry.clear();
}

function buildVisibleRouteBounds(project, google) {
  if (!google?.maps) {
    return null;
  }

  const bounds = new google.maps.LatLngBounds();
  let hasPoint = false;

  for (const route of project.routes || []) {
    if (route?.visible === false) {
      continue;
    }
    for (const segment of route.segments || []) {
      for (const sample of segment.gpsSamples || []) {
        if (Number.isFinite(sample?.lat) && Number.isFinite(sample?.lng)) {
          bounds.extend({ lat: sample.lat, lng: sample.lng });
          hasPoint = true;
        }
      }
      for (const frame of segment.frames || []) {
        if (frame.gpsStatus === "matched" && Number.isFinite(frame.lat) && Number.isFinite(frame.lng)) {
          bounds.extend({ lat: frame.lat, lng: frame.lng });
          hasPoint = true;
        }
      }
    }
  }

  return hasPoint ? bounds : null;
}

function getGoogleMapType(mapType) {
  if (mapType === "satellite") {
    return "satellite";
  }
  return "roadmap";
}

function applyMapStyle(map, mapType) {
  if (!map) {
    return;
  }

  if (mapType === "satellite") {
    map.setMapTypeId("satellite");
    map.setOptions({ styles: null });
    return;
  }

  map.setMapTypeId("roadmap");
  map.setOptions({
    styles: mapType === "monochrome" ? MONOCHROME_STYLE : null
  });
}

function clearRouteOverlays(overlayList = activeRouteOverlays) {
  for (const overlay of overlayList) {
    overlay.setMap?.(null);
  }
  if (overlayList === activeRouteOverlays) {
    activeRouteOverlays = [];
  }
}

function clearGoogleMapView(statusElement, message) {
  clearRouteOverlays();
  closeAllPopups();
  clearSyncTimelineOverlays();
  if (statusElement) {
    statusElement.textContent = message;
  }
}

function getDefaultView(project) {
  const fallback = { center: { lat: 35.681236, lng: 139.767125 }, zoom: 6 };
  const routes = Array.isArray(project?.routes) ? project.routes : [];

  for (const route of routes) {
    for (const segment of route.segments || []) {
      for (const sample of segment.gpsSamples || []) {
        if (Number.isFinite(sample?.lat) && Number.isFinite(sample?.lng)) {
          return { center: { lat: sample.lat, lng: sample.lng }, zoom: 12 };
        }
      }
      for (const frame of segment.frames || []) {
        if (frame.gpsStatus === "matched" && Number.isFinite(frame.lat) && Number.isFinite(frame.lng)) {
          return { center: { lat: frame.lat, lng: frame.lng }, zoom: 12 };
        }
      }
    }
  }

  return fallback;
}

function createPointMarkerIcon(color) {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 22 22">
      <circle cx="11" cy="11" r="5.5" fill="${color}" stroke="#ffffff" stroke-width="2.5" />
    </svg>
  `;
  return {
    url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`,
    scaledSize: new window.google.maps.Size(22, 22),
    anchor: new window.google.maps.Point(11, 11)
  };
}

function createClusterMarkerIcon(color, count) {
  const displayCount = count > 99 ? "99+" : String(count);
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="54" height="28" viewBox="0 0 54 28">
      <circle cx="14" cy="14" r="7" fill="${color}" stroke="#ffffff" stroke-width="2.5" />
      <text x="27" y="18" fill="#1f2937" font-size="13" font-weight="700" font-family="Arial, sans-serif">● ${displayCount}</text>
    </svg>
  `;
  return {
    url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`,
    scaledSize: new window.google.maps.Size(54, 28),
    anchor: new window.google.maps.Point(14, 14)
  };
}

function createSyncCurrentMarker(google, color) {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 22 22">
      <defs>
        <filter id="shadow" x="-25%" y="-25%" width="150%" height="150%">
          <feDropShadow dx="0" dy="1" stdDeviation="1.2" flood-color="#000000" flood-opacity="0.28"/>
        </filter>
      </defs>
      <circle cx="11" cy="11" r="7" fill="${color}" stroke="#ffffff" stroke-width="4" filter="url(#shadow)" />
    </svg>
  `;

  return new google.maps.Marker({
    map: activeMap,
    position: { lat: 0, lng: 0 },
    clickable: false,
    visible: false,
    zIndex: 10000,
    icon: {
      url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`,
      scaledSize: new google.maps.Size(22, 22),
      anchor: new google.maps.Point(11, 11)
    }
  });
}

function throttleDebugLog(key, intervalMs, callback) {
  const now = performance.now();
  const last = syncDebugLogThrottle.get(key) || 0;
  if (now - last < intervalMs) {
    return;
  }
  syncDebugLogThrottle.set(key, now);
  callback?.();
}

function getSyncRouteRuntime(route) {
  const routeId = route?.routeId || "route-unknown";
  const signature = buildSyncRouteSignature(route);
  const cached = syncRouteRuntimeCache.get(routeId);
  if (cached?.signature === signature) {
    return cached.runtime;
  }

  const runtime = {
    routeId,
    visible: route?.visible !== false,
    segments: (Array.isArray(route?.segments) ? route.segments : [])
      .map((segment, index) => buildSyncSegmentRuntime(route, segment, index))
      .filter(Boolean)
      .sort((left, right) => compareTimelineMs(left.startUtcMs, right.startUtcMs) || String(left.segmentId).localeCompare(String(right.segmentId)))
  };

  syncRouteRuntimeCache.set(routeId, { signature, runtime });
  return runtime;
}

function logSyncRouteSnapshotOnce(route, runtime, currentUtcMs) {
  const routeId = route?.routeId || "route-unknown";
  if (syncDebugRouteSnapshotLogged.has(routeId)) {
    return;
  }
  syncDebugRouteSnapshotLogged.add(routeId);

  const segments = Array.isArray(route?.segments) ? route.segments : [];
  const firstSegment = segments[0] || null;
  const gpsArrayProperty = detectArrayPropertyName(firstSegment, ["gpsSamples", "gps", "samples"]);
  const webpArrayProperty = detectArrayPropertyName(firstSegment, ["frames", "webpFrames", "images"]);
  const firstGpsSample = firstSegment && gpsArrayProperty ? firstSegment[gpsArrayProperty]?.[0] || null : null;
  const firstWebpFrame = firstSegment && webpArrayProperty ? firstSegment[webpArrayProperty]?.[0] || null : null;

  const allGps = flattenSegmentArray(segments, ["gpsSamples", "gps", "samples"])
    .map((sample) => ({ ...sample, _utcMs: normalizeTimelineMs(sample?.gpsTimestampMs ?? sample?.gpsTimestamp ?? sample?.timestamp ?? sample?.utcMs) }))
    .filter((sample) => Number.isFinite(sample._utcMs))
    .sort((left, right) => left._utcMs - right._utcMs);

  const allFrames = flattenSegmentArray(segments, ["frames", "webpFrames", "images"])
    .map((frame) => ({ ...frame, _utcMs: normalizeTimelineMs(frame?.absoluteUtcMs ?? frame?.absoluteUtc ?? frame?.timestamp ?? frame?.utcMs) }))
    .filter((frame) => Number.isFinite(frame._utcMs))
    .sort((left, right) => left._utcMs - right._utcMs);

  const routeStartMs = runtime?.segments?.reduce(
    (minValue, segment) => (Number.isFinite(minValue) ? Math.min(minValue, segment.startUtcMs) : segment.startUtcMs),
    null
  );
  const routeEndMs = runtime?.segments?.reduce(
    (maxValue, segment) => (Number.isFinite(maxValue) ? Math.max(maxValue, segment.endUtcMs) : segment.endUtcMs),
    null
  );

  console.log("[SyncDebug] route object", {
    routeKeys: Object.keys(route || {}),
    routeIdField: route?.id ?? route?.routeId ?? null,
    routeStartMs,
    routeStartIso: toIsoOrNull(routeStartMs),
    routeEndMs,
    routeEndIso: toIsoOrNull(routeEndMs),
    segmentCount: segments.length,
    webpFrameCount: allFrames.length,
    gpsSampleCount: allGps.length
  });

  console.log("[SyncDebug] segment object", {
    segmentKeys: firstSegment ? Object.keys(firstSegment) : [],
    segmentId: firstSegment?.id ?? firstSegment?.segmentId ?? null,
    startUtc: firstSegment?.startUtc ?? firstSegment?.startTime ?? null,
    endUtc: firstSegment?.endUtc ?? firstSegment?.endTime ?? null,
    hasStartUtcMsField: Boolean(firstSegment && Object.hasOwn(firstSegment, "startUtcMs")),
    hasEndUtcMsField: Boolean(firstSegment && Object.hasOwn(firstSegment, "endUtcMs")),
    gpsArrayProperty,
    webpArrayProperty
  });

  console.log("[SyncDebug] gps sample object", {
    gpsKeys: firstGpsSample ? Object.keys(firstGpsSample) : [],
    timestampField: detectOwnField(firstGpsSample, ["gpsTimestampMs", "gpsTimestamp", "timestamp", "utcMs"]),
    timestampType: detectFieldType(firstGpsSample, ["gpsTimestampMs", "gpsTimestamp", "timestamp", "utcMs"]),
    latField: detectOwnField(firstGpsSample, ["lat", "latitude"]),
    lngField: detectOwnField(firstGpsSample, ["lng", "lon", "longitude"])
  });

  console.log("[SyncDebug] webp frame object", {
    frameKeys: firstWebpFrame ? Object.keys(firstWebpFrame) : [],
    absoluteUtc: firstWebpFrame?.absoluteUtc ?? null,
    hasAbsoluteUtcMsField: Boolean(firstWebpFrame && Object.hasOwn(firstWebpFrame, "absoluteUtcMs")),
    absoluteUtcType: firstWebpFrame ? typeof firstWebpFrame.absoluteUtc : null,
    lat: firstWebpFrame?.lat ?? null,
    lng: firstWebpFrame?.lng ?? null,
    segmentId: firstWebpFrame?.segmentId ?? null
  });

  const segmentRanges = (runtime?.segments || []).map((segment) => ({
    id: segment.segmentId,
    startMs: segment.startUtcMs,
    startIso: toIsoOrNull(segment.startUtcMs),
    endMs: segment.endUtcMs,
    endIso: toIsoOrNull(segment.endUtcMs)
  }));

  console.log("[SyncDebug] route time ranges", {
    currentUtcMs,
    currentUtcIso: toIsoOrNull(currentUtcMs),
    routeStartMs,
    routeStartIso: toIsoOrNull(routeStartMs),
    routeEndMs,
    routeEndIso: toIsoOrNull(routeEndMs),
    segmentRanges,
    firstGpsMs: allGps[0]?._utcMs ?? null,
    firstGpsIso: toIsoOrNull(allGps[0]?._utcMs),
    lastGpsMs: allGps[allGps.length - 1]?._utcMs ?? null,
    lastGpsIso: toIsoOrNull(allGps[allGps.length - 1]?._utcMs),
    firstWebpMs: allFrames[0]?._utcMs ?? null,
    firstWebpIso: toIsoOrNull(allFrames[0]?._utcMs),
    lastWebpMs: allFrames[allFrames.length - 1]?._utcMs ?? null,
    lastWebpIso: toIsoOrNull(allFrames[allFrames.length - 1]?._utcMs)
  });

  console.table(segmentRanges);
}

function buildSyncRouteSignature(route) {
  return [
    route?.routeId || "route-unknown",
    route?.visible !== false,
    (Array.isArray(route?.segments) ? route.segments : [])
      .map((segment) => `${segment?.segmentId || "segment"}:${segment?.startTime || "-"}:${segment?.endTime || "-"}:${Array.isArray(segment?.gpsSamples) ? segment.gpsSamples.length : 0}:${Array.isArray(segment?.frames) ? segment.frames.length : 0}`)
      .join("|")
  ].join(";");
}

function buildSyncSegmentRuntime(route, segment, index) {
  const startUtcMs = normalizeTimelineMs(segment?.startTime ?? segment?.files?.[0]?.fileStartUtcMs);
  const endUtcMs = normalizeTimelineMs(segment?.endTime ?? segment?.files?.[segment?.files?.length - 1]?.fileEndUtcMs);
  if (!Number.isFinite(startUtcMs) || !Number.isFinite(endUtcMs)) {
    return null;
  }

  const gpsSamples = normalizeGpsSamples(segment?.gpsSamples || []);
  console.log("[SyncRoute] segment", {
    routeId: route?.routeId || `route-${index + 1}`,
    segmentId: segment?.segmentId || `segment-${index + 1}`,
    gpsSampleCount: gpsSamples.length,
    firstGpsUtc: formatAbsoluteTime(gpsSamples[0]?.gpsTimestampMs),
    lastGpsUtc: formatAbsoluteTime(gpsSamples[gpsSamples.length - 1]?.gpsTimestampMs)
  });

  return {
    routeId: route?.routeId || `route-${index + 1}`,
    segmentId: segment?.segmentId || `segment-${index + 1}`,
    startUtcMs,
    endUtcMs,
    gpsSamples,
    frames: normalizeFrames(segment?.frames || [])
  };
}

function normalizeGpsSamples(samples) {
  return (Array.isArray(samples) ? samples : [])
    .filter((sample) => Number.isFinite(sample?.gpsTimestampMs) && Number.isFinite(sample?.lat) && Number.isFinite(sample?.lng))
    .map((sample) => ({
      ...sample,
      gpsTimestampMs: sample.gpsTimestampMs,
      altitudeM: Number.isFinite(sample.altitudeM) ? sample.altitudeM : sample.altitudeM ?? null,
      lat: sample.lat,
      lng: sample.lng
    }))
    .sort((left, right) => left.gpsTimestampMs - right.gpsTimestampMs || String(left.sampleId).localeCompare(String(right.sampleId)));
}

function normalizeFrames(frames) {
  return (Array.isArray(frames) ? frames : [])
    .filter((frame) => frame?.blob && (frame?.gpsStatus === "matched" || Number.isFinite(frame?.lat) && Number.isFinite(frame?.lng)))
    .map((frame) => ({
      ...frame,
      absoluteUtcMs: normalizeTimelineMs(frame.absoluteUtc)
    }))
    .filter((frame) => Number.isFinite(frame.absoluteUtcMs))
    .sort((left, right) => left.absoluteUtcMs - right.absoluteUtcMs || String(left.id).localeCompare(String(right.id)));
}

function evaluateSyncRouteRuntime(runtime, currentUtcMs, webpMatchToleranceMs, gpsInterpolationGapLimitMs) {
  const segmentSearchRows = (runtime?.segments || []).map((segment) => ({
    id: segment?.segmentId || null,
    startMs: segment?.startUtcMs ?? null,
    endMs: segment?.endUtcMs ?? null,
    containsCurrentUtc: Number.isFinite(currentUtcMs) && Number.isFinite(segment?.startUtcMs) && Number.isFinite(segment?.endUtcMs)
      ? currentUtcMs >= segment.startUtcMs && currentUtcMs <= segment.endUtcMs
      : false
  }));

  if (!Number.isFinite(currentUtcMs)) {
    return {
      activeSegmentId: null,
      gpsInterpolationStatus: "timeline-not-set",
      markerPosition: null,
      currentFrame: null,
      debug: {
        segmentSearchRows,
        gpsSearch: null,
        webpSearch: null
      }
    };
  }

  const segment = findActiveSyncSegment(runtime?.segments || [], currentUtcMs);
  if (!segment) {
    return {
      activeSegmentId: null,
      gpsInterpolationStatus: "segment-gap",
      markerPosition: null,
      currentFrame: null,
      debug: {
        segmentSearchRows,
        gpsSearch: {
          segmentId: null,
          gpsSampleCount: 0,
          currentUtcMs,
          previous: null,
          next: null,
          gapMs: null,
          ratio: null,
          resultLat: null,
          resultLng: null
        },
        webpSearch: {
          segmentId: null,
          frameCount: 0,
          currentUtcMs,
          previousFrame: null,
          nextFrame: null,
          selectedFrameId: null,
          selectedFrameUtcMs: null,
          deltaMs: null,
          allowedDeltaMs: webpMatchToleranceMs
        }
      }
    };
  }

  const webpResult = findNearestSyncFrameWithDebug(segment.frames, currentUtcMs, webpMatchToleranceMs);
  const gpsResult = interpolateSyncGpsPosition(segment.gpsSamples, currentUtcMs, gpsInterpolationGapLimitMs);
  if (!gpsResult?.position) {
    return {
      activeSegmentId: segment.segmentId,
      gpsInterpolationStatus: gpsResult?.status || "gps-gap",
      markerPosition: null,
      currentFrame: webpResult.frame,
      debug: {
        segmentSearchRows,
        gpsSearch: {
          segmentId: segment.segmentId,
          gpsSampleCount: Array.isArray(segment.gpsSamples) ? segment.gpsSamples.length : 0,
          currentUtcMs,
          previous: gpsResult?.debug?.previous || null,
          next: gpsResult?.debug?.next || null,
          gapMs: gpsResult?.debug?.gapMs ?? null,
          ratio: gpsResult?.debug?.ratio ?? null,
          resultLat: null,
          resultLng: null
        },
        webpSearch: webpResult.debug
      }
    };
  }

  const currentFrame = webpResult.frame;
  return {
    activeSegmentId: segment.segmentId,
    gpsInterpolationStatus: gpsResult.status,
    markerPosition: gpsResult.position,
    currentFrame,
    debug: {
      segmentSearchRows,
      gpsSearch: {
        segmentId: segment.segmentId,
        gpsSampleCount: Array.isArray(segment.gpsSamples) ? segment.gpsSamples.length : 0,
        currentUtcMs,
        previous: gpsResult?.debug?.previous || null,
        next: gpsResult?.debug?.next || null,
        gapMs: gpsResult?.debug?.gapMs ?? null,
        ratio: gpsResult?.debug?.ratio ?? null,
        resultLat: gpsResult?.position?.lat ?? null,
        resultLng: gpsResult?.position?.lng ?? null
      },
      webpSearch: webpResult.debug
    }
  };
}

function findActiveSyncSegment(segments, currentUtcMs) {
  for (const segment of segments) {
    if (currentUtcMs >= segment.startUtcMs && currentUtcMs <= segment.endUtcMs) {
      return segment;
    }
  }
  return null;
}

function interpolateSyncGpsPosition(samples, currentUtcMs, gapLimitMs = 60000) {
  const ordered = Array.isArray(samples) ? samples : [];
  if (!ordered.length) {
    return { status: "no-gps-samples", position: null, debug: { previous: null, next: null, gapMs: null, ratio: null } };
  }

  const firstSample = ordered[0];
  const lastSample = ordered[ordered.length - 1];
  if (currentUtcMs < firstSample.gpsTimestampMs || currentUtcMs > lastSample.gpsTimestampMs) {
    return {
      status: "outside-gps-range",
      position: null,
      debug: {
        previous: currentUtcMs >= firstSample.gpsTimestampMs ? summarizeGpsPoint(firstSample) : null,
        next: currentUtcMs <= lastSample.gpsTimestampMs ? summarizeGpsPoint(lastSample) : null,
        gapMs: null,
        ratio: null
      }
    };
  }

  const index = binarySearchTimestampIndex(ordered, currentUtcMs, "gpsTimestampMs");
  const exactSample = ordered[index] && ordered[index].gpsTimestampMs === currentUtcMs ? ordered[index] : null;
  if (exactSample) {
    return {
      status: "exact",
      position: {
        lat: exactSample.lat,
        lng: exactSample.lng,
        altitudeM: exactSample.altitudeM ?? null
      },
      debug: {
        previous: summarizeGpsPoint(exactSample),
        next: summarizeGpsPoint(exactSample),
        gapMs: 0,
        ratio: 0
      }
    };
  }

  const left = ordered[Math.max(0, index - 1)];
  const right = ordered[Math.min(ordered.length - 1, index)];
  if (!left || !right || left === right) {
    return {
      status: "edge-gps-gap",
      position: null,
      debug: {
        previous: summarizeGpsPoint(left),
        next: summarizeGpsPoint(right),
        gapMs: null,
        ratio: null
      }
    };
  }

  const gapMs = right.gpsTimestampMs - left.gpsTimestampMs;
  if (!Number.isFinite(gapMs) || gapMs <= 0 || gapMs > gapLimitMs) {
    return {
      status: "gps-gap-too-large",
      position: null,
      debug: {
        previous: summarizeGpsPoint(left),
        next: summarizeGpsPoint(right),
        gapMs,
        ratio: null
      }
    };
  }

  const ratio = (currentUtcMs - left.gpsTimestampMs) / gapMs;
  const altitudeM = Number.isFinite(left.altitudeM) && Number.isFinite(right.altitudeM)
    ? left.altitudeM + (right.altitudeM - left.altitudeM) * ratio
    : left.altitudeM ?? right.altitudeM ?? null;

  return {
    status: "interpolated",
    position: {
      lat: left.lat + (right.lat - left.lat) * ratio,
      lng: left.lng + (right.lng - left.lng) * ratio,
      altitudeM
    },
    debug: {
      previous: summarizeGpsPoint(left),
      next: summarizeGpsPoint(right),
      gapMs,
      ratio
    }
  };
}

function findNearestSyncFrameWithDebug(frames, currentUtcMs, toleranceMs) {
  const ordered = Array.isArray(frames) ? frames : [];
  if (!ordered.length) {
    return {
      frame: null,
      debug: {
        segmentId: null,
        frameCount: 0,
        currentUtcMs,
        previousFrame: null,
        nextFrame: null,
        selectedFrameId: null,
        selectedFrameUtcMs: null,
        deltaMs: null,
        allowedDeltaMs: toleranceMs
      }
    };
  }

  const index = binarySearchTimestampIndex(ordered, currentUtcMs, "absoluteUtcMs");
  const exactFrame = ordered[index] && ordered[index].absoluteUtcMs === currentUtcMs ? ordered[index] : null;
  if (exactFrame) {
    return {
      frame: exactFrame,
      debug: {
        segmentId: exactFrame.segmentId ?? null,
        frameCount: ordered.length,
        currentUtcMs,
        previousFrame: summarizeFramePoint(exactFrame),
        nextFrame: summarizeFramePoint(exactFrame),
        selectedFrameId: exactFrame.id ?? null,
        selectedFrameUtcMs: exactFrame.absoluteUtcMs ?? null,
        deltaMs: 0,
        allowedDeltaMs: toleranceMs
      }
    };
  }

  const left = ordered[Math.max(0, index - 1)];
  const right = ordered[Math.min(ordered.length - 1, index)];
  const leftDelta = left ? Math.abs(currentUtcMs - left.absoluteUtcMs) : Number.POSITIVE_INFINITY;
  const rightDelta = right ? Math.abs(right.absoluteUtcMs - currentUtcMs) : Number.POSITIVE_INFINITY;
  const nearest = leftDelta <= rightDelta ? left : right;
  const nearestDelta = Math.min(leftDelta, rightDelta);
  if (!nearest || !Number.isFinite(nearestDelta) || nearestDelta > toleranceMs) {
    return {
      frame: null,
      debug: {
        segmentId: left?.segmentId ?? right?.segmentId ?? null,
        frameCount: ordered.length,
        currentUtcMs,
        previousFrame: summarizeFramePoint(left),
        nextFrame: summarizeFramePoint(right),
        selectedFrameId: null,
        selectedFrameUtcMs: null,
        deltaMs: Number.isFinite(nearestDelta) ? nearestDelta : null,
        allowedDeltaMs: toleranceMs
      }
    };
  }
  return {
    frame: nearest,
    debug: {
      segmentId: nearest.segmentId ?? null,
      frameCount: ordered.length,
      currentUtcMs,
      previousFrame: summarizeFramePoint(left),
      nextFrame: summarizeFramePoint(right),
      selectedFrameId: nearest.id ?? null,
      selectedFrameUtcMs: nearest.absoluteUtcMs ?? null,
      deltaMs: nearestDelta,
      allowedDeltaMs: toleranceMs
    }
  };
}

function binarySearchTimestampIndex(items, targetUtcMs, key) {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (items[mid][key] < targetUtcMs) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

function buildEmptySyncDiagnostics(syncState) {
  return {
    timelineStartUtcMs: Number.isFinite(syncState.timelineStartUtcMs) ? syncState.timelineStartUtcMs : null,
    timelineEndUtcMs: Number.isFinite(syncState.timelineEndUtcMs) ? syncState.timelineEndUtcMs : null,
    currentUtcMs: Number.isFinite(syncState.currentUtcMs) ? syncState.currentUtcMs : null,
    playing: Boolean(syncState.playing),
    visibleRouteCount: 0,
    activeRouteCount: 0,
    currentMarkerCount: 0,
    syncPopupCount: 0,
    routeDiagnostics: []
  };
}

function updateMinTimelineMs(previousValue, nextValue) {
  if (!Number.isFinite(nextValue)) {
    return previousValue;
  }
  if (!Number.isFinite(previousValue)) {
    return nextValue;
  }
  return Math.min(previousValue, nextValue);
}

function updateMaxTimelineMs(previousValue, nextValue) {
  if (!Number.isFinite(nextValue)) {
    return previousValue;
  }
  if (!Number.isFinite(previousValue)) {
    return nextValue;
  }
  return Math.max(previousValue, nextValue);
}

function compareTimelineMs(leftValue, rightValue) {
  const leftMs = normalizeTimelineMs(leftValue);
  const rightMs = normalizeTimelineMs(rightValue);

  if (leftMs == null && rightMs == null) {
    return 0;
  }
  if (leftMs == null) {
    return 1;
  }
  if (rightMs == null) {
    return -1;
  }
  return leftMs - rightMs;
}

function normalizeTimelineMs(value) {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return null;
    }
    if (Math.abs(value) < 1e11) {
      return value * 1000;
    }
    return value;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (value instanceof Date) {
    const parsed = value.getTime();
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function detectArrayPropertyName(target, candidates) {
  if (!target) {
    return null;
  }
  return candidates.find((name) => Array.isArray(target?.[name])) || null;
}

function flattenSegmentArray(segments, candidates) {
  const result = [];
  for (const segment of Array.isArray(segments) ? segments : []) {
    const arrayName = detectArrayPropertyName(segment, candidates);
    if (!arrayName) {
      continue;
    }
    for (const item of segment[arrayName] || []) {
      result.push(item);
    }
  }
  return result;
}

function detectOwnField(target, candidates) {
  if (!target) {
    return null;
  }
  return candidates.find((name) => Object.hasOwn(target, name)) || null;
}

function detectFieldType(target, candidates) {
  const field = detectOwnField(target, candidates);
  if (!field) {
    return null;
  }
  return typeof target[field];
}

function summarizeGpsPoint(sample) {
  if (!sample) {
    return null;
  }
  return {
    utcMs: normalizeTimelineMs(sample.gpsTimestampMs ?? sample.gpsTimestamp ?? sample.timestamp ?? sample.utcMs),
    lat: Number.isFinite(sample.lat) ? sample.lat : sample.latitude ?? null,
    lng: Number.isFinite(sample.lng) ? sample.lng : sample.longitude ?? sample.lon ?? null
  };
}

function summarizeFramePoint(frame) {
  if (!frame) {
    return null;
  }
  return {
    id: frame.id ?? null,
    utcMs: normalizeTimelineMs(frame.absoluteUtcMs ?? frame.absoluteUtc ?? frame.timestamp ?? frame.utcMs),
    lat: Number.isFinite(frame.lat) ? frame.lat : frame.latitude ?? null,
    lng: Number.isFinite(frame.lng) ? frame.lng : frame.longitude ?? frame.lon ?? null,
    segmentId: frame.segmentId ?? null
  };
}

function toIsoOrNull(value) {
  const utcMs = normalizeTimelineMs(value);
  if (!Number.isFinite(utcMs)) {
    return null;
  }
  try {
    return new Date(utcMs).toISOString();
  } catch {
    return null;
  }
}

function clamp(value, minValue, maxValue) {
  return Math.min(Math.max(value, minValue), maxValue);
}

function toLatLng(position, google) {
  if (!position || !google?.maps) {
    return null;
  }
  if (position instanceof google.maps.LatLng) {
    return position;
  }
  if (typeof position.lat === "number" && typeof position.lng === "number") {
    return new google.maps.LatLng(position.lat, position.lng);
  }
  return null;
}

function toLatLngLiteral(frame) {
  if (!Number.isFinite(frame?.lat) || !Number.isFinite(frame?.lng)) {
    return null;
  }
  return { lat: frame.lat, lng: frame.lng };
}

function distanceMeters(left, right) {
  if (!left || !right) {
    return Infinity;
  }

  const radiusMeters = 6371000;
  const lat1 = (left.lat * Math.PI) / 180;
  const lat2 = (right.lat * Math.PI) / 180;
  const deltaLat = ((right.lat - left.lat) * Math.PI) / 180;
  const deltaLng = ((right.lng - left.lng) * Math.PI) / 180;

  const a =
    Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) * Math.sin(deltaLng / 2);
  return 2 * radiusMeters * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

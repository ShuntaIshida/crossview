import { createAnalysisSession, createPhase3AProbeState, createProject, createProgressState, PHASE2B_ANALYSIS_STAGES, PHASE3B_ANALYSIS_STAGES } from "../domain/models.js";
import { state, setState, subscribe, updateState } from "./state-store.js";
import { Phase2AError } from "./phase2a-analyzer.js";
import { analyzeRouteFilesForPhase2B, PHASE2B_STAGES } from "./phase2b-route-analyzer.js";
import { PHASE3A_STAGES, Phase3AError, probeHevcFrameExtraction } from "./phase3a-frame-probe.js";
import { generateRouteWebpSet, PHASE3B_STAGES, Phase3BError } from "./phase3b-webp-generator.js";
import { destroyGoogleMapView, fitVisibleRoutesToMap, rememberGoogleMapView, syncGoogleMapView } from "./google-maps-view.js";
import { createSyncController } from "./sync-controller.js";
import { renderAnalysisModal } from "../ui/analysis-modal.js";
import { renderMainScreen, updateMainScreenState } from "../ui/main-screen.js";
import { renderStartScreen } from "../ui/start-screen.js";

const appRoot = document.querySelector("#app");
let modalNode = null;
let analysisAbortController = null;
let phase3aResourceCleanup = null;
const ROUTE_COLORS = ["#0d9488", "#ea580c", "#2563eb", "#dc2626", "#7c3aed", "#16a34a", "#c2410c"];
let lastMainScreenSignature = null;
let lastRenderedProjectId = null;
let lastMapDataSignature = null;
let lastMapSurfaceNode = null;
let pendingFitBoundsOnce = false;
let renderMainScreenCount = 0;
let mapContainerGenerationCount = 0;
const syncController = createSyncController();

function openFileDialogForProject() {
  const picker = document.createElement("input");
  picker.type = "file";
  picker.accept = ".gopromap,.zip,application/zip";
  picker.addEventListener("change", () => {
    const selected = picker.files?.[0];
    if (selected) {
      alert("Phase 1ではプロジェクト読込はUI骨格のみです。選択: " + selected.name);
    }
  });
  picker.click();
}

function handleCancelAnalysis() {
  if (state.progress.status === "running" && analysisAbortController) {
    analysisAbortController.abort();
    return;
  }

  updateState((draft) => {
    draft.analysisModalVisible = false;
    draft.analysisSession = createAnalysisSession("");
    draft.progress = createProgressState("");
  });
}

function disposePhase3AResources() {
  if (typeof phase3aResourceCleanup === "function") {
    phase3aResourceCleanup();
    phase3aResourceCleanup = null;
  }
}

function handleCancelPhase3A() {
  if (state.phase3aProbe.status === "running" && analysisAbortController) {
    analysisAbortController.abort();
    return;
  }

  disposePhase3AResources();
  updateState((draft) => {
    draft.phase3aModalVisible = false;
    draft.phase3aProbe = createPhase3AProbeState();
  });
}

function updateStageState(index, stageState) {
  updateState((draft) => {
    const stage = draft.progress.stageStateList[index];
    draft.progress.stageIndex = Number.isInteger(index) ? index : draft.progress.stageIndex;
    if (stage) {
      draft.progress.currentStageLabel = stage.label;
    }
    draft.progress.stageStateList = draft.progress.stageStateList.map((stage, currentIndex) => {
      if (currentIndex === index) {
        return { ...stage, state: stageState };
      }
      if (currentIndex > index && stageState === "running") {
        return { ...stage, state: "pending" };
      }
      return stage;
    });
  });
}

function appendProgressLog(line) {
  updateState((draft) => {
    draft.progress.logs = [...draft.progress.logs, line].slice(-180);
  });
}

function updateExtractionProgress(extraction) {
  updateState((draft) => {
    draft.progress.extraction = {
      ...draft.progress.extraction,
      ...extraction
    };
  });
}

function updatePhase2BProgress(snapshot) {
  updateState((draft) => {
    if (Number.isFinite(snapshot.overallProgress)) {
      draft.progress.overallProgress = snapshot.overallProgress;
    }
    if (Number.isFinite(snapshot.fileProgressPercent)) {
      draft.progress.fileProgressPercent = snapshot.fileProgressPercent;
    }
    if (Number.isFinite(snapshot.fileIndex)) {
      draft.progress.fileIndex = snapshot.fileIndex;
    }
    if (Number.isFinite(snapshot.fileTotal)) {
      draft.progress.fileTotal = snapshot.fileTotal;
    }
    if (typeof snapshot.currentFileName === "string") {
      draft.progress.currentFileName = snapshot.currentFileName;
    }
    if (Number.isFinite(snapshot.successCount)) {
      draft.progress.successFileCount = snapshot.successCount;
    }
    if (Number.isFinite(snapshot.failedCount)) {
      draft.progress.failedFileCount = snapshot.failedCount;
    }
  });
}

function updatePhase3BProgress(snapshot) {
  updateState((draft) => {
    if (Number.isFinite(snapshot.overallProgress)) {
      draft.progress.overallProgress = snapshot.overallProgress;
    }
    if (typeof snapshot.currentFileName === "string") {
      draft.progress.currentFileName = snapshot.currentFileName;
    }
    if (typeof snapshot.currentSegmentLabel === "string") {
      draft.progress.currentSegmentLabel = snapshot.currentSegmentLabel;
    }
    if (typeof snapshot.currentAbsoluteUtc === "string") {
      draft.progress.currentAbsoluteUtc = snapshot.currentAbsoluteUtc;
    }
    if (Number.isFinite(snapshot.currentMediaTimeSec)) {
      draft.progress.currentMediaTimeSec = snapshot.currentMediaTimeSec;
    }
    if (Number.isFinite(snapshot.webpDone)) {
      draft.progress.webpDone = snapshot.webpDone;
    }
    if (Number.isFinite(snapshot.webpTotal)) {
      draft.progress.webpTotal = snapshot.webpTotal;
    }
  });
}

function markAnalysisError(error) {
  const code = error?.code || (error instanceof Phase2AError ? error.code : "UNEXPECTED_ERROR");
  const message =
    error?.message ||
    (error instanceof Phase2AError ? error.message : `解析中に予期しないエラーが発生しました: ${error?.message || String(error)}`);

  updateState((draft) => {
    draft.progress.status = code === "ANALYSIS_CANCELED" ? "canceled" : "error";
    draft.progress.errorCode = code;
    draft.progress.errorMessage = message;
    draft.progress.result = draft.progress.phase === "phase3b" ? buildPhase3BResultSummary(draft.progress, error) : draft.progress.result;
    draft.progress.overallProgress = draft.progress.phase === "phase3b" ? draft.progress.overallProgress : null;
    draft.progress.stageStateList = draft.progress.stageStateList.map((stage) => {
      if (stage.state === "running") {
        return { ...stage, state: "error" };
      }
      return stage;
    });
  });
}

function updatePhase3AStage(index, stageState) {
  updateState((draft) => {
    draft.phase3aProbe.stageStateList = draft.phase3aProbe.stageStateList.map((stage, currentIndex) => {
      if (currentIndex === index) {
        return { ...stage, state: stageState };
      }
      return stage;
    });
  });
}

function appendPhase3ALog(line) {
  updateState((draft) => {
    draft.phase3aProbe.logs = [...draft.phase3aProbe.logs, line].slice(-120);
  });
}

function updatePhase3AProgress(snapshot) {
  updateState((draft) => {
    if (Number.isFinite(snapshot.overallProgress)) {
      draft.phase3aProbe.overallProgress = snapshot.overallProgress;
    }
    if (Number.isFinite(snapshot.currentProbeIndex)) {
      draft.phase3aProbe.currentProbeIndex = snapshot.currentProbeIndex;
    }
    if (Number.isFinite(snapshot.probeCount)) {
      draft.phase3aProbe.probeCount = snapshot.probeCount;
    }
    if (Number.isFinite(snapshot.targetTimeSec)) {
      draft.phase3aProbe.targetTimeSec = snapshot.targetTimeSec;
    }
  });
}

function markPhase3AError(error) {
  const code = error instanceof Phase3AError ? error.code : "PHASE3A_FAILED";
  const message = error instanceof Phase3AError ? error.message : error?.message || String(error);

  updateState((draft) => {
    draft.phase3aProbe.status = code === "ANALYSIS_CANCELED" ? "canceled" : "error";
    draft.phase3aProbe.errorCode = code;
    draft.phase3aProbe.errorMessage = message;
    draft.phase3aProbe.result = error instanceof Phase3AError ? error.details || null : null;
    draft.phase3aProbe.stageStateList = draft.phase3aProbe.stageStateList.map((stage) => {
      if (stage.state === "running") {
        return { ...stage, state: "error" };
      }
      return stage;
    });
  });
}

function getNextRouteLabel() {
  const next = getNextRouteSequence(state.project);
  return buildRouteLabel(next);
}

function buildRouteLabel(sequence) {
  return `Route-${String(sequence).padStart(2, "0")}`;
}

function buildRouteId(sequence) {
  return `route-${String(sequence).padStart(2, "0")}`;
}

function setRouteVisibility(routeId, visible) {
  updateState((draft) => {
    const route = draft.project?.routes?.find((item) => item.routeId === routeId);
    if (route) {
      route.visible = Boolean(visible);
    }
  });
}

function setMapType(mapType) {
  updateState((draft) => {
    if (!draft.project?.mapSettings) {
      return;
    }
    draft.project.mapSettings.mapType = mapType;
  });
}

function getNextRouteSequence(project) {
  if (Number.isFinite(project?.nextRouteSequence)) {
    return project.nextRouteSequence;
  }

  const routes = Array.isArray(project?.routes) ? project.routes : [];
  let maxSequence = 0;

  for (const route of routes) {
    const candidates = [route?.routeId, route?.displayName];
    for (const value of candidates) {
      const match = String(value || "").match(/(\d+)$/);
      if (!match) {
        continue;
      }
      const sequence = Number(match[1]);
      if (Number.isFinite(sequence)) {
        maxSequence = Math.max(maxSequence, sequence);
      }
    }
  }

  return maxSequence + 1;
}

function chooseRouteColor(index) {
  return ROUTE_COLORS[index % ROUTE_COLORS.length];
}

async function commitAnalyzedRoute() {
  const result = state.progress.result;
  if (!result?.ok || !result.routeDraft || !state.project) {
    return;
  }

  const sequence = getNextRouteSequence(state.project);
  const routeIndex = state.project.routes.length;
  const color = chooseRouteColor(routeIndex);
  const routeName = buildRouteLabel(sequence);
  const routeDraftForGeneration = buildFinalRouteDraft(result.routeDraft, {
    routeId: buildRouteId(sequence),
    routeName,
    color
  });

  updateState((draft) => {
    draft.progress = createProgressState(routeName, {
      phase: "phase3b",
      stageLabels: PHASE3B_ANALYSIS_STAGES
    });
    draft.progress.status = "running";
    draft.progress.currentStageLabel = PHASE3B_STAGES[0];
    draft.progress.currentFileName = "-";
    draft.progress.currentSegmentLabel = "-";
    draft.progress.logs = ["Phase 3B: SegmentごとのWebP生成を開始"];
    draft.analysisSession.status = "phase3b-running";
  });

  analysisAbortController = new AbortController();

  try {
    const generationResult = await generateRouteWebpSet({
      routeDraft: routeDraftForGeneration,
      sourceFiles: result.sourceFiles || [],
      frameIntervalSec: state.project.frameIntervalSec,
      signal: analysisAbortController.signal,
      onStage: ({ index, state: stageState }) => {
        updateStageState(index, stageState);
      },
      onLog: (line) => {
        appendProgressLog(line);
      },
      onProgress: (snapshot) => {
        updatePhase3BProgress(snapshot);
      }
    });

    updateState((draft) => {
      draft.project.routes = [...draft.project.routes, generationResult.routeDraft];
      draft.project.nextRouteSequence = sequence + 1;
      draft.project.updatedAt = new Date().toISOString();
      draft.progress.status = "done";
      draft.progress.result = buildPhase3BResultSummary(draft.progress, null, generationResult, generationResult.routeDraft);
      draft.progress.errorCode = null;
      draft.progress.errorMessage = null;
      draft.progress.overallProgress = 100;
      draft.analysisSession.status = "done";
    });
    pendingFitBoundsOnce = true;
  } catch (error) {
    markAnalysisError(error instanceof Phase3BError ? error : error);
    appendProgressLog(`ERROR: ${error?.message || String(error)}`);
  } finally {
    analysisAbortController = null;
  }
}

function buildPhase3BResultSummary(progress, error = null, generationResult = null, routeDraft = null) {
  const stats = generationResult?.stats || error?.details?.stats || null;
  const finalizedRoute = routeDraft || generationResult?.routeDraft || null;
  const plannedCount = Number.isFinite(stats?.plannedCount) ? stats.plannedCount : Number(progress.webpTotal || 0);
  const generatedCount = Number.isFinite(stats?.generatedCount) ? stats.generatedCount : Number(progress.webpDone || 0);
  const failedCount = Math.max(0, plannedCount - generatedCount);
  const segmentCount = finalizedRoute?.segments?.length || 0;
  const fileCount = finalizedRoute?.files?.length || 0;
  const frameIntervalSec = finalizedRoute?.imageSetStats?.frameIntervalSec || state.project?.frameIntervalSec || null;
  const hasAbsoluteUtc = Boolean(finalizedRoute) && finalizedRoute.segments.every((segment) => (segment.frames || []).every((frame) => Boolean(frame.absoluteUtc)));
  const isCanceled = error?.code === "ANALYSIS_CANCELED" || progress.status === "canceled";
  const overallSuccess = Boolean(finalizedRoute) && plannedCount > 0 && generatedCount === plannedCount && failedCount === 0 && hasAbsoluteUtc;

  return {
    kind: "phase3b-result",
    status: isCanceled ? "Cancelled" : overallSuccess ? "Success" : "Failed",
    overallSuccess,
    routeLabel: progress.routeLabel || finalizedRoute?.displayName || "-",
    frameIntervalSec,
    fileCount,
    segmentCount,
    plannedCount,
    generatedCount,
    failedCount,
    elapsedMs: stats?.elapsedMs ?? null,
    averageWebpSizeBytes: stats?.averageWebpSizeBytes ?? null,
    estimatedTotalBytes: stats?.estimatedTotalBytes ?? null,
    verification: {
      multiMp4: fileCount > 1,
      segmentBoundaries: segmentCount > 0,
      recordingGapExcluded: plannedCount === generatedCount || isCanceled || Boolean(error),
      absoluteUtcAssigned: hasAbsoluteUtc,
      webp960px: Boolean(finalizedRoute) && finalizedRoute.segments.every((segment) => (segment.frames || []).every((frame) => Math.max(frame.width || 0, frame.height || 0) <= 960)),
      webpQuality08: true
    }
  };
}

function buildFinalRouteDraft(routeDraft, { routeId, routeName, color }) {
  return {
    ...routeDraft,
    routeId,
    displayName: routeName,
    color,
    files: (routeDraft.files || []).map((fileMeta) => ({ ...fileMeta })),
    segments: (routeDraft.segments || []).map((segment, idx) => ({
      ...segment,
      segmentId: `segment-${String(idx + 1).padStart(2, "0")}`,
      routeId,
      files: (segment.files || []).map((fileMeta) => ({ ...fileMeta })),
      gpsSamples: (segment.gpsSamples || []).map((sample) => ({ ...sample })),
      frames: []
    }))
  };
}

function openMp4PickerForPhase2B() {
  const picker = document.createElement("input");
  picker.type = "file";
  picker.accept = "video/mp4,.mp4";
  picker.multiple = true;

  picker.addEventListener("change", async () => {
    const files = Array.from(picker.files || []);
    if (!files.length) {
      return;
    }

    const routeLabel = getNextRouteLabel();
    const session = createAnalysisSession(routeLabel);
    const progress = createProgressState(routeLabel, {
      phase: "phase2b",
      stageLabels: PHASE2B_ANALYSIS_STAGES
    });
    progress.currentFileName = files[0].name;
    progress.fileIndex = 1;
    progress.fileTotal = files.length;
    progress.status = "running";
    progress.logs = ["Phase 2B: 複数GoPro MP4の時系列整列とSegment化を開始"];
    progress.currentStageLabel = PHASE2B_STAGES[0];

    updateState((draft) => {
      draft.analysisModalVisible = true;
      draft.analysisSession = session;
      draft.progress = progress;
    });

    analysisAbortController = new AbortController();

    try {
      const result = await analyzeRouteFilesForPhase2B(files, {
        tempRouteId: session.tempRouteId,
        routeLabel,
        signal: analysisAbortController.signal,
        onStage: ({ index, state: stageState }) => {
          updateStageState(index, stageState);
        },
        onLog: (line) => {
          appendProgressLog(line);
          console.info("[Phase2B]", line);
        },
        onProgress: (snapshot) => {
          if (snapshot.extraction) {
            updateExtractionProgress(snapshot.extraction);
          }
          updatePhase2BProgress(snapshot);
        }
      });

      if (result.ok) {
        updateState((draft) => {
          draft.progress.status = "done";
          draft.progress.result = {
            ...result,
            sourceFiles: files.slice()
          };
          draft.progress.errorCode = null;
          draft.progress.errorMessage = null;
          draft.progress.overallProgress = 100;
          draft.progress.canCommitRoute = true;
          draft.progress.warnings = (result.continuity?.issues || []).map((issue) => `${issue.code}: ${issue.currentFile} -> ${issue.nextFile}`);
          draft.analysisSession.status = "ready-to-commit";
        });
      } else {
        updateState((draft) => {
          draft.progress.status = "error";
          draft.progress.result = result;
          draft.progress.errorCode = "PARTIAL_FILE_ANALYSIS_FAILED";
          draft.progress.errorMessage = "一部ファイルの解析に失敗したためRouteは追加されません。";
          draft.progress.overallProgress = 100;
          draft.progress.canCommitRoute = false;
          draft.analysisSession.status = "failed";
        });
      }
    } catch (error) {
      markAnalysisError(error);
      appendProgressLog(`ERROR: ${error?.message || String(error)}`);
    } finally {
      analysisAbortController = null;
    }
  });

  picker.click();
}

function openMp4PickerForPhase3A() {
  const picker = document.createElement("input");
  picker.type = "file";
  picker.accept = "video/mp4,.mp4";
  picker.multiple = false;

  picker.addEventListener("change", async () => {
    const file = picker.files?.[0];
    if (!file) {
      return;
    }

    disposePhase3AResources();

    updateState((draft) => {
      draft.phase3aModalVisible = true;
      draft.phase3aProbe = createPhase3AProbeState();
      draft.phase3aProbe.currentFileName = file.name;
      draft.phase3aProbe.status = "running";
      draft.phase3aProbe.logs = ["Phase 3A: HTMLVideoElement + Canvas でHEVC MP4からWebP抽出を開始"];
    });

    analysisAbortController = new AbortController();

    try {
      const result = await probeHevcFrameExtraction(file, {
        signal: analysisAbortController.signal,
        onStage: ({ index, state: stageState }) => {
          updatePhase3AStage(index, stageState);
        },
        onLog: (line) => {
          appendPhase3ALog(line);
          console.info("[Phase3A]", line);
        },
        onProgress: (snapshot) => {
          updatePhase3AProgress(snapshot);
        }
      });

      phase3aResourceCleanup = result.cleanup;
      updateState((draft) => {
        draft.phase3aProbe.status = "done";
        draft.phase3aProbe.result = result;
        draft.phase3aProbe.errorCode = null;
        draft.phase3aProbe.errorMessage = null;
        draft.phase3aProbe.overallProgress = 100;
      });
    } catch (error) {
      markPhase3AError(error);
      appendPhase3ALog(`ERROR: ${error?.message || String(error)}`);
    } finally {
      analysisAbortController = null;
    }
  });

  picker.click();
}

function render() {
  if (state.screen !== "main") {
    destroyGoogleMapView();
    syncController.reset();
    lastMainScreenSignature = null;
    lastRenderedProjectId = null;
    lastMapDataSignature = null;
    lastMapSurfaceNode = null;
  }

  if (state.screen === "start") {
    renderStartScreen(appRoot, ({ name, frameIntervalSec }) => {
      const project = createProject({ name, frameIntervalSec });
      setState({
        project,
        screen: "main",
        mode: "async"
      });
    }, openFileDialogForProject);
  }

  if (state.screen !== "main") {
    return;
  }

  if (state.screen === "main") {
    const mainScreenSignature = buildMainScreenSignature(state);
    const shouldRebuildMainScreen = state.project?.id !== lastRenderedProjectId || lastMainScreenSignature == null;

    if (shouldRebuildMainScreen) {
      rememberGoogleMapView();
      renderMainScreenCount += 1;
      console.info("[Render] main-screen rebuild", { renderMainScreenCount });
      lastMainScreenSignature = mainScreenSignature;
      lastRenderedProjectId = state.project?.id || null;

      renderMainScreen(appRoot, state, {
        onToggleSidebar: () => {
          setState({ sidebarCollapsed: !state.sidebarCollapsed });
        },
        onModeChange: (mode) => {
          setState({ mode });
        },
        onAddRoute: () => {
          openMp4PickerForPhase2B();
        },
        onToggleRouteVisibility: (routeId, visible) => {
          setRouteVisibility(routeId, visible);
        },
        onSetMapType: (mapType) => {
          setMapType(mapType);
        },
        onFitAllRoutes: () => {
          fitVisibleRoutesToMap();
        },
        onTimelinePlay: () => {
          syncController.play();
        },
        onTimelinePause: () => {
          syncController.pause();
        },
        onTimelineSeek: (value) => {
          syncController.onSliderInput(value);
        },
        onTimelineImageToggle: (checked) => {
          syncController.toggleImages(checked);
        }
      });
    } else {
      updateMainScreenState(appRoot, state, {
        onToggleSidebar: () => {
          setState({ sidebarCollapsed: !state.sidebarCollapsed });
        },
        onModeChange: (mode) => {
          setState({ mode });
        },
        onAddRoute: () => {
          openMp4PickerForPhase2B();
        },
        onToggleRouteVisibility: (routeId, visible) => {
          setRouteVisibility(routeId, visible);
        },
        onSetMapType: (mapType) => {
          setMapType(mapType);
        },
        onFitAllRoutes: () => {
          fitVisibleRoutesToMap();
        },
        onTimelinePlay: () => {
          syncController.play();
        },
        onTimelinePause: () => {
          syncController.pause();
        },
        onTimelineSeek: (value) => {
          syncController.onSliderInput(value);
        },
        onTimelineImageToggle: (checked) => {
          syncController.toggleImages(checked);
        }
      });
    }
  }

  syncController.attach(appRoot);
  syncController.syncFromState(state);

  const previousMapSurfaceNode = lastMapSurfaceNode;
  const mapSurface = appRoot.querySelector("#mapSurface");
  if (mapSurface && mapSurface !== lastMapSurfaceNode) {
    mapContainerGenerationCount += 1;
    lastMapSurfaceNode = mapSurface;
    console.info("[Render] map container generated", { mapContainerGenerationCount });
  }

  const mapDataSignature = buildMapDataSignature(state.project);
  const shouldSyncMap = Boolean(mapSurface) && (mapSurface !== previousMapSurfaceNode || mapDataSignature !== lastMapDataSignature || pendingFitBoundsOnce);

  if (shouldSyncMap) {
    lastMapDataSignature = mapDataSignature;
    syncGoogleMapView(mapSurface, state.project, {
      fitBounds: pendingFitBoundsOnce,
      interactionMode: state.mode
    });
    pendingFitBoundsOnce = false;
  }

  if (modalNode) {
    modalNode.remove();
    modalNode = null;
  }

  if (state.analysisModalVisible) {
    modalNode = renderAnalysisModal(state.progress, {
      onCancel: handleCancelAnalysis,
      onCommitRoute: commitAnalyzedRoute
    });
    document.body.append(modalNode);
    return;
  }
}

export function bootstrap() {
  if (import.meta.env.DEV) {
    window.__crossviewDebug = {
      getState: () => state,
      setState,
      updateState,
      syncController
    };
  }
  subscribe(render);
  render();
}

function buildMainScreenSignature(currentState) {
  return [currentState.screen, currentState.project?.id || "no-project"].join(";");
}

function buildMapDataSignature(project) {
  if (!project) {
    return "no-project";
  }

  const routes = Array.isArray(project.routes) ? project.routes : [];
  const routeSignature = routes
    .map((route) => {
      const segments = Array.isArray(route.segments) ? route.segments : [];
      const segmentSignature = segments
        .map((segment) => `${segment.segmentId}:${(segment.gpsSamples || []).length}:${(segment.frames || []).length}:${(segment.files || []).length}`)
        .join(",");
      return `${route.routeId}:${route.visible !== false}:${segmentSignature}`;
    })
    .join("|");

  return `${project.mapSettings?.mapType || "monochrome"};${routeSignature}`;
}

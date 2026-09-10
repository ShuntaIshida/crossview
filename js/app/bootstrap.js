import { createAnalysisSession, createProject, createProgressState, PHASE2B_ANALYSIS_STAGES } from "../domain/models.js";
import { state, setState, subscribe, updateState } from "./state-store.js";
import { Phase2AError } from "./phase2a-analyzer.js";
import { analyzeRouteFilesForPhase2B, PHASE2B_STAGES } from "./phase2b-route-analyzer.js";
import { renderAnalysisModal } from "../ui/analysis-modal.js";
import { renderMainScreen } from "../ui/main-screen.js";
import { renderStartScreen } from "../ui/start-screen.js";

const appRoot = document.querySelector("#app");
let modalNode = null;
let analysisAbortController = null;
const ROUTE_COLORS = ["#0d9488", "#ea580c", "#2563eb", "#dc2626", "#7c3aed", "#16a34a", "#c2410c"];

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

function markAnalysisError(error) {
  const code = error instanceof Phase2AError ? error.code : "UNEXPECTED_ERROR";
  const message = error instanceof Phase2AError ? error.message : `解析中に予期しないエラーが発生しました: ${error?.message || String(error)}`;

  updateState((draft) => {
    draft.progress.status = code === "ANALYSIS_CANCELED" ? "canceled" : "error";
    draft.progress.errorCode = code;
    draft.progress.errorMessage = message;
    draft.progress.overallProgress = null;
    draft.progress.stageStateList = draft.progress.stageStateList.map((stage) => {
      if (stage.state === "running") {
        return { ...stage, state: "error" };
      }
      return stage;
    });
  });
}

function getNextRouteLabel() {
  const next = (state.demoRoutes?.length || 0) + 1;
  return `Route-${String(next).padStart(2, "0")}`;
}

function chooseRouteColor(index) {
  return ROUTE_COLORS[index % ROUTE_COLORS.length];
}

function commitAnalyzedRoute() {
  const result = state.progress.result;
  if (!result?.ok || !result.routeDraft || !state.project) {
    return;
  }

  const finalRouteId = `route-${crypto.randomUUID()}`;
  const routeIndex = state.project.routes.length;
  const color = chooseRouteColor(routeIndex);
  const routeName = result.routeLabel || getNextRouteLabel();

  const committedRoute = {
    ...result.routeDraft,
    routeId: finalRouteId,
    displayName: routeName,
    color,
    files: (result.routeDraft.files || []).map((fileMeta) => ({ ...fileMeta })),
    segments: (result.routeDraft.segments || []).map((segment, idx) => ({
      ...segment,
      segmentId: `segment-${String(idx + 1).padStart(2, "0")}`,
      routeId: finalRouteId,
      files: (segment.files || []).map((fileMeta) => ({ ...fileMeta }))
    }))
  };

  updateState((draft) => {
    draft.project.routes = [...draft.project.routes, committedRoute];
    draft.project.updatedAt = new Date().toISOString();
    draft.demoRoutes = [
      ...draft.demoRoutes,
      {
        id: committedRoute.routeId,
        name: committedRoute.displayName,
        color: committedRoute.color,
        visible: true
      }
    ];
    draft.analysisModalVisible = false;
    draft.analysisSession = createAnalysisSession("");
    draft.progress = createProgressState("");
  });
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
          draft.progress.result = result;
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

function render() {
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

  if (state.screen === "main") {
    renderMainScreen(appRoot, state, {
      onToggleSidebar: () => {
        setState({ sidebarCollapsed: !state.sidebarCollapsed });
      },
      onModeChange: (mode) => {
        setState({ mode });
      },
      onAddRoute: () => {
        openMp4PickerForPhase2B();
      }
    });
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
  }
}

export function bootstrap() {
  subscribe(render);
  render();
}

import { createAnalysisSession, createPhase3AProbeState, createProgressState } from "../domain/models.js";

const listeners = new Set();

export const state = {
  screen: "start",
  project: null,
  mode: "async",
  sidebarCollapsed: false,
  analysisModalVisible: false,
  analysisSession: createAnalysisSession(),
  progress: createProgressState(""),
  phase3aModalVisible: false,
  phase3aProbe: createPhase3AProbeState()
};

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setState(patch) {
  Object.assign(state, patch);
  emit();
}

export function updateState(updater) {
  updater(state);
  emit();
}

function emit() {
  for (const listener of listeners) {
    listener(state);
  }
}

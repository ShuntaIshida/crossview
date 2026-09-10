import { createAnalysisSession, createProgressState } from "../domain/models.js";

const listeners = new Set();

export const state = {
  screen: "start",
  project: null,
  mode: "async",
  sidebarCollapsed: false,
  analysisModalVisible: false,
  analysisSession: createAnalysisSession(),
  progress: createProgressState(""),
  demoRoutes: [
    { id: "route-01", name: "Route-01", color: "#0d9488", visible: true },
    { id: "route-02", name: "Route-02", color: "#ea580c", visible: true },
    { id: "route-03", name: "Route-03", color: "#2563eb", visible: true }
  ]
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

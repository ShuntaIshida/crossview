function renderRouteItem(route) {
  return `
    <li class="route-item">
      <span class="route-color-dot" style="background:${route.color}"></span>
      <span class="route-name">${route.displayName}</span>
      <input data-route-id="${route.routeId}" type="checkbox" ${route.visible ? "checked" : ""} aria-label="${route.displayName}の表示切替" />
      <button class="route-actions" aria-label="${route.displayName}のメニュー">⋯</button>
    </li>
  `;
}

function renderRouteList(routes) {
  return (Array.isArray(routes) ? routes : []).map(renderRouteItem).join("");
}

function bindMainScreenHandlers(container, handlers) {
  container.querySelector("#toggleSidebarBtn")?.addEventListener("click", handlers.onToggleSidebar);
  const openFab = container.querySelector("#openSidebarFab");
  openFab?.addEventListener("click", handlers.onToggleSidebar);

  container.querySelector("#asyncModeBtn")?.addEventListener("click", () => handlers.onModeChange("async"));
  container.querySelector("#syncModeBtn")?.addEventListener("click", () => handlers.onModeChange("sync"));
  container.querySelector("#addRouteBtn")?.addEventListener("click", handlers.onAddRoute);
  container.querySelector("#fitAllBtn")?.addEventListener("click", handlers.onFitAllRoutes);
  container.querySelector("#mapTypeStandardBtn")?.addEventListener("click", () => handlers.onSetMapType("standard"));
  container.querySelector("#mapTypeMonochromeBtn")?.addEventListener("click", () => handlers.onSetMapType("monochrome"));
  container.querySelector("#mapTypeSatelliteBtn")?.addEventListener("click", () => handlers.onSetMapType("satellite"));

  container.querySelector("#timelinePlayBtn")?.addEventListener("click", handlers.onTimelinePlay);
  container.querySelector("#timelinePauseBtn")?.addEventListener("click", handlers.onTimelinePause);
  container.querySelector("#timelineTrack")?.addEventListener("input", (event) => {
    handlers.onTimelineSeek(event.currentTarget.value);
  });
  container.querySelector("#timelineImageToggle")?.addEventListener("change", (event) => {
    handlers.onTimelineImageToggle(event.currentTarget.checked);
  });

  container.addEventListener("change", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || !target.matches("[data-route-id]")) {
      return;
    }
    handlers.onToggleRouteVisibility(target.dataset.routeId, target.checked);
  });
}

export function updateMainScreenState(container, currentState, handlers) {
  if (!container) {
    return;
  }

  const sidebar = container.querySelector(".sidebar");
  const openFab = container.querySelector("#openSidebarFab");
  const modeCaption = container.querySelector(".mode-caption");
  const asyncModeBtn = container.querySelector("#asyncModeBtn");
  const syncModeBtn = container.querySelector("#syncModeBtn");
  const timelineShell = container.querySelector("#timelineShell");
  const projectName = container.querySelector(".project-name");
  const mapTypeStandardBtn = container.querySelector("#mapTypeStandardBtn");
  const mapTypeMonochromeBtn = container.querySelector("#mapTypeMonochromeBtn");
  const mapTypeSatelliteBtn = container.querySelector("#mapTypeSatelliteBtn");
  const routeList = container.querySelector(".route-list");

  const isSyncMode = currentState.mode === "sync";
  const mapType = currentState.project?.mapSettings?.mapType || "monochrome";

  sidebar?.classList.toggle("collapsed", Boolean(currentState.sidebarCollapsed));
  openFab?.classList.toggle("hidden", !currentState.sidebarCollapsed);
  if (modeCaption) {
    modeCaption.textContent = isSyncMode ? "全ルートを同じ時刻で表示" : "各地点を自由に表示";
  }
  asyncModeBtn?.classList.toggle("active", currentState.mode === "async");
  syncModeBtn?.classList.toggle("active", isSyncMode);
  timelineShell?.classList.toggle("hidden", !isSyncMode);
  if (projectName) {
    projectName.textContent = currentState.project?.name || "-";
  }
  mapTypeStandardBtn?.classList.toggle("active", mapType === "standard");
  mapTypeMonochromeBtn?.classList.toggle("active", mapType === "monochrome");
  mapTypeSatelliteBtn?.classList.toggle("active", mapType === "satellite");

  if (routeList) {
    routeList.innerHTML = renderRouteList(currentState.project?.routes || []);
  }
}

export function renderMainScreen(container, currentState, handlers) {
  const modeCaption = currentState.mode === "async" ? "各地点を自由に表示" : "全ルートを同じ時刻で表示";
  const routes = currentState.project?.routes || [];
  const mapType = currentState.project?.mapSettings?.mapType || "monochrome";

  container.innerHTML = `
    <section class="screen main-shell">
      <main class="workspace">
        <button id="openSidebarFab" class="sidebar-open-fab ${currentState.sidebarCollapsed ? "" : "hidden"}" aria-label="サイドバーを開く">≡</button>

        <aside class="sidebar ${currentState.sidebarCollapsed ? "collapsed" : ""}">
          <header class="sidebar-header">
            <strong class="sidebar-title">Project</strong>
            <button id="toggleSidebarBtn" class="icon-btn" aria-label="サイドバーを閉じる">×</button>
          </header>
          <div class="sidebar-body">
            <h2 class="project-name">${currentState.project?.name || "-"}</h2>
            <button id="addRouteBtn" class="add-route-btn">＋ ルートを追加</button>
            <h3 class="sidebar-section-title">ルート一覧</h3>
            <ul class="route-list">
              ${renderRouteList(routes)}
            </ul>
          </div>
        </aside>

        <div class="top-center-controls">
          <div class="mode-switch">
            <button id="asyncModeBtn" class="mode-btn ${currentState.mode === "async" ? "active" : ""}">非同期</button>
            <button id="syncModeBtn" class="mode-btn ${currentState.mode === "sync" ? "active" : ""}">同期</button>
          </div>
          <div class="mode-caption">${modeCaption}</div>
        </div>

        <div class="toolbar-right">
          <button id="fitAllBtn" class="small-btn">全体表示</button>
          <div class="map-type-switch" role="group" aria-label="地図タイプ切替">
            <button id="mapTypeStandardBtn" class="small-btn ${mapType === "standard" ? "active" : ""}">通常</button>
            <button id="mapTypeMonochromeBtn" class="small-btn ${mapType === "monochrome" ? "active" : ""}">モノクロ</button>
            <button id="mapTypeSatelliteBtn" class="small-btn ${mapType === "satellite" ? "active" : ""}">衛星</button>
          </div>
        </div>

        <section class="map-surface" id="mapSurface" aria-label="地図表示領域">
          <div class="map-canvas" id="mapCanvas"></div>
          <div class="map-status" id="mapStatus" aria-live="polite"></div>
        </section>

        <section class="timeline-shell ${currentState.mode === "sync" ? "" : "hidden"}" id="timelineShell">
          <div class="timeline-header">
            <button id="timelinePlayBtn" class="ghost-btn">再生</button>
            <button id="timelinePauseBtn" class="ghost-btn">一時停止</button>
            <span class="time-text" id="timelineCurrentTime">現在時刻: --</span>
            <label class="timeline-toggle">
              <input id="timelineImageToggle" type="checkbox" /> 画像表示
            </label>
          </div>
          <input id="timelineTrack" class="timeline-track" type="range" min="0" max="0" value="0" step="1000" />
          <div class="timeline-footer">
            <div class="time-text" id="timelineEndTime">終了時刻: --</div>
            <details class="timeline-debug-panel">
              <summary>debug</summary>
              <pre id="timelineDebug" class="timeline-debug-text">-</pre>
            </details>
          </div>
        </section>
      </main>
    </section>
  `;

  bindMainScreenHandlers(container, handlers);
}

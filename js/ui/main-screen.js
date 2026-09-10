function renderRouteItem(route) {
  return `
    <li class="route-item">
      <span class="route-color-dot" style="background:${route.color}"></span>
      <span class="route-name">${route.name}</span>
      <input type="checkbox" ${route.visible ? "checked" : ""} aria-label="${route.name}の表示切替" />
      <button class="route-actions" aria-label="${route.name}のメニュー">⋯</button>
    </li>
  `;
}

export function renderMainScreen(container, currentState, handlers) {
  const modeCaption = currentState.mode === "async" ? "各地点を自由に表示" : "全ルートを同じ時刻で表示";

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
              ${currentState.demoRoutes.map(renderRouteItem).join("")}
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
          <button class="small-btn" disabled>固定をすべて解除</button>
          <button class="small-btn" disabled>全体表示</button>
          <button class="small-btn" disabled>地図タイプ</button>
        </div>

        <section class="map-surface" id="mapSurface" aria-label="地図表示領域">
          <div class="map-placeholder">
            <h2>Map View (Phase 1 Skeleton)</h2>
            <p>Google Maps連携はPhase 4で接続予定</p>
          </div>
        </section>

        <section class="timeline-shell ${currentState.mode === "sync" ? "" : "hidden"}" id="timelineShell">
          <div class="timeline-header">
            <button class="ghost-btn" disabled>再生</button>
            <button class="ghost-btn" disabled>一時停止</button>
            <span class="time-text">現在時刻: --:--:--</span>
            <label>
              <input type="checkbox" disabled /> 画像表示
            </label>
          </div>
          <input class="timeline-track" type="range" min="0" max="100" value="0" disabled />
          <div class="time-text">終了時刻: --:--:--</div>
        </section>
      </main>
    </section>
  `;

  container.querySelector("#toggleSidebarBtn").addEventListener("click", handlers.onToggleSidebar);
  const openFab = container.querySelector("#openSidebarFab");
  if (openFab) {
    openFab.addEventListener("click", handlers.onToggleSidebar);
  }
  container.querySelector("#asyncModeBtn").addEventListener("click", () => handlers.onModeChange("async"));
  container.querySelector("#syncModeBtn").addEventListener("click", () => handlers.onModeChange("sync"));
  container.querySelector("#addRouteBtn").addEventListener("click", handlers.onAddRoute);
}

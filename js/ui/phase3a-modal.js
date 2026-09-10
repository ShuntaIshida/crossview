function getStateMark(state) {
  if (state === "done") return "✓";
  if (state === "error") return "!";
  if (state === "running") return "→";
  return "○";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function fmtAny(value) {
  if (value == null) return "-";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "-";
  return String(value);
}

function fmtMs(value) {
  return Number.isFinite(value) ? `${value.toFixed(3)} ms` : "-";
}

function fmtSec(value) {
  return Number.isFinite(value) ? `${value.toFixed(3)} sec` : "-";
}

function fmtBytes(bytes) {
  if (!Number.isFinite(bytes)) return "-";
  const unit = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < unit.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index === 0 ? 0 : 2)} ${unit[index]}`;
}

function renderFrameCards(frames) {
  return (frames || [])
    .map(
      (frame) => `
        <article class="phase3a-frame-card">
          <h4>${escapeHtml(fmtSec(frame.targetTimeSec))}</h4>
          <img src="${escapeHtml(frame.previewUrl)}" alt="${escapeHtml(fmtSec(frame.targetTimeSec))} のプレビュー" />
          <div class="kv-grid compact-grid">
            <div>targetTime</div><div>${escapeHtml(fmtSec(frame.targetTimeSec))}</div>
            <div>actual currentTime</div><div>${escapeHtml(fmtSec(frame.actualCurrentTimeSec))}</div>
            <div>seek</div><div>${escapeHtml(fmtMs(frame.seekDurationMs))}</div>
            <div>draw</div><div>${escapeHtml(fmtMs(frame.drawDurationMs))}</div>
            <div>encode</div><div>${escapeHtml(fmtMs(frame.encodeDurationMs))}</div>
            <div>total</div><div>${escapeHtml(fmtMs(frame.totalDurationMs))}</div>
            <div>frame width</div><div>${escapeHtml(fmtAny(frame.frameWidth))}</div>
            <div>frame height</div><div>${escapeHtml(fmtAny(frame.frameHeight))}</div>
            <div>WebP blob size</div><div>${escapeHtml(fmtBytes(frame.blobSize))}</div>
            <div>mimeType</div><div>${escapeHtml(frame.mimeType || "-")}</div>
            <div>黒フレーム疑い</div><div>${frame.blackFrameLikely ? "Yes" : "No"}</div>
          </div>
        </article>
      `
    )
    .join("");
}

function renderResult(result) {
  const file = result.file || {};
  const decode = result.decode || {};
  const frames = result.frames || [];

  return `
    <section class="phase2a-result">
      <h2>Phase 3A 検証結果</h2>

      <section class="result-block">
        <h3>File</h3>
        <div class="kv-grid">
          <div>fileName</div><div>${escapeHtml(file.fileName || "-")}</div>
          <div>size</div><div>${escapeHtml(fmtBytes(file.sizeBytes))}</div>
          <div>duration</div><div>${escapeHtml(fmtSec(file.durationSec))}</div>
          <div>videoWidth</div><div>${escapeHtml(fmtAny(file.videoWidth))}</div>
          <div>videoHeight</div><div>${escapeHtml(fmtAny(file.videoHeight))}</div>
          <div>codec</div><div>${escapeHtml(file.codec || "-")}</div>
          <div>mimeType</div><div>${escapeHtml(file.mimeType || "-")}</div>
        </div>
      </section>

      <section class="result-block">
        <h3>Decode</h3>
        <div class="kv-grid">
          <div>HTMLVideoElement load</div><div>${escapeHtml(decode.htmlVideoLoad || "-")}</div>
          <div>metadata loaded</div><div>${decode.metadataLoaded ? "Yes" : "No"}</div>
          <div>seek</div><div>${escapeHtml(decode.seek || "-")}</div>
          <div>canvas draw</div><div>${escapeHtml(decode.canvasDraw || "-")}</div>
          <div>WebP encode</div><div>${escapeHtml(decode.webpEncode || "-")}</div>
          <div>canPlayType(codec)</div><div>${escapeHtml(decode.canPlayTypeResult || "" || "-")}</div>
          <div>canPlayType(video/mp4)</div><div>${escapeHtml(decode.genericCanPlayType || "" || "-")}</div>
          <div>requestVideoFrameCallback</div><div>${decode.requestVideoFrameCallbackSupported ? "Yes" : "No"}</div>
          <div>video.error.code</div><div>${escapeHtml(fmtAny(decode.videoErrorCode))}</div>
          <div>browser</div><div>${escapeHtml(decode.browser || "-")}</div>
        </div>
      </section>

      <section class="result-block">
        <h3>Scale</h3>
        <div class="kv-grid">
          <div>scale</div><div>${escapeHtml(fmtAny(result.scale?.scale))}</div>
          <div>targetWidth</div><div>${escapeHtml(fmtAny(result.scale?.width))}</div>
          <div>targetHeight</div><div>${escapeHtml(fmtAny(result.scale?.height))}</div>
        </div>
      </section>

      <section class="result-block">
        <h3>Frame Previews</h3>
        <div class="phase3a-frame-grid">
          ${renderFrameCards(frames) || "<p>プレビューなし</p>"}
        </div>
      </section>
    </section>
  `;
}

export function renderPhase3AModal(state, handlers) {
  const onCancel = handlers?.onCancel;
  const items = state.stageStateList
    .map((stage) => {
      const mark = getStateMark(stage.state);
      return `<li class="step-item ${stage.state === "done" ? "done" : ""} ${stage.state === "running" ? "running" : ""} ${stage.state === "error" ? "error" : ""}">
        <span class="step-state">${mark}</span>
        <span>${stage.label}</span>
      </li>`;
    })
    .join("");

  const progressPercent = Number.isFinite(state.overallProgress) ? Math.max(0, Math.min(100, state.overallProgress)) : null;
  const logText = (state.logs || []).join("\n");
  const currentTarget = Number.isFinite(state.targetTimeSec) ? fmtSec(state.targetTimeSec) : "-";
  const running = state.status === "running";
  const errorBlock =
    state.status === "error" || state.status === "canceled"
      ? `<div class="analysis-error">
          <strong>${escapeHtml(state.errorCode || (state.status === "canceled" ? "ANALYSIS_CANCELED" : "ERROR"))}</strong>
          <p>${escapeHtml(state.errorMessage || "Phase 3Aに失敗しました")}</p>
        </div>`
      : "";

  const resultBlock = state.result ? renderResult(state.result) : "";

  const wrapper = document.createElement("section");
  wrapper.className = "analysis-modal-backdrop";
  wrapper.innerHTML = `
    <div class="analysis-modal phase3a-modal" role="dialog" aria-modal="true" aria-label="Phase 3A検証モーダル">
      <h2>Phase 3A: HEVC/H.265 MP4からWebP抽出検証</h2>
      <div class="analysis-meta">
        <div>ファイル: ${escapeHtml(state.currentFileName || "-")}</div>
        <div>状態: ${escapeHtml(state.status || "idle")}</div>
        <div>抽出地点: ${escapeHtml(fmtAny(state.currentProbeIndex))} / ${escapeHtml(fmtAny(state.probeCount))}</div>
        <div>現在ターゲット: ${escapeHtml(currentTarget)}</div>
      </div>
      <div class="progress-track ${progressPercent == null ? "indeterminate" : ""}" aria-label="全体進捗">
        <div class="progress-fill" style="width:${progressPercent == null ? 35 : progressPercent}%"></div>
      </div>
      <ul class="step-list">${items}</ul>
      ${errorBlock}
      <section class="result-block">
        <h3>ログ</h3>
        <pre class="log-block">${escapeHtml(logText || "-")}</pre>
      </section>
      ${resultBlock}
      <div class="modal-footer">
        <button class="cancel-btn" id="closePhase3ABtn">${running ? "キャンセル" : "閉じる"}</button>
      </div>
    </div>
  `;

  wrapper.querySelector("#closePhase3ABtn")?.addEventListener("click", () => {
    onCancel?.();
  });

  return wrapper;
}

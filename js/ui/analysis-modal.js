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

function fmtNumber(value, digits = 6) {
  return Number.isFinite(value) ? Number(value).toFixed(digits) : "-";
}

function fmtAny(value) {
  if (value == null) return "-";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "-";
  return String(value);
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

function renderTrackTable(result) {
  const rows = (result.file.tracks || [])
    .map(
      (track) => `<tr>
      <td>${escapeHtml(fmtAny(track.id))}</td>
      <td>${escapeHtml(track.type || "-")}</td>
      <td>${escapeHtml(track.codec || "-")}</td>
      <td>${escapeHtml(track.handler || "-")}</td>
      <td>${escapeHtml(fmtAny(track.timescale))}</td>
      <td>${escapeHtml(fmtAny(track.sampleCount))}</td>
    </tr>`
    )
    .join("");

  return `
    <section class="result-block">
      <h3>MP4 Tracks</h3>
      <div class="result-table-wrap">
        <table class="result-table">
          <thead>
            <tr>
              <th>track ID</th>
              <th>type</th>
              <th>codec</th>
              <th>handler</th>
              <th>timescale</th>
              <th>sample count</th>
            </tr>
          </thead>
          <tbody>${rows || "<tr><td colspan='6'>-</td></tr>"}</tbody>
        </table>
      </div>
    </section>
  `;
}

function renderGpsTable(top10) {
  const rows = (top10 || [])
    .map(
      (row) => `<tr>
      <td>${escapeHtml(fmtAny(row.sampleIndex))}</td>
      <td>${escapeHtml(row.timestampIso || "-")}</td>
      <td>${escapeHtml(fmtNumber(row.latitude, 7))}</td>
      <td>${escapeHtml(fmtNumber(row.longitude, 7))}</td>
      <td>${escapeHtml(fmtNumber(row.altitude, 3))}</td>
      <td>${escapeHtml(fmtNumber(row.speed2D, 3))}</td>
      <td>${escapeHtml(fmtNumber(row.speed3D, 3))}</td>
      <td>${escapeHtml(fmtAny(row.fix))}</td>
      <td>${escapeHtml(row.timestampSource || "-")}</td>
    </tr>`
    )
    .join("");

  return `
    <section class="result-block">
      <h3>Decoded GPS9 records (先頭10件)</h3>
      <div class="result-table-wrap">
        <table class="result-table compact">
          <thead>
            <tr>
              <th>#</th>
              <th>timestamp</th>
              <th>lat</th>
              <th>lng</th>
              <th>alt</th>
              <th>speed2D</th>
              <th>speed3D</th>
              <th>fix</th>
              <th>source</th>
            </tr>
          </thead>
          <tbody>${rows || "<tr><td colspan='9'>-</td></tr>"}</tbody>
        </table>
      </div>
    </section>
  `;
}

function renderResult(result) {
  const firstDecoded = result.gps.firstDecodedGps9Record;
  const firstValid = result.gps.firstValidSample;
  const phase = result.phase2a || {};
  const last = result.gps.lastSample;
  const fastModeNotScanned = !result.gps.fullFileScanned;
  const lastTimestampText = fastModeNotScanned
    ? "全ファイル未走査のため未取得"
    : result.gps.lastTimestamp || "取得できなかった";
  const lastSampleLabel = fastModeNotScanned ? "Last GPS sample (全ファイル未走査)" : "Last GPS sample";
  const keyList = (result.gpmf.detectedKeys || []).join(", ") || "-";
  const treePreview = (result.gpmf.keyTreePreview || []).join("\n\n") || "-";

  return `
    <section class="phase2a-result">
      <h2>GPMF検証結果</h2>

      <section class="result-block">
        <h3>File</h3>
        <div class="kv-grid">
          <div>ファイル名</div><div>${escapeHtml(result.file.name || "-")}</div>
          <div>duration(sec)</div><div>${escapeHtml(fmtAny(result.file.durationSec))}</div>
          <div>creation_time</div><div>${escapeHtml(result.file.creationTime || "取得できなかった")}</div>
          <div>creation_time role</div><div>Auxiliary metadata / sanity check only</div>
        </div>
      </section>

      <section class="result-block">
        <h3>Phase 2A Status</h3>
        <div class="kv-grid">
          <div>GPMF decode</div><div>${phase.gpmfDecodeSuccess ? "Success" : "Failed"}</div>
          <div>GPS9 decode</div><div>${phase.gps9DecodeSuccess ? "Success" : "Failed"}</div>
          <div>Valid GPS fix</div><div>${phase.validGpsFixFound ? "Success" : "Not found in current probe"}</div>
          <div>Coordinates</div><div>${phase.coordinatesSuccess ? "Success" : "Pending"}</div>
          <div>GPS9 absolute time</div><div>${phase.gps9AbsoluteTimeSuccess ? "Success" : "Pending"}</div>
          <div>Media-to-UTC mapping</div><div>${phase.mediaToUtcMappingSuccess ? "Success" : "Pending"}</div>
          <div>Mapping note</div><div>${escapeHtml(phase.absoluteTimeAlignmentMessage || "未検証")}</div>
          <div>Phase 2A overall</div><div>${phase.success ? "Success" : "Pending"}</div>
        </div>
      </section>

      <section class="result-block">
        <h3>Telemetry</h3>
        <div class="kv-grid">
          <div>gpmd track detected</div><div>${result.telemetry.detected ? "Yes" : "No"}</div>
          <div>gpmd track ID</div><div>${escapeHtml(fmtAny(result.telemetry.trackId))}</div>
          <div>gpmd sample count</div><div>${escapeHtml(fmtAny(result.telemetry.sampleCount))}</div>
          <div>first sample size</div><div>${escapeHtml(fmtAny(result.telemetry.firstSample?.size))}</div>
          <div>first sample timestamp</div><div>${escapeHtml(fmtAny(result.telemetry.firstSample?.dts))}</div>
          <div>first sample duration</div><div>${escapeHtml(fmtAny(result.telemetry.firstSample?.duration))}</div>
        </div>
      </section>

      <section class="result-block">
        <h3>GPMF</h3>
        <div class="kv-grid">
          <div>GPS5</div><div>${result.gpmf.GPS5 ? "Yes" : "No"}</div>
          <div>GPS9</div><div>${result.gpmf.GPS9 ? "Yes" : "No"}</div>
          <div>SCAL</div><div>${result.gpmf.SCAL ? "Yes" : "No"}</div>
          <div>TYPE</div><div>${result.gpmf.TYPE ? "Yes" : "No"}</div>
          <div>SIUN</div><div>${result.gpmf.SIUN ? "Yes" : "No"}</div>
          <div>GPSU</div><div>${result.gpmf.GPSU ? "Yes" : "No"}</div>
          <div>GPSF</div><div>${result.gpmf.GPSF ? "Yes" : "No"}</div>
          <div>GPSP</div><div>${result.gpmf.GPSP ? "Yes" : "No"}</div>
        </div>
      </section>

      <section class="result-block">
        <h3>Detected GPMF keys</h3>
        <pre class="log-block">${escapeHtml(keyList)}</pre>
      </section>

      <section class="result-block">
        <h3>GPMF FourCC Tree (sample#0-1)</h3>
        <pre class="log-block">${escapeHtml(treePreview)}</pre>
      </section>

      <section class="result-block">
        <h3>GPS</h3>
        <div class="kv-grid">
          <div>GPS9 records decoded</div><div>${escapeHtml(fmtAny(result.gps.decodedGps9RecordCount))}</div>
          <div>Valid GPS samples</div><div>${escapeHtml(fmtAny(result.gps.validGpsSampleCount))}</div>
          <div>No-fix records</div><div>${escapeHtml(fmtAny(result.gps.noFixRecordCount))}</div>
          <div>first valid timestamp</div><div>${escapeHtml(result.gps.firstTimestamp || "取得できなかった")}</div>
          <div>last timestamp</div><div>${escapeHtml(lastTimestampText)}</div>
          <div>GPSF values</div><div>${escapeHtml(result.quality.gpsfValues.length ? result.quality.gpsfValues.join(", ") : "取得できなかった")}</div>
          <div>GPSP values</div><div>${escapeHtml(result.quality.gpspValues.length ? result.quality.gpspValues.join(", ") : "取得できなかった")}</div>
        </div>
      </section>

      <section class="result-block">
        <h3>First valid GPS sample</h3>
        <div class="kv-grid">
          <div>kind</div><div>${escapeHtml(firstValid?.gpsKind || "見つからなかった")}</div>
          <div>timestamp</div><div>${escapeHtml(firstValid?.timestampIso || "見つからなかった")}</div>
          <div>timestamp source</div><div>${escapeHtml(firstValid?.timestampSource || "見つからなかった")}</div>
          <div>latitude</div><div>${escapeHtml(fmtNumber(firstValid?.latitude, 7))}</div>
          <div>longitude</div><div>${escapeHtml(fmtNumber(firstValid?.longitude, 7))}</div>
          <div>altitude</div><div>${escapeHtml(fmtNumber(firstValid?.altitude, 3))}</div>
          <div>speed2D</div><div>${escapeHtml(fmtNumber(firstValid?.speed2D, 3))}</div>
          <div>speed3D</div><div>${escapeHtml(fmtNumber(firstValid?.speed3D, 3))}</div>
          <div>fix</div><div>${escapeHtml(fmtAny(firstValid?.fix))}</div>
          <div>DOP</div><div>${escapeHtml(fmtAny(firstValid?.dop))}</div>
          <div>days since 2000</div><div>${escapeHtml(fmtAny(firstValid?.daysSince2000))}</div>
          <div>seconds since midnight</div><div>${escapeHtml(fmtAny(firstValid?.secondsSinceMidnight))}</div>
          <div>MP4 creation_time差(ms)</div><div>${escapeHtml(fmtAny(firstValid?.mp4CreationDeltaMs))}</div>
        </div>
      </section>

      <details class="result-block">
        <summary>GPS9 Decode Detail</summary>
        <div class="kv-grid">
          <div>gpmd samples inspected</div><div>${escapeHtml(fmtAny(result.gpsMeta?.gpmdSamplesInspected))} / ${escapeHtml(fmtAny(result.gpsMeta?.probeLimitGpmdSamples))}</div>
          <div>GPS9 records inspected</div><div>${escapeHtml(fmtAny(result.gpsMeta?.recordsInspected))}</div>
          <div>Invalid/no-fix skipped</div><div>${escapeHtml(fmtAny(result.gpsMeta?.invalidNoFixRecordsSkipped))}</div>
          <div>First valid GPS9 index</div><div>${escapeHtml(fmtAny(result.gpsMeta?.firstValidGps9Index))}</div>
          <div>Probe status</div><div>${escapeHtml(result.gpsMeta?.probeStatusCode || "-")}</div>
          <div>Probe message</div><div>${escapeHtml(result.gpsMeta?.probeStatusMessage || "-")}</div>
          <div>TYPE</div><div>${escapeHtml(result.gpsMeta?.firstTypeDefinition || "unknown")}</div>
          <div>SCAL</div><div>${escapeHtml(Array.isArray(result.gpsMeta?.firstScalValues) ? result.gpsMeta.firstScalValues.join(", ") : "unknown")}</div>
          <div>UNIT / SIUN</div><div>${escapeHtml(Array.isArray(result.gpsMeta?.firstSiunValues) ? result.gpsMeta.firstSiunValues.join(", ") : "unknown")}</div>
          <div>First GPS9 raw</div><div>${escapeHtml(result.gpsMeta?.firstRawBytesHex || "unknown")}</div>
          <div>First GPS9 typed</div><div>${escapeHtml(Array.isArray(result.gpsMeta?.firstTypedValues) ? result.gpsMeta.firstTypedValues.join(", ") : "unknown")}</div>
          <div>First GPS9 scaled</div><div>${escapeHtml(Array.isArray(result.gpsMeta?.firstScaledValues) ? result.gpsMeta.firstScaledValues.join(", ") : "unknown")}</div>
          <div>Decoded no-fix record</div><div>${escapeHtml(firstDecoded?.fix === 0 ? "Yes" : "No / unknown")}</div>
          <div>Decoded no-fix latitude</div><div>${escapeHtml(fmtAny(firstDecoded?.latitude ?? "unknown"))}</div>
          <div>Decoded no-fix longitude</div><div>${escapeHtml(fmtAny(firstDecoded?.longitude ?? "unknown"))}</div>
          <div>Decoded no-fix altitude</div><div>${escapeHtml(fmtAny(firstDecoded?.altitude ?? "unknown"))}</div>
          <div>Decoded no-fix speed2D</div><div>${escapeHtml(fmtAny(firstDecoded?.speed2D ?? "unknown"))}</div>
          <div>Decoded no-fix speed3D</div><div>${escapeHtml(fmtAny(firstDecoded?.speed3D ?? "unknown"))}</div>
          <div>Decoded no-fix fix</div><div>${escapeHtml(fmtAny(firstDecoded?.fix ?? "unknown"))}</div>
          <div>Decoded no-fix DOP</div><div>${escapeHtml(fmtAny(firstDecoded?.dop ?? "unknown"))}</div>
          <div>Decoded no-fix absolute timestamp</div><div>${escapeHtml(firstDecoded?.timestampTrusted ? firstDecoded?.timestampIso || "unknown" : "untrusted / no-fix")}</div>
          <div>Decoded no-fix timestamp source</div><div>${escapeHtml(firstDecoded?.timestampTrusted ? firstDecoded?.timestampSource?.startsWith("GPS9") ? "GPS9" : "unknown" : "untrusted / no-fix")}</div>
          <div>Decoded no-fix creation_time difference</div><div>${escapeHtml(Number.isFinite(firstDecoded?.mp4CreationDeltaSec) ? `${firstDecoded.mp4CreationDeltaSec.toFixed(3)} sec` : "untrusted / no-fix")}</div>
        </div>
      </details>

      <section class="result-block">
        <h3>Media-to-UTC Mapping</h3>
        <div class="kv-grid">
          <div>anchor count</div><div>${escapeHtml(fmtAny(result.timeMapping?.anchorCount))}</div>
          <div>intercept</div><div>${escapeHtml(result.timeMapping?.interceptIso || "-")}</div>
          <div>slope (ms/sec)</div><div>${escapeHtml(Number.isFinite(result.timeMapping?.slopeMsPerSec) ? result.timeMapping.slopeMsPerSec.toFixed(6) : "-")}</div>
          <div>clock drift (ppm)</div><div>${escapeHtml(Number.isFinite(result.timeMapping?.clockDriftPpm) ? result.timeMapping.clockDriftPpm.toFixed(3) : "-")}</div>
          <div>max residual (ms)</div><div>${escapeHtml(Number.isFinite(result.timeMapping?.maxResidualMs) ? result.timeMapping.maxResidualMs.toFixed(3) : "-")}</div>
          <div>RMS residual (ms)</div><div>${escapeHtml(Number.isFinite(result.timeMapping?.rmsResidualMs) ? result.timeMapping.rmsResidualMs.toFixed(3) : "-")}</div>
          <div>fallback source</div><div>${escapeHtml(result.timeMappingFallback?.status || "-")}</div>
        </div>
      </section>

      <section class="result-block">
        <h3>Anchor Diagnostics</h3>
        <div class="result-table-wrap">
          <table class="result-table compact">
            <thead>
              <tr>
                <th>probe(sec)</th>
                <th>media(sec)</th>
                <th>gpmd DTS(sec)</th>
                <th>GPS9 timestamp</th>
                <th>predicted UTC</th>
                <th>residual(ms)</th>
                <th>creation_time + DTS</th>
                <th>creation diff(sec)</th>
                <th>GPS9 repeat</th>
                <th>STMP</th>
                <th>TSMP</th>
              </tr>
            </thead>
            <tbody>${(result.timeMapping?.anchorDiagnostics || [])
              .map(
                (row) => `<tr>
                  <td>${escapeHtml(fmtAny(row.probeTimeSec))}</td>
                  <td>${escapeHtml(Number.isFinite(row.mediaTimeSec) ? row.mediaTimeSec.toFixed(3) : "-")}</td>
                  <td>${escapeHtml(Number.isFinite(row.gpmdDtsSec) ? row.gpmdDtsSec.toFixed(3) : "-")}</td>
                  <td>${escapeHtml(row.gpsAbsoluteTimeIso || row.gps9TimestampIso || "-")}</td>
                  <td>${escapeHtml(row.predictedAbsoluteTimeIso || "-")}</td>
                  <td>${escapeHtml(Number.isFinite(row.residualMs) ? row.residualMs.toFixed(3) : "-")}</td>
                  <td>${escapeHtml(row.metadata?.differenceMsVsCreationTime == null ? (row.mp4CreationPlusDtsIso || "-") : (row.metadata?.mp4CreationPlusDtsIso || row.mp4CreationPlusDtsIso || "-"))}</td>
                  <td>${escapeHtml(Number.isFinite(row.metadata?.differenceMsVsCreationTime) ? (row.metadata.differenceMsVsCreationTime / 1000).toFixed(3) : "-")}</td>
                  <td>${escapeHtml(fmtAny(row.metadata?.gps9Repeat))}</td>
                  <td>${escapeHtml(Array.isArray(row.stmpValues) && row.stmpValues.length ? row.stmpValues.join(",") : "-")}</td>
                  <td>${escapeHtml(Array.isArray(row.tsmpValues) && row.tsmpValues.length ? row.tsmpValues.join(",") : "-")}</td>
                </tr>`
              )
              .join("") || "<tr><td colspan='10'>-</td></tr>"}</tbody>
          </table>
        </div>
      </section>

      <section class="result-block">
        <h3>${lastSampleLabel}</h3>
        <div class="kv-grid">
          <div>timestamp</div><div>${escapeHtml(fastModeNotScanned ? "全ファイル未走査のため未取得" : last?.timestampIso || "取得できなかった")}</div>
          <div>latitude</div><div>${escapeHtml(fmtNumber(last?.latitude, 7))}</div>
          <div>longitude</div><div>${escapeHtml(fmtNumber(last?.longitude, 7))}</div>
          <div>altitude</div><div>${escapeHtml(fmtNumber(last?.altitude, 3))}</div>
          <div>speed2D</div><div>${escapeHtml(fmtNumber(last?.speed2D, 3))}</div>
          <div>speed3D</div><div>${escapeHtml(fmtNumber(last?.speed3D, 3))}</div>
        </div>
      </section>

      <section class="result-block">
        <h3>抽出診断</h3>
        <div class="kv-grid">
          <div>read bytes</div><div>${escapeHtml(fmtBytes(result.scan?.bytesRead))} / ${escapeHtml(fmtBytes(result.scan?.totalBytes))}</div>
          <div>read ratio</div><div>${escapeHtml(Number.isFinite(result.scan?.ratio) ? `${(result.scan.ratio * 100).toFixed(2)}%` : "-")}</div>
          <div>chunk index</div><div>${escapeHtml(fmtAny(result.scan?.chunkIndex))}</div>
          <div>fileStart</div><div>${escapeHtml(fmtAny(result.scan?.fileStart))}</div>
          <div>nextFileStart</div><div>${escapeHtml(fmtAny(result.scan?.nextFileStart))}</div>
          <div>onSamples calls</div><div>${escapeHtml(fmtAny(result.scan?.onSamplesCalls))}</div>
          <div>extracted samples</div><div>${escapeHtml(fmtAny(result.scan?.extractedSamples))}</div>
          <div>expected total samples</div><div>${escapeHtml(fmtAny(result.scan?.expectedSamples))}</div>
          <div>last sample DTS</div><div>${escapeHtml(fmtAny(result.scan?.lastSampleDts))}</div>
          <div>done reason</div><div>${escapeHtml(result.scan?.doneReason || "-")}</div>
        </div>
      </section>

      ${renderTrackTable(result)}
      ${renderGpsTable(result.gps.top10)}

      <section class="result-block">
        <h3>時刻検証メモ</h3>
        <pre class="log-block">${escapeHtml((result.timing.mappingNotes || []).join("\n") || "-")}</pre>
      </section>
    </section>
  `;
}

function fmtDurationSec(value) {
  return Number.isFinite(value) ? `${value.toFixed(3)} sec` : "-";
}

function fmtGapSec(value) {
  return Number.isFinite(value) ? `${value.toFixed(3)} sec` : "-";
}

function fmtMediaTime(value) {
  return Number.isFinite(value) ? `${value.toFixed(3)} sec` : "-";
}

function fmtStatus(value) {
  return value || "-";
}

function renderPhase2BResult(result) {
  const successfulFiles = result.successfulFiles || result.files || [];
  const failedFiles = result.failedFiles || [];
  const continuityLinks = result.continuity?.links || [];
  const segments = result.segments || [];

  const filesRows = successfulFiles
    .map(
      (file) => `<tr>
      <td>${escapeHtml(file.fileName || "-")}</td>
      <td>${escapeHtml(fmtDurationSec(file.durationSec))}</td>
      <td>${escapeHtml(file.fileStartUtc || "-")}</td>
      <td>${escapeHtml(file.fileEndUtc || "-")}</td>
      <td>${escapeHtml(file.mappingSource || "-")}</td>
      <td>${escapeHtml(file.mappingQuality || "-")}</td>
      <td>${escapeHtml(file.gpsFormat || "-")}</td>
    </tr>`
    )
    .join("");

  const sortedRows = (result.sortedOrder || [])
    .map(
      (item) => `<tr>
      <td>${escapeHtml(fmtAny(item.order))}</td>
      <td>${escapeHtml(item.fileName || "-")}</td>
      <td>${escapeHtml(item.fileStartUtc || "-")}</td>
      <td>${escapeHtml(item.fileEndUtc || "-")}</td>
    </tr>`
    )
    .join("");

  const continuityRows = continuityLinks
    .map(
      (link) => `<tr>
      <td>${escapeHtml(link.currentFile || "-")} → ${escapeHtml(link.nextFile || "-")}</td>
      <td>${escapeHtml(link.currentEndUtc || "-")}</td>
      <td>${escapeHtml(link.nextStartUtc || "-")}</td>
      <td>${escapeHtml(fmtGapSec(link.gapSec))}</td>
      <td>${escapeHtml(link.relation || "-")}</td>
    </tr>`
    )
    .join("");

  const segmentRows = segments
    .map(
      (segment) => `<tr>
      <td>${escapeHtml(segment.segmentId || "-")}</td>
      <td>${escapeHtml(segment.startTime || "-")}</td>
      <td>${escapeHtml(segment.endTime || "-")}</td>
      <td>${escapeHtml((segment.files || []).map((file) => file.fileName).join(", ") || "-")}</td>
    </tr>`
    )
    .join("");

  const failedRows = failedFiles
    .map(
      (file) => `<tr>
      <td>${escapeHtml(file.fileName || "-")}</td>
      <td>${escapeHtml(file.errorCode || "-")}</td>
      <td>${escapeHtml(file.errorMessage || "-")}</td>
    </tr>`
    )
    .join("");

  const mappingSourceRows = (result.timeSourceAudit?.rows || [])
    .map(
      (row) => `<tr>
      <td>${escapeHtml(row.fileName || "-")}</td>
      <td>${escapeHtml(row.mappingSource || "-")}</td>
      <td>${escapeHtml(row.mappingQuality || "-")}</td>
      <td>${escapeHtml(row.mappingSourceReason || "-")}</td>
    </tr>`
    )
    .join("");

  return `
    <section class="phase2a-result">
      <h2>Phase 2B 検証結果</h2>

      <section class="result-block">
        <h3>Summary</h3>
        <div class="kv-grid">
          <div>Route</div><div>${escapeHtml(result.routeLabel || "-")}</div>
          <div>status</div><div>${result.ok ? "success" : "failed"}</div>
          <div>成功ファイル数</div><div>${escapeHtml(fmtAny(successfulFiles.length))}</div>
          <div>失敗ファイル数</div><div>${escapeHtml(fmtAny(failedFiles.length))}</div>
          <div>continuity tolerance</div><div>${escapeHtml(fmtGapSec(result.continuityToleranceSec))}</div>
          <div>segment数</div><div>${escapeHtml(fmtAny(segments.length))}</div>
        </div>
      </section>

      <section class="result-block">
        <h3>Files</h3>
        <div class="result-table-wrap">
          <table class="result-table compact">
            <thead>
              <tr>
                <th>fileName</th>
                <th>duration</th>
                <th>fileStartUtc</th>
                <th>fileEndUtc</th>
                <th>mappingSource</th>
                <th>mappingQuality</th>
                <th>GPS format</th>
              </tr>
            </thead>
            <tbody>${filesRows || "<tr><td colspan='7'>-</td></tr>"}</tbody>
          </table>
        </div>
      </section>

      <section class="result-block">
        <h3>Sorted order</h3>
        <div class="result-table-wrap">
          <table class="result-table compact">
            <thead>
              <tr>
                <th>#</th>
                <th>file</th>
                <th>start</th>
                <th>end</th>
              </tr>
            </thead>
            <tbody>${sortedRows || "<tr><td colspan='4'>-</td></tr>"}</tbody>
          </table>
        </div>
      </section>

      <section class="result-block">
        <h3>Continuity</h3>
        <div class="result-table-wrap">
          <table class="result-table compact">
            <thead>
              <tr>
                <th>pair</th>
                <th>current end</th>
                <th>next start</th>
                <th>gap</th>
                <th>判定</th>
              </tr>
            </thead>
            <tbody>${continuityRows || "<tr><td colspan='5'>-</td></tr>"}</tbody>
          </table>
        </div>
      </section>

      <section class="result-block">
        <h3>Segments</h3>
        <div class="result-table-wrap">
          <table class="result-table compact">
            <thead>
              <tr>
                <th>segmentId</th>
                <th>start</th>
                <th>end</th>
                <th>files</th>
              </tr>
            </thead>
            <tbody>${segmentRows || "<tr><td colspan='4'>-</td></tr>"}</tbody>
          </table>
        </div>
      </section>

      <section class="result-block">
        <h3>Mapping source semantics</h3>
        <p>${escapeHtml(result.timeSourceAudit?.note || "-")}</p>
        <div class="result-table-wrap">
          <table class="result-table compact">
            <thead>
              <tr>
                <th>file</th>
                <th>source</th>
                <th>quality</th>
                <th>reason</th>
              </tr>
            </thead>
            <tbody>${mappingSourceRows || "<tr><td colspan='4'>-</td></tr>"}</tbody>
          </table>
        </div>
      </section>

      <section class="result-block">
        <h3>失敗ファイル</h3>
        <div class="result-table-wrap">
          <table class="result-table compact">
            <thead>
              <tr>
                <th>fileName</th>
                <th>errorCode</th>
                <th>errorMessage</th>
              </tr>
            </thead>
            <tbody>${failedRows || "<tr><td colspan='3'>なし</td></tr>"}</tbody>
          </table>
        </div>
      </section>
    </section>
  `;
}

function renderPhase3BResult(result) {
  const multiMp4Status = Number(result.fileCount || 0) >= 2 ? (result.verification?.multiMp4 ? "Success" : "Failed") : "Skipped";
  const verificationRows = [
    ["複数MP4処理", multiMp4Status],
    ["Segment境界処理", result.verification?.segmentBoundaries],
    ["recording gap除外", result.verification?.recordingGapExcluded],
    ["absolute UTC付与", result.verification?.absoluteUtcAssigned],
    ["WebP 960px", result.verification?.webp960px],
    ["WebP quality 0.8", result.verification?.webpQuality08]
  ]
    .map(
      ([label, status]) => `<tr>
        <td>${escapeHtml(label)}</td>
        <td>${escapeHtml(status)}</td>
      </tr>`
    )
    .join("");

  return `
    <section class="phase2a-result">
      <h2>Phase 3B 検証結果</h2>

      <section class="result-block">
        <h3>Summary</h3>
        <div class="kv-grid">
          <div>Status</div><div>${escapeHtml(fmtStatus(result.status))}</div>
          <div>Route</div><div>${escapeHtml(result.routeLabel || "-")}</div>
          <div>抽出間隔</div><div>${escapeHtml(fmtMediaTime(result.frameIntervalSec))}</div>
          <div>対象MP4数</div><div>${escapeHtml(fmtAny(result.fileCount))}</div>
          <div>Segment数</div><div>${escapeHtml(fmtAny(result.segmentCount))}</div>
          <div>生成予定枚数</div><div>${escapeHtml(fmtAny(result.plannedCount))}</div>
          <div>実生成枚数</div><div>${escapeHtml(fmtAny(result.generatedCount))}</div>
          <div>失敗枚数</div><div>${escapeHtml(fmtAny(result.failedCount))}</div>
          <div>処理時間</div><div>${escapeHtml(Number.isFinite(result.elapsedMs) ? `${result.elapsedMs.toFixed(3)} ms` : "-")}</div>
          <div>平均WebPサイズ</div><div>${escapeHtml(fmtBytes(result.averageWebpSizeBytes))}</div>
          <div>WebP総容量</div><div>${escapeHtml(fmtBytes(result.estimatedTotalBytes))}</div>
          <div>Phase 3B overall</div><div>${result.overallSuccess ? "Success" : "Failed"}</div>
        </div>
      </section>

      <section class="result-block">
        <h3>検証項目</h3>
        <div class="result-table-wrap">
          <table class="result-table compact">
            <thead>
              <tr>
                <th>項目</th>
                <th>結果</th>
              </tr>
            </thead>
            <tbody>${verificationRows}</tbody>
          </table>
        </div>
      </section>
    </section>
  `;
}

export function renderAnalysisModal(progress, handlers) {
  const onCancel = typeof handlers === "function" ? handlers : handlers?.onCancel;
  const onCommitRoute = typeof handlers === "function" ? null : handlers?.onCommitRoute;
  const items = progress.stageStateList
    .map((stage) => {
      const mark = getStateMark(stage.state);
      return `<li class="step-item ${stage.state === "done" ? "done" : ""} ${stage.state === "running" ? "running" : ""} ${stage.state === "error" ? "error" : ""}">
        <span class="step-state">${mark}</span>
        <span>${stage.label}</span>
      </li>`;
    })
    .join("");

  const progressPercent = Number.isFinite(progress.overallProgress) ? Math.max(0, Math.min(100, progress.overallProgress)) : null;
  const running = progress.status === "running";
  const isPhase2B = progress.phase === "phase2b";
  const isPhase3B = progress.phase === "phase3b";
  const logText = (progress.logs || []).join("\n");
  const liveExtract = progress.extraction || {};
  const readRatioText = Number.isFinite(liveExtract.ratio) ? `${(liveExtract.ratio * 100).toFixed(2)}%` : "-";
  const expectedSamplesText = liveExtract.expectedSamples == null ? "-" : String(liveExtract.expectedSamples);
  const fileProgressText = Number.isFinite(progress.fileProgressPercent) ? `${progress.fileProgressPercent.toFixed(1)}%` : "-";
  const stageLabel = progress.currentStageLabel || progress.stageStateList[progress.stageIndex]?.label || "-";

  const errorBlock =
    progress.status === "error" || progress.status === "canceled"
      ? `<div class="analysis-error">
          <strong>${escapeHtml(progress.errorCode || (progress.status === "canceled" ? "ANALYSIS_CANCELED" : "ERROR"))}</strong>
          <p>${escapeHtml(progress.errorMessage || "解析に失敗しました")}</p>
        </div>`
      : "";

  const hasPhaseResult = Boolean(progress.result) && (progress.status === "done" || progress.status === "error" || progress.status === "canceled");
  const resultBlock = hasPhaseResult ? (isPhase3B ? renderPhase3BResult(progress.result) : isPhase2B ? renderPhase2BResult(progress.result) : renderResult(progress.result)) : "";
  const phaseStatusText =
    progress.status === "done" && progress.result && !isPhase2B && !isPhase3B
      ? progress.result.phase2a?.message || progress.status
      : progress.status || "idle";

  const phase3BProgressBlock = isPhase3B && progress.status === "running"
    ? `<section class="result-block">
        <h3>WebP生成中の進捗</h3>
        <div class="kv-grid">
          <div>現在ファイル</div><div>${escapeHtml(progress.currentFileName || "-")}</div>
          <div>現在Segment</div><div>${escapeHtml(progress.currentSegmentLabel || "-")}</div>
          <div>生成済み / 予定枚数</div><div>${escapeHtml(fmtAny(progress.webpDone))} / ${escapeHtml(fmtAny(progress.webpTotal))}</div>
          <div>現在absolute UTC</div><div>${escapeHtml(progress.currentAbsoluteUtc || "-")}</div>
          <div>現在media time</div><div>${escapeHtml(fmtMediaTime(progress.currentMediaTimeSec))}</div>
        </div>
      </section>`
    : "";

  const actionButtons = running
    ? `<button class="cancel-btn" id="cancelAnalysisBtn">キャンセル</button>`
    : isPhase2B && progress.status === "done" && progress.canCommitRoute
      ? `<button class="ghost-btn" id="closeAnalysisBtn">閉じる</button>
         <button class="cancel-btn" id="commitRouteBtn">Routeを追加</button>`
      : `<button class="cancel-btn" id="cancelAnalysisBtn">閉じる</button>`;

  const wrapper = document.createElement("section");
  wrapper.className = "analysis-modal-backdrop";
  wrapper.innerHTML = `
    <div class="analysis-modal" role="dialog" aria-modal="true" aria-label="Route解析モーダル">
      <h2>${isPhase3B ? "Phase 3B: Segment WebP生成" : isPhase2B ? "Phase 2B: 複数MP4時系列整列とSegment化" : "Phase 2A: GPMF/GPS技術検証"}</h2>
      <div class="analysis-meta">
        <div>Route: ${progress.routeLabel || "-"}</div>
        <div>ファイル: ${progress.currentFileName || "-"}</div>
        <div>ファイル進行: ${progress.fileIndex} / ${progress.fileTotal}</div>
        <div>現在ステージ: ${escapeHtml(stageLabel)}</div>
        <div>ファイル単位進捗: ${escapeHtml(fileProgressText)}</div>
        <div>成功済み: ${escapeHtml(fmtAny(progress.successFileCount))}</div>
        <div>失敗: ${escapeHtml(fmtAny(progress.failedFileCount))}</div>
        <div>状態: ${escapeHtml(phaseStatusText)}</div>
      </div>
      <div class="progress-track ${progressPercent == null ? "indeterminate" : ""}" aria-label="全体進捗">
        <div class="progress-fill" style="width:${progressPercent == null ? 35 : progressPercent}%"></div>
      </div>
      <ul class="step-list">${items}</ul>
      ${isPhase3B ? phase3BProgressBlock : `<section class="result-block">
        <h3>gpmd抽出中の進捗</h3>
        <div class="kv-grid">
          <div>読み込み</div><div>${escapeHtml(fmtBytes(liveExtract.bytesRead))} / ${escapeHtml(fmtBytes(liveExtract.totalBytes))} (${escapeHtml(readRatioText)})</div>
          <div>取得済み</div><div>${escapeHtml(fmtAny(liveExtract.extractedSamples))} samples / expected ${escapeHtml(expectedSamplesText)}</div>
          <div>onSamples calls</div><div>${escapeHtml(fmtAny(liveExtract.onSamplesCalls))}</div>
          <div>chunk番号</div><div>${escapeHtml(fmtAny(liveExtract.chunkIndex))}</div>
          <div>fileStart</div><div>${escapeHtml(fmtAny(liveExtract.fileStart))}</div>
          <div>nextFileStart</div><div>${escapeHtml(fmtAny(liveExtract.nextFileStart))}</div>
          <div>last sample DTS</div><div>${escapeHtml(fmtAny(liveExtract.lastSampleDts))}</div>
        </div>
      </section>`}
      ${errorBlock}
      <section class="result-block">
        <h3>解析ログ</h3>
        <pre class="log-block">${escapeHtml(logText || "-")}</pre>
      </section>
      ${resultBlock}
      <div class="modal-footer">
        ${actionButtons}
      </div>
    </div>
  `;

  const cancelBtn = wrapper.querySelector("#cancelAnalysisBtn");
  if (cancelBtn) {
    cancelBtn.addEventListener("click", () => {
      onCancel?.();
    });
  }

  const closeBtn = wrapper.querySelector("#closeAnalysisBtn");
  if (closeBtn) {
    closeBtn.addEventListener("click", () => {
      onCancel?.();
    });
  }

  const commitBtn = wrapper.querySelector("#commitRouteBtn");
  if (commitBtn) {
    commitBtn.addEventListener("click", () => {
      onCommitRoute?.();
    });
  }

  return wrapper;
}

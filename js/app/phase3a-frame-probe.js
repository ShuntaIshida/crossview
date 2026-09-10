import * as MP4Box from "mp4box";

const METADATA_CHUNK_SIZE = 1024 * 1024;
const FRAME_TARGETS_SEC = [10, 60, 300];
const MAX_EDGE_PX = 960;
const WEBP_QUALITY = 0.8;

export class Phase3AError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "Phase3AError";
    this.code = code;
    this.details = details;
  }
}

export const PHASE3A_STAGES = [
  "MP4を確認",
  "HTMLVideoElementを初期化",
  "メタデータを取得",
  "指定時刻へseek",
  "Canvasへ描画",
  "WebPを生成",
  "結果を確認"
];

export async function probeHevcFrameExtraction(file, { signal, onStage, onLog, onProgress } = {}) {
  const notifyStage = (index, state = "running") => onStage?.({ index, state });
  const log = (line) => onLog?.(line);
  const previewUrls = [];
  let sourceObjectUrl = null;
  let video = null;
  let partialResult = createPartialResult(file);

  const cleanup = () => {
    try {
      if (video) {
        video.pause();
        video.removeAttribute("src");
        video.load();
        video.remove();
      }
    } catch {
      // noop
    }

    if (sourceObjectUrl) {
      URL.revokeObjectURL(sourceObjectUrl);
      sourceObjectUrl = null;
    }

    for (const url of previewUrls.splice(0)) {
      URL.revokeObjectURL(url);
    }
  };

  try {
    throwIfAborted(signal);

    notifyStage(0, "running");
    const mp4Info = await readMp4VideoMetadata(file, signal);
    partialResult.file.codec = mp4Info.codec;
    notifyStage(0, "done");

    notifyStage(1, "running");
    sourceObjectUrl = URL.createObjectURL(file);
    video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    video.playsInline = true;
    video.crossOrigin = "anonymous";
    video.style.position = "fixed";
    video.style.left = "-9999px";
    video.style.top = "-9999px";
    video.style.width = "1px";
    video.style.height = "1px";
    video.src = sourceObjectUrl;
    document.body.append(video);
    partialResult.decode.htmlVideoLoad = "success";
    notifyStage(1, "done");

    const codecMimeType = mp4Info.codec ? `video/mp4; codecs="${mp4Info.codec}"` : "video/mp4";
    const canPlayTypeResult = video.canPlayType(codecMimeType);
    const genericCanPlayType = video.canPlayType("video/mp4");
    partialResult.file.mimeType = codecMimeType;
    partialResult.decode.canPlayTypeResult = canPlayTypeResult;
    partialResult.decode.genericCanPlayType = genericCanPlayType;
    log(`canPlayType(${codecMimeType}) => ${canPlayTypeResult || ""}`);
    log(`canPlayType(video/mp4) => ${genericCanPlayType || ""}`);

    notifyStage(2, "running");
    const metadata = await loadVideoMetadata(video, signal);
    notifyStage(2, "done");

    partialResult = {
      ...partialResult,
      file: {
        ...partialResult.file,
        durationSec: metadata.durationSec,
        videoWidth: metadata.videoWidth,
        videoHeight: metadata.videoHeight
      },
      decode: {
        ...partialResult.decode,
        metadataLoaded: true,
        loadedMetadataReached: true,
        requestVideoFrameCallbackSupported: typeof video.requestVideoFrameCallback === "function"
      }
    };

    const probeTimesSec = FRAME_TARGETS_SEC.filter((sec) => sec < metadata.durationSec);
    if (probeTimesSec.length === 0 && Number.isFinite(metadata.durationSec) && metadata.durationSec > 0) {
      probeTimesSec.push(Math.max(0, Math.min(metadata.durationSec - 0.25, metadata.durationSec / 2)));
    }

    const scaleInfo = calculateScaledSize(metadata.videoWidth, metadata.videoHeight, MAX_EDGE_PX);
    partialResult.scale = scaleInfo;

    for (let i = 0; i < probeTimesSec.length; i += 1) {
      throwIfAborted(signal);
      notifyStage(3, "running");
      notifyStage(4, "pending");
      notifyStage(5, "pending");
      onProgress?.({
        currentProbeIndex: i + 1,
        probeCount: probeTimesSec.length,
        targetTimeSec: probeTimesSec[i],
        overallProgress: 20 + (i / Math.max(1, probeTimesSec.length)) * 70
      });

      const frame = await extractFrameAtTime({
        video,
        targetTimeSec: probeTimesSec[i],
        scaledWidth: scaleInfo.width,
        scaledHeight: scaleInfo.height,
        signal
      });

      partialResult.decode.seek = "success";
      notifyStage(3, "done");
      notifyStage(4, "running");
      partialResult.decode.canvasDraw = "success";
      notifyStage(4, "done");
      notifyStage(5, "running");
      partialResult.decode.webpEncode = "success";
      notifyStage(5, "done");

      previewUrls.push(frame.previewUrl);
      partialResult.frames = [...partialResult.frames, frame];
      log(
        `frame ${i + 1}/${probeTimesSec.length}: target=${frame.targetTimeSec.toFixed(3)} actual=${frame.actualCurrentTimeSec.toFixed(3)} blob=${frame.blobSize}B black=${frame.blackFrameLikely ? "yes" : "no"}`
      );
    }

    notifyStage(6, "running");
    notifyStage(6, "done");
    onProgress?.({
      currentProbeIndex: partialResult.frames.length,
      probeCount: probeTimesSec.length,
      overallProgress: 100
    });

    return {
      ok: true,
      file: partialResult.file,
      decode: partialResult.decode,
      scale: partialResult.scale,
      frames: partialResult.frames,
      cleanup
    };
  } catch (error) {
    const videoErrorCode = video?.error?.code ?? null;
    if (error instanceof Phase3AError) {
      error.details = buildErrorDetails(partialResult, error.details, videoErrorCode);
      cleanup();
      throw error;
    }

    cleanup();
    throw new Phase3AError("PHASE3A_FAILED", error?.message || String(error), buildErrorDetails(partialResult, null, videoErrorCode));
  }
}

export async function openVideoFrameSource(file, { signal, onLog } = {}) {
  const log = (line) => onLog?.(line);
  throwIfAborted(signal);

  const mp4Info = await readMp4VideoMetadata(file, signal);
  const sourceObjectUrl = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.preload = "metadata";
  video.muted = true;
  video.playsInline = true;
  video.crossOrigin = "anonymous";
  video.style.position = "fixed";
  video.style.left = "-9999px";
  video.style.top = "-9999px";
  video.style.width = "1px";
  video.style.height = "1px";
  video.src = sourceObjectUrl;
  document.body.append(video);

  try {
    const codecMimeType = mp4Info.codec ? `video/mp4; codecs="${mp4Info.codec}"` : "video/mp4";
    const canPlayTypeResult = video.canPlayType(codecMimeType);
    const genericCanPlayType = video.canPlayType("video/mp4");
    log(`canPlayType(${codecMimeType}) => ${canPlayTypeResult || ""}`);
    log(`canPlayType(video/mp4) => ${genericCanPlayType || ""}`);

    const metadata = await loadVideoMetadata(video, signal);
    const scaleInfo = calculateScaledSize(metadata.videoWidth, metadata.videoHeight, MAX_EDGE_PX);

    return {
      file: {
        fileName: file.name,
        sizeBytes: file.size,
        durationSec: metadata.durationSec,
        videoWidth: metadata.videoWidth,
        videoHeight: metadata.videoHeight,
        codec: mp4Info.codec,
        mimeType: codecMimeType
      },
      decode: {
        canPlayTypeResult,
        genericCanPlayType,
        requestVideoFrameCallbackSupported: typeof video.requestVideoFrameCallback === "function"
      },
      scale: scaleInfo,
      async extractWebpFrame(mediaTimeSec) {
        return extractFrameAtTime({
          video,
          targetTimeSec: mediaTimeSec,
          scaledWidth: scaleInfo.width,
          scaledHeight: scaleInfo.height,
          signal,
          createPreviewUrl: false
        });
      },
      cleanup() {
        try {
          video.pause();
          video.removeAttribute("src");
          video.load();
          video.remove();
        } catch {
          // noop
        }
        URL.revokeObjectURL(sourceObjectUrl);
      }
    };
  } catch (error) {
    try {
      video.pause();
      video.removeAttribute("src");
      video.load();
      video.remove();
    } catch {
      // noop
    }
    URL.revokeObjectURL(sourceObjectUrl);
    throw error;
  }
}

function createPartialResult(file) {
  return {
    file: {
      fileName: file.name,
      sizeBytes: file.size,
      durationSec: null,
      videoWidth: null,
      videoHeight: null,
      codec: null,
      mimeType: null
    },
    decode: {
      htmlVideoLoad: "pending",
      metadataLoaded: false,
      seek: "pending",
      canvasDraw: "pending",
      webpEncode: "pending",
      canPlayTypeResult: "",
      genericCanPlayType: "",
      browser: navigator.userAgent,
      videoErrorCode: null,
      loadedMetadataReached: false,
      requestVideoFrameCallbackSupported: false
    },
    scale: null,
    frames: []
  };
}

function readMp4VideoMetadata(file, signal) {
  return new Promise((resolve, reject) => {
    const mp4boxfile = MP4Box.createFile();
    let settled = false;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      try {
        mp4boxfile.stop();
      } catch {
        // noop
      }
      resolve(value);
    };

    const fail = (error) => {
      if (settled) return;
      settled = true;
      try {
        mp4boxfile.stop();
      } catch {
        // noop
      }
      reject(error);
    };

    signal?.addEventListener(
      "abort",
      () => {
        fail(new Phase3AError("ANALYSIS_CANCELED", "Phase 3Aをキャンセルしました"));
      },
      { once: true }
    );

    mp4boxfile.onError = (message) => {
      fail(new Phase3AError("MP4_METADATA_FAILED", `MP4メタデータ解析に失敗しました: ${message}`));
    };

    mp4boxfile.onReady = (info) => {
      const videoTrack = (info.tracks || []).find(
        (track) =>
          String(track.type || "").toLowerCase() === "video" ||
          String(track.codec || "").toLowerCase().includes("hvc1") ||
          String(track.codec || "").toLowerCase().includes("hev1")
      );

      finish({
        codec: videoTrack?.codec || null,
        width: numberOrNull(videoTrack?.video?.width) ?? numberOrNull(videoTrack?.track_width) ?? null,
        height: numberOrNull(videoTrack?.video?.height) ?? numberOrNull(videoTrack?.track_height) ?? null
      });
    };

    (async () => {
      try {
        let offset = 0;
        while (!settled && offset < file.size) {
          throwIfAborted(signal);
          const chunk = await file.slice(offset, Math.min(offset + METADATA_CHUNK_SIZE, file.size)).arrayBuffer();
          chunk.fileStart = offset;
          offset = mp4boxfile.appendBuffer(chunk);
          if (!Number.isFinite(offset)) {
            fail(new Phase3AError("MP4_METADATA_FAILED", "MP4メタデータ解析で無効なオフセットが返されました"));
            return;
          }
        }
      } catch (error) {
        fail(error instanceof Phase3AError ? error : new Phase3AError("MP4_METADATA_FAILED", error?.message || String(error)));
      }
    })();
  });
}

function loadVideoMetadata(video, signal) {
  return new Promise((resolve, reject) => {
    if (Number.isFinite(video.duration) && video.videoWidth > 0 && video.videoHeight > 0) {
      resolve({
        durationSec: video.duration,
        videoWidth: video.videoWidth,
        videoHeight: video.videoHeight
      });
      return;
    }

    const cleanupListeners = () => {
      video.removeEventListener("loadedmetadata", onLoadedMetadata);
      video.removeEventListener("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };

    const onAbort = () => {
      cleanupListeners();
      reject(new Phase3AError("ANALYSIS_CANCELED", "Phase 3Aをキャンセルしました"));
    };

    const onError = () => {
      cleanupListeners();
      reject(
        new Phase3AError("HEVC_DECODE_UNAVAILABLE", "HTMLVideoElementでHEVC/H.265をdecodeできませんでした", {
          videoErrorCode: video.error?.code ?? null,
          loadedMetadataReached: false
        })
      );
    };

    const onLoadedMetadata = () => {
      cleanupListeners();
      if (!Number.isFinite(video.duration) || video.videoWidth <= 0 || video.videoHeight <= 0) {
        reject(
          new Phase3AError("HEVC_DECODE_UNAVAILABLE", "loadedmetadata後も動画寸法またはdurationを取得できませんでした", {
            videoErrorCode: video.error?.code ?? null,
            loadedMetadataReached: true
          })
        );
        return;
      }
      resolve({
        durationSec: video.duration,
        videoWidth: video.videoWidth,
        videoHeight: video.videoHeight
      });
    };

    video.addEventListener("loadedmetadata", onLoadedMetadata, { once: true });
    video.addEventListener("error", onError, { once: true });
    signal?.addEventListener("abort", onAbort, { once: true });
    video.load();
  });
}

async function extractFrameAtTime({ video, targetTimeSec, scaledWidth, scaledHeight, signal, createPreviewUrl = true }) {
  const safeTargetTimeSec = clampTargetTime(video.duration, targetTimeSec);
  const perfStarted = performance.now();
  const seekStarted = performance.now();
  await seekVideo(video, safeTargetTimeSec, signal);
  const seekEnded = performance.now();

  const drawStarted = performance.now();
  await waitForPaintableFrame(video, signal);

  const canvas = document.createElement("canvas");
  canvas.width = scaledWidth;
  canvas.height = scaledHeight;

  const ctx = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
  if (!ctx) {
    throw new Phase3AError("CANVAS_CONTEXT_UNAVAILABLE", "2D Canvas contextを取得できませんでした");
  }

  ctx.drawImage(video, 0, 0, scaledWidth, scaledHeight);
  const drawEnded = performance.now();

  const blackFrameLikely = detectNearBlackFrame(ctx, scaledWidth, scaledHeight);
  if (scaledWidth <= 0 || scaledHeight <= 0) {
    throw new Phase3AError("FRAME_SIZE_INVALID", "フレームサイズが0です");
  }

  const encodeStarted = performance.now();
  const blob = await canvasToBlob(canvas, "image/webp", WEBP_QUALITY, signal);
  const encodeEnded = performance.now();

  return {
    targetTimeSec: safeTargetTimeSec,
    actualCurrentTimeSec: video.currentTime,
    seekDurationMs: roundMs(seekEnded - seekStarted),
    drawDurationMs: roundMs(drawEnded - drawStarted),
    encodeDurationMs: roundMs(encodeEnded - encodeStarted),
    totalDurationMs: roundMs(encodeEnded - perfStarted),
    frameWidth: scaledWidth,
    frameHeight: scaledHeight,
    mimeType: blob.type,
    blobSize: blob.size,
    previewUrl: createPreviewUrl ? URL.createObjectURL(blob) : null,
    blob,
    blackFrameLikely
  };
}

function seekVideo(video, targetTimeSec, signal) {
  return new Promise((resolve, reject) => {
    const cleanupListeners = () => {
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };

    const onAbort = () => {
      cleanupListeners();
      reject(new Phase3AError("ANALYSIS_CANCELED", "Phase 3Aをキャンセルしました"));
    };

    const onError = () => {
      cleanupListeners();
      reject(new Phase3AError("SEEK_FAILED", "seek中に動画decodeエラーが発生しました", {
        videoErrorCode: video.error?.code ?? null
      }));
    };

    const onSeeked = () => {
      cleanupListeners();
      resolve();
    };

    video.addEventListener("seeked", onSeeked, { once: true });
    video.addEventListener("error", onError, { once: true });
    signal?.addEventListener("abort", onAbort, { once: true });
    video.currentTime = targetTimeSec;
  });
}

function waitForPaintableFrame(video, signal) {
  if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    return waitForAnimationFrame(signal);
  }

  if (typeof video.requestVideoFrameCallback === "function") {
    return new Promise((resolve, reject) => {
      let callbackId = null;
      let settled = false;
      let timeoutId = null;
      const onAbort = () => {
        if (settled) {
          return;
        }
        settled = true;
        if (callbackId != null && typeof video.cancelVideoFrameCallback === "function") {
          video.cancelVideoFrameCallback(callbackId);
        }
        if (timeoutId != null) {
          clearTimeout(timeoutId);
        }
        signal?.removeEventListener("abort", onAbort);
        reject(new Phase3AError("ANALYSIS_CANCELED", "Phase 3Aをキャンセルしました"));
      };

      signal?.addEventListener("abort", onAbort, { once: true });
      callbackId = video.requestVideoFrameCallback(() => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeoutId != null) {
          clearTimeout(timeoutId);
        }
        signal?.removeEventListener("abort", onAbort);
        resolve();
      });

      timeoutId = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        if (callbackId != null && typeof video.cancelVideoFrameCallback === "function") {
          video.cancelVideoFrameCallback(callbackId);
        }
        signal?.removeEventListener("abort", onAbort);
        waitForAnimationFrame(signal).then(resolve, reject);
      }, 250);
    });
  }

  return waitForAnimationFrame(signal);
}

function waitForAnimationFrame(signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal?.removeEventListener("abort", onAbort);
      reject(new Phase3AError("ANALYSIS_CANCELED", "Phase 3Aをキャンセルしました"));
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    requestAnimationFrame(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    });
  });
}

function canvasToBlob(canvas, type, quality, signal) {
  return new Promise((resolve, reject) => {
    throwIfAborted(signal);
    canvas.toBlob((blob) => {
      if (signal?.aborted) {
        reject(new Phase3AError("ANALYSIS_CANCELED", "Phase 3Aをキャンセルしました"));
        return;
      }
      if (!blob) {
        reject(new Phase3AError("WEBP_ENCODE_FAILED", "WebP Blobを生成できませんでした"));
        return;
      }
      resolve(blob);
    }, type, quality);
  });
}

function detectNearBlackFrame(ctx, width, height) {
  const sampleWidth = Math.min(16, width);
  const sampleHeight = Math.min(16, height);
  const { data } = ctx.getImageData(0, 0, sampleWidth, sampleHeight);
  if (!data.length) {
    return true;
  }

  let maxChannel = 0;
  let luminanceSum = 0;
  const pixelCount = data.length / 4;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    maxChannel = Math.max(maxChannel, r, g, b);
    luminanceSum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  const averageLuminance = luminanceSum / pixelCount;
  return averageLuminance < 8 && maxChannel < 16;
}

function calculateScaledSize(width, height, maxEdgePx) {
  const scale = Math.min(1, maxEdgePx / Math.max(width, height));
  return {
    scale,
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  };
}

function clampTargetTime(durationSec, targetTimeSec) {
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    return 0;
  }
  const safeMax = Math.max(0, durationSec - 0.05);
  return Math.max(0, Math.min(targetTimeSec, safeMax));
}

function roundMs(value) {
  return Math.round(value * 1000) / 1000;
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw new Phase3AError("ANALYSIS_CANCELED", "Phase 3Aをキャンセルしました");
  }
}

function numberOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function buildErrorDetails(partialResult, details, videoErrorCode) {
  return {
    file: partialResult.file,
    decode: {
      ...partialResult.decode,
      videoErrorCode: details?.videoErrorCode ?? videoErrorCode ?? partialResult.decode.videoErrorCode,
      loadedMetadataReached: details?.loadedMetadataReached ?? partialResult.decode.loadedMetadataReached
    },
    scale: partialResult.scale,
    frames: partialResult.frames
  };
}

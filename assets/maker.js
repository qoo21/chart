// Chart Maker（譜面ビューアの「譜面画像を作る」ページ）
//   元の「譜面静止画メーカー」の仕組みをそのまま使い、画面だけを譜面ビューアに合わせた。
//   変えられる設定は「作成する範囲」だけ（ほかの設定は画面に出さず、初めの値のまま使う）。
//   動画はこのブラウザの中だけで処理し、どこにも送信しない。

// 明るい表示／暗い表示（譜面ビューアと同じ設定を使う）
(() => {
  const root = document.documentElement;
  try { const t = localStorage.getItem("cv-theme"); if (t === "light" || t === "dark") root.dataset.theme = t; } catch (e) {}
  const btn = document.getElementById("themeBtn");
  if (btn) btn.addEventListener("click", () => {
    const dark = root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    root.dataset.theme = dark ? "light" : "dark";
    try { localStorage.setItem("cv-theme", root.dataset.theme); } catch (e) {}
  });
})();

// =========================================================
// 0. 処理方式（端末の速さに依存しない全フレーム解析）
//   旧方式は「シーク → 待機時間 → 切り出し」を繰り返していたため、端末が遅いと別のコマを切り出していた。
//   現在は MP4/MOV を WebCodecs で先頭から全フレーム順番にデコードし、各フレームの正確な時刻と
//   実際の移動量（画像照合）で合成するので、端末の速さは処理時間にしか影響しない。
// =========================================================
const WEBCODECS_AVAILABLE = typeof VideoDecoder !== "undefined" && typeof EncodedVideoChunk !== "undefined";
const ENGINE_SUPPORT_LABEL = WEBCODECS_AVAILABLE
  ? "MP4/MOV は全フレーム解析 (WebCodecs)"
  : "互換モード: シーク解析（このブラウザは WebCodecs 非対応）";

// =========================================================
// 1. ZIPファイル生成エンジン（フォールバック安全機構付き）
// =========================================================
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(u8) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < u8.length; i++) crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ u8[i]) & 0xFF];
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function createZipBlob(files) {
  const encoder = new TextEncoder();
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    const dataBytes = (file.data instanceof Uint8Array) ? file.data : encoder.encode(file.data);
    const crc = crc32(dataBytes);
    const size = dataBytes.length;

    const lfh = new Uint8Array(30 + nameBytes.length);
    const lfv = new DataView(lfh.buffer);
    lfv.setUint32(0, 0x04034b50, true);
    lfv.setUint16(4, 20, true);
    lfv.setUint16(6, 0x0800, true);
    lfv.setUint16(8, 0, true);
    lfv.setUint16(10, 0, true);
    lfv.setUint16(12, 0x5421, true);
    lfv.setUint32(14, crc, true);
    lfv.setUint32(18, size, true);
    lfv.setUint32(22, size, true);
    lfv.setUint16(26, nameBytes.length, true);
    lfv.setUint16(28, 0, true);
    lfh.set(nameBytes, 30);
    localParts.push(lfh, dataBytes);

    const cdh = new Uint8Array(46 + nameBytes.length);
    const cdv = new DataView(cdh.buffer);
    cdv.setUint32(0, 0x02014b50, true);
    cdv.setUint16(4, 20, true);
    cdv.setUint16(6, 20, true);
    cdv.setUint16(8, 0x0800, true);
    cdv.setUint16(10, 0, true);
    cdv.setUint16(12, 0, true);
    cdv.setUint16(14, 0x5421, true);
    cdv.setUint32(16, crc, true);
    cdv.setUint32(20, size, true);
    cdv.setUint32(24, size, true);
    cdv.setUint16(28, nameBytes.length, true);
    cdv.setUint16(30, 0, true);
    cdv.setUint16(32, 0, true);
    cdv.setUint16(34, 0, true);
    cdv.setUint16(36, 0, true);
    cdv.setUint32(38, 0, true);
    cdv.setUint32(42, offset, true);
    cdh.set(nameBytes, 46);

    centralParts.push(cdh);
    offset += lfh.length + size;
  }

  let cdSize = 0;
  for (const part of centralParts) cdSize += part.length;

  const eocd = new Uint8Array(22);
  const eocdv = new DataView(eocd.buffer);
  eocdv.setUint32(0, 0x06054b50, true);
  eocdv.setUint16(8, files.length, true);
  eocdv.setUint16(10, files.length, true);
  eocdv.setUint32(12, cdSize, true);
  eocdv.setUint32(16, offset, true);

  return new Blob([...localParts, ...centralParts, eocd], { type: "application/zip" });
}

function downloadBlob(blob, filename) {
  if (!blob) return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  // 大きなファイルは保存の開始に時間がかかるため、URLの破棄は十分に待ってから行う
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 30000);
}

function canvasToBlobSafe(canvas) {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => {
        if (blob) {
          resolve(blob);
          return;
        }
        try {
          const dataUrl = canvas.toDataURL("image/png");
          const binStr = atob(dataUrl.split(",")[1] || "");
          const u8 = new Uint8Array(binStr.length);
          for (let i = 0; i < binStr.length; i++) u8[i] = binStr.charCodeAt(i);
          resolve(new Blob([u8], { type: "image/png" }));
        } catch (err2) {
          resolve(null);
        }
      }, "image/png");
    } catch (err) {
      resolve(null);
    }
  });
}

async function canvasToUint8Array(canvas) {
  const blob = await canvasToBlobSafe(canvas);
  if (!blob) return new Uint8Array(0);
  const buf = await blob.arrayBuffer();
  return new Uint8Array(buf);
}

// =========================================================
// 2. 黒背景フィルター（動画全体から推定した静止背景との差で、動く譜面要素だけを残す）
//   旧方式は合成後の縦長画像に空間フィルターをかけていたため、毎フレーム同じ位置の背景が
//   縦に引き伸ばされて「ノコギリ状・縦筋状」の残りが出ていた。現在はフレームごとに静止背景を除いてから合成する。
// =========================================================
const blackBgToggle = document.getElementById("blackBgToggle");
const bgThreshSlider = document.getElementById("bgThreshSlider");
const bgThreshLabel = document.getElementById("bgThreshLabel");
const gridBoostSlider = document.getElementById("gridBoostSlider");
const gridBoostLabel = document.getElementById("gridBoostLabel");

function getBlackFilterParams() {
  const thresh = parseInt(bgThreshSlider.value, 10) || 36;
  const gridBoost = parseFloat(gridBoostSlider.value) || 0.5;
  return {
    t0: Math.max(4, thresh * 0.3),   // 静止背景よりこれ以上明るい画素を譜面要素とみなす
    invTw: 1 / 10,                   // そこから10段階かけて滑らかに残す
    lineGain: 0.6 + 0.8 * gridBoost  // 0.5倍（初期値）で元の明るさのまま
  };
}

// 静止背景の中で「縦方向にずっと続く細い線」（レーンの縦線）だけを列ごとに取り出す
//   bg: 幅 bgW の静止背景（RGB）、x0〜x0+width の列を対象にする
function extractStaticVerticalLines(bg, bgW, x0, width, h, topSafeY, gain) {
  const lane = new Uint8Array(width * 3);
  const rows = [];
  for (let y = topSafeY; y < h - 2; y += 3) rows.push(y);
  if (rows.length < 8) return lane;
  const contrast = new Float32Array(rows.length);
  const chan = [new Uint8Array(rows.length), new Uint8Array(rows.length), new Uint8Array(rows.length)];
  const maxAt = (j) => {
    const r = bg[j], g = bg[j + 1], b = bg[j + 2];
    return r > g ? (r > b ? r : b) : (g > b ? g : b);
  };
  for (let lx = 0; lx < width; lx++) {
    const x = x0 + lx;
    if (x - 3 < 0 || x + 3 >= bgW) continue;
    for (let k = 0; k < rows.length; k++) {
      const j = (rows[k] * bgW + x) * 3;
      const m = maxAt(j);
      const ml = maxAt(j - 9);
      const mr = maxAt(j + 9);
      contrast[k] = m - (ml > mr ? ml : mr);
      chan[0][k] = bg[j];
      chan[1][k] = bg[j + 1];
      chan[2][k] = bg[j + 2];
    }
    // 高さの75%以上で両隣より明るい列だけをレーン線とみなす（イラストの縦の輪郭は除外される）
    const sorted = Array.from(contrast).sort((a, b) => a - b);
    if (sorted[Math.floor(sorted.length * 0.25)] < 6) continue;
    for (let c = 0; c < 3; c++) {
      const vals = Array.from(chan[c]).sort((a, b) => a - b);
      lane[lx * 3 + c] = Math.min(255, Math.round(vals[vals.length >> 1] * gain));
    }
  }
  return lane;
}

// 静止背景との差で動いている譜面要素だけを残す（1行分）。lane はレーン線（列ごとの色）
function maskRowAgainstBackground(src, srcOff, bg, bgOff, width, fp, lane, dst, dstOff) {
  const { t0, invTw, lineGain } = fp;
  for (let x = 0; x < width; x++) {
    const i = srcOff + x * 4;
    const j = bgOff + x * 3;
    const r = src[i], g = src[i + 1], b = src[i + 2];
    const dr = r - bg[j], dg = g - bg[j + 1], db = b - bg[j + 2];
    const dmax = dr > dg ? (dr > db ? dr : db) : (dg > db ? dg : db);
    let a = (dmax - t0) * invTw;
    a = a < 0 ? 0 : (a > 1 ? 1 : a);
    let or = r * a, og = g * a, ob = b * a;
    if (lineGain !== 1 && a > 0) {
      const mx = or > og ? (or > ob ? or : ob) : (og > ob ? og : ob);
      const mn = or < og ? (or < ob ? or : ob) : (og < ob ? og : ob);
      if (mx - mn < 40) {
        or *= lineGain;
        og *= lineGain;
        ob *= lineGain;
      }
    }
    if (lane) {
      const l = x * 3;
      if (lane[l] > or) or = lane[l];
      if (lane[l + 1] > og) og = lane[l + 1];
      if (lane[l + 2] > ob) ob = lane[l + 2];
    }
    const o = dstOff + x * 4;
    dst[o] = or;
    dst[o + 1] = og;
    dst[o + 2] = ob;
    dst[o + 3] = 255;
  }
}

// =========================================================
// 3. UI要素・裏でのタイムスタンプ＆設定自動保存/読み込み管理
// =========================================================
const video = document.getElementById("videoPreview");
const previewCanvas = document.getElementById("previewCanvas");
// 再生中は毎フレーム動画を描くだけなので GPU キャンバスのままにする（読み出し用のキャンバスとは分ける）
const pCtx = previewCanvas.getContext("2d");
const filterSubCanvas = document.createElement("canvas");
const filterSubCtx = filterSubCanvas.getContext("2d", { willReadFrequently: true });

const headerControls = document.getElementById("headerControls");
const filesInput = document.getElementById("filesInput");
const folderInput = document.getElementById("folderInput");
const linkRootFolderBtn = document.getElementById("linkRootFolderBtn");
const selectFilesBtn = document.getElementById("selectFilesBtn");
const selectFolderBtn = document.getElementById("selectFolderBtn");

const topSwitcherCard = document.getElementById("topSwitcherCard");
const switcherContent = document.getElementById("switcherContent");
const folderStatusLabel = document.getElementById("folderStatusLabel");
const reconnectFolderBtn = document.getElementById("reconnectFolderBtn");
const refreshFolderBtn = document.getElementById("refreshFolderBtn");
const folderTabs = document.getElementById("folderTabs");
const currentViewFileName = document.getElementById("currentViewFileName");
const bottomSaveStatusLabel = document.getElementById("bottomSaveStatusLabel");

const mainTransportBar = document.getElementById("mainTransportBar");
const seekSlider = document.getElementById("seekSlider");
const currentTimeLabel = document.getElementById("currentTimeLabel");
const playPauseBtn = document.getElementById("playPauseBtn");
const viewerPlayPauseBtn = document.getElementById("viewerPlayPauseBtn");
const playbackRateSelect = document.getElementById("playbackRateSelect");
const viewerPlaybackRateSelect = document.getElementById("viewerPlaybackRateSelect");
const setStartBtn = document.getElementById("setStartBtn");
const setEndBtn = document.getElementById("setEndBtn");

const startTimeInput = document.getElementById("startTimeInput");
const endTimeInput = document.getElementById("endTimeInput");
const cropLeftSlider = document.getElementById("cropLeftSlider");
const cropRightSlider = document.getElementById("cropRightSlider");
const leftVal = document.getElementById("leftVal");
const rightVal = document.getElementById("rightVal");
const resolutionSelect = document.getElementById("resolutionSelect");
const deviceSpecBadge = document.getElementById("deviceSpecBadge");

const speedSlider = document.getElementById("speedSlider");
const speedInput = document.getElementById("speedInput");
const speedValLabel = document.getElementById("speedValLabel");
const autoSpeedBtn = document.getElementById("autoSpeedBtn");

const genActionGroup = document.getElementById("genActionGroup");
const reLayoutActionGroup = document.getElementById("reLayoutActionGroup");
const detailsTab = document.getElementById("detailsTab");
const bottomSaveBar = document.getElementById("bottomSaveBar");

const layoutMode = document.getElementById("layoutMode");
const colHeightInput = document.getElementById("colHeightInput");
const reLayoutBtn = document.getElementById("reLayoutBtn");

const generateBtn = document.getElementById("generateBtn");
const batchGenerateBtn = document.getElementById("batchGenerateBtn");
const testGenerateBtn = document.getElementById("testGenerateBtn");
const progressStopBtn = document.getElementById("progressStopBtn");
const progressContainer = document.getElementById("progressContainer");
const progressText = document.getElementById("progressText");
const progressPercent = document.getElementById("progressPercent");
const progressBar = document.getElementById("progressBar");

const canvasStage = document.getElementById("canvasStage");
const outputCanvas = document.getElementById("outputCanvas");
const playheadColHighlight = document.getElementById("playheadColHighlight");
const playheadBar = document.getElementById("playheadBar");
const playheadTimeBadge = document.getElementById("playheadTimeBadge");

const downloadPngBtn = document.getElementById("downloadPngBtn");
const targetColInput = document.getElementById("targetColInput");
const downloadSingleColBtn = document.getElementById("downloadSingleColBtn");
const downloadResultZipBtn = document.getElementById("downloadResultZipBtn");
const showPlayheadToggle = document.getElementById("showPlayheadToggle");
const followPlayheadToggle = document.getElementById("followPlayheadToggle");
const playheadOffsetSlider = document.getElementById("playheadOffsetSlider");
const playheadOffsetInput = document.getElementById("playheadOffsetInput");
const resetOffsetBtn = document.getElementById("resetOffsetBtn");

if (deviceSpecBadge) {
  deviceSpecBadge.textContent = ENGINE_SUPPORT_LABEL;
}

const SETTINGS_FILE_NAME = "pjsekai_settings.json";
const LOCAL_STORAGE_SETTINGS_KEY = "PJSekaiChartMaker_Settings_AutoV16";
const CHART_IMAGE_SUFFIX = "_譜面";

let currentColumnWidths = 0;
let activeVideoName = "";
let activeVideoItem = null;
let cancelGenerationRequested = false;
let activeGenerationJob = null;
let isGenerating = false;
let shouldRestartFromBeginning = false;
let currentPlaybackRate = 1.0;

let savedTimestampsByFolder = {};

const activeSeekResolvers = new Set();

const folderGroups = new Map();
let activeFolderName = "";
let savedDirectoryHandle = null;

// フォルダ名（"親/子" 形式もある）から、保存する静止画のファイル名を作る
function chartImageFileName(folderName) {
  const base = String(folderName || "").split("/").pop() || "Proseka_Chart";
  return `${base}${CHART_IMAGE_SUFFIX}.png`;
}

// フォルダに入っていない動画と静止画を同じ組にまとめる（「xxx_譜面.png」は「xxx.mp4」と同じ組）
function rootGroupNameForFile(fileName, isImage) {
  let base = String(fileName || "").replace(/\.[^.]+$/, "");
  if (isImage && base.endsWith(CHART_IMAGE_SUFFIX) && base.length > CHART_IMAGE_SUFFIX.length) {
    base = base.slice(0, -CHART_IMAGE_SUFFIX.length);
  }
  return base;
}

function applyPlaybackRate(rateValue, save = true) {
  const rate = parseFloat(rateValue) || 1.0;
  currentPlaybackRate = rate;
  const rateStr = String(rate);
  if (playbackRateSelect.value !== rateStr) playbackRateSelect.value = rateStr;
  if (viewerPlaybackRateSelect.value !== rateStr) viewerPlaybackRateSelect.value = rateStr;

  if ("preservesPitch" in video) video.preservesPitch = true;
  else if ("webkitPreservesPitch" in video) video.webkitPreservesPitch = true;

  video.defaultPlaybackRate = rate;
  video.playbackRate = rate;

  if (save) scheduleSaveSettings();
}

playbackRateSelect.addEventListener("change", () => {
  applyPlaybackRate(playbackRateSelect.value, true);
});
viewerPlaybackRateSelect.addEventListener("change", () => {
  applyPlaybackRate(viewerPlaybackRateSelect.value, true);
});

// =========================================================
// 時刻→位置マップ（保存用の間引き・再生位置バー用の平滑化）
// =========================================================
// 誤差 tol(px) 以内で点数を減らす（録画の停止フレームによる段差は残る）
function simplifyTimeMap(map, tol = 2.0, maxPoints = 1500) {
  if (!map || map.length <= 2) return (map || []).map(p => ({ time: p.time, bottomY: p.bottomY }));
  let t = tol;
  for (let attempt = 0; attempt < 10; attempt++) {
    const keep = new Uint8Array(map.length);
    keep[0] = 1;
    keep[map.length - 1] = 1;
    const stack = [[0, map.length - 1]];
    while (stack.length > 0) {
      const [a, b] = stack.pop();
      if (b - a < 2) continue;
      const pa = map[a], pb = map[b];
      const dt = pb.time - pa.time;
      let maxErr = -1, idx = -1;
      for (let i = a + 1; i < b; i++) {
        const r = dt > 1e-9 ? (map[i].time - pa.time) / dt : 0;
        const e = Math.abs(map[i].bottomY - (pa.bottomY + r * (pb.bottomY - pa.bottomY)));
        if (e > maxErr) { maxErr = e; idx = i; }
      }
      if (maxErr > t) {
        keep[idx] = 1;
        stack.push([a, idx], [idx, b]);
      }
    }
    const out = [];
    for (let i = 0; i < map.length; i++) if (keep[i]) out.push({ time: map[i].time, bottomY: map[i].bottomY });
    if (out.length <= maxPoints) return out;
    t *= 1.8;
  }
  const step = Math.ceil(map.length / maxPoints);
  const out = [];
  for (let i = 0; i < map.length; i += step) out.push({ time: map[i].time, bottomY: map[i].bottomY });
  const last = map[map.length - 1];
  if (out[out.length - 1].time !== last.time) out.push({ time: last.time, bottomY: last.bottomY });
  return out;
}

function boxSmooth(src, r) {
  const n = src.length;
  const out = new Float64Array(n);
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + src[i];
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - r), b = Math.min(n - 1, i + r);
    out[i] = (prefix[b + 1] - prefix[a]) / (b - a + 1);
  }
  return out;
}

// 再生位置バー用：1/60秒刻みに並べ直し、±0.1秒でならす
// （録画の停止フレームによる段差や、ゲーム側のフレームごとの揺らぎでバーがカクつかないようにする）
function buildDisplayTimeMap(map) {
  if (!map || map.length < 2) return null;
  const t0 = map[0].time;
  const t1 = map[map.length - 1].time;
  if (!(t1 > t0)) return null;
  const dt = 1 / 60;
  const n = Math.min(600000, Math.max(2, Math.ceil((t1 - t0) / dt) + 1));
  const ys = new Float64Array(n);
  let j = 0;
  for (let i = 0; i < n; i++) {
    const t = t0 + i * dt;
    while (j < map.length - 2 && map[j + 1].time < t) j++;
    const a = map[j], b = map[j + 1];
    const span = b.time - a.time;
    const r = span > 1e-9 ? Math.max(0, Math.min(1, (t - a.time) / span)) : 1;
    ys[i] = a.bottomY + r * (b.bottomY - a.bottomY);
  }
  return { t0, dt, ys: boxSmooth(boxSmooth(ys, 6), 6) };
}

function displayMapY(dm, t) {
  const n = dm.ys.length;
  const f = (t - dm.t0) / dm.dt;
  if (!(f > 0)) return dm.ys[0];
  if (f >= n - 1) return dm.ys[n - 1];
  const i = Math.floor(f);
  return dm.ys[i] + (dm.ys[i + 1] - dm.ys[i]) * (f - i);
}

function displayMapTime(dm, Y) {
  const ys = dm.ys;
  const n = ys.length;
  if (Y <= ys[0]) return dm.t0;
  if (Y >= ys[n - 1]) return dm.t0 + (n - 1) * dm.dt;
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (ys[mid] < Y) lo = mid;
    else hi = mid;
  }
  const span = ys[hi] - ys[lo];
  const r = span > 1e-9 ? (Y - ys[lo]) / span : 0;
  return dm.t0 + (lo + r) * dm.dt;
}

// =========================================================
// 静止画へのタイムスタンプ埋め込み（ステガノグラフィ）＆ 抽出エンジン
//   画像の最下行から上へ、R/G の下位2ビットに書き込む（容量が足りなければ複数行を使う）
// =========================================================
const STEGO_MAGIC = "PJSK_TS1:";
const STEGO_MAX_ROWS = 32;

function stegoPixelIndex(k, W, rows) {
  // ストリームの k 番目の画素：最下行の左端から右へ、次は1つ上の行へ
  return (((rows - 1 - Math.floor(k / W)) * W) + (k % W)) * 4;
}

function embedTimestampsIntoCanvas(canvas, metaObj) {
  if (!canvas || canvas.width < 64 || canvas.height < 10) return false;
  try {
    const map = simplifyTimeMap(metaObj.timeToYMap || [], 2.0, 1500);
    const payload = JSON.stringify({
      v: 2,
      th: Math.round(metaObj.totalHeight || 0),
      bb: Math.round(metaObj.bottomBaseH || 0),
      tc: Math.round(metaObj.topCapH || 0),
      ts: Number((metaObj.tStart || 0).toFixed(3)),
      te: Number((metaObj.tEnd || 0).toFixed(3)),
      fh: Math.round(metaObj.frameH || 0),
      cy: Math.round(metaObj.captureY || 0),
      lay: metaObj.layout || undefined,
      m: map.map(p => [Number(p.time.toFixed(3)), Math.round(p.bottomY)])
    });
    const bytes = new TextEncoder().encode(STEGO_MAGIC + payload);
    const totalLen = bytes.length;
    const W = canvas.width;
    // 1バイトに2画素を使うので、必要な画素数は 16（長さ） + 2 × バイト数
    const rows = Math.ceil((16 + totalLen * 2) / W);
    if (rows > Math.min(STEGO_MAX_ROWS, Math.floor(canvas.height / 4))) return false;

    const ctx = canvas.getContext("2d");
    const y0 = canvas.height - rows;
    const img = ctx.getImageData(0, y0, W, rows);
    const data = img.data;
    for (let b = 0; b < 16; b++) {
      const i = stegoPixelIndex(b, W, rows);
      data[i] = (data[i] & 0xFC) | ((totalLen >>> (b * 2)) & 0x03);
      data[i + 3] = 255;
    }
    for (let i = 0; i < totalLen; i++) {
      const v = bytes[i];
      const i1 = stegoPixelIndex(16 + i * 2, W, rows);
      const i2 = stegoPixelIndex(17 + i * 2, W, rows);
      data[i1] = (data[i1] & 0xFC) | (v & 0x03);
      data[i1 + 1] = (data[i1 + 1] & 0xFC) | ((v >>> 2) & 0x03);
      data[i1 + 3] = 255;
      data[i2] = (data[i2] & 0xFC) | ((v >>> 4) & 0x03);
      data[i2 + 1] = (data[i2 + 1] & 0xFC) | ((v >>> 6) & 0x03);
      data[i2 + 3] = 255;
    }
    ctx.putImageData(img, 0, y0);
    return true;
  } catch (e) {
    return false;
  }
}

function extractTimestampsFromCanvas(ctx, width, height) {
  if (width < 64 || height < 10) return null;
  try {
    const lastRow = ctx.getImageData(0, height - 1, width, 1).data;
    let totalLen = 0;
    for (let b = 0; b < 16; b++) {
      totalLen = (totalLen | ((lastRow[b * 4] & 0x03) << (b * 2))) >>> 0;
    }
    if (totalLen <= STEGO_MAGIC.length) return null;
    const rows = Math.ceil((16 + totalLen * 2) / width);
    if (rows > Math.min(STEGO_MAX_ROWS, Math.floor(height / 4))) return null;
    const data = rows === 1 ? lastRow : ctx.getImageData(0, height - rows, width, rows).data;

    const bytes = new Uint8Array(totalLen);
    for (let i = 0; i < totalLen; i++) {
      const i1 = stegoPixelIndex(16 + i * 2, width, rows);
      const i2 = stegoPixelIndex(17 + i * 2, width, rows);
      bytes[i] = (data[i1] & 0x03) | ((data[i1 + 1] & 0x03) << 2) | ((data[i2] & 0x03) << 4) | ((data[i2 + 1] & 0x03) << 6);
    }

    const str = new TextDecoder().decode(bytes);
    if (!str.startsWith(STEGO_MAGIC)) return null;

    const parsed = JSON.parse(str.slice(STEGO_MAGIC.length));
    if (!parsed || !Array.isArray(parsed.m)) return null;

    return {
      version: parsed.v || 1,
      totalHeight: parsed.th,
      bottomBaseH: parsed.bb,
      topCapH: parsed.tc,
      tStart: parsed.ts,
      tEnd: parsed.te,
      frameH: parsed.fh || 0,
      captureY: parsed.cy || 0,
      layout: parsed.lay || null,
      timeToYMap: parsed.m.map(pair => ({ time: pair[0], bottomY: pair[1] }))
    };
  } catch (e) {
    return null;
  }
}

function saveTimestampProfileForFolder(folderName, metaObj) {
  if (!folderName || !metaObj || !metaObj.timeToYMap || metaObj.timeToYMap.length < 2) return;
  const compact = simplifyTimeMap(metaObj.timeToYMap, 2.0, 1500).map(p => ({
    time: Number(p.time.toFixed(3)),
    bottomY: Math.round(p.bottomY)
  }));

  savedTimestampsByFolder[folderName] = {
    totalHeight: Math.round(metaObj.totalHeight || 0),
    bottomBaseH: Math.round(metaObj.bottomBaseH || 0),
    topCapH: Math.round(metaObj.topCapH || 0),
    tStart: Number((metaObj.tStart || 0).toFixed(3)),
    tEnd: Number((metaObj.tEnd || 0).toFixed(3)),
    frameH: Math.round(metaObj.frameH || 0),
    captureY: Math.round(metaObj.captureY || 0),
    layout: metaObj.layout || null,
    engine: 2,
    timeToYMap: compact
  };
  scheduleSaveSettings();
}

// =========================================================
// 設定ファイル (pjsekai_settings.json) のバックグラウンド自動保存/自動読込
// =========================================================
function collectCurrentSettings() {
  const cLeft = parseFloat(cropLeftSlider.value);
  const cRight = parseFloat(cropRightSlider.value);
  return {
    cropLeft: isNaN(cLeft) ? 18 : cLeft,
    cropRight: isNaN(cRight) ? 78.5 : cRight,
    resolution: resolutionSelect.value || "original",
    blackBg: blackBgToggle.checked,
    bgThresh: parseInt(bgThreshSlider.value, 10) || 36,
    gridBoost: parseFloat(gridBoostSlider.value) || 0.5,
    speed: parseFloat(speedInput.value) || 47.50,
    colHeight: parseInt(colHeightInput.value, 10) || 8000,
    layoutMode: layoutMode.value || "grid",
    showPlayhead: showPlayheadToggle.checked,
    followPlayhead: followPlayheadToggle.checked,
    playheadOffsetSec: parseFloat(playheadOffsetInput.value) || 0.00,
    playbackRate: currentPlaybackRate,
    savedTimestampsByFolder: savedTimestampsByFolder
  };
}

function applySettingsObject(s) {
  if (!s || typeof s !== "object") return;
  if (s.cropLeft === 0 && s.cropRight === 100) {
    s.cropLeft = 18;
    s.cropRight = 78.5;
  }
  if (typeof s.cropLeft === "number") {
    cropLeftSlider.value = s.cropLeft;
    leftVal.textContent = s.cropLeft.toFixed(1);
  }
  if (typeof s.cropRight === "number") {
    cropRightSlider.value = s.cropRight;
    rightVal.textContent = s.cropRight.toFixed(1);
  }
  // ★ Chart Maker: 解像度・背景を消す設定・スクロール速度は画面に出さないので、保存されていても初めの値のまま使う
  if (typeof s.colHeight === "number" && s.colHeight >= 400) {
    colHeightInput.value = s.colHeight;
  }
  if (s.layoutMode === "grid" || s.layoutMode === "single") {
    layoutMode.value = s.layoutMode;
  }
  if (typeof s.showPlayhead === "boolean") showPlayheadToggle.checked = s.showPlayhead;
  if (typeof s.followPlayhead === "boolean") followPlayheadToggle.checked = s.followPlayhead;
  if (typeof s.playheadOffsetSec === "number") {
    playheadOffsetInput.value = s.playheadOffsetSec.toFixed(2);
    playheadOffsetSlider.value = Math.max(-2, Math.min(2, s.playheadOffsetSec)).toFixed(2);
  }
  if (typeof s.playbackRate === "number" && [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2].includes(s.playbackRate)) {
    applyPlaybackRate(s.playbackRate, false);
  }
  if (s.savedTimestampsByFolder && typeof s.savedTimestampsByFolder === "object") {
    savedTimestampsByFolder = s.savedTimestampsByFolder;
  }
  drawPreview(true);
  drawPlayheadOverlay();
}

// スライダー操作のたびに大きな設定（タイムスタンプ込み）を書き込むと重くなるため、まとめて保存する
let saveSettingsTimer = null;
function scheduleSaveSettings() {
  clearTimeout(saveSettingsTimer);
  saveSettingsTimer = setTimeout(() => {
    saveSettingsTimer = null;
    flushSettingsToLocalStorage();
    saveSettingsFileToRootFolder();
  }, 300);
}

function flushSettingsToLocalStorage() {
  const s = collectCurrentSettings();
  try {
    localStorage.setItem(LOCAL_STORAGE_SETTINGS_KEY, JSON.stringify(s));
  } catch (e) {
    // 容量オーバー時はタイムスタンプを除いて保存（タイムスタンプは設定ファイルと静止画側に残る）
    try {
      const lite = Object.assign({}, s, { savedTimestampsByFolder: {} });
      localStorage.setItem(LOCAL_STORAGE_SETTINGS_KEY, JSON.stringify(lite));
    } catch (e2) {}
  }
}

window.addEventListener("beforeunload", () => {
  if (saveSettingsTimer) {
    clearTimeout(saveSettingsTimer);
    saveSettingsTimer = null;
    flushSettingsToLocalStorage();
  }
});

async function saveSettingsFileToRootFolder() {
  if (!savedDirectoryHandle) return;
  try {
    const perm = await savedDirectoryHandle.queryPermission({ mode: "readwrite" });
    if (perm === "granted") {
      const s = collectCurrentSettings();
      const jsonText = JSON.stringify(s, null, 2);
      const fileHandle = await savedDirectoryHandle.getFileHandle(SETTINGS_FILE_NAME, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(jsonText);
      await writable.close();
    }
  } catch (e) {}
}

async function loadSettingsFileFromRootHandle(dirHandle) {
  if (!dirHandle) return false;
  try {
    const fileHandle = await dirHandle.getFileHandle(SETTINGS_FILE_NAME);
    const file = await fileHandle.getFile();
    const text = await file.text();
    const parsed = JSON.parse(text);
    applySettingsObject(parsed);
    flushSettingsToLocalStorage();
    return true;
  } catch (e) {
    return false;
  }
}

// =========================================================
// 生成した静止画をその動画のフォルダへ自動保存する関数
// =========================================================
async function autoSaveCanvasToFolder(folderName, targetCanvas) {
  if (!folderName || !targetCanvas || !targetCanvas.width || cancelGenerationRequested) return false;
  const grp = folderGroups.get(folderName);
  const dirHandle = (grp && grp.dirHandle) ? grp.dirHandle : savedDirectoryHandle;
  if (!dirHandle) return false;

  try {
    let perm = await dirHandle.queryPermission({ mode: "readwrite" });
    if (perm !== "granted") return false;

    const blob = await canvasToBlobSafe(targetCanvas);
    if (!blob || cancelGenerationRequested) return false;

    // 入れ子フォルダ（"親/子"）でも、ファイル名には末尾のフォルダ名だけを使う
    const fileName = chartImageFileName(folderName);
    const fileHandle = await dirHandle.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(blob);
    await writable.close();

    const savedFile = await fileHandle.getFile();
    if (grp) {
      const existingIdx = grp.images.findIndex(img => img.name === fileName);
      const entry = {
        name: fileName,
        file: savedFile,
        url: null,
        folderName: folderName,
        masterData: (grp.images[existingIdx] && grp.images[existingIdx].masterData) ? grp.images[existingIdx].masterData : null
      };
      if (existingIdx >= 0) grp.images[existingIdx] = entry;
      else grp.images.unshift(entry);
    }

    bottomSaveStatusLabel.textContent = `フォルダ「${folderName}」に ${fileName} （タイムスタンプ記録済）を自動保存しました`;
    return true;
  } catch (e) {
    return false;
  }
}

// 画像生成中のロック制御
function setGeneratingLock(locked) {
  isGenerating = locked;
  const lockTargets = [
    headerControls,
    topSwitcherCard,
    mainTransportBar,
    genActionGroup,
    reLayoutActionGroup,
    detailsTab,
    bottomSaveBar
  ];
  for (const el of lockTargets) {
    if (!el) continue;
    if (locked) el.classList.add("locked-during-gen");
    else el.classList.remove("locked-during-gen");
  }

  viewerPlayPauseBtn.disabled = locked;
  viewerPlaybackRateSelect.disabled = locked;
  progressStopBtn.disabled = !locked;

  const tabBtns = folderTabs.querySelectorAll("button");
  tabBtns.forEach(b => { b.disabled = locked; });

  if (!locked) {
    const hasVid = Boolean(video.src && video.videoWidth > 0);
    generateBtn.disabled = !hasVid;
    testGenerateBtn.disabled = !hasVid;
    updateBatchButtonState();
    reLayoutBtn.disabled = !masterChartData.hasData;
  }
}

// マスター譜面データ保持構造（下から上へ1本に繋がった譜面を、高さ2048pxごとのキャンバスに分けて持つ）
const MASTER_CHUNK_H = 2048;
let masterChartData = {
  hasData: false,
  cropW: 0,
  totalHeight: 0,
  bottomBaseH: 0,
  topCapH: 0,
  chunks: [],
  tStart: 0.0,
  tEnd: 120.0,
  timeToYMap: [],
  sourceLabel: ""
};

function releaseMasterChunks(mData) {
  if (!mData || !mData.chunks) return;
  for (const ch of mData.chunks) {
    ch.width = 0;
    ch.height = 0;
  }
  mData.chunks = [];
  mData.hasData = false;
}

// 保存済み（ファイルから読み直せる）ならマスターを解放してメモリを空ける。未保存の生成結果は残す
function releaseMasterIfReloadable(mData) {
  if (!mData || !mData.hasData) return false;
  for (const [, grp] of folderGroups) {
    for (const img of grp.images) {
      if (img.masterData === mData && !img.file) return false;
    }
  }
  for (const [, grp] of folderGroups) {
    for (const img of grp.images) {
      if (img.masterData === mData) img.masterData = null;
    }
  }
  releaseMasterChunks(mData);
  return true;
}

function replaceMasterChartData(newData) {
  const old = masterChartData;
  masterChartData = newData;
  if (old && old !== newData && old.hasData) releaseMasterIfReloadable(old);
}

let chartMeta = {
  isGenerated: false,
  mode: "grid",
  numCols: 1,
  cropW: 400,
  colMaxH: 8000,
  colGap: 14,
  headerH: 0,
  totalHeight: 8000,
  bottomBaseH: 120,
  topCapH: 250,
  tStart: 0.0,
  tEnd: 120.0,
  scale: 1,
  renderScale: 1,
  colRects: [],
  timeToYMap: [],
  displayMap: null
};

// =========================================================
// PC内の同階層フォルダをIndexedDBに記憶して自動読み込み・自動保存する仕組み
// =========================================================
function openHandleDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("ProsekaChartMakerLocalDB", 1);
    req.onupgradeneeded = (e) => {
      e.target.result.createObjectStore("handles");
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

async function saveDirHandleToDB(handle) {
  try {
    const db = await openHandleDB();
    const tx = db.transaction("handles", "readwrite");
    tx.objectStore("handles").put(handle, "rootDir");
  } catch (e) {}
}

async function getDirHandleFromDB() {
  try {
    const db = await openHandleDB();
    return new Promise((resolve) => {
      const tx = db.transaction("handles", "readonly");
      const req = tx.objectStore("handles").get("rootDir");
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch (e) {
    return null;
  }
}

async function scanDirectoryHandle(dirHandle, path = "", collected = []) {
  for await (const entry of dirHandle.values()) {
    if (entry.kind === "file") {
      if (entry.name.toLowerCase() === SETTINGS_FILE_NAME) {
        try {
          const sFile = await entry.getFile();
          const sText = await sFile.text();
          applySettingsObject(JSON.parse(sText));
        } catch (e) {}
        continue;
      }
      if (/\.(mp4|mov|m4v|webm|mkv|avi|png|jpe?g|webp|bmp)$/i.test(entry.name)) {
        try {
          const file = await entry.getFile();
          const isImg = /\.(png|jpe?g|webp|bmp)$/i.test(entry.name);
          file._customFolder = path || rootGroupNameForFile(entry.name, isImg);
          file._dirHandle = dirHandle;
          collected.push(file);
        } catch (e) {}
      }
    } else if (entry.kind === "directory") {
      const subPath = path ? `${path}/${entry.name}` : entry.name;
      await scanDirectoryHandle(entry, subPath, collected);
    }
  }
  return collected;
}

async function loadFromSavedHandle(requestPerm = false) {
  if (!savedDirectoryHandle || isGenerating) return;
  try {
    let perm = await savedDirectoryHandle.queryPermission({ mode: "readwrite" });
    if (perm !== "granted" && requestPerm) {
      perm = await savedDirectoryHandle.requestPermission({ mode: "readwrite" });
    }
    if (perm !== "granted") {
      perm = await savedDirectoryHandle.queryPermission({ mode: "read" });
      if (perm !== "granted" && requestPerm) {
        perm = await savedDirectoryHandle.requestPermission({ mode: "read" });
      }
    }

    if (perm === "granted") {
      reconnectFolderBtn.style.display = "none";
      refreshFolderBtn.style.display = "inline-flex";
      await loadSettingsFileFromRootHandle(savedDirectoryHandle);
      folderGroups.clear();
      const files = await scanDirectoryHandle(savedDirectoryHandle, "");
      await handleIncomingFiles(files);
    } else {
      reconnectFolderBtn.style.display = "inline-flex";
      reconnectFolderBtn.textContent = `「${savedDirectoryHandle.name}」を読み込む`;
      folderStatusLabel.textContent = `登録済みのフォルダ「${savedDirectoryHandle.name}」があります。「読み込む」を押すと続きから使えます。`;
    }
  } catch (e) {}
}

window.addEventListener("DOMContentLoaded", async () => {
  try {
    const savedStr = localStorage.getItem(LOCAL_STORAGE_SETTINGS_KEY);
    if (savedStr) applySettingsObject(JSON.parse(savedStr));
  } catch (e) {}

  savedDirectoryHandle = await getDirHandleFromDB();
  if (savedDirectoryHandle) {
    await loadFromSavedHandle(false);
  }
});

linkRootFolderBtn.addEventListener("click", async () => {
  if (isGenerating) return;
  if (window.showDirectoryPicker) {
    try {
      const handle = await window.showDirectoryPicker({ mode: "readwrite" });
      savedDirectoryHandle = handle;
      await saveDirHandleToDB(handle);
      await loadFromSavedHandle(true);
      await saveSettingsFileToRootFolder();
    } catch (e) {}
  } else {
    folderInput.click();
  }
});

reconnectFolderBtn.addEventListener("click", () => { if (!isGenerating) loadFromSavedHandle(true); });
refreshFolderBtn.addEventListener("click", () => { if (!isGenerating) loadFromSavedHandle(true); });

selectFilesBtn.addEventListener("click", () => { if (!isGenerating) filesInput.click(); });
selectFolderBtn.addEventListener("click", () => { if (!isGenerating) folderInput.click(); });

window.addEventListener("dragover", (e) => {
  e.preventDefault();
  if (isGenerating) return;
  topSwitcherCard.style.borderColor = "var(--accent)";
});
window.addEventListener("dragleave", (e) => {
  if (!e.relatedTarget) topSwitcherCard.style.borderColor = "";
});
window.addEventListener("drop", async (e) => {
  e.preventDefault();
  topSwitcherCard.style.borderColor = "";
  if (isGenerating) return;
  const items = e.dataTransfer.items;
  if (items && items.length > 0 && items[0].webkitGetAsEntry) {
    // ドロップ情報はイベント中しか読めないため、先に全エントリを取り出してから中身を辿る
    const entries = [];
    for (let i = 0; i < items.length; i++) {
      const entry = items[i].webkitGetAsEntry();
      if (entry) entries.push(entry);
    }
    const collected = [];
    for (const entry of entries) await traverseFileTree(entry, "", collected);
    if (collected.length > 0) await handleIncomingFiles(collected);
  } else if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
    await handleIncomingFiles(Array.from(e.dataTransfer.files));
  }
});

async function traverseFileTree(item, path, collected) {
  if (item.isFile) {
    const file = await new Promise((res) => item.file(res, () => res(null)));
    if (!file) return;
    const isImg = /\.(png|jpe?g|webp|bmp)$/i.test(file.name);
    file._customFolder = path || rootGroupNameForFile(file.name, isImg);
    collected.push(file);
  } else if (item.isDirectory) {
    const dirReader = item.createReader();
    let entries = [];
    let batch;
    do {
      batch = await new Promise((res) => dirReader.readEntries(res, () => res([])));
      entries = entries.concat(batch);
    } while (batch.length > 0);
    const nextPath = path ? `${path}/${item.name}` : item.name;
    for (const entry of entries) {
      await traverseFileTree(entry, nextPath, collected);
    }
  }
}

// 動画・静止画・設定ファイルを1つのボタンでまとめて選べる
filesInput.addEventListener("change", (e) => {
  if (!isGenerating && e.target.files && e.target.files.length > 0) handleIncomingFiles(Array.from(e.target.files));
  e.target.value = "";
});
folderInput.addEventListener("change", (e) => {
  if (!isGenerating && e.target.files && e.target.files.length > 0) {
    folderGroups.clear();
    handleIncomingFiles(Array.from(e.target.files));
  }
  e.target.value = "";
});

async function handleIncomingFiles(files) {
  if (isGenerating) return;
  let firstFolder = "";
  const addedFolders = new Set();

  for (const f of files) {
    if (f.name.toLowerCase() === SETTINGS_FILE_NAME) {
      try {
        const text = await f.text();
        applySettingsObject(JSON.parse(text));
      } catch (e) {}
    }
  }

  for (const f of files) {
    const isVid = (f.type || "").startsWith("video/") || /\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(f.name);
    const isImg = (f.type || "").startsWith("image/") || /\.(png|jpe?g|webp|bmp)$/i.test(f.name);
    if (!isVid && !isImg) continue;

    let folderName = f._customFolder || "";
    if (!folderName && f.webkitRelativePath) {
      const parts = f.webkitRelativePath.split("/");
      parts.pop();
      if (parts.length > 1) parts.shift();
      folderName = parts.join("/");
    }
    if (!folderName) {
      folderName = rootGroupNameForFile(f.name, isImg);
    }

    if (!folderGroups.has(folderName)) {
      folderGroups.set(folderName, { images: [], videos: [], dirHandle: f._dirHandle || null });
    }
    const group = folderGroups.get(folderName);
    if (f._dirHandle && !group.dirHandle) {
      group.dirHandle = f._dirHandle;
    }

    const entry = { name: f.name, file: f, url: null, folderName: folderName };

    if (isVid) {
      const idx = group.videos.findIndex(v => v.name === f.name);
      if (idx >= 0) group.videos[idx] = entry;
      else group.videos.push(entry);
    } else if (isImg) {
      const idx = group.images.findIndex(img => img.name === f.name);
      if (idx >= 0) group.images[idx] = entry;
      else group.images.push(entry);
    }

    if (!firstFolder) firstFolder = folderName;
    addedFolders.add(folderName);
  }

  for (const [, grp] of folderGroups) {
    grp.images.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    grp.videos.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  }

  if (folderGroups.size > 0) {
    switcherContent.style.display = "block";
    // 今追加したファイルの組を表示する。以前は表示中の組を優先していたため、スマホなどで動画を1本ずつ選ぶと
    // 前の動画が表示されたままになり、そのまま「作成」すると前の動画（＝前回の画像）が作られていた。
    // 表示中の組そのものを読み直した場合（フォルダの再読み込みなど）は、表示中の組のままにする
    const targetFolder = (activeFolderName && addedFolders.has(activeFolderName))
      ? activeFolderName
      : (firstFolder || (folderGroups.has(activeFolderName) ? activeFolderName : Array.from(folderGroups.keys())[0]));
    selectFolderSet(targetFolder);
  }
  updateBatchButtonState();
}

function selectFolderSet(folderName) {
  if (isGenerating) return;
  const grp = folderGroups.get(folderName);
  if (!grp) return;
  activeFolderName = folderName;
  renderTopSwitcher();

  if (grp.videos.length > 0) {
    loadVideoItem(grp.videos[0]);
  }
  if (grp.images.length > 0) {
    loadImageItemToViewer(grp.images[0]);
  } else {
    // 静止画のないフォルダでは、前のフォルダの譜面を表示したままにしない（バーの位置が別の曲になってしまうため）
    clearViewerChart();
  }
}

function getUnprocessedVideoEntries() {
  const unprocessed = [];
  for (const [fName, grp] of folderGroups) {
    if (grp.images && grp.images.length > 0) continue;
    for (const v of grp.videos) {
      unprocessed.push({ videoEntry: v, folderName: fName });
    }
  }
  return unprocessed;
}

function updateBatchButtonState() {
  const unprocessedVids = getUnprocessedVideoEntries();
  batchGenerateBtn.disabled = isGenerating || unprocessedVids.length === 0;
  if (unprocessedVids.length > 0) {
    batchGenerateBtn.textContent = `未作成をまとめて作成（${unprocessedVids.length}本）`;
  } else {
    batchGenerateBtn.textContent = `未作成をまとめて作成`;
  }
}

function renderTopSwitcher() {
  folderTabs.innerHTML = "";
  const totalFolders = folderGroups.size;
  const unprocessedCount = getUnprocessedVideoEntries().length;

  folderStatusLabel.textContent = totalFolders > 0
    ? `${totalFolders} フォルダ（未作成 ${unprocessedCount}）`
    : "";

  for (const [folderName, grp] of folderGroups) {
    const hasVideoOnly = grp.videos.length > 0 && grp.images.length === 0;
    const btn = document.createElement("button");
    btn.className = "folder-set-btn"
      + (folderName === activeFolderName ? " active" : "")
      + (hasVideoOnly ? " unprocessed" : "");
    btn.textContent = hasVideoOnly ? `${folderName} (未作成)` : folderName;
    btn.disabled = isGenerating;
    btn.addEventListener("click", () => {
      if (!isGenerating) selectFolderSet(folderName);
    });
    folderTabs.appendChild(btn);
  }
}

// =========================================================
// 4. 画像内の列領域を実測する検出エンジン ＆ 外部画像の読み込み
// =========================================================
function detectColumnRectsFromCanvas(ctx, W, H) {
  const sampleYs = [
    Math.round(H * 0.20),
    Math.round(H * 0.35),
    Math.round(H * 0.50),
    Math.round(H * 0.65),
    Math.round(H * 0.80)
  ];

  const refPixel = ctx.getImageData(Math.min(2, W - 1), Math.round(H * 0.5), 1, 1).data;
  const refR = refPixel[0], refG = refPixel[1], refB = refPixel[2];

  function isGapBgColor(r, g, b) {
    const dRef = Math.abs(r - refR) + Math.abs(g - refG) + Math.abs(b - refB);
    const dDark = Math.abs(r - 5) + Math.abs(g - 7) + Math.abs(b - 11);
    const dNavy = Math.abs(r - 22) + Math.abs(g - 28) + Math.abs(b - 46);
    return dRef <= 18 || dDark <= 18 || dNavy <= 22;
  }

  const rowDatas = sampleYs.map(y => ctx.getImageData(0, y, W, 1).data);
  const isContentX = new Uint8Array(W);

  for (let x = 0; x < W; x++) {
    const idx = x * 4;
    let allGap = true;
    for (let s = 0; s < rowDatas.length; s++) {
      const rd = rowDatas[s];
      if (!isGapBgColor(rd[idx], rd[idx + 1], rd[idx + 2])) {
        allGap = false;
        break;
      }
    }
    if (!allGap) isContentX[x] = 1;
  }

  const rawSpans = [];
  let inSpan = false;
  let startX = 0;
  for (let x = 0; x < W; x++) {
    if (isContentX[x] && !inSpan) {
      inSpan = true;
      startX = x;
    } else if (!isContentX[x] && inSpan) {
      inSpan = false;
      rawSpans.push({ x1: startX, x2: x - 1 });
    }
  }
  if (inSpan) rawSpans.push({ x1: startX, x2: W - 1 });

  const mergedSpans = [];
  for (const sp of rawSpans) {
    if (mergedSpans.length === 0) {
      mergedSpans.push({ ...sp });
    } else {
      const prev = mergedSpans[mergedSpans.length - 1];
      const gapWidth = sp.x1 - prev.x2 - 1;
      if (gapWidth < 6) {
        prev.x2 = sp.x2;
      } else {
        mergedSpans.push({ ...sp });
      }
    }
  }

  const validSpans = mergedSpans.filter(sp => (sp.x2 - sp.x1 + 1) >= 60);

  if (validSpans.length >= 2) {
    const midX = Math.round((validSpans[0].x1 + validSpans[0].x2) * 0.5);
    const colLineData = ctx.getImageData(midX, 0, 1, H).data;

    let topY = 0;
    for (let y = 0; y < Math.min(80, Math.round(H * 0.15)); y++) {
      const idx = y * 4;
      if (!isGapBgColor(colLineData[idx], colLineData[idx + 1], colLineData[idx + 2])) {
        topY = y;
        break;
      }
    }

    let bottomY = H - 2;
    for (let y = H - 2; y >= H - Math.min(50, Math.round(H * 0.1)); y--) {
      const idx = y * 4;
      if (!isGapBgColor(colLineData[idx], colLineData[idx + 1], colLineData[idx + 2])) {
        bottomY = y;
        break;
      }
    }

    const colH = Math.max(100, bottomY - topY + 1);
    const rects = validSpans.map(sp => ({
      x: sp.x1,
      y: topY,
      w: sp.x2 - sp.x1 + 1,
      h: colH
    }));
    return { mode: "grid", rects };
  }

  if (validSpans.length === 1) {
    const sp = validSpans[0];
    return {
      mode: "single",
      rects: [{ x: sp.x1, y: 0, w: sp.x2 - sp.x1 + 1, h: H }]
    };
  }

  return {
    mode: "single",
    rects: [{ x: 0, y: 0, w: W, h: H }]
  };
}

// 新しい静止画は並べ方（列の位置・倍率）を埋め込んでいるので、枠線を誤検出せず正確な列位置を使う
function layoutRectsFromMeta(lay, W, H) {
  if (!lay || !lay.m) return null;
  if (lay.m === "single") return { mode: "single", rects: [{ x: 0, y: 0, w: W, h: H }] };
  const s = lay.s || 1;
  const g = lay.g || 0;
  const top = (lay.hh || 0) + g;
  const rects = [];
  for (let c = 0; c < (lay.n || 0); c++) {
    const x1 = Math.round((g + c * (lay.cw + g)) * s);
    const x2 = Math.round((g + c * (lay.cw + g) + lay.cw) * s);
    const y1 = Math.round(top * s);
    const y2 = Math.round((top + lay.ch) * s);
    if (x2 > W || y2 > H || x2 <= x1 || y2 <= y1) return null;
    rects.push({ x: x1, y: y1, w: x2 - x1, h: y2 - y1 });
  }
  return rects.length > 0 ? { mode: "grid", rects } : null;
}

function loadImageAsDrawable(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("image load failed")); };
    img.src = url;
  });
}

let imageLoadToken = 0;
async function loadImageItemToViewer(imgItem) {
  if (imgItem.masterData && imgItem.masterData.hasData) {
    imageLoadToken++;
    replaceMasterChartData(imgItem.masterData);
    reLayoutBtn.disabled = isGenerating;
    rebuildLayoutFromMaster(false);
    return;
  }

  const token = ++imageLoadToken;
  let drawable = null;
  try {
    const blob = imgItem.file || (imgItem.url ? await (await fetch(imgItem.url)).blob() : null);
    if (!blob) return;
    // 色変換をかけずに読み込む（埋め込んだタイムスタンプの下位ビットが崩れないように）
    if (typeof createImageBitmap === "function") {
      try {
        drawable = await createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none" });
      } catch (e) {
        drawable = null;
      }
    }
    if (!drawable) drawable = await loadImageAsDrawable(blob);
  } catch (e) {
    bottomSaveStatusLabel.textContent = `画像を読み込めませんでした: ${imgItem.name}`;
    return;
  }
  if (token !== imageLoadToken) {
    if (drawable && drawable.close) drawable.close();
    return;
  }

  const W = drawable.width;
  const H = drawable.height;
  outputCanvas.width = W;
  outputCanvas.height = H;
  const outCtx = outputCanvas.getContext("2d", { willReadFrequently: true });
  outCtx.drawImage(drawable, 0, 0);

  const infoText = `表示中: ${activeFolderName} / ${imgItem.name} (${W} x ${H} px)`;
  currentViewFileName.textContent = infoText;
  bottomSaveStatusLabel.textContent = infoText;

  extractMasterFromExternalImage(drawable, outCtx, `${activeFolderName}`);
  if (drawable.close) drawable.close();
  setupViewerAfterGenerate(chartMeta.numCols);
  drawPlayheadOverlay();
}

function extractMasterFromExternalImage(img, ctx, labelName) {
  const W = img.width;
  const H = img.height;
  const parsedStart = parseFloat(startTimeInput.value);
  const parsedEnd = parseFloat(endTimeInput.value);
  let tStart = !isNaN(parsedStart) ? parsedStart : 0.0;
  let tEnd = (!isNaN(parsedEnd) && parsedEnd > tStart) ? parsedEnd : (video.duration || 120.0);

  const embeddedMeta = extractTimestampsFromCanvas(ctx, W, H);
  const detected = (embeddedMeta && layoutRectsFromMeta(embeddedMeta.layout, W, H)) || detectColumnRectsFromCanvas(ctx, W, H);
  const colRects = detected.rects;
  const mode = detected.mode;
  const numCols = colRects.length;
  const calcCropW = Math.round(colRects[0].w);
  const colMaxH = Math.round(colRects[0].h);
  const estColGap = numCols > 1 ? Math.max(0, colRects[1].x - (colRects[0].x + colRects[0].w)) : 0;
  const estHeaderH = mode === "grid" ? Math.max(0, colRects[0].y - estColGap) : 0;

  currentColumnWidths = calcCropW;
  const totalHeight = numCols * colMaxH;

  const cropRatio = Math.max(0.2, (parseFloat(cropRightSlider.value) - parseFloat(cropLeftSlider.value)) / 100);
  const estVideoW = calcCropW / cropRatio;
  const estH = estVideoW * 0.68;
  let estBottomBaseH = Math.round(estH * 0.38);
  let estTopCapH = Math.round(estH * 0.55);
  let restoredTimeMap = [];
  let frameH = 0;
  let captureY = 0;

  // マスター上の位置 → この画像上の位置の倍率。一覧画像は最後の列に空白があるため、
  // 全体の高さの比ではなく「1列の高さ」の比で求める（並べ方の情報が無い古い画像は従来どおり）
  const scaleFromLayout = (lay, fallbackTotal) => {
    if (lay && lay.m === "grid" && lay.ch > 0) return colMaxH / lay.ch;
    return fallbackTotal > 0 ? (totalHeight / fallbackTotal) : 1.0;
  };

  if (embeddedMeta && embeddedMeta.timeToYMap && embeddedMeta.timeToYMap.length >= 2) {
    const scaleY = scaleFromLayout(embeddedMeta.layout, embeddedMeta.totalHeight);
    estBottomBaseH = Math.round((embeddedMeta.bottomBaseH || estBottomBaseH) * scaleY);
    estTopCapH = Math.round((embeddedMeta.topCapH || estTopCapH) * scaleY);
    frameH = Math.round((embeddedMeta.frameH || 0) * scaleY);
    captureY = Math.round((embeddedMeta.captureY || 0) * scaleY);
    tStart = embeddedMeta.tStart ?? tStart;
    tEnd = embeddedMeta.tEnd ?? tEnd;
    restoredTimeMap = embeddedMeta.timeToYMap.map(pt => ({
      time: pt.time,
      bottomY: pt.bottomY * scaleY
    }));
  } else if (savedTimestampsByFolder[labelName] && savedTimestampsByFolder[labelName].timeToYMap) {
    const savedProf = savedTimestampsByFolder[labelName];
    const scaleY = scaleFromLayout(savedProf.layout, savedProf.totalHeight);
    estBottomBaseH = Math.round((savedProf.bottomBaseH || estBottomBaseH) * scaleY);
    estTopCapH = Math.round((savedProf.topCapH || estTopCapH) * scaleY);
    frameH = Math.round((savedProf.frameH || 0) * scaleY);
    captureY = Math.round((savedProf.captureY || 0) * scaleY);
    tStart = savedProf.tStart ?? tStart;
    tEnd = savedProf.tEnd ?? tEnd;
    restoredTimeMap = savedProf.timeToYMap.map(pt => ({
      time: pt.time,
      bottomY: pt.bottomY * scaleY
    }));
  }

  const numChunks = Math.ceil(totalHeight / MASTER_CHUNK_H);
  const chunks = [];
  for (let k = 0; k < numChunks; k++) {
    const ch = document.createElement("canvas");
    ch.width = calcCropW;
    ch.height = MASTER_CHUNK_H;
    chunks.push(ch);
  }

  for (let c = 0; c < numCols; c++) {
    const rect = colRects[c];
    const sx = rect.x;
    const sy = rect.y;

    const colBottomStart = c * colMaxH;
    const startChunk = Math.floor(colBottomStart / MASTER_CHUNK_H);
    const endChunk = Math.floor((colBottomStart + colMaxH - 1) / MASTER_CHUNK_H);
    for (let k = startChunk; k <= endChunk; k++) {
      const chunkBottomStart = k * MASTER_CHUNK_H;
      const overlapBottom = Math.max(colBottomStart, chunkBottomStart);
      const overlapTop = Math.min(colBottomStart + colMaxH, chunkBottomStart + MASTER_CHUNK_H);
      const copyH = overlapTop - overlapBottom;
      if (copyH <= 0) continue;

      const srcY = sy + (colMaxH - (overlapBottom - colBottomStart) - copyH);
      const dstY = MASTER_CHUNK_H - (overlapBottom - chunkBottomStart) - copyH;
      chunks[k].getContext("2d").drawImage(img, sx, srcY, rect.w, copyH, 0, dstY, calcCropW, copyH);
    }
  }

  replaceMasterChartData({
    hasData: true,
    cropW: calcCropW,
    totalHeight: totalHeight,
    bottomBaseH: estBottomBaseH,
    topCapH: estTopCapH,
    chunks: chunks,
    tStart: tStart,
    tEnd: tEnd,
    timeToYMap: restoredTimeMap,
    frameH,
    captureY,
    sourceLabel: labelName
  });
  reLayoutBtn.disabled = isGenerating;

  chartMeta = {
    isGenerated: false,
    mode: mode,
    numCols: numCols,
    cropW: calcCropW,
    colMaxH: colMaxH,
    colGap: estColGap,
    headerH: estHeaderH,
    totalHeight: totalHeight,
    bottomBaseH: estBottomBaseH,
    topCapH: estTopCapH,
    tStart: tStart,
    tEnd: tEnd,
    scale: 1,
    renderScale: 1,
    colRects: colRects,
    timeToYMap: [],
    displayMap: null
  };
  setChartTimeMap(restoredTimeMap);
}

// 静止画のないフォルダを選んだときに、表示中の譜面と再生位置バーを片付ける
function clearViewerChart() {
  imageLoadToken++;
  replaceMasterChartData({ hasData: false, cropW: 0, totalHeight: 0, bottomBaseH: 0, topCapH: 0, chunks: [], tStart: 0, tEnd: 0, timeToYMap: [], sourceLabel: "" });
  outputCanvas.width = 0;
  outputCanvas.height = 0;
  chartMeta.isGenerated = false;
  chartMeta.colRects = [];
  setChartTimeMap([]);
  colJumpBar.style.display = "none";
  reLayoutBtn.disabled = true;
  currentViewFileName.textContent = `表示中: ${activeFolderName}（静止画は未作成です）`;
  bottomSaveStatusLabel.textContent = "";
  drawPlayheadOverlay();
}

// =========================================================
// 5. マスター譜面データから「1列の高さ」を変更して即時再生成
// =========================================================
function drawColumnFromMaster(targetCtx, mData, c, colMaxH, destX, destY) {
  const { cropW, totalHeight, chunks } = mData;
  targetCtx.fillStyle = "#000000";
  targetCtx.fillRect(destX, destY, cropW, colMaxH);

  const colBottomStart = c * colMaxH;
  const colBottomEnd = Math.min(totalHeight, colBottomStart + colMaxH);
  if (colBottomEnd <= colBottomStart) return;

  const startChunk = Math.floor(colBottomStart / MASTER_CHUNK_H);
  const endChunk = Math.floor((colBottomEnd - 1) / MASTER_CHUNK_H);

  for (let k = startChunk; k <= endChunk; k++) {
    if (k < 0 || k >= chunks.length) continue;
    const chunkBottomStart = k * MASTER_CHUNK_H;
    const overlapBottom = Math.max(colBottomStart, chunkBottomStart);
    const overlapTop = Math.min(colBottomEnd, chunkBottomStart + MASTER_CHUNK_H);
    const copyH = overlapTop - overlapBottom;
    if (copyH <= 0) continue;

    const srcY = MASTER_CHUNK_H - (overlapBottom - chunkBottomStart) - copyH;
    const dstY = destY + (colMaxH - (overlapBottom - colBottomStart) - copyH);
    targetCtx.drawImage(chunks[k], 0, srcY, cropW, copyH, destX, dstY, cropW, copyH);
  }
}

// 一覧画像のキャンバスを確保して下地を塗る。iOS Safari などは上限を超えるサイズだと例外を出さずに真っ白のままになるため、
// 実際に塗れたことを確かめ、塗れなければ倍率を下げて取り直す
function allocateChartCanvas(canvas, rawW, rawH, fill) {
  const MAX_DIM = 14000;
  const MAX_AREA = 60000000;
  let scale = Math.min(1, MAX_DIM / Math.max(1, rawW), MAX_DIM / Math.max(1, rawH), Math.sqrt(MAX_AREA / Math.max(1, rawW * rawH)));
  for (let tries = 0; tries < 6; tries++) {
    canvas.width = Math.max(1, Math.round(rawW * scale));
    canvas.height = Math.max(1, Math.round(rawH * scale));
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (ctx) {
      ctx.fillStyle = fill;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      if (ctx.getImageData(canvas.width - 1, canvas.height - 1, 1, 1).data[3] === 255) {
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        return { ctx, scale };
      }
    }
    scale *= 0.7;
  }
  throw canvasMemoryError();
}

// マスターから一覧画像（または1本の縦長画像）を描く。画面表示用と一括処理の保存用で共通
function renderChartLayout(mData, targetCanvas) {
  const { cropW, totalHeight } = mData;
  const colMaxH = Math.max(400, parseInt(colHeightInput.value, 10) || 8000);
  const mode = layoutMode.value === "single" ? "single" : "grid";
  const numCols = Math.max(1, Math.ceil(totalHeight / colMaxH));
  const colGap = 14;
  const headerH = 0;

  let renderScale = 1;
  const colRects = [];

  if (mode === "single") {
    const alloc = allocateChartCanvas(targetCanvas, cropW, totalHeight, "#000000");
    const outCtx = alloc.ctx;
    renderScale = alloc.scale;
    outCtx.save();
    outCtx.scale(renderScale, renderScale);

    for (let c = 0; c < numCols; c++) {
      const destY = totalHeight - (c + 1) * colMaxH;
      drawColumnFromMaster(outCtx, mData, c, colMaxH, 0, destY);
    }
    outCtx.restore();

    colRects.push({ x: 0, y: 0, w: targetCanvas.width, h: targetCanvas.height });
  } else {
    const rawW = numCols * cropW + (numCols + 1) * colGap;
    const rawH = colMaxH + headerH + colGap * 2;
    const alloc = allocateChartCanvas(targetCanvas, rawW, rawH, blackBgToggle.checked ? "#05070b" : "#161c2e");
    const outCtx = alloc.ctx;
    renderScale = alloc.scale;

    outCtx.save();
    outCtx.scale(renderScale, renderScale);

    for (let c = 0; c < numCols; c++) {
      const x = colGap + c * (cropW + colGap);
      const y = headerH + colGap;

      drawColumnFromMaster(outCtx, mData, c, colMaxH, x, y);
      // 枠線は譜面の外側に描く（以前は譜面の端の1行を上書きしていた）
      outCtx.strokeStyle = "#2b3856";
      outCtx.lineWidth = 2;
      outCtx.strokeRect(x - 1, y - 1, cropW + 2, colMaxH + 2);

      colRects.push({
        x: x * renderScale,
        y: y * renderScale,
        w: cropW * renderScale,
        h: colMaxH * renderScale
      });
    }
    outCtx.restore();
  }

  return {
    mode, numCols, colMaxH, colGap, headerH, renderScale, colRects,
    layoutMeta: { m: mode, n: numCols, ch: colMaxH, cw: cropW, g: colGap, hh: headerH, s: Number(renderScale.toFixed(6)) }
  };
}

async function rebuildLayoutFromMaster(shouldAutoSave = true, opts = {}) {
  if (!masterChartData.hasData || !masterChartData.chunks || masterChartData.chunks.length === 0) return;
  const mData = masterChartData;
  const { cropW, totalHeight, bottomBaseH, topCapH, tStart, tEnd, timeToYMap, sourceLabel } = mData;

  currentColumnWidths = cropW;
  const lay = renderChartLayout(mData, outputCanvas);

  chartMeta = {
    isGenerated: true,
    mode: lay.mode,
    numCols: lay.numCols,
    cropW: cropW,
    colMaxH: lay.colMaxH,
    colGap: lay.colGap,
    headerH: lay.headerH,
    totalHeight: totalHeight,
    bottomBaseH: bottomBaseH || 0,
    topCapH: topCapH || 0,
    tStart: tStart,
    tEnd: tEnd,
    scale: lay.renderScale,
    renderScale: lay.renderScale,
    colRects: lay.colRects,
    timeToYMap: [],
    displayMap: null,
    frameH: mData.frameH || 0,
    captureY: mData.captureY || 0,
    layout: lay.layoutMeta
  };
  setChartTimeMap(timeToYMap);

  embedTimestampsIntoCanvas(outputCanvas, chartMeta);
  // お試し作成など、保存しない結果（keepExisting）は後から1列の高さを変えても上書きしない
  if (activeFolderName && opts.saveProfile !== false && !mData.keepExisting) {
    saveTimestampProfileForFolder(activeFolderName, chartMeta);
  }

  const infoText = `${sourceLabel || activeFolderName || "生成譜面"} [1列の高さ: ${lay.colMaxH}px / 全${lay.numCols}列] (${outputCanvas.width} x ${outputCanvas.height} px)`;
  currentViewFileName.textContent = infoText;
  bottomSaveStatusLabel.textContent = infoText;
  setupViewerAfterGenerate(lay.numCols);
  drawPlayheadOverlay();

  if (shouldAutoSave && !mData.keepExisting && activeFolderName && !cancelGenerationRequested) {
    return await autoSaveCanvasToFolder(activeFolderName, outputCanvas);
  }
  return false;
}

reLayoutBtn.addEventListener("click", () => {
  if (!isGenerating && masterChartData.hasData) rebuildLayoutFromMaster(true);
});
layoutMode.addEventListener("change", () => {
  scheduleSaveSettings();
  if (!isGenerating && masterChartData.hasData) rebuildLayoutFromMaster(true);
});
colHeightInput.addEventListener("change", () => {
  scheduleSaveSettings();
  if (!isGenerating && masterChartData.hasData) rebuildLayoutFromMaster(true);
});
resolutionSelect.addEventListener("change", () => {
  scheduleSaveSettings();
});

function getVideoObjectUrl(vidItem) {
  if (!vidItem) return "";
  if (vidItem.file) {
    // 同じ動画を何度選んでも URL を作り直さない（作るたびに解放されずに溜まっていたため）
    if (!vidItem.objectUrl) vidItem.objectUrl = URL.createObjectURL(vidItem.file);
    return vidItem.objectUrl;
  }
  return vidItem.url || "";
}

function waitForVideoMetadata(vidElem, timeoutMs = 15000) {
  return new Promise((resolve) => {
    if (vidElem.readyState >= 1 && vidElem.videoWidth) {
      resolve(true);
      return;
    }
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      vidElem.removeEventListener("loadedmetadata", onOk);
      vidElem.removeEventListener("error", onErr);
      resolve(ok);
    };
    const onOk = () => finish(true);
    const onErr = () => finish(false);
    const timer = setTimeout(() => finish(false), timeoutMs);
    vidElem.addEventListener("loadedmetadata", onOk);
    vidElem.addEventListener("error", onErr);
  });
}

function loadVideoItem(vidItem) {
  if (isGenerating) return;
  if (activeVideoItem && activeVideoItem !== vidItem) {
    activeVideoItem.previewBg = null;   // プレビュー用の背景モデルは表示中の動画の分だけ持つ
  }
  activeVideoName = vidItem.name;
  activeVideoItem = vidItem;
  shouldRestartFromBeginning = false;
  playbackClock.stop();

  video.src = getVideoObjectUrl(vidItem);
  video.muted = false;
  video.volume = 1.0;
  video.load();
  video.onloadedmetadata = () => {
    applyPlaybackRate(currentPlaybackRate, false);
    previewCanvas.width = video.videoWidth || 640;
    previewCanvas.height = video.videoHeight || 360;
    const dur = video.duration || 0;
    seekSlider.max = dur.toFixed(2);

    const defaultStart = 0.0;
    const defaultEnd = dur;
    startTimeInput.value = defaultStart.toFixed(1);
    endTimeInput.value = defaultEnd.toFixed(1);

    if (!chartMeta.isGenerated && (!chartMeta.timeToYMap || chartMeta.timeToYMap.length === 0)) {
      chartMeta.tStart = defaultStart;
      chartMeta.tEnd = defaultEnd;
    }

    generateBtn.disabled = isGenerating;
    testGenerateBtn.disabled = isGenerating;
    updateBatchButtonState();

    video.currentTime = defaultStart;
    drawPlayheadOverlay();
    ensurePreviewBackgroundModel(vidItem);
  };
}

// プレビューの黒背景表示用に、動画全体の静止背景モデル（フレーム全体・原寸）を裏で作る
async function ensurePreviewBackgroundModel(vidItem) {
  if (!vidItem || vidItem.previewBg || vidItem.previewBgPending || vidItem.previewBgFailed || !blackBgToggle.checked) return;
  if (!video.videoWidth || vidItem !== activeVideoItem) return;
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (w * h > 3840 * 2160) return;
  const dur = video.duration || 0;
  vidItem.previewBgPending = true;
  let tempVid = null;
  try {
    let source = vidItem.file ? await WebCodecsFrameSource.open(vidItem.file, w, h) : null;
    if (!source) {
      tempVid = document.createElement("video");
      tempVid.muted = true;
      tempVid.preload = "auto";
      tempVid.src = video.src;
      if (!(await waitForVideoMetadata(tempVid))) {
        vidItem.previewBgFailed = true;
        return;
      }
      source = new SeekFrameSource(tempVid);
    }
    const geo = computeCaptureGeometry(w, h, 0, 1, 1);
    geo.rotation = source.rotation || 0;
    const stop = () => activeVideoItem !== vidItem || isGenerating;
    const bg = await buildStaticBackgroundModel(source, geo, 0, dur, stop, null, { maxSamples: 11, minSamples: 7 });
    if (bg && !stop()) vidItem.previewBg = { bg, w: geo.cropW, h: geo.h, laneCache: null };
    // 途中で別の動画に切り替えた・生成が始まった場合は、次に表示したときに作り直す
    else if (!stop()) vidItem.previewBgFailed = true;
  } catch (e) {
    vidItem.previewBgFailed = true;
  } finally {
    vidItem.previewBgPending = false;
    if (tempVid) {
      tempVid.removeAttribute("src");
      tempVid.load();
    }
  }
  if (vidItem === activeVideoItem && video.paused && !isGenerating) drawPreview(true);
}

function drawPreview(forceFilter = false) {
  if (isGenerating && !forceFilter) return;
  if (!video.videoWidth) return;
  const w = previewCanvas.width;
  const h = previewCanvas.height;
  pCtx.drawImage(video, 0, 0, w, h);

  const leftPct = parseFloat(cropLeftSlider.value) / 100;
  const rightPct = parseFloat(cropRightSlider.value) / 100;
  const x1 = Math.round(w * leftPct);
  const x2 = Math.round(w * rightPct);
  const cw = x2 - x1;

  // 一時停止中は、生成時と同じ「静止背景モデルとの差」で黒背景化した結果を表示する
  if ((video.paused || forceFilter) && !isGenerating && blackBgToggle.checked && cw > 10) {
    const pb = activeVideoItem && activeVideoItem.previewBg;
    if (pb && pb.w === w && pb.h === h) {
      if (filterSubCanvas.width !== cw || filterSubCanvas.height !== h) {
        filterSubCanvas.width = cw;
        filterSubCanvas.height = h;
      }
      filterSubCtx.drawImage(video, x1, 0, cw, h, 0, 0, cw, h);
      const img = filterSubCtx.getImageData(0, 0, cw, h);
      const fp = getBlackFilterParams();
      const laneKey = `${x1}:${cw}:${fp.lineGain}`;
      if (!pb.laneCache || pb.laneCache.key !== laneKey) {
        pb.laneCache = {
          key: laneKey,
          lane: extractStaticVerticalLines(pb.bg, pb.w, x1, cw, h, Math.round(h * TOP_SAFE_RATIO), fp.lineGain)
        };
      }
      for (let y = 0; y < h; y++) {
        maskRowAgainstBackground(img.data, y * cw * 4, pb.bg, (y * pb.w + x1) * 3, cw, fp, pb.laneCache.lane, img.data, y * cw * 4);
      }
      filterSubCtx.putImageData(img, 0, 0);
      pCtx.drawImage(filterSubCanvas, x1, 0);
    } else if (activeVideoItem) {
      ensurePreviewBackgroundModel(activeVideoItem);
    }
  }

  pCtx.fillStyle = "rgba(0, 0, 0, 0.72)";
  pCtx.fillRect(0, 0, x1, h);
  pCtx.fillRect(x2, 0, w - x2, h);

  pCtx.strokeStyle = "#00d4d4";
  pCtx.lineWidth = 2;
  pCtx.strokeRect(x1, 0, cw, h);

  // 切り出し基準ライン（再生位置バーはこのラインにある譜面の位置を指す）
  const anchorY = Math.round(h * CAPTURE_LINE_RATIO);
  pCtx.strokeStyle = "#ff4d88";
  pCtx.setLineDash([6, 4]);
  pCtx.beginPath();
  pCtx.moveTo(x1, anchorY);
  pCtx.lineTo(x2, anchorY);
  pCtx.stroke();
  pCtx.setLineDash([]);
}

// =========================================================
// 6. 再生位置バー（実フレーム時刻で記録した位置マップ ＋ 滑らかな再生時計 ＋ 画面座標での描画）
// =========================================================
function setChartTimeMap(map) {
  chartMeta.timeToYMap = map || [];
  chartMeta.displayMap = buildDisplayTimeMap(chartMeta.timeToYMap);
}

function getNominalBottomYForTime(t) {
  if (chartMeta.displayMap) return displayMapY(chartMeta.displayMap, t);
  const { tStart, tEnd, totalHeight, bottomBaseH, topCapH } = chartMeta;
  const dur = Math.max(0.1, tEnd - tStart);
  const startY = bottomBaseH || 0;
  const endY = Math.max(startY + 100, totalHeight - (topCapH || 0));
  const ratio = Math.max(0, Math.min(1, (t - tStart) / dur));
  return startY + ratio * (endY - startY);
}

function getTimeForBottomY(targetBottomY) {
  if (chartMeta.displayMap) return displayMapTime(chartMeta.displayMap, targetBottomY);
  const { tStart, tEnd, totalHeight, bottomBaseH, topCapH } = chartMeta;
  const startY = bottomBaseH || 0;
  const endY = Math.max(startY + 100, totalHeight - (topCapH || 0));
  const ratio = Math.max(0, Math.min(1, (targetBottomY - startY) / Math.max(1, endY - startY)));
  return tStart + ratio * (tEnd - tStart);
}

// 再生時計：video.currentTime はフレームごとに数msの揺らぎがあるため、
// 実フレームの表示時刻（requestVideoFrameCallback）に少しずつ合わせ込む一定速度の時計でバーを動かす
const playbackClock = {
  running: false,
  synced: false,
  anchorMedia: 0,
  anchorPerf: 0,
  rate: 1,
  lastObsPerf: 0,
  reset(mediaTime, perfAt) {
    this.anchorMedia = mediaTime;
    this.anchorPerf = perfAt;
    this.rate = video.playbackRate || 1;
    this.lastObsPerf = perfAt;
  },
  start() {
    this.running = true;
    this.synced = false;
    this.reset(video.currentTime || 0, performance.now());
  },
  stop() {
    this.running = false;
  },
  predict(perfAt) {
    if (!this.running) return video.currentTime || 0;
    let t = this.anchorMedia + (perfAt - this.anchorPerf) * 0.001 * this.rate;
    if (video.duration && t > video.duration) t = video.duration;
    return t;
  },
  observe(mediaTime, perfAt) {
    if (!this.running || !(mediaTime >= 0)) return;
    if (!this.synced) {
      // 再生開始直後は、最初に実際に表示されたフレームの時刻にそのまま合わせる
      // （currentTime から始めると出力遅延ぶんずれ、それを少しずつ直す間バーが減速して見えていた）
      this.synced = true;
      this.reset(mediaTime, perfAt);
      return;
    }
    const err = mediaTime - this.predict(perfAt);
    if (Math.abs(err) > 0.15 * Math.max(1, this.rate)) this.reset(mediaTime, perfAt);
    else this.anchorMedia += err * 0.1;
    this.lastObsPerf = perfAt;
  }
};
const HAS_RVFC = typeof video.requestVideoFrameCallback === "function";

// 一時停止・再開を繰り返しても監視が二重に登録されないよう、前の予約を取り消してから登録する
let frameObservationHandle = 0;
function requestFrameObservation() {
  if (!HAS_RVFC) return;
  if (frameObservationHandle && typeof video.cancelVideoFrameCallback === "function") {
    video.cancelVideoFrameCallback(frameObservationHandle);
  }
  frameObservationHandle = video.requestVideoFrameCallback((now, meta) => {
    frameObservationHandle = 0;
    if (!playbackClock.running) return;
    playbackClock.observe(meta.mediaTime, meta.expectedDisplayTime || now);
    requestFrameObservation();
  });
}

let playheadGeom = null;   // 最後に計算した再生位置バーの位置（静止画キャンバス上の座標）
let lastBadgeText = "";
let lastBarWidthPx = -1;
let lastHighlightKey = "";

function drawPlayheadOverlay(mediaTime) {
  if (!outputCanvas.width || !outputCanvas.height || !showPlayheadToggle.checked || !chartMeta.totalHeight) {
    playheadGeom = null;
    positionPlayheadOverlay();
    return;
  }

  const rawTime = (typeof mediaTime === "number") ? mediaTime : (video.currentTime || 0);
  const offsetSec = parseFloat(playheadOffsetInput.value) || 0;
  const { colMaxH, numCols, totalHeight, colRects } = chartMeta;
  const bottomY = Math.max(0, Math.min(totalHeight, getNominalBottomYForTime(rawTime + offsetSec)));

  let barX = 0, barY = 0, barW = outputCanvas.width;
  let colRect = null;

  // 一覧表示は1列しかなくても列の高さが基準（譜面が短いと列の上側は空白になるので、全体の高さの比では位置がずれる）
  if (chartMeta.mode === "single" || !colRects || colRects.length === 0) {
    const rect = (colRects && colRects[0]) ? colRects[0] : { x: 0, y: 0, w: outputCanvas.width, h: outputCanvas.height };
    barX = rect.x;
    barW = rect.w;
    const ratio = Math.max(0, Math.min(1, bottomY / Math.max(1, totalHeight)));
    barY = rect.y + rect.h * (1 - ratio);
  } else {
    const colIndex = Math.min(numCols - 1, Math.max(0, Math.floor(bottomY / colMaxH)));
    const relBottom = Math.max(0, Math.min(colMaxH, bottomY - colIndex * colMaxH));
    const rect = colRects[colIndex] || colRects[0];
    barX = rect.x;
    barW = rect.w;
    barY = rect.y + rect.h * (1 - relBottom / Math.max(1, colMaxH));
    colRect = rect;
  }
  playheadGeom = { barX, barY, barW, colRect };

  const badge = `${rawTime.toFixed(2)}s (${currentPlaybackRate}x)`;
  if (badge !== lastBadgeText) {
    lastBadgeText = badge;
    playheadTimeBadge.textContent = badge;
  }

  if (followPlayheadToggle.checked && !isDragging) {
    const vw = viewerViewport.clientWidth;
    const vh = viewerViewport.clientHeight;
    vX = vw * 0.5 - (barX + barW * 0.5) * vScale;
    vY = vh * 0.55 - barY * vScale;
  }
  updateViewerTransform();
}

// 再生位置バーは拡大縮小される静止画の中ではなく画面座標で描く（細くなって消えたり、文字が潰れたりしない）
function positionPlayheadOverlay() {
  if (!playheadGeom) {
    playheadBar.style.display = "none";
    playheadColHighlight.style.display = "none";
    lastHighlightKey = "";
    return;
  }
  const { barX, barY, barW, colRect } = playheadGeom;
  const sx = vX + barX * vScale;
  const sy = vY + barY * vScale;
  const sw = Math.max(1, barW * vScale);
  if (Math.abs(sw - lastBarWidthPx) > 0.25) {
    lastBarWidthPx = sw;
    playheadBar.style.width = `${sw}px`;
  }
  playheadBar.style.transform = `translate3d(${sx}px, ${sy}px, 0)`;
  playheadBar.style.display = "block";

  if (colRect) {
    const hx = vX + colRect.x * vScale;
    const hy = vY + colRect.y * vScale;
    const hw = colRect.w * vScale;
    const hh = colRect.h * vScale;
    const key = `${hw.toFixed(2)}x${hh.toFixed(2)}`;
    if (key !== lastHighlightKey) {
      lastHighlightKey = key;
      playheadColHighlight.style.width = `${hw}px`;
      playheadColHighlight.style.height = `${hh}px`;
    }
    playheadColHighlight.style.transform = `translate3d(${hx}px, ${hy}px, 0)`;
    playheadColHighlight.style.display = "block";
  } else {
    playheadColHighlight.style.display = "none";
    lastHighlightKey = "";
  }
}

let animFrameId = null;
let rafIntervalEstimate = 16.7;
let lastRafTs = 0;
let lastUiUpdateWall = 0;
function startPlaybackLoop() {
  lastRafTs = 0;
  const tick = (ts) => {
    if (video.paused || video.ended || isGenerating) return;
    if (lastRafTs) {
      const d = ts - lastRafTs;
      if (d > 3 && d < 60) rafIntervalEstimate = rafIntervalEstimate * 0.9 + d * 0.1;
    }
    lastRafTs = ts;
    // requestVideoFrameCallback が使えない／止まっているときは currentTime で時計を補正する
    const nowPerf = performance.now();
    if (!HAS_RVFC || nowPerf - playbackClock.lastObsPerf > 300) {
      playbackClock.observe(video.currentTime, nowPerf);
    }
    // この描画が画面に出るのは次の垂直同期なので、その時刻の再生位置を使う
    const t = playbackClock.predict(ts + rafIntervalEstimate);

    if (nowPerf - lastUiUpdateWall > 100) {
      lastUiUpdateWall = nowPerf;
      seekSlider.value = video.currentTime;
      currentTimeLabel.textContent = `${video.currentTime.toFixed(2)} 秒 / ${(video.duration || 0).toFixed(2)} 秒`;
    }
    drawPreview(false);
    drawPlayheadOverlay(t);
    animFrameId = requestAnimationFrame(tick);
  };
  cancelAnimationFrame(animFrameId);
  animFrameId = requestAnimationFrame(tick);
}

video.addEventListener("play", () => {
  if (!isGenerating) {
    applyPlaybackRate(currentPlaybackRate, false);
    startPlaybackLoop();
  }
});
video.addEventListener("playing", () => {
  if (isGenerating) return;
  playbackClock.start();
  requestFrameObservation();
  startPlaybackLoop();
});
video.addEventListener("waiting", () => {
  playbackClock.stop();
});
video.addEventListener("seeking", () => {
  playbackClock.stop();
});
video.addEventListener("ratechange", () => {
  if (playbackClock.running) playbackClock.reset(playbackClock.predict(performance.now()), performance.now());
});
video.addEventListener("pause", () => {
  playbackClock.stop();
  cancelAnimationFrame(animFrameId);
  if (!isGenerating) {
    seekSlider.value = video.currentTime;
    currentTimeLabel.textContent = `${video.currentTime.toFixed(2)} 秒 / ${(video.duration || 0).toFixed(2)} 秒`;
    drawPreview(true);
    drawPlayheadOverlay();
  }
});
video.addEventListener("seeked", () => {
  if (isGenerating) return;
  if (!video.paused) {
    playbackClock.start();
    requestFrameObservation();
    return;
  }
  seekSlider.value = video.currentTime;
  currentTimeLabel.textContent = `${video.currentTime.toFixed(2)} 秒 / ${(video.duration || 0).toFixed(2)} 秒`;
  drawPreview(true);
  drawPlayheadOverlay();
});

showPlayheadToggle.addEventListener("change", () => {
  scheduleSaveSettings();
  drawPlayheadOverlay();
});
followPlayheadToggle.addEventListener("change", () => {
  scheduleSaveSettings();
  drawPlayheadOverlay();
});

playheadOffsetSlider.addEventListener("input", () => {
  const val = parseFloat(playheadOffsetSlider.value) || 0;
  playheadOffsetInput.value = val.toFixed(2);
  if (video.paused) drawPlayheadOverlay();
  scheduleSaveSettings();
});
playheadOffsetInput.addEventListener("input", () => {
  const val = parseFloat(playheadOffsetInput.value) || 0;
  playheadOffsetSlider.value = Math.max(-2, Math.min(2, val)).toFixed(2);
  if (video.paused) drawPlayheadOverlay();
  scheduleSaveSettings();
});
resetOffsetBtn.addEventListener("click", () => {
  playheadOffsetSlider.value = "0.00";
  playheadOffsetInput.value = "0.00";
  if (video.paused) drawPlayheadOverlay();
  scheduleSaveSettings();
});

startTimeInput.addEventListener("change", () => {
  if (!chartMeta.isGenerated) {
    chartMeta.tStart = parseFloat(startTimeInput.value) || 0;
    drawPlayheadOverlay();
  }
});
endTimeInput.addEventListener("change", () => {
  if (!chartMeta.isGenerated) {
    chartMeta.tEnd = parseFloat(endTimeInput.value) || 100;
    drawPlayheadOverlay();
  }
});

seekSlider.addEventListener("input", () => {
  if (isGenerating) return;
  shouldRestartFromBeginning = false;
  video.pause();
  video.currentTime = parseFloat(seekSlider.value);
});

function toggleVideoPlay() {
  if (!video.src || isGenerating) return;
  video.muted = false;
  applyPlaybackRate(currentPlaybackRate, false);
  if (video.paused) {
    if (shouldRestartFromBeginning || video.ended || (video.duration && video.currentTime >= video.duration - 0.1)) {
      video.currentTime = 0;
      shouldRestartFromBeginning = false;
    }
    const p = video.play();
    if (p && typeof p.catch === "function") p.catch(() => {});
  } else {
    video.pause();
  }
}
playPauseBtn.addEventListener("click", toggleVideoPlay);
viewerPlayPauseBtn.addEventListener("click", toggleVideoPlay);

setStartBtn.addEventListener("click", () => { if (!isGenerating) startTimeInput.value = video.currentTime.toFixed(2); });
setEndBtn.addEventListener("click", () => { if (!isGenerating) endTimeInput.value = video.currentTime.toFixed(2); });

cropLeftSlider.addEventListener("input", () => {
  if (parseFloat(cropLeftSlider.value) >= parseFloat(cropRightSlider.value) - 5) {
    cropLeftSlider.value = parseFloat(cropRightSlider.value) - 5;
  }
  leftVal.textContent = parseFloat(cropLeftSlider.value).toFixed(1);
  drawPreview(true);
  scheduleSaveSettings();
});
cropRightSlider.addEventListener("input", () => {
  if (parseFloat(cropRightSlider.value) <= parseFloat(cropLeftSlider.value) + 5) {
    cropRightSlider.value = parseFloat(cropLeftSlider.value) + 5;
  }
  rightVal.textContent = parseFloat(cropRightSlider.value).toFixed(1);
  drawPreview(true);
  scheduleSaveSettings();
});

blackBgToggle.addEventListener("change", () => {
  drawPreview(true);
  scheduleSaveSettings();
});
bgThreshSlider.addEventListener("input", () => {
  bgThreshLabel.textContent = bgThreshSlider.value;
  drawPreview(true);
  scheduleSaveSettings();
});
gridBoostSlider.addEventListener("input", () => {
  gridBoostLabel.textContent = `${parseFloat(gridBoostSlider.value).toFixed(1)}倍`;
  drawPreview(true);
  scheduleSaveSettings();
});

speedSlider.addEventListener("input", () => {
  const v = parseFloat(speedSlider.value).toFixed(2);
  speedInput.value = v;
  speedValLabel.textContent = `${v} %/秒`;
  scheduleSaveSettings();
});
speedInput.addEventListener("input", () => {
  const v = parseFloat(speedInput.value) || 47.5;
  speedSlider.value = v;
  speedValLabel.textContent = `${v.toFixed(2)} %/秒`;
  scheduleSaveSettings();
});

// 画面上の動画を指定時刻へ動かす（生成後に先頭へ戻すときなど）
function seekVideoElementTo(vidElem, timeSec) {
  return new Promise((resolve) => {
    const maxSafeTime = vidElem.duration ? Math.max(0, vidElem.duration - 0.001) : timeSec;
    const target = Math.min(Math.max(0, timeSec), maxSafeTime);
    if (Math.abs(vidElem.currentTime - target) < 0.0005 && !vidElem.seeking) {
      resolve();
      return;
    }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      vidElem.removeEventListener("seeked", finish);
      resolve();
    };
    const timer = setTimeout(finish, 3000);
    vidElem.addEventListener("seeked", finish);
    try {
      vidElem.currentTime = target;
    } catch (e) {
      finish();
    }
  });
}

// =========================================================
// 7. スクロール速度の自動計測（生成エンジンと同じ照合で、実フレーム時刻あたりの移動量を測る）
// =========================================================
autoSpeedBtn.addEventListener("click", async () => {
  if (!video.videoWidth || isGenerating || autoSpeedBtn.disabled) return;
  video.pause();
  autoSpeedBtn.disabled = true;
  autoSpeedBtn.textContent = "計測中...";
  const prevTime = video.currentTime;
  let usedElement = false;

  try {
    const dur = video.duration || 0;
    const userStart = Math.max(0, parseFloat(startTimeInput.value) || 0);
    const parsedEnd = parseFloat(endTimeInput.value);
    const userEnd = (!isNaN(parsedEnd) && parsedEnd > userStart) ? Math.min(parsedEnd, dur) : dur;
    const geo = computeCaptureGeometry(video.videoWidth, video.videoHeight,
      parseFloat(cropLeftSlider.value) / 100, parseFloat(cropRightSlider.value) / 100, computeWorkScale(video.videoHeight));

    let source = (activeVideoItem && activeVideoItem.file) ? await WebCodecsFrameSource.open(activeVideoItem.file, video.videoWidth, video.videoHeight) : null;
    if (!source) {
      source = new SeekFrameSource(video);
      usedElement = true;
    }
    geo.rotation = source.rotation || 0;
    const never = () => false;
    const bg = await buildStaticBackgroundModel(source, geo, userStart, userEnd, never, null, { maxSamples: 11, minSamples: 7 });
    const speedPct = parseFloat(speedInput.value) || 47.5;
    const stepSec = source.kind === "seek" ? 1 / 30 : 1 / (source.fps || 60);
    const tracker = new ScrollRegistrationTracker(geo, bg, (geo.h * speedPct / 100) * stepSec);
    const bandTop = tracker.fTop;
    const work = createWorkCanvas(geo.cropW, tracker.fH, true);
    const rates = [];
    let prevT = null;
    const tA = userStart + (userEnd - userStart) * 0.3;
    const tB = Math.min(userEnd, tA + 8);
    await source.forEachFrame(tA, tB, async (frame, t) => {
      drawFrameRows(work.ctx, frame, geo, bandTop);
      tracker.computeFeatures(work.ctx.getImageData(0, 0, geo.cropW, tracker.fH).data, bandTop);
      if (prevT !== null) {
        const r = tracker.register(null);
        if (r.status === "motion" && r.unique && t - prevT > 1e-4) rates.push(r.d / (t - prevT));
      }
      tracker.commit();
      prevT = t;
    }, never, null, () => stepSec);
    work.canvas.width = 0;

    if (rates.length >= 5) {
      rates.sort((a, b) => a - b);
      const median = rates[Math.floor(rates.length / 2)];
      const rounded = (Math.round((median / geo.h) * 100 * 50) / 50).toFixed(2);
      speedInput.value = rounded;
      speedSlider.value = rounded;
      speedValLabel.textContent = `${rounded} %/秒`;
      scheduleSaveSettings();
    } else {
      alert("この区間では譜面が動いていないため、スクロール速度を計測できませんでした。開始・終了時刻を譜面が流れている範囲に合わせてから再度お試しください。");
    }
  } catch (e) {
    alert(`速度の計測中にエラーが発生しました: ${e && e.message ? e.message : e}`);
  } finally {
    autoSpeedBtn.disabled = false;
    autoSpeedBtn.textContent = "速度を自動計測する";
    if (usedElement) await seekVideoElementTo(video, prevTime);
  }
});

// =========================================================
// 8. 【新エンジン】全フレーム解析 ＋ 実移動量照合 ＋ 静止背景モデル除去 ＋ クロスフェード合成
//   ・MP4/MOV は WebCodecs で全フレームを先頭から順番にデコードし、正確なフレーム時刻で処理する
//     （シーク待ちや待機時間に頼らないため、端末の速さで結果が変わらない）
//   ・それ以外の形式はシーク方式にフォールバックし、requestVideoFrameCallback で実フレーム時刻を取得する
//   ・各フレームの実際のスクロール量を前フレームとの画像照合で測る
//     （録画のカクつき・数フレームの停止・速度設定の誤差があっても継ぎ目がずれない）
//   ・動画全体から推定した静止背景（イラスト・固定UI）をフレーム単位で除去してから合成する
// =========================================================
const CAPTURE_LINE_RATIO = 0.70;   // 切り出し基準ライン（画面上端からの割合）
const TOP_SAFE_RATIO = 0.07;       // 最上部のUI表示（「16分音符」など）を避ける割合
const NO_SCROLL_MIN_SEC = 3;       // これより短い範囲では「譜面が動かなかった」判定をしない
const DECODER_STALL_MS = 15000;    // デコーダーがこの時間まったく反応しなければ止まったとみなす
// iOS Safari はキャンバスの総メモリが端末メモリの1/4までに制限され、超えると例外も出さずに何も描かれなくなる
const IS_IOS_FAMILY = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const MASTER_MEMORY_BUDGET = (IS_IOS_FAMILY ? 600 : 1400) * 1024 * 1024;

function canvasMemoryError() {
  const err = new Error("端末のメモリが足りず、画像を作れませんでした。他のタブやアプリを閉じてから、もう一度お試しください。");
  err.outOfMemory = true;
  return err;
}

function yieldToEventLoop() {
  if (window.scheduler && typeof window.scheduler.yield === "function") return window.scheduler.yield();
  // バックグラウンドタブでも間引かれない MessageChannel で制御を返す
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => resolve();
    ch.port2.postMessage(0);
  });
}

// gpu=true: 動画フレームの描画用（GPUで描いて必要な帯だけ読み出す方が、CPUキャンバスへ全面変換するより数倍速い）
function createWorkCanvas(w, h, gpu = false) {
  let canvas;
  if (typeof OffscreenCanvas !== "undefined") {
    canvas = new OffscreenCanvas(w, h);
  } else {
    canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext("2d", gpu ? { alpha: false } : { willReadFrequently: true });
  if (!ctx) throw canvasMemoryError();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  return { canvas, ctx };
}

function getDrawableSize(src) {
  if (typeof VideoFrame !== "undefined" && src instanceof VideoFrame) {
    return { w: src.displayWidth, h: src.displayHeight };
  }
  return { w: src.videoWidth || src.width || 0, h: src.videoHeight || src.height || 0 };
}

// フレームの切り抜き範囲を作業解像度で描画する（rowTop 行目がキャンバスの0行目になる）
function drawFrameRows(ctx, src, geo, rowTop) {
  const size = getDrawableSize(src);
  let rot = (geo.rotation && typeof VideoFrame !== "undefined" && src instanceof VideoFrame) ? geo.rotation : 0;
  // 90/270度の動画なのに最初から表示と同じ向きのフレームは、ブラウザ側で回転済みとみなす
  if (rot % 180 && size.w !== size.h && (size.w > size.h) === (geo.rawW > geo.rawH)) rot = 0;
  if (rot) {
    // デコーダの出力は保存時の向きのままなので、<video> の表示と同じ向きに回してから切り抜く
    const dispW = rot === 180 ? size.w : size.h;
    const dispH = rot === 180 ? size.h : size.w;
    const cs = geo.cropW / geo.srcCropW;
    ctx.save();
    ctx.setTransform((geo.rawW / dispW) * cs, 0, 0, geo.h / dispH, -geo.srcX1 * cs, -rowTop);
    if (rot === 90) ctx.transform(0, 1, -1, 0, size.h, 0);
    else if (rot === 180) ctx.transform(-1, 0, 0, -1, size.w, size.h);
    else ctx.transform(0, -1, 1, 0, 0, size.w);
    ctx.drawImage(src, 0, 0, size.w, size.h);
    ctx.restore();
    return;
  }
  const fx = size.w > 0 ? size.w / geo.rawW : 1;
  const fy = size.h > 0 ? size.h / geo.rawH : 1;
  ctx.drawImage(src, geo.srcX1 * fx, 0, geo.srcCropW * fx, geo.rawH * fy, 0, -rowTop, geo.cropW, geo.h);
}

function computeCaptureGeometry(rawW, rawH, leftPct, rightPct, workScale) {
  const srcX1 = Math.round(rawW * leftPct);
  const srcX2 = Math.round(rawW * rightPct);
  const srcCropW = Math.max(10, srcX2 - srcX1);
  const h = Math.max(160, Math.round(rawH * workScale));
  // 縦横同じ倍率で縮める（以前は縦横を別々に丸めていたため、小さい動画で縦横比がずれることがあった）
  const scale = h / rawH;
  const cropW = Math.max(60, Math.round(srcCropW * scale));
  return {
    rawW, rawH, srcX1, srcCropW, cropW, h,
    capY: Math.round(h * CAPTURE_LINE_RATIO),
    topSafeY: Math.round(h * TOP_SAFE_RATIO)
  };
}

function computeWorkScale(rawH) {
  const resMode = resolutionSelect.value || "original";
  if (resMode === "original") return 1.0;
  const maxH = parseInt(resMode, 10) || 1080;
  return rawH > maxH ? (maxH / rawH) : 1.0;
}

// ---------------------------------------------------------
// 8-1. MP4/MOV コンテナ解析（外部ライブラリ不要・通常MP4と断片化MP4に対応）
// ---------------------------------------------------------
function mp4U32(b, o) { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; }
function mp4U16(b, o) { return (b[o] << 8) | b[o + 1]; }
function mp4U64(b, o) { return mp4U32(b, o) * 4294967296 + mp4U32(b, o + 4); }
function mp4Type(b, o) { return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]); }

function mp4ParseBoxes(b, start, end) {
  const out = [];
  let off = start;
  while (off + 8 <= end) {
    let size = mp4U32(b, off);
    const type = mp4Type(b, off + 4);
    let hdr = 8;
    if (size === 1) {
      if (off + 16 > end) break;
      size = mp4U64(b, off + 8);
      hdr = 16;
    } else if (size === 0) {
      size = end - off;
    }
    if (size < hdr || off + size > end) break;
    out.push({ type, start: off, data: off + hdr, end: off + size });
    off += size;
  }
  return out;
}
function mp4Find(boxes, type) { return boxes.find(x => x.type === type) || null; }
function mp4Kids(b, box, skip = 0) { return mp4ParseBoxes(b, box.data + skip, box.end); }

async function mp4ReadRange(blob, start, end) {
  return new Uint8Array(await blob.slice(start, end).arrayBuffer());
}

async function mp4ScanTopLevel(blob) {
  const tops = [];
  const size = blob.size;
  let off = 0;
  while (off + 8 <= size && tops.length < 500000) {
    const hd = await mp4ReadRange(blob, off, Math.min(size, off + 16));
    let bsize = mp4U32(hd, 0);
    const type = mp4Type(hd, 4);
    let hdr = 8;
    if (bsize === 1) {
      bsize = mp4U64(hd, 8);
      hdr = 16;
    } else if (bsize === 0) {
      bsize = size - off;
    }
    if (bsize < hdr || !/^[\x20-\x7e]{4}$/.test(type)) break;
    tops.push({ type, start: off, data: off + hdr, end: Math.min(size, off + bsize) });
    off += bsize;
  }
  return tops;
}

function mp4CodecString(entryType, cfgType, c) {
  const hex2 = (n) => n.toString(16).padStart(2, "0");
  if (cfgType === "avcC" && c.length >= 4) {
    return `${entryType}.${hex2(c[1])}${hex2(c[2])}${hex2(c[3])}`;
  }
  if (cfgType === "hvcC" && c.length >= 13) {
    const profileSpace = c[1] >> 6;
    const tier = (c[1] >> 5) & 1;
    const profileIdc = c[1] & 0x1f;
    let compat = mp4U32(c, 2);
    let rev = 0;
    for (let i = 0; i < 32; i++) {
      rev = (rev << 1) | (compat & 1);
      compat >>>= 1;
    }
    const cons = [];
    for (let i = 6; i < 12; i++) cons.push(c[i]);
    while (cons.length && cons[cons.length - 1] === 0) cons.pop();
    let s = `${entryType}.${["", "A", "B", "C"][profileSpace]}${profileIdc}.${(rev >>> 0).toString(16)}.${tier ? "H" : "L"}${c[12]}`;
    for (const x of cons) s += "." + x.toString(16);
    return s;
  }
  if (cfgType === "av1C" && c.length >= 4) {
    const profile = c[1] >> 5;
    const level = c[1] & 0x1f;
    const tier = c[2] >> 7;
    const highBit = (c[2] >> 6) & 1;
    const twelve = (c[2] >> 5) & 1;
    const depth = (profile === 2 && highBit) ? (twelve ? 12 : 10) : (highBit ? 10 : 8);
    return `av01.${profile}.${String(level).padStart(2, "0")}${tier ? "H" : "M"}.${String(depth).padStart(2, "0")}`;
  }
  if (cfgType === "vpcC" && c.length >= 7) {
    return `vp09.${String(c[4]).padStart(2, "0")}.${String(c[5]).padStart(2, "0")}.${String(c[6] >> 4).padStart(2, "0")}`;
  }
  return null;
}

// トラックの表示行列（tkhd の matrix）から、表示するときに時計回りに何度回すかを返す
// （0/90/180/270。鏡像など、ここで扱えない変換は null）
// 端末の画面録画では、縦向きのまま保存して「横向きに回して表示する」指定だけが付いていることがある
function mp4TrackRotation(b, tkhd) {
  const m = tkhd.data + (b[tkhd.data] === 1 ? 52 : 40);
  if (m + 36 > tkhd.end) return 0;
  const fixed = (o) => (mp4U32(b, m + o) | 0) / 65536;
  const m00 = fixed(0), m01 = fixed(4), m10 = fixed(12), m11 = fixed(16);
  const eps = 1e-3;
  if (Math.abs(m01) < eps && Math.abs(m10) < eps) {
    if (m00 >= 0 && m11 >= 0) return 0;
    if (m00 < 0 && m11 < 0) return 180;
    return null;
  }
  if (Math.abs(m00) < eps && Math.abs(m11) < eps) {
    if (m01 > 0 && m10 < 0) return 90;
    if (m01 < 0 && m10 > 0) return 270;
  }
  return null;
}

async function demuxMp4VideoTrack(blob) {
  const tops = await mp4ScanTopLevel(blob);
  const okFirst = ["ftyp", "moov", "free", "skip", "wide", "mdat", "styp", "sidx", "pnot", "uuid"];
  if (!tops.length || !okFirst.includes(tops[0].type)) return null;
  const moovTop = tops.find(t => t.type === "moov");
  if (!moovTop) return null;

  const moov = await mp4ReadRange(blob, moovTop.start, moovTop.end);
  const mBoxes = mp4ParseBoxes(moov, moovTop.data - moovTop.start, moov.length);
  const mvhd = mp4Find(mBoxes, "mvhd");
  const movieTs = mvhd ? (moov[mvhd.data] === 1 ? mp4U32(moov, mvhd.data + 20) : mp4U32(moov, mvhd.data + 12)) : 1000;

  let track = null;
  for (const trak of mBoxes.filter(x => x.type === "trak")) {
    const tb = mp4Kids(moov, trak);
    const mdia = mp4Find(tb, "mdia");
    if (!mdia) continue;
    const mdb = mp4Kids(moov, mdia);
    const hdlr = mp4Find(mdb, "hdlr");
    if (!hdlr || mp4Type(moov, hdlr.data + 8) !== "vide") continue;
    const tkhd = mp4Find(tb, "tkhd");
    const trackId = tkhd ? (moov[tkhd.data] === 1 ? mp4U32(moov, tkhd.data + 20) : mp4U32(moov, tkhd.data + 12)) : 0;
    const mdhd = mp4Find(mdb, "mdhd");
    const minf = mp4Find(mdb, "minf");
    const stbl = minf ? mp4Find(mp4Kids(moov, minf), "stbl") : null;
    if (!mdhd || !stbl) continue;
    const timescale = moov[mdhd.data] === 1 ? mp4U32(moov, mdhd.data + 20) : mp4U32(moov, mdhd.data + 12);
    if (!timescale) continue;

    // 編集リスト（先頭の空白区間・メディア開始位置）
    let editMediaTime = 0;
    let editEmptySec = 0;
    const edts = mp4Find(tb, "edts");
    const elst = edts ? mp4Find(mp4Kids(moov, edts), "elst") : null;
    if (elst) {
      const ver = moov[elst.data];
      const n = mp4U32(moov, elst.data + 4);
      let p = elst.data + 8;
      for (let i = 0; i < n && p + (ver === 1 ? 20 : 12) <= elst.end; i++) {
        const segDur = ver === 1 ? mp4U64(moov, p) : mp4U32(moov, p);
        const mediaTime = ver === 1 ? (mp4U32(moov, p + 8) | 0) * 4294967296 + mp4U32(moov, p + 12) : (mp4U32(moov, p + 4) | 0);
        p += ver === 1 ? 20 : 12;
        if (mediaTime === -1) {
          editEmptySec += segDur / (movieTs || 1000);
          continue;
        }
        editMediaTime = mediaTime;
        break;
      }
    }
    const rotation = tkhd ? mp4TrackRotation(moov, tkhd) : 0;
    track = { trackId, timescale, stblKids: mp4Kids(moov, stbl), editMediaTime, editEmptySec, rotation };
    break;
  }
  if (!track) return null;

  const sb = track.stblKids;
  const stsd = mp4Find(sb, "stsd");
  if (!stsd) return null;
  const entry = mp4ParseBoxes(moov, stsd.data + 8, stsd.end)[0];
  if (!entry || entry.end - entry.data < 78) return null;
  const codedWidth = mp4U16(moov, entry.data + 24);
  const codedHeight = mp4U16(moov, entry.data + 26);
  const cfg = mp4ParseBoxes(moov, entry.data + 78, entry.end).find(x => ["avcC", "hvcC", "av1C", "vpcC"].includes(x.type));
  if (!cfg) return null;
  const cfgBytes = moov.slice(cfg.data, cfg.end);
  const codec = mp4CodecString(entry.type, cfg.type, cfgBytes);
  if (!codec) return null;

  const samples = [];
  const stsz = mp4Find(sb, "stsz");
  const stco = mp4Find(sb, "stco") || mp4Find(sb, "co64");
  const stsc = mp4Find(sb, "stsc");
  const stts = mp4Find(sb, "stts");
  if (stsz && stco && stsc && stts && mp4U32(moov, stsz.data + 8) > 0) {
    const fixedSize = mp4U32(moov, stsz.data + 4);
    const count = mp4U32(moov, stsz.data + 8);
    const isCo64 = stco.type === "co64";
    const nChunks = mp4U32(moov, stco.data + 4);
    const chunkOffsets = new Array(nChunks);
    for (let i = 0; i < nChunks; i++) {
      chunkOffsets[i] = isCo64 ? mp4U64(moov, stco.data + 8 + i * 8) : mp4U32(moov, stco.data + 8 + i * 4);
    }
    const nStsc = mp4U32(moov, stsc.data + 4);
    const stss = mp4Find(sb, "stss");
    let keySet = null;
    if (stss) {
      keySet = new Set();
      const n = mp4U32(moov, stss.data + 4);
      for (let i = 0; i < n; i++) keySet.add(mp4U32(moov, stss.data + 8 + i * 4) - 1);
    }
    let s = 0;
    for (let e = 0; e < nStsc && s < count; e++) {
      const p = stsc.data + 8 + e * 12;
      const firstChunk = mp4U32(moov, p) - 1;
      const perChunk = mp4U32(moov, p + 4);
      const lastChunk = (e + 1 < nStsc) ? mp4U32(moov, stsc.data + 8 + (e + 1) * 12) - 1 : nChunks;
      for (let ch = firstChunk; ch < lastChunk && s < count; ch++) {
        let off = chunkOffsets[ch];
        for (let k = 0; k < perChunk && s < count; k++) {
          const size = fixedSize || mp4U32(moov, stsz.data + 12 + s * 4);
          samples.push({ offset: off, size, dts: 0, cts: 0, dur: 0, key: keySet ? keySet.has(s) : true });
          off += size;
          s++;
        }
      }
    }
    const nStts = mp4U32(moov, stts.data + 4);
    let dts = 0;
    let idx = 0;
    for (let i = 0; i < nStts; i++) {
      const cnt = mp4U32(moov, stts.data + 8 + i * 8);
      const delta = mp4U32(moov, stts.data + 12 + i * 8);
      for (let k = 0; k < cnt && idx < samples.length; k++) {
        samples[idx].dts = dts;
        samples[idx].dur = delta;
        dts += delta;
        idx++;
      }
    }
    for (const sm of samples) sm.cts = sm.dts;
    const ctts = mp4Find(sb, "ctts");
    if (ctts) {
      const ver = moov[ctts.data];
      const n = mp4U32(moov, ctts.data + 4);
      let i2 = 0;
      for (let i = 0; i < n; i++) {
        const cnt = mp4U32(moov, ctts.data + 8 + i * 8);
        let off = mp4U32(moov, ctts.data + 12 + i * 8);
        if (ver === 1) off |= 0;
        for (let k = 0; k < cnt && i2 < samples.length; k++) {
          samples[i2].cts = samples[i2].dts + off;
          i2++;
        }
      }
    }
  }

  // 断片化MP4（moof）
  const moofs = tops.filter(t => t.type === "moof");
  if (moofs.length > 0) {
    let trexDur = 0, trexSize = 0, trexFlags = 0;
    const mvex = mp4Find(mBoxes, "mvex");
    if (mvex) {
      for (const tr of mp4Kids(moov, mvex).filter(x => x.type === "trex")) {
        if (mp4U32(moov, tr.data + 4) === track.trackId) {
          trexDur = mp4U32(moov, tr.data + 12);
          trexSize = mp4U32(moov, tr.data + 16);
          trexFlags = mp4U32(moov, tr.data + 20);
        }
      }
    }
    let nextDts = samples.length ? samples[samples.length - 1].dts + samples[samples.length - 1].dur : 0;
    for (const mf of moofs) {
      const mb = await mp4ReadRange(blob, mf.start, mf.end);
      for (const traf of mp4ParseBoxes(mb, mf.data - mf.start, mb.length).filter(x => x.type === "traf")) {
        const tk = mp4Kids(mb, traf);
        const tfhd = mp4Find(tk, "tfhd");
        if (!tfhd || mp4U32(mb, tfhd.data + 4) !== track.trackId) continue;
        const flags = mp4U32(mb, tfhd.data) & 0xffffff;
        let p = tfhd.data + 8;
        let baseOffset = mf.start;
        if (flags & 0x1) { baseOffset = mp4U64(mb, p); p += 8; }
        if (flags & 0x2) p += 4;
        let defDur = trexDur, defSize = trexSize, defFlags = trexFlags;
        if (flags & 0x8) { defDur = mp4U32(mb, p); p += 4; }
        if (flags & 0x10) { defSize = mp4U32(mb, p); p += 4; }
        if (flags & 0x20) { defFlags = mp4U32(mb, p); p += 4; }
        const tfdt = mp4Find(tk, "tfdt");
        if (tfdt) nextDts = mb[tfdt.data] === 1 ? mp4U64(mb, tfdt.data + 4) : mp4U32(mb, tfdt.data + 4);
        for (const trun of tk.filter(x => x.type === "trun")) {
          const tflags = mp4U32(mb, trun.data) & 0xffffff;
          const ver = mb[trun.data];
          const n = mp4U32(mb, trun.data + 4);
          let q = trun.data + 8;
          let dataOff = baseOffset;
          if (tflags & 0x1) { dataOff = baseOffset + (mp4U32(mb, q) | 0); q += 4; }
          let firstFlags = null;
          if (tflags & 0x4) { firstFlags = mp4U32(mb, q); q += 4; }
          for (let i = 0; i < n; i++) {
            let dur = defDur, size = defSize, sflags = (i === 0 && firstFlags !== null) ? firstFlags : defFlags, cto = 0;
            if (tflags & 0x100) { dur = mp4U32(mb, q); q += 4; }
            if (tflags & 0x200) { size = mp4U32(mb, q); q += 4; }
            if (tflags & 0x400) { sflags = mp4U32(mb, q); q += 4; }
            if (tflags & 0x800) { cto = ver === 1 ? (mp4U32(mb, q) | 0) : mp4U32(mb, q); q += 4; }
            samples.push({ offset: dataOff, size, dts: nextDts, cts: nextDts + cto, dur, key: !((sflags >> 16) & 1) });
            dataOff += size;
            nextDts += dur;
          }
        }
      }
    }
  }
  if (samples.length === 0) return null;

  const durs = [];
  for (const sm of samples) {
    sm.time = (sm.cts - track.editMediaTime) / track.timescale + track.editEmptySec;
    if (sm.dur > 0 && durs.length < 4000) durs.push(sm.dur);
  }
  durs.sort((a, b) => a - b);
  const medianDur = durs.length ? durs[durs.length >> 1] : track.timescale / 30;
  const fps = track.timescale / medianDur;
  let duration = 0;
  for (const sm of samples) duration = Math.max(duration, sm.time + sm.dur / track.timescale);

  return {
    codec,
    entryType: entry.type,
    configType: cfg.type,
    description: cfgBytes,
    codedWidth,
    codedHeight,
    rotation: track.rotation,
    timescale: track.timescale,
    fps: (fps > 1 && fps < 1000) ? fps : 30,
    duration,
    samples
  };
}

// ---------------------------------------------------------
// 8-2. フレーム供給源（WebCodecs 全フレーム順次デコード / シーク方式フォールバック）
// ---------------------------------------------------------
class WebCodecsFrameSource {
  constructor(blob, track, config) {
    this.kind = "webcodecs";
    this.blob = blob;
    this.track = track;
    this.config = config;
    this.fps = track.fps;
    this.duration = track.duration;
    this.rotation = track.rotation;
    this.label = `WebCodecs 全フレーム解析 (${track.codec.split(".")[0]} / ${Math.round(track.fps)}fps)`;
  }

  // dispW/dispH: <video> が表示するサイズ。回転を考慮しても向きが食い違う動画は、ここでは正しく描けないので null を返す（シーク方式に任せる）
  static async open(blob, dispW = 0, dispH = 0) {
    if (!blob || !WEBCODECS_AVAILABLE) return null;
    let track = null;
    try {
      track = await demuxMp4VideoTrack(blob);
    } catch (e) {
      track = null;
    }
    if (!track || track.rotation === null) return null;
    const quarterTurn = track.rotation % 180 !== 0;
    const expectW = quarterTurn ? track.codedHeight : track.codedWidth;
    const expectH = quarterTurn ? track.codedWidth : track.codedHeight;
    if (dispW && dispH && dispW !== dispH && expectW !== expectH && (dispW > dispH) !== (expectW > expectH)) return null;
    const codecs = [track.codec];
    if (track.entryType === "avc3") codecs.push(track.codec.replace(/^avc3/, "avc1"));
    if (track.entryType === "hev1") codecs.push(track.codec.replace(/^hev1/, "hvc1"));
    for (const codec of codecs) {
      const variants = [
        { codec, codedWidth: track.codedWidth, codedHeight: track.codedHeight, description: track.description },
        { codec, codedWidth: track.codedWidth, codedHeight: track.codedHeight }
      ];
      for (const cfg of variants) {
        if (track.configType === "vpcC" && cfg.description) continue;
        try {
          const res = await VideoDecoder.isConfigSupported(cfg);
          if (res && res.supported) return new WebCodecsFrameSource(blob, track, cfg);
        } catch (e) {}
      }
    }
    return null;
  }

  _makeState() {
    const state = {
      outQ: [],
      error: null,
      waiter: null,
      lastActive: performance.now(),
      wake() {
        if (state.waiter) {
          const w = state.waiter;
          state.waiter = null;
          w();
        }
      },
      wait(ms) {
        return new Promise((resolve) => {
          state.waiter = resolve;
          setTimeout(() => {
            if (state.waiter === resolve) state.waiter = null;
            resolve();
          }, ms);
        });
      },
      // デコーダーが反応した（入力を受け取った・フレームを出した）ことを記録する
      touch() {
        state.lastActive = performance.now();
      },
      // デコーダーを待っている間に呼ぶ。一定時間まったく反応が無ければ例外にする（呼び出し元がシーク方式に切り替える）
      // 画面が裏に回っている間はブラウザがデコードを止めることがあるので、その時間は数えない
      checkStall() {
        const now = performance.now();
        if (document.visibilityState === "hidden") {
          state.lastActive = now;
          return;
        }
        if (now - state.lastActive > DECODER_STALL_MS) {
          const err = new Error("動画のデコードが途中で止まりました");
          err.decoderStalled = true;
          throw err;
        }
      }
    };
    return state;
  }

  _createDecoder(state) {
    const decoder = new VideoDecoder({
      output: (frame) => {
        state.outQ.push(frame);
        state.touch();
        state.wake();
      },
      error: (err) => {
        state.error = err || new Error("VideoDecoder error");
        state.wake();
      }
    });
    decoder.configure(this.config);
    if (typeof decoder.addEventListener === "function") {
      decoder.addEventListener("dequeue", () => {
        state.touch();
        state.wake();
      });
    }
    return decoder;
  }

  // flush の完了を待つ間も、出てきたフレームを渡して閉じ続ける
  // （閉じずに溜めると、同時に持てるフレームの数に上限があるハードウェアデコーダー（スマホなど）では flush が終わらず、そこで止まってしまう）
  async _flushDelivering(decoder, state, deliver, shouldStop) {
    let done = false;
    let failure = null;
    decoder.flush().then(() => {
      done = true;
      state.wake();
    }, (e) => {
      failure = e;
      done = true;
      state.wake();
    });
    state.touch();
    while (!done && !state.error && !shouldStop()) {
      if (state.outQ.length > 0) {
        await deliver();
        state.touch();
        continue;
      }
      state.checkStall();
      await state.wait(40);
    }
    if (state.error) throw state.error;
    if (shouldStop()) return;
    if (failure) throw failure;
    await deliver();
  }

  _readSample(index, cache) {
    let p = cache.get(index);
    if (!p) {
      const s = this.track.samples[index];
      p = mp4ReadRange(this.blob, s.offset, s.offset + s.size);
      cache.set(index, p);
    }
    return p;
  }

  _chunkFor(index, data) {
    const s = this.track.samples[index];
    return new EncodedVideoChunk({
      type: s.key ? "key" : "delta",
      timestamp: Math.round(s.time * 1e6),
      duration: Math.max(0, Math.round((s.dur / this.track.timescale) * 1e6)),
      data
    });
  }

  _closeAll(state, decoder) {
    for (const f of state.outQ) {
      try { f.close(); } catch (e) {}
    }
    state.outQ.length = 0;
    try { if (decoder.state !== "closed") decoder.close(); } catch (e) {}
  }

  // [tFrom, tTo] のフレームを表示順に1枚ずつ onFrame(frame, timeSec) へ渡す（frame は呼び出し後に閉じる）
  forEachFrame(tFrom, tTo, onFrame, shouldStop) {
    return this.forEachFrameInRanges([[tFrom, tTo]], (frame, t) => onFrame(frame, t), shouldStop);
  }

  // ranges（時刻順の [from, to] の並び）の各区間のフレームを、表示順に onFrame(frame, timeSec, rangeIndex) へ渡す
  // デコーダーは1つを使い回す。次の区間のキーフレームがまだ先にあるときだけ flush してそこへ飛び、
  // 今デコードしている所より手前にあるときはそのまま続ける（キーフレームの少ない動画で、区間ごとに遠いキーフレームからデコードし直さない）
  async forEachFrameInRanges(ranges, onFrame, shouldStop) {
    const samples = this.track.samples;
    const state = this._makeState();
    const decoder = this._createDecoder(state);
    const cache = new Map();
    let next = -1;
    let stopped = false;

    const rangeOf = (t) => {
      for (let r = 0; r < ranges.length; r++) {
        if (t >= ranges[r][0] - 1e-4 && t <= ranges[r][1] + 1e-4) return r;
      }
      return -1;
    };
    const deliver = async () => {
      while (state.outQ.length > 0) {
        const frame = state.outQ.shift();
        const t = frame.timestamp / 1e6;
        try {
          const r = stopped ? -1 : rangeOf(t);
          if (r >= 0) await onFrame(frame, t, r);
        } finally {
          frame.close();
        }
        if (shouldStop()) stopped = true;
      }
    };

    try {
      for (const [tFrom, tTo] of ranges) {
        if (stopped || shouldStop()) {
          stopped = true;
          break;
        }
        let keyIdx = 0;
        for (let i = 0; i < samples.length; i++) {
          if (samples[i].key && samples[i].time <= tFrom + 1e-6) keyIdx = i;
        }
        let endIdx = samples.length;
        for (let i = keyIdx; i < samples.length; i++) {
          if (samples[i].time > tTo + 1e-6) {
            endIdx = Math.min(samples.length, i + 24);
            break;
          }
        }
        if (keyIdx >= next) {
          if (next >= 0) await this._flushDelivering(decoder, state, deliver, shouldStop);
          next = keyIdx;
        }
        while (!stopped) {
          if (state.error) throw state.error;
          if (shouldStop()) {
            stopped = true;
            break;
          }
          if (state.outQ.length > 0) {
            await deliver();
            state.touch();
            continue;
          }
          if (next >= endIdx) break;
          if (decoder.decodeQueueSize >= 4) {
            state.checkStall();
            await state.wait(40);
            continue;
          }
          // 少し先まで読み込んでおき、ファイル読み込みとデコードを重ねる
          for (let k = next; k < Math.min(endIdx, next + 10); k++) this._readSample(k, cache);
          const data = await this._readSample(next, cache);
          cache.delete(next);
          if (state.error) throw state.error;
          decoder.decode(this._chunkFor(next, data));
          state.touch();
          next++;
        }
      }
      if (!stopped && !state.error) await this._flushDelivering(decoder, state, deliver, shouldStop);
      if (state.error) throw state.error;
    } finally {
      this._closeAll(state, decoder);
    }
  }

  // 指定した各時刻の直後のフレームを取り出す（キーフレームからその時刻までだけをデコードする）
  async sampleFrames(targetTimes, onFrame, shouldStop) {
    const samples = this.track.samples;
    const keyOf = (t) => {
      let k = 0;
      for (let i = 0; i < samples.length; i++) {
        if (samples[i].key && samples[i].time <= t + 1e-6) k = i;
      }
      return k;
    };
    const groups = new Map();
    for (const t of targetTimes.slice().sort((a, b) => a - b)) {
      const k = keyOf(t);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(t);
    }
    const state = this._makeState();
    const decoder = this._createDecoder(state);
    try {
      for (const [keyIdx, times] of groups) {
        if (shouldStop()) break;
        let ti = 0;
        const lastT = times[times.length - 1];
        const deliver = async () => {
          while (state.outQ.length > 0) {
            const frame = state.outQ.shift();
            const t = frame.timestamp / 1e6;
            try {
              if (ti < times.length && t >= times[ti] - 1e-6) {
                while (ti < times.length && t >= times[ti] - 1e-6) ti++;
                await onFrame(frame, t);
              }
            } finally {
              frame.close();
            }
          }
        };
        for (let i = keyIdx; i < samples.length; i++) {
          if (shouldStop() || ti >= times.length) break;
          if (i > keyIdx && samples[i].key) break;
          if (i > keyIdx && samples[i].time > lastT + 1.0) break;
          // 待っている間も出てきたフレームは閉じる（溜めると、フレーム数に上限があるデコーダーが入力を受け取れなくなる）
          while (decoder.decodeQueueSize >= 4 && !state.error) {
            if (state.outQ.length > 0) {
              await deliver();
              state.touch();
              continue;
            }
            state.checkStall();
            await state.wait(40);
          }
          if (state.error) throw state.error;
          const data = await mp4ReadRange(this.blob, samples[i].offset, samples[i].offset + samples[i].size);
          decoder.decode(this._chunkFor(i, data));
          state.touch();
          await deliver();
        }
        await this._flushDelivering(decoder, state, deliver, shouldStop);
      }
    } finally {
      this._closeAll(state, decoder);
    }
  }
}

class SeekFrameSource {
  constructor(videoElem) {
    this.kind = "seek";
    this.video = videoElem;
    this.fps = 0;
    this.duration = videoElem.duration || 0;
    this.hasRVFC = typeof videoElem.requestVideoFrameCallback === "function";
    this.rvfcTries = 0;
    this.rvfcHits = 0;
    this.label = "互換モード: シーク解析（実フレーム時刻を取得）";
  }

  // 一時停止中のシークでは requestVideoFrameCallback が呼ばれないことがあるため、
  // 取れる場合だけ実フレーム時刻を使い、取れない環境では待ち時間を使わない（画像の位置合わせは画像照合で行うので影響しない）
  _useRVFC() {
    if (!this.hasRVFC) return false;
    return this.rvfcTries < 8 || this.rvfcHits / this.rvfcTries >= 0.9;
  }

  // シークが続けて終わらない（ブラウザがこの動画を読めていない）ときは、進まないまま待ち続けずにエラーにする
  _checkSeek(r) {
    if (r.ok) {
      this.seekFailures = 0;
      return;
    }
    this.seekFailures = (this.seekFailures || 0) + 1;
    if (this.seekFailures >= 3) {
      const err = new Error("動画の再生位置を移動できませんでした。このブラウザではこの動画を読み取れない可能性があります");
      err.seekFailed = true;
      throw err;
    }
  }

  // 指定時刻へシークし、実際に表示されたフレームの時刻を返す
  seekTo(timeSec, shouldStop) {
    const v = this.video;
    return new Promise((resolve) => {
      const maxT = v.duration ? Math.max(0, v.duration - 0.001) : timeSec;
      const target = Math.min(Math.max(0, timeSec), maxT);
      const useRVFC = this._useRVFC();
      let seeked = false;
      let frameTime = null;
      let settled = false;
      let rvfcTimer = 0;
      let guardTimer = 0;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(guardTimer);
        clearTimeout(rvfcTimer);
        activeSeekResolvers.delete(cancel);
        v.removeEventListener("seeked", onSeeked);
        v.removeEventListener("error", onError);
        if (useRVFC && ok) {
          this.rvfcTries++;
          if (frameTime !== null) this.rvfcHits++;
        }
        resolve({ ok, time: frameTime !== null ? frameTime : v.currentTime });
      };
      const cancel = () => finish(false);
      const onSeeked = () => {
        seeked = true;
        if (!useRVFC || frameTime !== null) finish(true);
        else rvfcTimer = setTimeout(() => finish(true), 80);
      };
      const onError = () => finish(false);
      guardTimer = setTimeout(() => finish(false), 8000);
      activeSeekResolvers.add(cancel);
      // 表示されるフレームの時刻を取るため、シーク開始前にコールバックを登録しておく
      if (useRVFC) {
        v.requestVideoFrameCallback((now, meta) => {
          frameTime = (meta && typeof meta.mediaTime === "number") ? meta.mediaTime : null;
          if (seeked) finish(true);
        });
      }
      v.addEventListener("seeked", onSeeked);
      v.addEventListener("error", onError);
      if (shouldStop && shouldStop()) {
        finish(false);
        return;
      }
      try {
        v.currentTime = target;
      } catch (e) {
        finish(false);
      }
    });
  }

  async forEachFrame(tFrom, tTo, onFrame, shouldStop, deliverFilter = null, getStepSec = null) {
    let t = tFrom;
    let lastTime = -1;
    let guard = 0;
    while (t <= tTo + 1e-6 && !shouldStop() && guard++ < 2000000) {
      const r = await this.seekTo(t, shouldStop);
      if (shouldStop()) break;
      this._checkSeek(r);
      const ft = r.time;
      if (Math.abs(ft - lastTime) > 1e-4 && (!deliverFilter || deliverFilter(ft))) {
        await onFrame(this.video, ft);
        lastTime = ft;
      }
      const step = getStepSec ? getStepSec() : (1 / 30);
      t = Math.max(t + step, ft + 0.0015);
    }
  }

  async sampleFrames(targetTimes, onFrame, shouldStop) {
    for (const t of targetTimes) {
      if (shouldStop()) break;
      const r = await this.seekTo(t, shouldStop);
      if (shouldStop()) break;
      this._checkSeek(r);
      await onFrame(this.video, r.time);
    }
  }
}

// ---------------------------------------------------------
// 8-3. 静止背景モデル（画素ごとに、時間方向で最も値がまとまっている所を背景とみなす）
// ---------------------------------------------------------
// 端末によらず毎回同じ結果になるよう、固定シードの擬似乱数で取り出す時刻を決める
function seededRandom(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

//  ・取り出す時刻は「等間隔の区間それぞれの中のランダムな位置」にする
//    （キーフレームのような等間隔だけだと、BPMによっては16分線が毎回同じ位置に来て背景と誤認されるため）
//  ・画素ごとに、取り出した値の中で「最も狭い範囲に3割の値が集まっている所」を背景とみなす
//    静止背景は毎回ほぼ同じ値になるので必ず固まりを作る。最小値はノーツの暗い縁取りに、
//    中央値はロングノーツやスライドが長く通る位置（半分近くの時間で譜面が写る）に引きずられるため使わない
async function buildStaticBackgroundModel(source, geo, tFrom, tTo, shouldStop, onProgress, options = {}) {
  const { cropW, h } = geo;
  const n = cropW * h * 3;
  const maxSamples = options.maxSamples || 21;
  const minSamples = options.minSamples || 9;
  let count = Math.max(minSamples, Math.min(maxSamples, Math.floor((96 * 1024 * 1024) / n)));
  // メモリが足りないときは枚数を減らしてでも作る（背景モデルが無いと、静止した背景が照合の邪魔をして譜面の動きを見失いやすい）
  let stack = null;
  while (!stack) {
    try {
      stack = new Uint8Array(n * count);
    } catch (e) {
      if (count <= 5) return null;
      count = Math.max(5, count - 4);
    }
  }
  const span = Math.max(0.05, tTo - tFrom);
  const rnd = seededRandom(0x5EC41);
  const targets = [];
  for (let i = 0; i < count; i++) targets.push(tFrom + span * (i + 0.1 + 0.8 * rnd()) / count);

  const work = createWorkCanvas(cropW, h, true);
  let got = 0;
  await source.sampleFrames(targets, async (frame) => {
    if (got >= count) return;
    drawFrameRows(work.ctx, frame, geo, 0);
    const d = work.ctx.getImageData(0, 0, cropW, h).data;
    const base = got * n;
    for (let i = 0, j = 0; j < n; i += 4, j += 3) {
      stack[base + j] = d[i];
      stack[base + j + 1] = d[i + 1];
      stack[base + j + 2] = d[i + 2];
    }
    got++;
    if (onProgress) onProgress(Math.min(1, got / count) * 0.8);
    await yieldToEventLoop();
  }, shouldStop);
  work.canvas.width = 0;
  work.canvas.height = 0;
  if (got < 3 || shouldStop()) return null;

  const bg = new Uint8Array(n);
  const tmp = new Uint8Array(got);
  const win = Math.max(2, Math.ceil(got * 0.3));
  const half = win >> 1;
  let lastYield = performance.now();
  for (let p = 0; p < n; p++) {
    for (let s = 0; s < got; s++) {
      const v = stack[s * n + p];
      let k = s - 1;
      while (k >= 0 && tmp[k] > v) {
        tmp[k + 1] = tmp[k];
        k--;
      }
      tmp[k + 1] = v;
    }
    // 最も狭い範囲に win 個が収まる区間を探す（ほぼ同じ狭さなら暗い方＝背景側を優先）
    let minRange = 256;
    for (let i = 0; i + win <= got; i++) {
      const r = tmp[i + win - 1] - tmp[i];
      if (r < minRange) minRange = r;
    }
    let pick = 0;
    for (let i = 0; i + win <= got; i++) {
      if (tmp[i + win - 1] - tmp[i] <= minRange + 2) {
        pick = i;
        break;
      }
    }
    bg[p] = tmp[pick + half];
    if ((p & 0xFFFF) === 0 && performance.now() - lastYield > 30) {
      lastYield = performance.now();
      if (onProgress) onProgress(0.8 + 0.2 * (p / n));
      await yieldToEventLoop();
      if (shouldStop()) return null;
    }
  }
  return bg;
}

// ---------------------------------------------------------
// 8-4. スクロール量の照合（前フレームとの画像照合・停止フレーム判定・信頼度判定）
// ---------------------------------------------------------
class ScrollRegistrationTracker {
  constructor(geo, bgModel, dExpInit) {
    const { cropW, h, capY } = geo;
    this.geo = geo;
    this.bg = bgModel;
    this.win = Math.max(24, Math.round(h * 0.10));
    let dMax = Math.round(Math.max(h * 0.12, dExpInit * 3 + 12));
    dMax = Math.min(dMax, Math.round(h * 0.25), capY - this.win - geo.topSafeY);
    this.dMax = Math.max(16, dMax);
    this.fTop = capY - this.win - this.dMax;
    this.fBot = capY + this.win;
    this.fH = this.fBot - this.fTop;
    this.fw = Math.ceil(cropW / 2);
    this.strips = 24;
    this.stripStart = new Int32Array(this.strips + 1);
    for (let s = 0; s <= this.strips; s++) this.stripStart[s] = Math.round(s * this.fw / this.strips);
    this.curF = new Uint8Array(this.fw * this.fH);
    this.prevF = new Uint8Array(this.fw * this.fH);
    this.curP = new Float32Array(this.fH * this.strips);
    this.prevP = new Float32Array(this.fH * this.strips);
    this.costs = new Float32Array(this.dMax + 1);
    this.hasPrev = false;
    this.dExp = Math.max(0.5, Math.min(this.dMax * 0.8, dExpInit));
    this.recent = [];
    this.moving = false;
    this.ignoredStrips = null;
    this.widthScale = 1;
  }

  // 予測値の出発点を与える（count 回分の仮の実測値として入れ、最初の追いつきジャンプ1回では予測が崩れないようにする）
  seedSpeed(dPerFrame, count) {
    this.dExp = Math.max(0.5, Math.min(this.dMax * 0.8, dPerFrame));
    this.recent = new Array(count).fill(this.dExp);
  }

  // 直近5回の移動量の中央値を次のフレームの予測値にする（1回だけの外れ値には引きずられず、譜面の速度変化には数フレームで追従する）
  _noteMotion(d) {
    this.recent.push(d);
    if (this.recent.length > 5) this.recent.shift();
    const s = this.recent.slice().sort((x, y) => x - y);
    this.dExp = s[(s.length - 1) >> 1];
  }

  // band: RGBA データ（作業解像度の bandTop 行目から）。静止背景との差を特徴量にする
  computeFeatures(band, bandTop) {
    const { cropW } = this.geo;
    const { fw, fH, fTop, curF, curP, strips, stripStart, ignoredStrips } = this;
    const bg = this.bg;
    for (let fy = 0; fy < fH; fy++) {
      const y = fTop + fy;
      const bRow = (y - bandTop) * cropW;
      const gRow = y * cropW;
      const o = fy * fw;
      for (let k = 0; k < fw; k++) {
        let x = k * 2;
        if (x >= cropW) x = cropW - 1;
        const i = (bRow + x) * 4;
        let v;
        if (bg) {
          const j = (gRow + x) * 3;
          const dr = band[i] - bg[j], dg = band[i + 1] - bg[j + 1], db = band[i + 2] - bg[j + 2];
          v = ((dr < 0 ? -dr : dr) + (dg < 0 ? -dg : dg) + (db < 0 ? -db : db)) * 0.5 - 4;
        } else {
          const r = band[i], g = band[i + 1], b = band[i + 2];
          v = r > g ? (r > b ? r : b) : (g > b ? g : b);
        }
        curF[o + k] = v <= 0 ? 0 : (v >= 255 ? 255 : v);
      }
      for (let s = 0; s < strips; s++) {
        const k0 = stripStart[s], k1 = stripStart[s + 1];
        if (ignoredStrips && ignoredStrips[s]) {
          curF.fill(0, o + k0, o + k1);
          curP[fy * strips + s] = 0;
          continue;
        }
        let acc = 0;
        for (let k = k0; k < k1; k++) acc += curF[o + k];
        curP[fy * strips + s] = acc / Math.max(1, k1 - k0);
      }
    }
  }

  // 前フレームと比べて、動いている列帯と止まっている列帯を still / moving に数える
  // （切り抜き範囲に入ったミニマップの端のように、譜面が動いている間も止まったままの列帯を見つけるため）
  tallyStripMotion(still, moving) {
    const { win, dMax, curP, prevP, strips } = this;
    const best = new Int32Array(strips).fill(-1);
    for (let s = 0; s < strips; s++) {
      let minC = Infinity, minD = 0, sum = 0;
      for (let d = 0; d <= dMax; d++) {
        let acc = 0;
        for (let fy = dMax; fy < dMax + 2 * win; fy += 2) {
          const q = curP[fy * strips + s] - prevP[(fy - d) * strips + s];
          acc += q < 0 ? -q : q;
        }
        sum += acc;
        if (acc < minC) {
          minC = acc;
          minD = d;
        }
      }
      // ずらしても差が変わらない列帯（何も写っていない・ロングノーツだけ等）は判断材料にしない
      if (sum / (dMax + 1) > minC * 2 + 5) best[s] = minD;
    }
    const ds = [];
    let stillCount = 0;
    for (let s = 0; s < strips; s++) {
      if (best[s] >= 2) ds.push(best[s]);
      else if (best[s] >= 0) stillCount++;
    }
    // 動いている列帯の方が多いフレーム（＝譜面が動いているフレーム）だけを数える
    if (ds.length < 4 || ds.length <= stillCount) return;
    ds.sort((x, y) => x - y);
    const D = ds[ds.length >> 1];
    for (let s = 0; s < strips; s++) {
      if (best[s] < 0) continue;
      if (best[s] < 2) still[s]++;
      else if (Math.abs(best[s] - D) <= 2) moving[s]++;
    }
  }

  _ssd(d) {
    // 2次元の二乗誤差（照合窓の全行・特徴列を1つおき）
    const { fw, win, dMax, curF, prevF } = this;
    const di = Math.floor(d);
    let acc = 0, n = 0;
    for (let fy = dMax; fy < dMax + 2 * win; fy++) {
      const o = fy * fw;
      const op = (fy - di) * fw;
      for (let k = 0; k < fw; k += 2) {
        const q = curF[o + k] - prevF[op + k];
        acc += q * q;
        n++;
      }
    }
    return (acc / Math.max(1, n)) * this.widthScale;
  }

  // 前フレームからの移動量を求める（wholeFrameStatic: 画面全体が前フレームと同一かを返す関数・不明なら null）
  register(wholeFrameStatic) {
    const { fw, dMax, curF, prevF } = this;
    if (!this.hasPrev) return { status: "first", d: 0 };

    // 1) 照合窓の特徴量の強さと、帯全体をずらさずに比べた差（停止フレーム判定）
    //    ロングノーツのように縦にずらしても同じ見た目の要素があるため、停止判定は窓より広い帯全体で行う
    let energy = 0, n = 0, energyAll = 0, diff0 = 0, nAll = 0;
    for (let fy = 0; fy < this.fH; fy++) {
      const o = fy * fw;
      const inWin = fy >= dMax;
      for (let k = 0; k < fw; k += 2) {
        const c = curF[o + k];
        const p = prevF[o + k];
        diff0 += c > p ? c - p : p - c;
        energyAll += c;
        nAll++;
        if (inWin) {
          energy += c;
          n++;
        }
      }
    }
    energy = (energy / Math.max(1, n)) * this.widthScale;
    energyAll = (energyAll / Math.max(1, nAll)) * this.widthScale;
    diff0 = (diff0 / Math.max(1, nAll)) * this.widthScale;
    if (energyAll < 0.3) {
      // 帯全体に譜面要素が無い：画面全体の変化で再生中か停止中かを判断し、再生中なら予測値で進める
      const st = wholeFrameStatic ? wholeFrameStatic() : null;
      if (st === true) this.moving = false;
      else if (st === false) this.moving = true;
      return this.moving ? { status: "predicted", d: this.dExp } : { status: "freeze", d: 0 };
    }
    if (diff0 < 0.1) {
      // 前フレームと実質同一（録画側で同じ画面が続いた／再生停止中）
      // 線が薄い・まばらな区間は動いていても差が小さく出るため、明らかに同一のときだけここで止める（それ以外は下の照合で判断）
      this.moving = false;
      return { status: "freeze", d: 0 };
    }
    this.moving = true;
    if (energy < 0.6) {
      // 帯は変化している（再生中）が、照合窓の中に手掛かりが無い：直近の実測値で進める
      return { status: "predicted", d: this.dExp };
    }

    // 2) 移動量0〜最大まで全範囲を探す（一部の範囲だけで判定すると、範囲内の局所的な一致を誤って採用してしまう）
    const res = this._searchAll();
    if (!res) return { status: "predicted", d: this.dExp };
    const { best, alt, sharp } = res;
    if (sharp < Math.max(2, best.e * 0.25)) {
      // 縦にずらしてもほとんど変わらない（ロングノーツだけ等）：手掛かりが無いので直近の実測値で進める
      return { status: "predicted", d: this.dExp };
    }
    // 最良とほぼ同じだけ一致する候補（ノーツの無い区間で、等間隔のグリッド線が「線1本ずれ」でも重なる場合など）は
    // どれが正しいか画像だけでは決められないので、直近の実測値に最も近いものを採る
    const tolE = best.e + Math.max(3, sharp * 0.3);
    const good = res.refined.filter(c => c.e <= tolE);
    const unique = good.length === 1 && best.e < alt * 0.55;
    let pick = best;
    if (!unique) {
      for (const c of good) {
        if (Math.abs(c.d - this.dExp) < Math.abs(pick.d - this.dExp)) pick = c;
      }
    }
    if (pick.d === 0) {
      // 譜面は止まっていて、別の表示だけが変化している
      this.moving = false;
      return { status: "freeze", d: 0, stuck: true };
    }
    const d = this._subpixel(pick.d, pick.e);
    this._noteMotion(d);
    return { status: "motion", d, unique };
  }

  // 全範囲 [0, dMax] を列帯プロファイルで粗く探し、上位の候補を2次元の二乗誤差で精密に比べる
  _searchAll() {
    const { win, dMax, curP, prevP, strips, costs } = this;
    let mean = 0;
    for (let d = 0; d <= dMax; d++) {
      let acc = 0;
      for (let fy = dMax; fy < dMax + 2 * win; fy += 2) {
        const o = fy * strips;
        const op = (fy - d) * strips;
        for (let s = 0; s < strips; s++) {
          const q = curP[o + s] - prevP[op + s];
          acc += q < 0 ? -q : q;
        }
      }
      costs[d] = acc;
      mean += acc;
    }
    mean /= (dMax + 1);
    // 予測値に近いほどわずかに有利にする（等間隔の16分線などで迷ったときの決め手）
    const tol = Math.max(2, this.dExp * 0.3);
    const lambda = mean * 0.12;
    const scored = (d) => {
      const z = (d - this.dExp) / tol;
      return costs[d] + lambda * Math.min(1, z * z);
    };
    const local = [];
    for (let d = 0; d <= dMax; d++) {
      const v = scored(d);
      const left = d > 0 ? scored(d - 1) : Infinity;
      const right = d < dMax ? scored(d + 1) : Infinity;
      if (v <= left && v <= right) local.push({ d, v });
    }
    if (local.length === 0) return null;
    local.sort((a, b) => a.v - b.v);

    const refined = [];
    for (const c of local.slice(0, 4)) {
      let lb = null;
      for (let d = Math.max(0, c.d - 1); d <= Math.min(dMax, c.d + 1); d++) {
        const e = this._ssd(d);
        if (!lb || e < lb.e) lb = { d, e };
      }
      if (!refined.some(r => r.d === lb.d)) refined.push(lb);
    }
    refined.sort((a, b) => a.e - b.e);
    const best = refined[0];
    // 最良の位置から少しずらしたときの誤差の増え方（一致の「鋭さ」）
    const spread = Math.max(3, Math.round(this.dExp * 0.25));
    let spreadE = Infinity;
    if (best.d - spread >= 0) spreadE = Math.min(spreadE, this._ssd(best.d - spread));
    if (best.d + spread <= dMax) spreadE = Math.min(spreadE, this._ssd(best.d + spread));
    let alt = spreadE;
    for (const r of refined) if (Math.abs(r.d - best.d) >= 3 && r.e < alt) alt = r.e;
    return { best, alt, refined, sharp: spreadE === Infinity ? 0 : spreadE - best.e };
  }

  // 放物線近似によるサブピクセル補間
  _subpixel(d, e) {
    if (d < 1 || d >= this.dMax) return d;
    const a = this._ssd(d - 1), c = this._ssd(d + 1);
    const den = a - 2 * e + c;
    return den > 1e-9 ? d + Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / den)) : d;
  }

  commit() {
    // 今回のフレームを「前フレーム」にする
    let t = this.prevF; this.prevF = this.curF; this.curF = t;
    let p = this.prevP; this.prevP = this.curP; this.curP = p;
    this.hasPrev = true;
  }
}

// ---------------------------------------------------------
// 8-5. マスター画像（縦に長い1本の譜面）の書き込み
// ---------------------------------------------------------
class ChartMasterWriter {
  constructor(width) {
    this.width = width;
    this.canvases = [];
    this.curIndex = -1;
    this.curImage = null;
  }

  _flush() {
    if (this.curIndex < 0 || !this.curImage) return;
    const c = document.createElement("canvas");
    c.width = this.width;
    c.height = MASTER_CHUNK_H;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    if (ctx) ctx.putImageData(this.curImage, 0, 0);
    // キャンバスのメモリ上限を超えると例外なしで何も書き込まれず、譜面がそこから先だけ真っ黒になるため確認する（書き込む画素は必ず不透明）
    if (!ctx || ctx.getImageData(0, 0, 1, 1).data[3] !== 255) throw canvasMemoryError();
    this.canvases[this.curIndex] = c;
    this.curImage = null;
  }

  // 行 Y（下から数えた位置）を書き込むためのバイト位置を返す（Y は昇順で呼ぶ）
  row(Y) {
    const k = Math.floor(Y / MASTER_CHUNK_H);
    if (k !== this.curIndex) {
      this._flush();
      this.curIndex = k;
      this.curImage = new ImageData(this.width, MASTER_CHUNK_H);
      new Uint32Array(this.curImage.data.buffer).fill(0xFF000000);
    }
    return (MASTER_CHUNK_H - 1 - (Y - k * MASTER_CHUNK_H)) * this.width * 4;
  }

  get data() { return this.curImage.data; }

  finish() {
    this._flush();
    const out = [];
    for (let k = 0; k < this.canvases.length; k++) {
      if (!this.canvases[k]) {
        const c = document.createElement("canvas");
        c.width = this.width;
        c.height = MASTER_CHUNK_H;
        const ctx = c.getContext("2d", { willReadFrequently: true });
        ctx.fillStyle = "#000000";
        ctx.fillRect(0, 0, c.width, c.height);
        this.canvases[k] = c;
      }
      out.push(this.canvases[k]);
    }
    return out;
  }

  release() {
    for (const c of this.canvases) {
      if (c) { c.width = 0; c.height = 0; }
    }
    this.canvases = [];
    this.curImage = null;
  }
}

// 動画の数か所で、決め手のある照合結果だけを集めて「1フレームあたりのスクロール量」の基準を求める
// あわせて、譜面が動いている間も止まったままの列帯（照合を「停止」へ引っ張るので本番の照合から外す）を調べる
// seekStepSec: シーク方式のときの本番の取り出し間隔（シーク方式では列帯だけを調べ、速度の基準は求めない）
async function probeScrollPerFrame(source, geo, bgModel, tFrom, tTo, hintPerFrame, shouldStop, onProgress, seekStepSec = 0) {
  const span = tTo - tFrom;
  const isSeek = source.kind === "seek";
  if (span < 3 || (isSeek && !(seekStepSec > 0))) return null;
  const layout = new ScrollRegistrationTracker(geo, bgModel, hintPerFrame);
  const bandTop = layout.fTop;
  const work = createWorkCanvas(geo.cropW, layout.fH, true);
  const ds = [];
  const still = new Uint32Array(layout.strips);
  const moving = new Uint32Array(layout.strips);
  const ranges = [0.2, 0.35, 0.5, 0.65, 0.8].map(frac => [tFrom + span * frac, tFrom + span * frac + 0.3]);
  let tr = null;
  let prevT = null;
  let cur = -1;
  const onProbeFrame = async (frame, t, idx) => {
    if (idx !== cur) {
      // 区間どうしはつながっていないので、区間ごとに照合をやり直す
      cur = idx;
      tr = new ScrollRegistrationTracker(geo, bgModel, hintPerFrame);
      prevT = null;
      if (onProgress) onProgress(idx / ranges.length);
    }
    drawFrameRows(work.ctx, frame, geo, bandTop);
    tr.computeFeatures(work.ctx.getImageData(0, 0, geo.cropW, tr.fH).data, bandTop);
    if (tr.hasPrev) {
      const r = tr.register(null);
      const frames = Math.max(1, Math.round((t - prevT) * source.fps));
      if (r.status === "motion" && r.unique) ds.push(r.d / frames);
      tr.tallyStripMotion(still, moving);
    }
    tr.commit();
    prevT = t;
  };
  try {
    if (isSeek) {
      // 本番と同じ間隔で数枚ずつ取り出す
      for (let r = 0; r < ranges.length && !shouldStop(); r++) {
        const a = ranges[r][0];
        await source.forEachFrame(a, a + seekStepSec * 6, (frame, t) => onProbeFrame(frame, t, r), shouldStop, null, () => seekStepSec);
      }
    } else {
      // 5か所を1つのデコーダーで順に調べる（以前は1か所ごとにデコーダーを作り直し、キーフレームが少ない動画では毎回遠くからデコードし直していた）
      await source.forEachFrameInRanges(ranges, onProbeFrame, shouldStop);
    }
  } finally {
    work.canvas.width = 0;
  }
  ds.sort((x, y) => x - y);
  // 譜面が写っている列帯の割合。余白を含めて切り抜くと特徴量の平均が薄まり、同じ譜面でも手掛かりが無いと判定されてしまうので、その分を補正する
  const most = Math.max(...moving);
  const chartStrips = moving.filter(n => n >= most * 0.25).length;
  return {
    perFrame: (!isSeek && ds.length >= 6) ? ds[ds.length >> 1] : null,
    ignoredStrips: Array.from(still, (n, s) => n >= 5 && n >= moving[s] * 4),
    widthScale: most >= 5 ? Math.min(2, moving.length / chartStrips) : 1
  };
}

// 譜面エディタでは1小節目より下（再生ラインより下）には線もノーツも無いので、
// 最初の画面のその位置に譜面要素が写っていれば「録画開始時点で再生位置が曲の途中だった」とみなす
function detectMidChartStart(full, bg, geo, t0) {
  const { cropW, h } = geo;
  const y0 = Math.round(h * 0.85);
  const y1 = Math.round(h * 0.97);
  let hit = 0, n = 0;
  for (let y = y0; y < y1; y += 2) {
    for (let x = 0; x < cropW; x += 2) {
      const i = (y * cropW + x) * 4;
      const j = (y * cropW + x) * 3;
      const dr = full[i] - bg[j], dg = full[i + 1] - bg[j + 1], db = full[i + 2] - bg[j + 2];
      const dm = dr > dg ? (dr > db ? dr : db) : (dg > db ? dg : db);
      if (dm > t0) hit++;
      n++;
    }
  }
  return n > 0 && hit / n > 0.15;
}

// ---------------------------------------------------------
// 8-6. 合成エンジン本体
//   各フレームの「切り出し基準ライン」がマスター上のどこに当たるか（C）を実移動量で積み上げ、
//   前後2フレームの間の行を、上下のフレームからクロスフェードしながら埋めていく
// ---------------------------------------------------------
async function captureChartMasterFromSource(source, geo, opts, hooks) {
  const { cropW, h, capY, topSafeY } = geo;
  const shouldStop = hooks.shouldStop;

  // 1) 静止背景モデル
  if (hooks.onPhase) hooks.onPhase("bg", 0);
  const bgModel = await buildStaticBackgroundModel(source, geo, opts.bgFrom, opts.bgTo, shouldStop,
    (r) => { if (hooks.onPhase) hooks.onPhase("bg", r); });
  if (shouldStop()) return null;

  const useMask = Boolean(opts.blackBg && bgModel);
  const fp = opts.filterParams;
  const t0 = fp.t0;
  const invTw = fp.invTw;
  const lineGain = useMask ? fp.lineGain : 1;
  const lane = useMask ? extractStaticVerticalLines(bgModel, cropW, 0, cropW, h, topSafeY, fp.lineGain) : null;

  // 2) 照合・合成の準備
  const isSeek = source.kind === "seek";
  const fps = source.fps > 1 ? source.fps : 60;
  const speedHint = Math.max(1, opts.speedHintPxPerSec);
  const seekStepSec = Math.min(0.2, Math.max(1 / 60, (0.4 * h * 0.12) / speedHint));
  const frameInterval = isSeek ? seekStepSec : 1 / fps;
  // 曲ごとにスクロール速度が違うため、設定値ではなく動画から測った速度を予測の出発点にする
  // （出発点がずれていると、ノーツの無い前奏で「線1本ずれ」の位置を選んで譜面が伸び縮みしていた）
  if (hooks.onPhase) hooks.onPhase("speed", 0);
  const probe = await probeScrollPerFrame(source, geo, bgModel, opts.tStart, opts.tEnd, speedHint * frameInterval, shouldStop,
    (r) => { if (hooks.onPhase) hooks.onPhase("speed", r); }, isSeek ? seekStepSec : 0);
  if (shouldStop()) return null;
  const probed = probe && probe.perFrame;
  const tracker = new ScrollRegistrationTracker(geo, bgModel, probed || speedHint * frameInterval);
  tracker.seedSpeed(probed || speedHint * frameInterval, probed ? 3 : 1);
  if (probe) {
    tracker.ignoredStrips = probe.ignoredStrips;
    tracker.widthScale = probe.widthScale;
  }
  const dMax = tracker.dMax;
  const bandTop = Math.max(0, Math.min(tracker.fTop, capY - dMax - 2));
  const bandBot = Math.min(h, Math.max(tracker.fBot, capY + dMax + 2));
  const bandH = bandBot - bandTop;
  const bandWork = createWorkCanvas(cropW, bandH, true);
  const fullWork = createWorkCanvas(cropW, h, true);
  const thumbWork = createWorkCanvas(96, 54, true);
  let prevBand = null;
  let curBand = null;

  const writer = new ChartMasterWriter(cropW);
  const timeToYMap = [];
  const stats = { frames: 0, freeze: 0, predicted: 0, motion: 0, stuck: 0, ignoredStrips: probe ? probe.ignoredStrips.filter(Boolean).length : 0 };
  let motionDist = 0;   // 実際に動いていたフレームの移動量の合計と、その時間の合計（実測速度の表示用）
  let motionTime = 0;

  let C = 0;          // 現在フレームの切り出しラインが当たるマスター上の位置（下からのpx）
  let yFill = 0;      // 次に書き込むマスター行
  let firstTime = null;
  let lastTime = null;
  let lastFrameClone = null;
  let lastProgressWall = 0;
  let lastYieldWall = performance.now();

  const bgRowOff = (y) => y * cropW * 3;
  const rowA = new Float32Array(cropW * 3);
  const rowB = new Float32Array(cropW * 3);

  // band（rowTop 行目から始まる RGBA）の yIdx 行目（小数可）を補間で取り出し、黒背景化する
  const sampleRow = (band, rowTop, yIdx, out) => {
    const bandRows = band.length / (cropW * 4);
    let r0 = Math.floor(yIdx);
    let f = yIdx - r0;
    if (r0 < rowTop) { r0 = rowTop; f = 0; }
    let r1 = r0 + 1;
    if (r1 > rowTop + bandRows - 1) { r1 = r0; f = 0; }
    const ia0 = (r0 - rowTop) * cropW * 4;
    const ia1 = (r1 - rowTop) * cropW * 4;
    const ja0 = bgRowOff(r0), ja1 = bgRowOff(r1);
    for (let x = 0; x < cropW; x++) {
      const i0 = ia0 + x * 4, i1 = ia1 + x * 4;
      let r = band[i0] + (band[i1] - band[i0]) * f;
      let g = band[i0 + 1] + (band[i1 + 1] - band[i0 + 1]) * f;
      let b = band[i0 + 2] + (band[i1 + 2] - band[i0 + 2]) * f;
      if (useMask) {
        const j0 = ja0 + x * 3, j1 = ja1 + x * 3;
        const br = bgModel[j0] + (bgModel[j1] - bgModel[j0]) * f;
        const bgc = bgModel[j0 + 1] + (bgModel[j1 + 1] - bgModel[j0 + 1]) * f;
        const bb = bgModel[j0 + 2] + (bgModel[j1 + 2] - bgModel[j0 + 2]) * f;
        const dr = r - br, dg = g - bgc, db = b - bb;
        const dm = dr > dg ? (dr > db ? dr : db) : (dg > db ? dg : db);
        let a = (dm - t0) * invTw;
        a = a < 0 ? 0 : (a > 1 ? 1 : a);
        r *= a;
        g *= a;
        b *= a;
      }
      const o = x * 3;
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
    }
  };

  const writeBlendedRow = (Y, w) => {
    const off = writer.row(Y);
    const data = writer.data;
    for (let x = 0; x < cropW; x++) {
      const o = x * 3;
      let r = rowA[o] + (rowB[o] - rowA[o]) * w;
      let g = rowA[o + 1] + (rowB[o + 1] - rowA[o + 1]) * w;
      let b = rowA[o + 2] + (rowB[o + 2] - rowA[o + 2]) * w;
      if (lineGain !== 1) {
        const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
        const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
        if (mx > 0 && mx - mn < 40) {
          r *= lineGain;
          g *= lineGain;
          b *= lineGain;
        }
      }
      if (lane) {
        if (lane[o] > r) r = lane[o];
        if (lane[o + 1] > g) g = lane[o + 1];
        if (lane[o + 2] > b) b = lane[o + 2];
      }
      const p = off + x * 4;
      data[p] = r;
      data[p + 1] = g;
      data[p + 2] = b;
    }
  };

  // 2枚のフレームの間（Cprev〜Cnow）を、上下のフレームをクロスフェードしながら埋める
  const fillBetween = (Cprev, Cnow) => {
    const span = Cnow - Cprev;
    while (yFill + 0.5 <= Cnow) {
      const Yc = yFill + 0.5;
      const w = span > 1e-6 ? Math.max(0, Math.min(1, (Yc - Cprev) / span)) : 1;
      const yPrev = capY - (Yc - Cprev) - 0.5;
      const yCur = capY - (Yc - Cnow) - 0.5;
      const prevOk = prevBand && yPrev >= bandTop;
      if (prevOk) sampleRow(prevBand, bandTop, yPrev, rowA);
      sampleRow(curBand, bandTop, Math.min(bandBot - 1, yCur), rowB);
      if (!prevOk) rowA.set(rowB);
      writeBlendedRow(yFill, prevOk ? w : 1);
      yFill++;
    }
  };

  const onFrame = async (frame, t) => {
    if (shouldStop()) return;
    stats.frames++;
    drawFrameRows(bandWork.ctx, frame, geo, bandTop);
    curBand = bandWork.ctx.getImageData(0, 0, cropW, bandH).data;
    tracker.computeFeatures(curBand, bandTop);

    if (firstTime === null) {
      // 最初のフレーム：切り出しラインより下（画面下部）をそのまま土台として書き込む
      firstTime = t;
      drawFrameRows(fullWork.ctx, frame, geo, 0);
      const full = fullWork.ctx.getImageData(0, 0, cropW, h).data;
      C = h - capY;
      for (let Y = 0; Y < C; Y++) {
        const y = h - 1 - Y;
        const off = writer.row(Y);
        if (useMask) {
          maskRowAgainstBackground(full, y * cropW * 4, bgModel, bgRowOff(y), cropW, fp, lane, writer.data, off);
        } else {
          writer.data.set(full.subarray(y * cropW * 4, (y + 1) * cropW * 4), off);
        }
      }
      yFill = C;
      timeToYMap.push({ time: t, bottomY: C });
      // 動画の頭から作るのに、最初の画面ですでに譜面が途中まで進んでいないかを確認する
      if (bgModel && opts.tStart < 0.5) stats.startsMidChart = detectMidChartStart(full, bgModel, geo, t0);
    } else {
      // 照合窓に手掛かりが無いときだけ、画面全体（タイマー表示など）が前フレームから変化したかを確認する
      const wholeFrameStatic = () => {
        if (!lastFrameClone || !(typeof VideoFrame !== "undefined" && frame instanceof VideoFrame)) return null;
        thumbWork.ctx.drawImage(lastFrameClone, 0, 0, 96, 54);
        const a = thumbWork.ctx.getImageData(0, 0, 96, 54).data.slice();
        thumbWork.ctx.drawImage(frame, 0, 0, 96, 54);
        const b = thumbWork.ctx.getImageData(0, 0, 96, 54).data;
        let maxDiff = 0;
        for (let i = 0; i < a.length; i += 4) {
          const q = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
          if (q > maxDiff) maxDiff = q;
        }
        return maxDiff <= 9;
      };
      const reg = tracker.register(wholeFrameStatic);
      let d = reg.d;
      if (!(d >= 0)) d = 0;
      if (d > dMax) d = dMax;
      if (reg.status === "motion") {
        stats.motion++;
        if (t - lastTime > 1e-4) {
          motionDist += d;
          motionTime += t - lastTime;
        }
      } else if (reg.status === "freeze") {
        stats.freeze++;
        if (reg.stuck) stats.stuck++;
      } else {
        stats.predicted++;
      }
      if (d > 0) {
        const Cprev = C;
        C += d;
        fillBetween(Cprev, C);
      }
      timeToYMap.push({ time: t, bottomY: C });
    }
    tracker.commit();
    prevBand = curBand;
    lastTime = t;

    if (typeof VideoFrame !== "undefined" && frame instanceof VideoFrame) {
      if (lastFrameClone) lastFrameClone.close();
      lastFrameClone = frame.clone();
    }

    const now = performance.now();
    if (hooks.onProgress && (now - lastProgressWall > 150)) {
      lastProgressWall = now;
      hooks.onProgress(t, stats, tracker.dExp);
    }
    if (now - lastYieldWall > 30) {
      lastYieldWall = now;
      await yieldToEventLoop();
    }
  };

  const cleanupWork = () => {
    if (lastFrameClone) {
      lastFrameClone.close();
      lastFrameClone = null;
    }
    bandWork.canvas.width = 0;
    fullWork.canvas.width = 0;
    thumbWork.canvas.width = 0;
  };

  try {
    await source.forEachFrame(opts.tStart, opts.tEnd, onFrame, shouldStop, null, () => seekStepSec);
  } catch (err) {
    cleanupWork();
    writer.release();
    throw err;
  }

  if (shouldStop() || firstTime === null) {
    cleanupWork();
    writer.release();
    return null;
  }

  // 3) 最後のフレーム：切り出しラインより上（画面上部）を書き込む
  let chunks;
  try {
    const lastSrc = lastFrameClone || (isSeek ? source.video : null);
    const capEnd = C + (capY - topSafeY);
    if (lastSrc) {
      drawFrameRows(fullWork.ctx, lastSrc, geo, 0);
      const full = fullWork.ctx.getImageData(0, 0, cropW, h).data;
      while (yFill + 0.5 <= capEnd) {
        const Yc = yFill + 0.5;
        const yIdx = capY - (Yc - C) - 0.5;
        sampleRow(full, 0, Math.max(topSafeY, yIdx), rowB);
        rowA.set(rowB);
        writeBlendedRow(yFill, 1);
        yFill++;
      }
    }
    chunks = writer.finish();
  } catch (err) {
    cleanupWork();
    writer.release();
    throw err;
  }
  cleanupWork();

  const totalHeight = Math.max(100, yFill);
  const pxPerSec = motionTime > 0 ? motionDist / motionTime : tracker.dExp / frameInterval;
  stats.measuredSpeedPct = (pxPerSec / h) * 100;
  // 動画の長さの割に譜面の動きをほとんど測れなかった（動画の向きを正しく読めていない・譜面が流れていない録画など）
  stats.motionDist = motionDist;
  stats.noScroll = lastTime - firstTime >= NO_SCROLL_MIN_SEC && (motionDist < h || stats.motion < stats.stuck * 0.1);

  return {
    hasData: true,
    cropW,
    totalHeight,
    bottomBaseH: h - capY,
    topCapH: Math.max(0, totalHeight - Math.round(C)),
    chunks,
    tStart: firstTime,
    tEnd: lastTime,
    timeToYMap,
    frameH: h,
    captureY: capY,
    fps,
    engine: source.kind,
    stats
  };
}

// ---------------------------------------------------------
// 8-7. 動画1本分の生成（フレーム供給源の選択・メモリ上限の確認・失敗時の切り替え）
// ---------------------------------------------------------
async function buildMasterDataForVideo(vidElem, vidItem, sourceName, isTestMode, job, onProgress) {
  const rawW = vidElem.videoWidth;
  const rawH = vidElem.videoHeight;
  const leftPct = parseFloat(cropLeftSlider.value) / 100;
  const rightPct = parseFloat(cropRightSlider.value) / 100;
  const dur = vidElem.duration || 0;

  let tStart = 0.0;
  let fullEnd = dur;
  if (vidElem === video) {
    const userStart = parseFloat(startTimeInput.value);
    const userEnd = parseFloat(endTimeInput.value);
    tStart = !isNaN(userStart) ? Math.min(Math.max(0, userStart), Math.max(0, dur - 0.1)) : 0.0;
    fullEnd = (!isNaN(userEnd) && userEnd > tStart) ? Math.min(userEnd, dur) : dur;
  }
  const tEnd = isTestMode ? Math.min(fullEnd, tStart + 12.0) : fullEnd;
  const speedPct = parseFloat(speedInput.value) || 47.50;

  // 縦に長いマスター画像がメモリに収まるよう、極端に長い動画では作業解像度を自動で下げる
  let workScale = computeWorkScale(rawH);
  const geo0 = computeCaptureGeometry(rawW, rawH, leftPct, rightPct, workScale);
  // iOS は上限を超えると譜面が欠けるので、速度の設定が初期値のままでも収まるよう実際の最大速度で見積もる
  const estRows = (tEnd - tStart) * geo0.h * (Math.max(speedPct, IS_IOS_FAMILY ? 110 : 40) / 100) * 1.25 + geo0.h;
  const estBytes = geo0.cropW * estRows * 4;
  let reducedNote = "";
  if (estBytes > MASTER_MEMORY_BUDGET) {
    workScale *= Math.sqrt(MASTER_MEMORY_BUDGET / estBytes);
    reducedNote = "（動画が長いためメモリ節約のため解像度を自動調整）";
  }
  const geo = computeCaptureGeometry(rawW, rawH, leftPct, rightPct, workScale);

  const opts = {
    tStart,
    tEnd,
    bgFrom: tStart,
    bgTo: fullEnd,
    blackBg: blackBgToggle.checked,
    filterParams: getBlackFilterParams(),
    speedHintPxPerSec: geo.h * speedPct / 100
  };
  const hooks = {
    shouldStop: () => job.cancelled,
    onPhase: (phase, ratio) => { if (onProgress) onProgress({ phase, ratio }); },
    onProgress: (t, stats) => { if (onProgress) onProgress({ phase: "main", time: t, tStart, tEnd, stats }); }
  };

  let source = null;
  if (vidItem && vidItem.file) source = await WebCodecsFrameSource.open(vidItem.file, rawW, rawH);
  if (!source) source = new SeekFrameSource(vidElem);
  geo.rotation = source.rotation || 0;
  if (onProgress) onProgress({ phase: "engine", label: source.label + reducedNote });

  let result = null;
  let unreadable = false;
  try {
    result = await captureChartMasterFromSource(source, geo, opts, hooks);
    unreadable = !result || result.stats.noScroll;
  } catch (err) {
    if (source.kind !== "webcodecs" || job.cancelled || err.outOfMemory) throw err;
    unreadable = true;
  }
  if (unreadable && source.kind === "webcodecs" && !job.cancelled) {
    // この動画を全フレーム解析で読めなかった（デコードできない・譜面が動いて見えない）場合は、ブラウザの再生機能を使うシーク方式でやり直す
    if (result) releaseMasterChunks(result);
    source = new SeekFrameSource(vidElem);
    geo.rotation = 0;
    if (onProgress) onProgress({ phase: "engine", label: `${source.label}（全フレーム解析で読めなかったため切替）${reducedNote}` });
    result = await captureChartMasterFromSource(source, geo, opts, hooks);
  }
  if (!result) return { hasData: false, chunks: [] };
  result.sourceLabel = sourceName;
  result.engineLabel = source.label;
  return result;
}

// 録画の最初の時点でエディタの再生位置が曲の途中だった場合、その前の部分は動画に写っていないので作れない
const MID_CHART_START_NOTE = "　注意：録画の最初の時点で、エディタの再生位置が曲の途中でした。その前の部分は動画に写っていないため画像にも入りません。曲の最初から作るには、エディタの再生位置を先頭に戻してから録画し直してください。";
function midChartNoteFor(folders) {
  if (!folders.length) return "";
  return `　注意：${folders.map(f => `「${f}」`).join("")}は録画の最初の時点でエディタの再生位置が曲の途中だったため、その前の部分が入っていません（先頭に戻してから録画し直すと最初から作れます）。`;
}

// 譜面が流れていないように見える結果は、既存の画像を上書きしないよう保存せずに知らせる
const NO_SCROLL_NOTE = "譜面のスクロールを動画から検出できなかったため、フォルダには保存していません。譜面が流れている場面が録画に入っているか、動画の向きと切り抜き範囲を確認してください。";
function noScrollNoteFor(folders) {
  if (!folders.length) return "";
  return `　注意：${folders.map(f => `「${f}」`).join("")}は譜面のスクロールを動画から検出できなかったため、保存していません（録画の内容・動画の向き・切り抜き範囲を確認してください）。`;
}

function setProgress(pct, text) {
  const p = Math.max(0, Math.min(100, Math.round(pct)));
  progressPercent.textContent = `${p}%`;
  progressBar.style.width = `${p}%`;
  if (text) progressText.textContent = text;
}

function describeMainProgress(info, engineLabel, prefix = "") {
  const span = Math.max(0.001, info.tEnd - info.tStart);
  const ratio = Math.min(1, Math.max(0, (info.time - info.tStart) / span));
  const st = info.stats;
  return {
    ratio,
    text: `${prefix}作成中… ${info.time.toFixed(1)} / ${info.tEnd.toFixed(1)} 秒`
  };
}

function requestStopGeneration() {
  if (!activeGenerationJob) return;
  activeGenerationJob.cancelled = true;
  cancelGenerationRequested = true;
  for (const fn of Array.from(activeSeekResolvers)) {
    try { fn(); } catch (e) {}
  }
  activeSeekResolvers.clear();
  progressText.textContent = "停止しています...";
}
progressStopBtn.addEventListener("click", requestStopGeneration);

// 前に作った動画のマスターを、一括処理と同じように画像へ変換して手放す
// （iOS はキャンバスの総メモリ上限が低く、持ったままだと次の動画の途中で上限に達する。失敗しても生成は続ける）
async function compactOldMasters() {
  try {
    for (const [, grp] of folderGroups) {
      for (const img of grp.images) {
        const mData = img.masterData;
        if (!mData || !mData.hasData) continue;
        if (!img.file) {
          const c = document.createElement("canvas");
          const lay = renderChartLayout(mData, c);
          embedTimestampsIntoCanvas(c, Object.assign({}, mData, { layout: lay.layoutMeta }));
          const blob = await canvasToBlobSafe(c);
          c.width = 0;
          c.height = 0;
          if (!blob) continue;
          img.file = new File([blob], img.name, { type: "image/png" });
        }
        img.masterData = null;
        releaseMasterChunks(mData);
      }
    }
    // お試し作成の結果はどのフォルダにも属していない
    if (masterChartData.keepExisting) releaseMasterChunks(masterChartData);
  } catch (e) {}
}

async function generateChartImage(isTestMode = false) {
  if (!video.videoWidth || isGenerating) return;
  video.pause();
  const prevMuted = video.muted;
  video.muted = true;
  const job = { cancelled: false };
  activeGenerationJob = job;
  cancelGenerationRequested = false;

  const startWallTime = performance.now();
  setGeneratingLock(true);
  progressContainer.style.display = "block";
  setProgress(0, "生成の準備中...");
  let engineLabel = "";

  try {
    if (IS_IOS_FAMILY) await compactOldMasters();
    const label = activeFolderName || (activeVideoName ? activeVideoName.replace(/\.[^.]+$/, "") : "生成譜面");
    const onInfo = (info) => {
      if (job.cancelled) return;
      if (info.phase === "engine") {
        engineLabel = info.label;
        if (deviceSpecBadge) deviceSpecBadge.textContent = info.label;
      } else if (info.phase === "bg") {
        setProgress(info.ratio * 5, "背景を調べています…");
      } else if (info.phase === "speed") {
        setProgress(5 + 3 * (info.ratio || 0), "スクロール速度を測っています…");
      } else if (info.phase === "main") {
        const p = describeMainProgress(info, engineLabel);
        setProgress(8 + 92 * p.ratio, p.text);
      }
    };
    // ★ Chart Maker: 解像度の設定を画面から外したので、メモリが足りない時は自動で画像を小さくしてやり直す
    let resultData;
    for (;;) {
      try {
        resultData = await buildMasterDataForVideo(video, activeVideoItem, label, isTestMode, job, onInfo);
        break;
      } catch (err) {
        const next = { original: "1080", "1080": "720", "720": "560" }[resolutionSelect.value];
        if (!err || !err.outOfMemory || !next || job.cancelled) throw err;
        resolutionSelect.value = next;
        setProgress(0, "メモリが足りないため、画像を小さくしてやり直しています…");
        if (IS_IOS_FAMILY) await compactOldMasters();
      }
    }

    if (resultData.hasData && !job.cancelled) {
      const st = resultData.stats || {};
      // テスト作成と、譜面の動きを検出できなかった結果では、フォルダの静止画・保存済みタイムスタンプを上書きしない
      resultData.keepExisting = isTestMode || Boolean(st.noScroll);
      if (!resultData.keepExisting && activeFolderName && folderGroups.has(activeFolderName)) {
        const grp = folderGroups.get(activeFolderName);
        grp.images = [{ name: chartImageFileName(activeFolderName), file: null, url: null, masterData: resultData, folderName: activeFolderName }];
      }
      replaceMasterChartData(resultData);
      const saved = await rebuildLayoutFromMaster(true);
      const elapsedSec = ((performance.now() - startWallTime) / 1000).toFixed(1);
      const speedNote = st.measuredSpeedPct ? `・速度 ${st.measuredSpeedPct.toFixed(1)}%/秒` : "";
      const doneLabel = isTestMode
        ? "お試しで作成しました"
        : (saved ? "作成してフォルダに保存しました" : "作成しました。「画像を保存」で保存できます");
      setProgress(100, st.noScroll ? NO_SCROLL_NOTE : `${doneLabel}（${elapsedSec}秒${speedNote}）${st.startsMidChart ? MID_CHART_START_NOTE : ""}`);
    } else if (job.cancelled) {
      progressText.textContent = "停止しました";
    } else {
      progressText.textContent = "動画からフレームを読み取れませんでした。別の形式で書き出した動画で試してください。";
    }
  } catch (err) {
    progressText.textContent = `エラーが発生しました: ${err && err.message ? err.message : err}`;
  } finally {
    video.muted = prevMuted;
    resolutionSelect.value = "original";
    applyPlaybackRate(currentPlaybackRate, false);
    shouldRestartFromBeginning = true;
    await seekVideoElementTo(video, 0);
    seekSlider.value = 0;
    currentTimeLabel.textContent = `0.00 秒 / ${(video.duration || 0).toFixed(2)} 秒`;
    activeGenerationJob = null;
    setGeneratingLock(false);
    renderTopSwitcher();
    drawPreview(true);
    drawPlayheadOverlay();
  }
}

async function processMultipleVideosConcurrently() {
  if (isGenerating) return;
  const vidEntries = getUnprocessedVideoEntries();
  if (vidEntries.length === 0) return;

  video.pause();
  const job = { cancelled: false };
  activeGenerationJob = job;
  cancelGenerationRequested = false;
  const startWallTime = performance.now();
  setGeneratingLock(true);
  progressContainer.style.display = "block";
  setProgress(0, "一括作成の準備中...");

  let completedCount = 0;
  let savedCount = 0;
  let firstCompletedFolder = "";
  const midChartFolders = [];
  const noScrollFolders = [];

  try {
    if (IS_IOS_FAMILY) await compactOldMasters();
    for (let idx = 0; idx < vidEntries.length; idx++) {
      if (job.cancelled) break;
      const { videoEntry, folderName } = vidEntries[idx];
      const head = `${idx + 1}/${vidEntries.length}本目「${folderName}」 `;
      progressText.textContent = `${head}読み込み中…`;

      const tempVid = document.createElement("video");
      tempVid.playsInline = true;
      tempVid.muted = true;
      tempVid.preload = "auto";
      const tempUrl = videoEntry.file ? URL.createObjectURL(videoEntry.file) : (videoEntry.url || "");
      tempVid.src = tempUrl;
      tempVid.load();
      const ok = await waitForVideoMetadata(tempVid);

      try {
        if (ok && tempVid.videoWidth && !job.cancelled) {
          let engineLabel = "";
          const mData = await buildMasterDataForVideo(tempVid, videoEntry, folderName, false, job, (info) => {
            if (job.cancelled) return;
            if (info.phase === "engine") {
              engineLabel = info.label;
            } else if (info.phase === "bg") {
              setProgress(((idx + info.ratio * 0.05) / vidEntries.length) * 100, `${head}背景を調べています…`);
            } else if (info.phase === "speed") {
              setProgress(((idx + 0.05 + 0.03 * (info.ratio || 0)) / vidEntries.length) * 100, `${head}スクロール速度を測っています…`);
            } else if (info.phase === "main") {
              const p = describeMainProgress(info, engineLabel, head);
              setProgress(((idx + 0.08 + 0.92 * p.ratio) / vidEntries.length) * 100, p.text);
            }
          });

          if (!job.cancelled && (!mData.hasData || (mData.stats && mData.stats.noScroll))) {
            noScrollFolders.push(folderName);
            releaseMasterChunks(mData);
          } else if (mData.hasData && !job.cancelled) {
            completedCount++;
            if (!firstCompletedFolder) firstCompletedFolder = folderName;
            saveTimestampProfileForFolder(folderName, mData);

            const tempOutC = document.createElement("canvas");
            const lay = renderChartLayout(mData, tempOutC);
            embedTimestampsIntoCanvas(tempOutC, Object.assign({}, mData, { layout: lay.layoutMeta }));
            const grp = folderGroups.get(folderName);
            const saved = await autoSaveCanvasToFolder(folderName, tempOutC);
            if (saved) savedCount++;
            if (mData.stats && mData.stats.startsMidChart) midChartFolders.push(folderName);
            if (!saved && grp) {
              // 保存先が無い場合は画像としてメモリに残す（巨大なマスターは残さない）
              const blob = await canvasToBlobSafe(tempOutC);
              if (blob) {
                const name = chartImageFileName(folderName);
                grp.images = [{ name, file: new File([blob], name, { type: "image/png" }), url: null, masterData: null, folderName }];
              }
            }
            tempOutC.width = 0;
            tempOutC.height = 0;
            // 一括処理では動画1本ごとにマスターを解放する（以前は全動画分を保持してメモリ不足になり得た）
            releaseMasterChunks(mData);
          }
        }
      } finally {
        tempVid.removeAttribute("src");
        tempVid.load();
        if (videoEntry.file && tempUrl) URL.revokeObjectURL(tempUrl);
      }
    }

    const elapsedSec = ((performance.now() - startWallTime) / 1000).toFixed(1);
    const notes = midChartNoteFor(midChartFolders) + noScrollNoteFor(noScrollFolders);
    if (job.cancelled) {
      progressText.textContent = `停止しました（${completedCount}本作成済み）`;
    } else if (savedCount === completedCount) {
      setProgress(100, `${completedCount}本を作成して保存しました（${elapsedSec}秒）${notes}`);
    } else {
      setProgress(100, `${completedCount}本を作成しました。保存先フォルダが未登録の${completedCount - savedCount}本は、フォルダを選んで「画像を保存」で保存してください（${elapsedSec}秒）${notes}`);
    }
  } catch (err) {
    progressText.textContent = `エラーが発生しました: ${err && err.message ? err.message : err}`;
  } finally {
    shouldRestartFromBeginning = true;
    if (video.src) {
      applyPlaybackRate(currentPlaybackRate, false);
      await seekVideoElementTo(video, 0);
      seekSlider.value = 0;
      currentTimeLabel.textContent = `0.00 秒 / ${(video.duration || 0).toFixed(2)} 秒`;
    }
    const wasCancelled = job.cancelled;
    activeGenerationJob = null;
    setGeneratingLock(false);
    if (firstCompletedFolder && !wasCancelled) {
      switcherContent.style.display = "block";
      selectFolderSet(firstCompletedFolder);
    } else {
      renderTopSwitcher();
    }
    drawPreview(true);
    drawPlayheadOverlay();
  }
}

generateBtn.addEventListener("click", () => generateChartImage(false));
batchGenerateBtn.addEventListener("click", processMultipleVideosConcurrently);
testGenerateBtn.addEventListener("click", () => generateChartImage(true));

// =========================================================
// 9. ソフト内蔵「譜面ビューアー」（生成中も常時操作可能）
// =========================================================
const viewerBox = document.getElementById("viewerBox");
const viewerViewport = document.getElementById("viewerViewport");
const zoomLevelLabel = document.getElementById("zoomLevelLabel");
const zoomInBtn = document.getElementById("zoomInBtn");
const zoomOutBtn = document.getElementById("zoomOutBtn");
const fitAllBtn = document.getElementById("fitAllBtn");
const fitHeightBtn = document.getElementById("fitHeightBtn");
const zoom100Btn = document.getElementById("zoom100Btn");
const fullscreenBtn = document.getElementById("fullscreenBtn");
const exitFullscreenBtn = document.getElementById("exitFullscreenBtn");
const colJumpBar = document.getElementById("colJumpBar");

let vScale = 1.0;
let vX = 0;
let vY = 0;
let isDragging = false;
let dragStartX = 0;
let dragStartY = 0;
let lastZoomLabel = "";

function updateViewerTransform() {
  canvasStage.style.transform = `translate3d(${vX}px, ${vY}px, 0) scale(${vScale})`;
  const zl = `${Math.round(vScale * 100)}%`;
  if (zl !== lastZoomLabel) {
    lastZoomLabel = zl;
    zoomLevelLabel.textContent = zl;
  }
  positionPlayheadOverlay();
}

function fitViewerAll() {
  if (!outputCanvas.width || !outputCanvas.height) return;
  const vw = Math.max(200, viewerViewport.clientWidth);
  const vh = Math.max(200, viewerViewport.clientHeight);
  vScale = Math.min((vw - 20) / outputCanvas.width, (vh - 20) / outputCanvas.height, 1.5);
  vX = Math.max(10, (vw - outputCanvas.width * vScale) / 2);
  vY = Math.max(10, (vh - outputCanvas.height * vScale) / 2);
  updateViewerTransform();
}

function fitViewerHeight() {
  if (!outputCanvas.height) return;
  const vh = Math.max(200, viewerViewport.clientHeight);
  vScale = (vh - 20) / outputCanvas.height;
  vX = 10;
  vY = 10;
  updateViewerTransform();
}

function zoomAtCenter(factor) {
  const vw = viewerViewport.clientWidth;
  const vh = viewerViewport.clientHeight;
  const cx = vw / 2;
  const cy = vh / 2;
  const newScale = Math.min(4.0, Math.max(0.05, vScale * factor));
  const ratio = newScale / vScale;
  vX = cx - (cx - vX) * ratio;
  vY = cy - (cy - vY) * ratio;
  vScale = newScale;
  updateViewerTransform();
}

function setupViewerAfterGenerate(numCols) {
  colJumpBar.innerHTML = `<span style="font-size:0.82rem; color:#9aa5b8; white-space:nowrap;">列へジャンプ:</span>`;
  if (chartMeta.mode === "grid" && numCols > 1 && chartMeta.colRects && chartMeta.colRects.length > 1) {
    colJumpBar.style.display = "flex";
    for (let c = 0; c < numCols; c++) {
      const btn = document.createElement("button");
      btn.className = "btn btn-secondary";
      btn.style.padding = "4px 10px";
      btn.style.fontSize = "0.8rem";
      btn.style.whiteSpace = "nowrap";
      btn.textContent = `${c + 1}列目`;
      btn.addEventListener("click", () => {
        const rect = chartMeta.colRects[c] || chartMeta.colRects[0];
        vScale = Math.min(1.2, Math.max(0.4, viewerViewport.clientWidth / (rect.w * 2.2)));
        vX = 30 - rect.x * vScale;
        vY = 10;
        updateViewerTransform();
      });
      colJumpBar.appendChild(btn);
    }
  } else {
    colJumpBar.style.display = "none";
  }

  requestAnimationFrame(() => {
    fitViewerAll();
  });
}

viewerViewport.addEventListener("dblclick", (e) => seekToViewerPoint(e.clientX, e.clientY));

function seekToViewerPoint(clientX, clientY) {
  if (isGenerating || !video.src || !outputCanvas.width) return;
  shouldRestartFromBeginning = false;
  const rect = viewerViewport.getBoundingClientRect();
  const canvasX = (clientX - rect.left - vX) / vScale;
  const canvasY = (clientY - rect.top - vY) / vScale;

  let clickedBottomY = 0;
  const { colMaxH, totalHeight, colRects } = chartMeta;

  if (chartMeta.mode === "single" || !colRects || colRects.length === 0) {
    const r = (colRects && colRects[0]) ? colRects[0] : { x: 0, y: 0, w: outputCanvas.width, h: outputCanvas.height };
    const ratio = Math.max(0, Math.min(1, 1 - (canvasY - r.y) / Math.max(1, r.h)));
    clickedBottomY = ratio * totalHeight;
  } else {
    let bestCol = 0;
    let minDist = Infinity;
    for (let c = 0; c < colRects.length; c++) {
      const cr = colRects[c];
      const center = cr.x + cr.w * 0.5;
      const d = Math.abs(canvasX - center);
      if (d < minDist) {
        minDist = d;
        bestCol = c;
      }
    }
    const cr = colRects[bestCol];
    const relRatio = Math.max(0, Math.min(1, 1 - (canvasY - cr.y) / Math.max(1, cr.h)));
    clickedBottomY = bestCol * colMaxH + relRatio * colMaxH;
  }

  const offsetSec = parseFloat(playheadOffsetInput.value) || 0;
  const targetTime = getTimeForBottomY(clickedBottomY) - offsetSec;
  video.currentTime = Math.max(0, Math.min(video.duration || targetTime, targetTime));
}

zoomInBtn.addEventListener("click", () => zoomAtCenter(1.25));
zoomOutBtn.addEventListener("click", () => zoomAtCenter(0.8));
fitAllBtn.addEventListener("click", fitViewerAll);
fitHeightBtn.addEventListener("click", fitViewerHeight);
zoom100Btn.addEventListener("click", () => { vScale = 1.0; vX = 10; vY = 10; updateViewerTransform(); });

function setViewerFullscreen(enable) {
  if (enable) {
    viewerBox.classList.add("fullscreen");
    fullscreenBtn.textContent = "全画面を閉じる";
  } else {
    viewerBox.classList.remove("fullscreen");
    fullscreenBtn.textContent = "全画面";
  }
  setTimeout(fitViewerAll, 50);
}

fullscreenBtn.addEventListener("click", () => {
  setViewerFullscreen(!viewerBox.classList.contains("fullscreen"));
});

exitFullscreenBtn.addEventListener("click", () => {
  setViewerFullscreen(false);
});

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && viewerBox.classList.contains("fullscreen")) {
    setViewerFullscreen(false);
  }
});

viewerViewport.addEventListener("wheel", (e) => {
  e.preventDefault();
  const rect = viewerViewport.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  const factor = e.deltaY < 0 ? 1.15 : 0.87;
  const newScale = Math.min(4.5, Math.max(0.05, vScale * factor));
  const ratio = newScale / vScale;
  vX = mx - (mx - vX) * ratio;
  vY = my - (my - vY) * ratio;
  vScale = newScale;
  updateViewerTransform();
}, { passive: false });

// マウス・タッチ共通：1本指（左ボタン）で移動、2本指でピンチ拡大縮小、ダブルタップでその位置へ移動
const activePointers = new Map();
let pinchStart = null;
let lastTap = { time: 0, x: 0, y: 0 };

function startPinch() {
  const [a, b] = Array.from(activePointers.values());
  const rect = viewerViewport.getBoundingClientRect();
  pinchStart = {
    dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
    cx: (a.x + b.x) / 2 - rect.left,
    cy: (a.y + b.y) / 2 - rect.top,
    scale: vScale, x: vX, y: vY
  };
}

viewerViewport.addEventListener("pointerdown", (e) => {
  if (e.target === exitFullscreenBtn || (e.pointerType === "mouse" && e.button !== 0)) return;
  viewerViewport.setPointerCapture(e.pointerId);
  activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (activePointers.size === 1) {
    isDragging = true;
    dragStartX = e.clientX - vX;
    dragStartY = e.clientY - vY;
    viewerViewport.classList.add("dragging");
  } else if (activePointers.size === 2) {
    startPinch();
  }
});
viewerViewport.addEventListener("pointermove", (e) => {
  if (!activePointers.has(e.pointerId)) return;
  activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (activePointers.size >= 2 && pinchStart) {
    const [a, b] = Array.from(activePointers.values());
    const rect = viewerViewport.getBoundingClientRect();
    const dist = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
    const cx = (a.x + b.x) / 2 - rect.left;
    const cy = (a.y + b.y) / 2 - rect.top;
    const newScale = Math.min(4.5, Math.max(0.05, pinchStart.scale * dist / pinchStart.dist));
    const ratio = newScale / pinchStart.scale;
    vX = cx - (pinchStart.cx - pinchStart.x) * ratio;
    vY = cy - (pinchStart.cy - pinchStart.y) * ratio;
    vScale = newScale;
    updateViewerTransform();
  } else if (isDragging) {
    vX = e.clientX - dragStartX;
    vY = e.clientY - dragStartY;
    updateViewerTransform();
  }
});
function endPointer(e) {
  if (!activePointers.has(e.pointerId)) return;
  activePointers.delete(e.pointerId);
  if (activePointers.size === 1) {
    // ピンチの途中で1本指に戻ったら、残った指で移動を続ける
    const p = Array.from(activePointers.values())[0];
    pinchStart = null;
    dragStartX = p.x - vX;
    dragStartY = p.y - vY;
    return;
  }
  if (activePointers.size === 0) {
    isDragging = false;
    pinchStart = null;
    viewerViewport.classList.remove("dragging");
  }
  // タッチではダブルクリックが届かないことがあるため、ダブルタップを自前で判定する
  if (e.type === "pointerup" && e.pointerType !== "mouse") {
    const now = performance.now();
    if (now - lastTap.time < 320 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30) {
      seekToViewerPoint(e.clientX, e.clientY);
      lastTap.time = 0;
    } else {
      lastTap = { time: now, x: e.clientX, y: e.clientY };
    }
  }
}
viewerViewport.addEventListener("pointerup", endPointer);
viewerViewport.addEventListener("pointercancel", endPointer);
window.addEventListener("resize", () => {
  positionPlayheadOverlay();
});

// =========================================================
// 10. PNG画像・指定列のみ保存・ZIP一括ダウンロード保存
// =========================================================
downloadPngBtn.addEventListener("click", async () => {
  if (isGenerating || !outputCanvas.width) return;
  const blob = await canvasToBlobSafe(outputCanvas);
  const prefix = activeFolderName ? String(activeFolderName).split("/").pop() : "Proseka_Chart";
  downloadBlob(blob, `${prefix}.png`);
});

downloadSingleColBtn.addEventListener("click", async () => {
  if (isGenerating || !masterChartData.hasData) return;
  const rawText = (targetColInput.value || "").trim();
  const match = rawText.match(/\d+/);
  const colNumber = match ? parseInt(match[0], 10) : NaN;

  const { cropW, totalHeight } = masterChartData;
  const colMaxH = Math.max(400, parseInt(colHeightInput.value, 10) || 8000);
  const numCols = Math.max(1, Math.ceil(totalHeight / colMaxH));

  if (isNaN(colNumber) || colNumber < 1 || colNumber > numCols) {
    alert(`1 〜 ${numCols} の範囲で列番号を入力してください。`);
    return;
  }

  const c = colNumber - 1;
  const tmpColC = document.createElement("canvas");
  tmpColC.width = cropW;
  tmpColC.height = colMaxH;
  const tmpColCtx = tmpColC.getContext("2d");

  drawColumnFromMaster(tmpColCtx, masterChartData, c, colMaxH, 0, 0);
  const blob = await canvasToBlobSafe(tmpColC);
  tmpColC.width = 0;
  tmpColC.height = 0;

  const prefix = activeFolderName ? String(activeFolderName).split("/").pop() : "Proseka_Chart";
  const numStr = String(colNumber).padStart(2, "0");
  downloadBlob(blob, `${prefix}_列${numStr}.png`);
});

downloadResultZipBtn.addEventListener("click", async () => {
  if (isGenerating || !outputCanvas.width) return;
  downloadResultZipBtn.disabled = true;
  downloadResultZipBtn.textContent = "ZIPファイルを作成中...";
  try {
    const files = [];
    const prefix = activeFolderName ? String(activeFolderName).split("/").pop() : "Proseka_Chart";
    const fullPngBytes = await canvasToUint8Array(outputCanvas);
    if (fullPngBytes.length > 0) {
      files.push({ name: `00_${prefix}_全体一覧.png`, data: fullPngBytes });
    }

    if (masterChartData.hasData) {
      const { cropW, totalHeight } = masterChartData;
      const colMaxH = Math.max(400, parseInt(colHeightInput.value, 10) || 8000);
      const numCols = Math.max(1, Math.ceil(totalHeight / colMaxH));
      const tmpColC = document.createElement("canvas");
      tmpColC.width = cropW;
      tmpColC.height = colMaxH;
      const tmpColCtx = tmpColC.getContext("2d");

      for (let c = 0; c < numCols; c++) {
        drawColumnFromMaster(tmpColCtx, masterChartData, c, colMaxH, 0, 0);
        const colBytes = await canvasToUint8Array(tmpColC);
        if (colBytes.length > 0) {
          const num = String(c + 1).padStart(2, "0");
          files.push({ name: `${prefix}_分割列_${num}.png`, data: colBytes });
        }
      }
      tmpColC.width = 0;
      tmpColC.height = 0;
    }

    const zipBlob = createZipBlob(files);
    downloadBlob(zipBlob, `${prefix}_Images.zip`);
  } finally {
    downloadResultZipBtn.disabled = false;
    downloadResultZipBtn.textContent = "ZIPでまとめて保存";
  }
});

/* ================================================================
   mandelbrot · calje
   - main thread: state, scheduling, UI sync, palette LUT, drawing
   - worker pool: stripe-based iteration counting
   - progressive: low-res pass → full-res pass
================================================================ */

/* ---------- worker source (inlined) ---------- */
const WORKER_SRC = `
self.onmessage = (e) => {
  const job = e.data;
  const { id, gen, px0, py0, w, h, fullW, fullH, cx, cy, scale, maxIter } = job;
  // scale = complex units per pixel (vertical), assume aspect = fullW/fullH
  // map (px, py) in [0..fullW, 0..fullH] → complex point centered on (cx, cy)
  // we render only the stripe [py0..py0+h) × [px0..px0+w)
  const out = new Float32Array(w * h);
  const bailout = 256.0;
  const logBail2 = Math.log(bailout);

  // y range in complex plane spans fullH * scale (vertical)
  // x spans fullW * scale (= scale * aspect * fullH ... but easier as scaleX = scale)
  // since pixels are square, x-step = y-step = scale
  const x0 = cx - (fullW * 0.5) * scale;
  const y0 = cy - (fullH * 0.5) * scale;

  let idx = 0;
  for (let py = 0; py < h; py++) {
    const ci = y0 + (py0 + py) * scale;
    for (let px = 0; px < w; px++) {
      const cr = x0 + (px0 + px) * scale;

      // ---- cardioid + period-2 bulb shortcut (skip known in-set) ----
      const crm = cr - 0.25;
      const ci2_q = ci * ci;
      const q = crm * crm + ci2_q;
      if (q * (q + crm) <= 0.25 * ci2_q) { out[idx++] = -1.0; continue; }
      const xp = cr + 1.0;
      if (xp * xp + ci2_q <= 0.0625) { out[idx++] = -1.0; continue; }

      // ---- iterate ----
      let zr = 0.0, zi = 0.0;
      let zr2 = 0.0, zi2 = 0.0;
      let i = 0;
      // periodicity check (simple): cache an old point and compare
      let oldZr = 0, oldZi = 0; let period = 0;
      while (i < maxIter && (zr2 + zi2) <= bailout) {
        zi = 2.0 * zr * zi + ci;
        zr = zr2 - zi2 + cr;
        zr2 = zr * zr;
        zi2 = zi * zi;
        i++;
        // every 20 iters check if we re-visited a point (cycle → inside)
        if (zr === oldZr && zi === oldZi) { i = maxIter; break; }
        if (++period > 20) { oldZr = zr; oldZi = zi; period = 0; }
      }

      if (i >= maxIter) {
        out[idx++] = -1.0;
      } else {
        // smooth iteration count
        const log_zn = Math.log(zr2 + zi2) * 0.5;
        const nu = Math.log(log_zn / Math.LN2) / Math.LN2;
        out[idx++] = i + 1 - nu;
      }
    }
  }

  postMessage({ id, gen, px0, py0, w, h, out }, [out.buffer]);
};
`;

/* ---------- worker pool ---------- */
const WORKER_COUNT = Math.min(Math.max(navigator.hardwareConcurrency || 4, 2), 12);
const workers = [];
const workerBusy = [];
let nextJobId = 1;

function makeWorker() {
  const blob = new Blob([WORKER_SRC], { type: 'application/javascript' });
  const url = URL.createObjectURL(blob);
  const w = new Worker(url);
  w.onmessage = (e) => onWorkerReply(w, e.data);
  return w;
}
for (let i = 0; i < WORKER_COUNT; i++) { workers.push(makeWorker()); workerBusy.push(false); }

/* ---------- state ---------- */
const state = {
  cx: -0.5,
  cy: 0.0,
  zoom: 1.0,            // linear; e.g. 1 means default view spans ~3 units wide
  palette: 'warm',
  maxIter: 512,
  quality: 0,           // 0 = fast, 1 = high (toggled by 'h')
  renderW: 'auto',
  autoZoom: false,
  paletteShift: 0,      // animates over time for "shimmer"
};

const DEFAULT_VIEW = { cx: -0.5, cy: 0.0, zoom: 1.0 };
const VERTICAL_EXTENT = 2.4; // complex units high at zoom 1

/* ---------- DOM ---------- */
const $ = (id) => document.getElementById(id);
const canvas = $('canvas');
const stage = $('stage');
const ctx = canvas.getContext('2d', { alpha: false });
const sel = $('sel');
const cursorEl = $('cursor');
const zMant = $('zMant');
const zExp = $('zExp');
const zMode = $('zMode');
const iterNow = $('iterNow');
const iterMax = $('iterMax');
const renderTime = $('renderTime');
const paletteSel = $('palette');
const reInput = $('re');
const imInput = $('im');
const autoBtn = $('auto');
const presetSel = $('preset');
const copyBtn = $('copy');
const shotBtn = $('screenshot');
const cpusBox = $('cpus');
const renderWSel = $('renderW');
const recordBtn = $('record');
const resetBtn = $('reset');
const progress = $('progress');
const toast = $('toast');
const recflag = $('recflag');

cpusBox.textContent = WORKER_COUNT;

/* ---------- palettes ---------- */
const PALETTES = {
  warm: [
    [0.00, [  4,  10,  40]],
    [0.16, [ 15,  53, 110]],
    [0.42, [105, 209, 255]],
    [0.64, [255, 252, 210]],
    [0.86, [255, 138,  28]],
    [1.00, [ 50,   7,   0]],
  ],
  phosphor: [
    [0.00, [  0,   0,   0]],
    [0.25, [ 30,  90,  30]],
    [0.55, [124, 255, 107]],
    [0.78, [242, 240, 234]],
    [0.92, [ 30,  90,  30]],
    [1.00, [  0,   0,   0]],
  ],
  ivory: [
    [0.00, [  0,   0,   0]],
    [0.50, [242, 240, 234]],
    [1.00, [  0,   0,   0]],
  ],
  electric: [
    [0.00, [  5,   0,  16]],
    [0.25, [  0, 229, 255]],
    [0.50, [242, 240, 234]],
    [0.75, [255,  61,  90]],
    [1.00, [  5,   0,  16]],
  ],
  abyss: [
    [0.00, [  3,   5,  18]],
    [0.40, [ 25,  60, 140]],
    [0.65, [120, 180, 255]],
    [0.85, [242, 240, 234]],
    [1.00, [  3,   5,  18]],
  ],
  ember: [
    [0.00, [  8,   2,   0]],
    [0.30, [120,  20,   5]],
    [0.55, [255,  61,  20]],
    [0.78, [245, 197,  24]],
    [1.00, [  8,   2,   0]],
  ],
};

const LUT_SIZE = 2048;
let paletteLUT = new Uint8Array(LUT_SIZE * 4);
function buildLUT(name) {
  const stops = PALETTES[name] || PALETTES.warm;
  for (let i = 0; i < LUT_SIZE; i++) {
    const t = i / (LUT_SIZE - 1);
    // find segment
    let a = stops[0], b = stops[stops.length - 1];
    for (let k = 0; k < stops.length - 1; k++) {
      if (t >= stops[k][0] && t <= stops[k + 1][0]) { a = stops[k]; b = stops[k + 1]; break; }
    }
    const span = b[0] - a[0];
    const f = span > 0 ? (t - a[0]) / span : 0;
    // smooth interpolation
    const ff = f * f * (3 - 2 * f);
    const r = a[1][0] + (b[1][0] - a[1][0]) * ff;
    const g = a[1][1] + (b[1][1] - a[1][1]) * ff;
    const bb = a[1][2] + (b[1][2] - a[1][2]) * ff;
    paletteLUT[i * 4    ] = r | 0;
    paletteLUT[i * 4 + 1] = g | 0;
    paletteLUT[i * 4 + 2] = bb | 0;
    paletteLUT[i * 4 + 3] = 255;
  }
}
buildLUT(state.palette);

/* index a smooth-iter value into the LUT */
function lutIndex(smoothIter, maxIter) {
  if (smoothIter < 0) return -1;
  // log-based mapping gives nice band density across zoom levels
  const t = Math.log(smoothIter + 1) * 0.20 + state.paletteShift;
  let f = t - Math.floor(t); // wrap
  if (f < 0) f += 1;
  return (f * (LUT_SIZE - 1)) | 0;
}

/* ---------- presets ---------- */
const PRESETS = [
  ['seahorse valley',    -0.7453,                 0.1127,                 200],
  ['triple spiral',      -0.088,                  0.654,                  600],
  ['elephant valley',     0.282,                  0.011,                  120],
  ['scepter valley',     -1.36,                   0.005,                  600],
  ['julia island',       -1.768778833,           -0.001738996,            5e6],
  ['mini mandelbrot',    -1.7693831791955150,     0.0042368479187367,     5e9],
  ['needle',             -1.99996,                0.0,                    8000],
  ['lightning',          -0.74364388703,          0.13182590421,          3e7],
  ['fingers',             0.36024,                0.10031,                4000],
  ['feather',            -0.7436447860,           0.1318252536,           4e8],
];
for (const [name] of PRESETS) {
  const o = document.createElement('option');
  o.value = name;
  o.textContent = name;
  presetSel.appendChild(o);
}

/* ---------- core derived values ---------- */
function aspect() { return canvas.width / canvas.height; }
function scalePerPx() {
  // complex units per pixel (vertical)
  // VERTICAL_EXTENT at zoom = 1, divided by canvas height
  return (VERTICAL_EXTENT / state.zoom) / canvas.height;
}
function computeMaxIter() {
  const base = 256;
  const z = Math.max(1, state.zoom);
  const k = state.quality === 1 ? 2.4 : 1.0;
  const m = Math.round((base + 120 * Math.log10(z)) * k);
  return Math.max(64, Math.min(40000, m));
}

/* ---------- canvas sizing ---------- */
function targetBufferWidth() {
  const cssW = window.innerWidth;
  if (state.renderW === 'auto') {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    return Math.min(Math.round(cssW * dpr), 2160);
  }
  return parseInt(state.renderW, 10);
}
function resizeCanvas() {
  const cssW = window.innerWidth;
  const cssH = window.innerHeight;
  const bw = targetBufferWidth();
  const bh = Math.round(bw * (cssH / cssW));
  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width = bw;
    canvas.height = bh;
    return true;
  }
  return false;
}

/* ---------- render scheduler ---------- */
let curGen = 0;
let inflight = 0;
let totalJobs = 0;
let doneJobs = 0;
let renderStart = 0;
let pendingPass = null;     // 'low' | 'full' | null
const jobQueue = [];        // FIFO
let lastImage = null;       // ImageData of last completed full pass (for instant redraws)

function scheduleRender() {
  curGen++;
  jobQueue.length = 0;

  state.maxIter = computeMaxIter();
  iterMax.textContent = state.maxIter;

  renderStart = performance.now();
  doneJobs = 0; totalJobs = 0;
  pendingPass = 'low';
  enqueuePass('low');
  pumpQueue();
  setBusy(true);
}

function enqueuePass(pass) {
  // pass-specific buffer downscale
  const div = pass === 'low' ? 4 : 1;
  const fullW = Math.max(2, Math.round(canvas.width / div));
  const fullH = Math.max(2, Math.round(canvas.height / div));
  const sc = scalePerPx() * div; // larger pixel = larger scale
  // split into ~WORKER_COUNT * 3 stripes for better load balance on full pass
  const stripes = pass === 'low' ? WORKER_COUNT : WORKER_COUNT * 3;
  const stripeH = Math.max(2, Math.ceil(fullH / stripes));
  for (let y = 0; y < fullH; y += stripeH) {
    const h = Math.min(stripeH, fullH - y);
    jobQueue.push({
      gen: curGen,
      pass,
      px0: 0, py0: y,
      w: fullW, h,
      fullW, fullH,
      cx: state.cx, cy: state.cy,
      scale: sc,
      maxIter: state.maxIter,
    });
    totalJobs++;
  }
}

function pumpQueue() {
  for (let i = 0; i < WORKER_COUNT; i++) {
    if (!workerBusy[i] && jobQueue.length) {
      const job = jobQueue.shift();
      const id = nextJobId++;
      job.id = id;
      workerBusy[i] = true;
      inflight++;
      workers[i].postMessage(job);
    }
  }
}

function onWorkerReply(w, msg) {
  // free this worker
  const idx = workers.indexOf(w);
  workerBusy[idx] = false;
  inflight--;

  // stale?
  if (msg.gen !== curGen) {
    if (!jobQueue.length && inflight === 0) setBusy(false);
    pumpQueue();
    return;
  }

  // colorize stripe into canvas
  drawStripe(msg);
  doneJobs++;
  updateProgress();

  // pump more
  pumpQueue();

  // if both queue empty and no inflight, finish this pass
  if (jobQueue.length === 0 && inflight === 0) {
    if (pendingPass === 'low') {
      // start full-res pass
      pendingPass = 'full';
      doneJobs = 0; totalJobs = 0;
      enqueuePass('full');
      pumpQueue();
    } else {
      const dt = Math.round(performance.now() - renderStart);
      renderTime.textContent = dt + 'ms';
      iterNow.textContent = state.maxIter;
      setBusy(false);
      pendingPass = null;
    }
  }
}

function drawStripe(msg) {
  const { px0, py0, w, h, out, pass } = msg;
  // For low pass: scale up to canvas. For full pass: 1:1.
  const div = (totalJobs > 0 && pendingPass === 'low') ? 4 : 1;
  // determine div from msg dims vs canvas
  const realDiv = Math.round(canvas.width / msg.fullW);

  // build ImageData for stripe
  const img = ctx.createImageData(w, h);
  const data = img.data;
  const mi = state.maxIter;
  for (let p = 0; p < w * h; p++) {
    const v = out[p];
    if (v < 0) {
      // in-set: pure black with a hint of warmth via palette[0]?
      data[p * 4    ] = 0;
      data[p * 4 + 1] = 0;
      data[p * 4 + 2] = 0;
      data[p * 4 + 3] = 255;
    } else {
      const li = lutIndex(v, mi);
      data[p * 4    ] = paletteLUT[li * 4];
      data[p * 4 + 1] = paletteLUT[li * 4 + 1];
      data[p * 4 + 2] = paletteLUT[li * 4 + 2];
      data[p * 4 + 3] = 255;
    }
  }

  if (realDiv === 1) {
    canvas.classList.add('smooth');
    ctx.putImageData(img, px0, py0);
  } else {
    canvas.classList.remove('smooth');
    // draw the stripe scaled up
    const off = document.createElement('canvas');
    off.width = w; off.height = h;
    off.getContext('2d').putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(off, 0, 0, w, h, px0 * realDiv, py0 * realDiv, w * realDiv, h * realDiv);
  }
}

function updateProgress() {
  const pct = totalJobs ? (doneJobs / totalJobs) * 100 : 0;
  progress.style.setProperty('--p', pct.toFixed(1) + '%');
}

function setBusy(b) {
  progress.classList.toggle('busy', b);
  if (!b) progress.style.setProperty('--p', '100%');
}

/* ---------- ui sync ---------- */
function syncUIFromState() {
  reInput.value = formatCoord(state.cx);
  imInput.value = formatCoord(state.cy);
  const [m, e] = decomposeZoom(state.zoom);
  zMant.value = m.toFixed(2);
  zExp.value = e;
  iterMax.textContent = state.maxIter;
  paletteSel.value = state.palette;
  renderWSel.value = state.renderW;
  zMode.textContent = state.zoom === 1 ? 'origin' : (state.zoom > 1e6 ? 'deep' : 'direct');
}
function decomposeZoom(z) {
  if (z <= 0 || !isFinite(z)) return [1, 0];
  const e = Math.floor(Math.log10(z));
  const m = z / Math.pow(10, e);
  return [m, e];
}
function formatCoord(v) {
  // adaptive precision based on zoom
  const digits = Math.min(17, Math.max(4, 4 + Math.ceil(Math.log10(Math.max(1, state.zoom)))));
  return v.toFixed(digits).replace(/0+$/, '').replace(/\.$/, '.0');
}

/* ---------- event: mouse / zoom ---------- */
function pageToComplex(px, py) {
  // px, py in CSS pixels → complex coords
  const rect = stage.getBoundingClientRect();
  const u = (px - rect.left) / rect.width;       // 0..1
  const v = (py - rect.top) / rect.height;       // 0..1
  const halfW = (VERTICAL_EXTENT / state.zoom) * (rect.width / rect.height) * 0.5;
  const halfH = (VERTICAL_EXTENT / state.zoom) * 0.5;
  return {
    re: state.cx - halfW + u * halfW * 2,
    im: state.cy - halfH + v * halfH * 2,
  };
}

const ZOOM_STEP = 2.5;

function zoomAt(px, py, factor) {
  const c = pageToComplex(px, py);
  // move toward target a little — feels nicer than pure recenter
  state.cx = c.re;
  state.cy = c.im;
  state.zoom *= factor;
  syncUIFromState();
  scheduleRender();
}

stage.addEventListener('click', (e) => {
  if (e.target !== canvas && e.target !== sel && e.target !== stage) return;
  const f = e.shiftKey ? (1 / ZOOM_STEP) : ZOOM_STEP;
  zoomAt(e.clientX, e.clientY, f);
});

/* selection rect preview */
let lastMouseX = 0, lastMouseY = 0;
stage.addEventListener('mousemove', (e) => {
  lastMouseX = e.clientX;
  lastMouseY = e.clientY;
  const rect = stage.getBoundingClientRect();
  const w = rect.width  / ZOOM_STEP;
  const h = rect.height / ZOOM_STEP;
  sel.style.left = (e.clientX - rect.left - w / 2) + 'px';
  sel.style.top  = (e.clientY - rect.top  - h / 2) + 'px';
  sel.style.width  = w + 'px';
  sel.style.height = h + 'px';
  sel.classList.remove('hidden');

  cursorEl.style.left = e.clientX + 'px';
  cursorEl.style.top  = e.clientY + 'px';
  cursorEl.classList.remove('hidden');
});
stage.addEventListener('mouseleave', () => {
  sel.classList.add('hidden');
  cursorEl.classList.add('hidden');
});

/* wheel zoom */
stage.addEventListener('wheel', (e) => {
  e.preventDefault();
  const f = e.deltaY < 0 ? 1.25 : 1 / 1.25;
  zoomAt(e.clientX, e.clientY, f);
}, { passive: false });

/* ---------- keyboard hotkeys ---------- */
window.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea')) return;

  // ctrl/cmd + c → copy view URL ; ctrl/cmd + shift + c → save PNG screenshot
  if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C')) {
    // only intercept when there's no active text selection
    const sel = window.getSelection();
    if (sel && sel.toString().length > 0) return;
    e.preventDefault();
    if (e.shiftKey) shotBtn.click();
    else            copyBtn.click();
    return;
  }

  if (e.code === 'Space') {
    e.preventDefault();
    const f = e.shiftKey ? (1 / ZOOM_STEP) : ZOOM_STEP;
    // zoom toward last mouse pos if known, else center
    if (lastMouseX || lastMouseY) zoomAt(lastMouseX, lastMouseY, f);
    else { state.zoom *= f; syncUIFromState(); scheduleRender(); }
  } else if (e.key === 'h' || e.key === 'H') {
    state.quality = state.quality === 1 ? 0 : 1;
    toastMsg('quality: ' + (state.quality === 1 ? 'high' : 'fast'));
    scheduleRender();
  } else if (e.key === 'r' || e.key === 'R') {
    resetView();
  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    const step = (VERTICAL_EXTENT / state.zoom) * 0.1;
    if (e.key === 'ArrowLeft')  state.cx -= step;
    if (e.key === 'ArrowRight') state.cx += step;
    if (e.key === 'ArrowUp')    state.cy -= step;
    if (e.key === 'ArrowDown')  state.cy += step;
    syncUIFromState();
    scheduleRender();
  } else if (e.key === 'm' || e.key === 'M') {
    document.body.classList.toggle('chrome-hidden');
    toastMsg(document.body.classList.contains('chrome-hidden') ? 'menu hidden — m to show' : 'menu shown');
  } else if (e.key === 'p' || e.key === 'P') {
    // cycle palettes
    const names = Object.keys(PALETTES);
    const i = (names.indexOf(state.palette) + 1) % names.length;
    state.palette = names[i];
    buildLUT(state.palette);
    paletteSel.value = state.palette;
    redrawFromCache();
    toastMsg('palette: ' + state.palette);
  }
});

/* ---------- ui handlers ---------- */
paletteSel.addEventListener('change', () => {
  state.palette = paletteSel.value;
  buildLUT(state.palette);
  redrawFromCache();
});
renderWSel.addEventListener('change', () => {
  state.renderW = renderWSel.value;
  resizeCanvas();
  scheduleRender();
});

reInput.addEventListener('change', () => {
  const v = parseFloat(reInput.value);
  if (!isNaN(v)) { state.cx = v; scheduleRender(); }
  syncUIFromState();
});
imInput.addEventListener('change', () => {
  const v = parseFloat(imInput.value);
  if (!isNaN(v)) { state.cy = v; scheduleRender(); }
  syncUIFromState();
});
function applyZoomInputs() {
  const m = parseFloat(zMant.value);
  const e = parseInt(zExp.value, 10);
  if (!isNaN(m) && !isNaN(e)) {
    state.zoom = m * Math.pow(10, e);
    syncUIFromState();
    scheduleRender();
  }
}
zMant.addEventListener('change', applyZoomInputs);
zExp.addEventListener('change', applyZoomInputs);

presetSel.addEventListener('change', () => {
  const p = PRESETS.find(x => x[0] === presetSel.value);
  if (!p) return;
  state.cx = p[1]; state.cy = p[2]; state.zoom = p[3];
  syncUIFromState();
  scheduleRender();
  toastMsg('→ ' + p[0]);
});

copyBtn.addEventListener('click', async () => {
  const params = new URLSearchParams({
    re: state.cx.toString(),
    im: state.cy.toString(),
    z:  state.zoom.toString(),
    p:  state.palette,
    q:  state.quality,
  });
  const url = location.origin + location.pathname + '#' + params.toString();
  try {
    await navigator.clipboard.writeText(url);
    toastMsg('view url copied');
  } catch (err) {
    toastMsg('copy failed');
  }
});

shotBtn.addEventListener('click', () => {
  canvas.toBlob((blob) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `mandelbrot_${state.cx.toFixed(6)}_${state.cy.toFixed(6)}_z${state.zoom.toExponential(2)}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toastMsg('screenshot saved');
  }, 'image/png');
});

resetBtn.addEventListener('click', resetView);
function resetView() {
  state.cx = DEFAULT_VIEW.cx;
  state.cy = DEFAULT_VIEW.cy;
  state.zoom = DEFAULT_VIEW.zoom;
  state.autoZoom = false;
  autoBtn.classList.remove('armed');
  autoBtn.textContent = '▶ auto';
  syncUIFromState();
  scheduleRender();
}

/* ---------- auto-zoom ---------- */
let autoRAF = 0;
autoBtn.addEventListener('click', () => {
  state.autoZoom = !state.autoZoom;
  autoBtn.classList.toggle('armed', state.autoZoom);
  autoBtn.textContent = state.autoZoom ? '■ stop' : '▶ auto';
  if (state.autoZoom) autoLoop();
});
let autoLast = 0;
function autoLoop(t) {
  if (!state.autoZoom) return;
  if (!autoLast) autoLast = t || performance.now();
  const now = t || performance.now();
  const dt = Math.min(0.05, (now - autoLast) / 1000);
  autoLast = now;
  // only schedule a render when no inflight, otherwise piggyback
  if (inflight === 0 && jobQueue.length === 0) {
    state.zoom *= Math.pow(1.5, dt); // ~50% per second
    syncUIFromState();
    scheduleRender();
  }
  autoRAF = requestAnimationFrame(autoLoop);
}

/* ---------- recording ---------- */
let mediaRecorder = null;
let recChunks = [];
recordBtn.addEventListener('click', () => {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
    return;
  }
  const stream = canvas.captureStream(30);
  recChunks = [];
  try {
    mediaRecorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp9', videoBitsPerSecond: 8_000_000 });
  } catch (err) {
    try { mediaRecorder = new MediaRecorder(stream, { mimeType: 'video/webm' }); }
    catch (e2) { toastMsg('recording not supported'); return; }
  }
  mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size) recChunks.push(e.data); };
  mediaRecorder.onstop = () => {
    const blob = new Blob(recChunks, { type: 'video/webm' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `mandelbrot_${Date.now()}.webm`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    recflag.classList.remove('on');
    recordBtn.classList.remove('armed');
    recordBtn.textContent = 'record';
    toastMsg('recording saved');
  };
  mediaRecorder.start(250);
  recflag.classList.add('on');
  recordBtn.classList.add('armed');
  recordBtn.textContent = '■ stop';
  toastMsg('recording…');
});

/* ---------- toast ---------- */
let toastTimer = 0;
function toastMsg(msg) {
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 1400);
}

/* ---------- redraw from cache (palette change) ---------- */
function redrawFromCache() {
  // simple: just re-render. (Caching iters would need a per-pixel store; not worth the memory.)
  scheduleRender();
}

/* ---------- resize ---------- */
let resizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (resizeCanvas()) scheduleRender();
  }, 120);
});

/* ---------- hash load ---------- */
function loadFromHash() {
  if (!location.hash) return;
  const params = new URLSearchParams(location.hash.slice(1));
  const re = parseFloat(params.get('re'));
  const im = parseFloat(params.get('im'));
  const z = parseFloat(params.get('z'));
  if (!isNaN(re)) state.cx = re;
  if (!isNaN(im)) state.cy = im;
  if (!isNaN(z) && z > 0) state.zoom = z;
  const p = params.get('p'); if (p && PALETTES[p]) state.palette = p;
  const q = params.get('q'); if (q === '1') state.quality = 1;
  buildLUT(state.palette);
}

/* ---------- init ---------- */
loadFromHash();
resizeCanvas();
syncUIFromState();
scheduleRender();

/* ---------- handle toggle ---------- */
document.getElementById('handle').addEventListener('click', () => {
  document.body.classList.toggle('chrome-hidden');
});

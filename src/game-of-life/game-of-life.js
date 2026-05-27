/* ================================================================
   Conway's Game of Life — interactive viewer
   ================================================================ */

const CELL = 10;            // pixel size of each cell
const $ = (id) => document.getElementById(id);

const canvas = $('grid');
const ctx = canvas.getContext('2d');
const stage = $('stage');
const toast = $('toast');
const menu = $('menu');
const handle = $('handle');

let cols = 0, rows = 0;
let grid    = new Uint8Array(0);
let next    = new Uint8Array(0);
let age     = new Uint16Array(0);
let generation = 0;
let aliveCount = 0;
let aliveMax = 0;          // peak alive count since last pattern (re)load or clear

let running = false;
let speed   = 12;                  // generations per second
let lastTick = 0;
let currentPatternId = 'soup';

// Wall-clock timer: accumulates running-state time only. Frozen on pause,
// resumed on play, zeroed when a pattern is (re)loaded or the grid is cleared.
let timeMs = 0;            // sum of completed play-segments
let runStartTs = 0;        // performance.now() at the start of the current run-segment (0 when paused)

// Auto-pause when the grid enters a loop — current hash matches any
// of the previous LOOP_WINDOW hashes. Catches static blobs (period 1),
// blinker/toad (period 2), and any oscillator up to period LOOP_WINDOW.
// LEAVES gliders / spaceships alone — their grid translates each step,
// so the hash never repeats. Glider guns keep adding cells, so hash
// keeps changing. Pure chaos: hashes wander, no loop, keeps running.
const LOOP_WINDOW = 32;
let gridHashes = [];       // ring buffer of recent post-step grid hashes

/* ---------------- canvas sizing ---------------- */
function resize() {
  const cssW = window.innerWidth;
  const cssH = window.innerHeight;
  const dpr  = Math.min(window.devicePixelRatio || 1, 2);
  const newCols = Math.floor(cssW / CELL);
  const newRows = Math.floor(cssH / CELL);
  canvas.width  = newCols * CELL * dpr;
  canvas.height = newRows * CELL * dpr;
  canvas.style.width  = newCols * CELL + 'px';
  canvas.style.height = newRows * CELL + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // re-allocate while preserving overlap
  const old = grid, oldCols = cols, oldRows = rows;
  cols = newCols; rows = newRows;
  grid = new Uint8Array(cols * rows);
  next = new Uint8Array(cols * rows);
  age  = new Uint16Array(cols * rows);
  // copy overlap
  if (old.length && oldCols && oldRows) {
    const cc = Math.min(cols, oldCols);
    const rr = Math.min(rows, oldRows);
    for (let y = 0; y < rr; y++) for (let x = 0; x < cc; x++) {
      grid[y * cols + x] = old[y * oldCols + x];
    }
  }
  recountAlive();
  draw();
}
window.addEventListener('resize', resize);

/* ---------------- core step ---------------- */
function step() {
  let total = 0;
  // Position-weighted XOR of alive-cell indices, folded into the main loop.
  // Knuth's 0x9E3779B9 multiplier scrambles indices; XORing alive-cell
  // contributions yields an order-independent, position-sensitive hash.
  let hash = 0;
  for (let y = 0; y < rows; y++) {
    const yu = (y - 1 + rows) % rows;
    const yd = (y + 1) % rows;
    for (let x = 0; x < cols; x++) {
      const xl = (x - 1 + cols) % cols;
      const xr = (x + 1) % cols;
      const idx = y * cols + x;
      const n = grid[yu*cols+xl] + grid[yu*cols+x] + grid[yu*cols+xr]
              + grid[y*cols+xl]                    + grid[y*cols+xr]
              + grid[yd*cols+xl] + grid[yd*cols+x] + grid[yd*cols+xr];
      const a = grid[idx];
      const nv = a ? (n === 2 || n === 3 ? 1 : 0) : (n === 3 ? 1 : 0);
      next[idx] = nv;
      if (nv) {
        total++;
        age[idx] = Math.min(420, age[idx] + 1);
        hash ^= ((idx + 1) * 0x9E3779B9) | 0;
      } else {
        age[idx] = 0;
      }
    }
  }
  // swap
  const tmp = grid; grid = next; next = tmp;
  generation++;
  aliveCount = total;
  if (aliveCount > aliveMax) aliveMax = aliveCount;

  // Loop detection: does the new hash match any of the last LOOP_WINDOW?
  // Period = how far back the match sits in the ring buffer (1 = static).
  // Guarded by `running` so manual step-button presses don't trip it.
  if (running) {
    for (let k = gridHashes.length - 1; k >= 0; k--) {
      if (gridHashes[k] === hash) {
        const period = gridHashes.length - k;
        setRunning(false);
        const label = aliveCount === 0 ? 'extinct'
                    : period === 1     ? 'static'
                                       : `period ${period}`;
        toastMsg(`${label} — paused`);
        return;
      }
    }
  }
  gridHashes.push(hash);
  if (gridHashes.length > LOOP_WINDOW) gridHashes.shift();
}

function recountAlive() {
  let t = 0;
  for (let i = 0; i < grid.length; i++) if (grid[i]) t++;
  aliveCount = t;
  if (aliveCount > aliveMax) aliveMax = aliveCount;
}

/* ---------------- drawing ---------------- */
function draw() {
  // dark background with subtle gradient
  ctx.fillStyle = '#070907';
  ctx.fillRect(0, 0, cols * CELL, rows * CELL);

  // very subtle grid lines
  ctx.strokeStyle = 'rgba(124,255,107,0.05)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x <= cols; x++) { ctx.moveTo(x*CELL + 0.5, 0); ctx.lineTo(x*CELL + 0.5, rows*CELL); }
  for (let y = 0; y <= rows; y++) { ctx.moveTo(0, y*CELL + 0.5); ctx.lineTo(cols*CELL, y*CELL + 0.5); }
  ctx.stroke();

  // cells
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (!grid[y*cols+x]) continue;
      const a = age[y*cols+x];
      const t = Math.min(1, a / 60);            // 0..1 maturity
      // young cells: bright phosphor; aged cells: cool teal
      const r = (124 * (1-t) + 60 * t) | 0;
      const g = (255 * (1-t) + 200 * t) | 0;
      const b = (107 * (1-t) + 180 * t) | 0;
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(x*CELL + 1, y*CELL + 1, CELL - 2, CELL - 2);
    }
  }
}

/* ---------------- patterns ---------------- */
function clearGrid() {
  grid.fill(0); next.fill(0); age.fill(0);
  generation = 0; aliveCount = 0; aliveMax = 0;
  gridHashes = [];
  resetTimer();
  updateStats();
}

function fillRandom(density) {
  generation = 0;
  age.fill(0);
  for (let i = 0; i < grid.length; i++) {
    grid[i] = Math.random() < density ? 1 : 0;
  }
  recountAlive();
}

function placePattern(cells, ox, oy) {
  for (let y = 0; y < cells.length; y++) {
    const row = cells[y];
    for (let x = 0; x < row.length; x++) {
      if (row[x] !== '.' && row[x] !== ' ') {
        const xx = (ox + x + cols) % cols;
        const yy = (oy + y + rows) % rows;
        grid[yy * cols + xx] = 1;
      }
    }
  }
}

function loadPattern(id) {
  const p = PATTERNS.find(x => x.id === id) || PATTERNS[0];
  currentPatternId = p.id;
  $('ddCurName').textContent = p.name;
  document.title = p.name + ' · life';

  clearGrid();
  if (p.kind === 'fill') {
    fillRandom(p.density);
  } else if (p.compose) {
    for (const c of p.compose) placePattern(c.cells, c.x, c.y);
    recountAlive();
  } else if (p.cells) {
    const h = p.cells.length;
    const w = p.cells.reduce((a, r) => Math.max(a, r.length), 0);
    const ox = ((cols - w) / 2) | 0;
    const oy = ((rows - h) / 2) | 0;
    placePattern(p.cells, ox, oy);
    recountAlive();
  }
  generation = 0;
  resetTimer();
  draw();
  updateStats();
}

/* ---------------- transport ---------------- */
function setRunning(r) {
  // Track timer transitions BEFORE flipping `running` so resetTimer reads
  // the previous state correctly if it gets called from a downstream handler.
  if (r && !running) {
    runStartTs = performance.now();
    // Fresh play-segment: drop stale hashes so loop detection doesn't
    // fire instantly after a pause→play round trip (and so the user
    // can resume an already-static pattern for inspection).
    gridHashes = [];
  } else if (!r && running) {
    timeMs += performance.now() - runStartTs;
    runStartTs = 0;
  }
  running = r;
  $('playLbl').textContent = running ? 'pause' : 'play';
  $('playIcon').innerHTML = running
    ? '<rect x="1.5" y="1" width="2" height="8"/><rect x="6.5" y="1" width="2" height="8"/>'
    : '<path d="M1.5 1 8.5 5 1.5 9z"/>';
  $('play').classList.toggle('paused', !running);
  $('state').textContent = running ? 'running' : 'paused';
  $('liveDot').classList.toggle('paused', !running);
  if (running) {
    lastTick = performance.now();
    requestAnimationFrame(loop);
  }
  // Refresh stats so the timer text freezes on pause (and re-renders on resume).
  updateStats();
}

function currentElapsedMs() {
  return timeMs + (running && runStartTs ? performance.now() - runStartTs : 0);
}

function resetTimer() {
  timeMs = 0;
  // If a reset fires mid-run (e.g. dropdown swap while playing), restart the
  // current segment so the clock keeps ticking from zero instead of stalling.
  runStartTs = running ? performance.now() : 0;
}

function fmtTime(ms) {
  const s = Math.floor(ms / 1000);
  const ss = String(s % 60).padStart(2, '0');
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}:${ss}`;
  const mm = String(m % 60).padStart(2, '0');
  const h = Math.floor(m / 60);
  return `${h}:${mm}:${ss}`;
}

function loop(t) {
  if (!running) return;
  const interval = 1000 / speed;
  while (t - lastTick >= interval) {
    step();
    lastTick += interval;
  }
  draw();
  updateStats();
  requestAnimationFrame(loop);
}

function updateStats() {
  $('gen').textContent      = generation;
  $('alive').textContent    = aliveCount;
  $('aliveMax').textContent = aliveMax;
  $('elapsed').textContent  = fmtTime(currentElapsedMs());
}

/* ---------------- dropdown ---------------- */
const dd = $('dropdown'), ddBtn = $('ddBtn'), ddMenu = $('ddMenu');
PATTERNS.forEach((p) => {
  const a = document.createElement('button');
  a.type = 'button';
  a.className = 'dropdown__item';
  a.innerHTML = `
    <span class="meta">·</span>
    <span>${p.name}</span>
    <span class="meta">${p.kind === 'fill' ? 'fill' : (p.compose ? 'compose' : 'place')}</span>
  `;
  a.addEventListener('click', () => {
    [...ddMenu.children].forEach(c => c.classList.remove('active'));
    a.classList.add('active');
    dd.classList.remove('open');
    loadPattern(p.id);
    toastMsg('→ ' + p.name);
  });
  ddMenu.appendChild(a);
});
ddBtn.addEventListener('click', (e) => { e.stopPropagation(); dd.classList.toggle('open'); });
document.addEventListener('click', () => dd.classList.remove('open'));

/* ---------------- ui events ---------------- */
$('play').addEventListener('click', () => setRunning(!running));
$('step').addEventListener('click', () => { setRunning(false); step(); draw(); updateStats(); });
$('reset').addEventListener('click', () => { setRunning(false); loadPattern(currentPatternId); });
$('clear').addEventListener('click', () => { setRunning(false); clearGrid(); draw(); });
$('speed').addEventListener('input', (e) => {
  speed = parseInt(e.target.value, 10);
  $('speedVal').textContent = speed;
});

handle.addEventListener('click', () => menu.classList.toggle('hidden'));

/* ---------------- draw with mouse ---------------- */
let drawing = false;
let drawValue = 1;
let lastCell = null;

function cellFromEvent(e) {
  const rect = canvas.getBoundingClientRect();
  const x = Math.floor((e.clientX - rect.left) / CELL);
  const y = Math.floor((e.clientY - rect.top)  / CELL);
  if (x < 0 || x >= cols || y < 0 || y >= rows) return null;
  return [x, y];
}

stage.addEventListener('mousedown', (e) => {
  if (e.target !== canvas && e.target !== stage) return;
  const c = cellFromEvent(e);
  if (!c) return;
  drawing = true;
  drawValue = grid[c[1]*cols + c[0]] ? 0 : 1;
  grid[c[1]*cols + c[0]] = drawValue;
  if (drawValue) age[c[1]*cols + c[0]] = 1; else age[c[1]*cols + c[0]] = 0;
  lastCell = c;
  recountAlive();
  draw();
  updateStats();
});
stage.addEventListener('mousemove', (e) => {
  if (!drawing) return;
  const c = cellFromEvent(e);
  if (!c) return;
  if (lastCell && lastCell[0] === c[0] && lastCell[1] === c[1]) return;
  grid[c[1]*cols + c[0]] = drawValue;
  if (drawValue) age[c[1]*cols + c[0]] = 1; else age[c[1]*cols + c[0]] = 0;
  lastCell = c;
  recountAlive();
  draw();
  updateStats();
});
window.addEventListener('mouseup', () => { drawing = false; lastCell = null; });

/* ---------------- hotkeys ---------------- */
window.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea')) return;
  if (e.code === 'Space') { e.preventDefault(); setRunning(!running); }
  else if (e.key === 'n' || e.key === 'N') { setRunning(false); step(); draw(); updateStats(); }
  else if (e.key === 'r' || e.key === 'R') { setRunning(false); loadPattern(currentPatternId); }
  else if (e.key === 'c' || e.key === 'C') {
    // not Ctrl+C — that's still copy.
    if (e.ctrlKey || e.metaKey) return;
    setRunning(false); clearGrid(); draw();
  }
  else if (e.key === 'm' || e.key === 'M') { menu.classList.toggle('hidden'); }
  else if (e.key === 'Escape') { location.href = '../../index.html'; }
  else if (e.key === '[') { speed = Math.max(1, speed - 2); $('speed').value = speed; $('speedVal').textContent = speed; toastMsg('speed ' + speed); }
  else if (e.key === ']') { speed = Math.min(60, speed + 2); $('speed').value = speed; $('speedVal').textContent = speed; toastMsg('speed ' + speed); }
});

/* ---------------- toast ---------------- */
let toastTimer = 0;
function toastMsg(t) {
  toast.textContent = t;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 1100);
}

/* ---------------- init ---------------- */
resize();
loadPattern('gun');               // start with the iconic glider gun
// mark default selection in dropdown
[...ddMenu.children].forEach((c, i) => c.classList.toggle('active', PATTERNS[i].id === currentPatternId));
setRunning(true);

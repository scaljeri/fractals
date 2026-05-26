/* ================================================================
   Fractal.html — generic viewer logic
   - reads ?type=xxx
   - shows fullscreen image
   - toggleable menu
   - palette swap via CSS filters
   ================================================================ */

const params = new URLSearchParams(location.search);
const type = params.get('type') || 'julia';
const idx  = FRACTALS.findIndex(f => f.id === type);
const f    = FRACTALS[idx >= 0 ? idx : 0];

/* -------- elements -------- */
const $   = (id) => document.getElementById(id);
const img = $('img');
const menu= $('menu');
const handle = $('handle');
const toast= $('toast');

/* -------- populate header -------- */
$('title').textContent = f.name;
$('desc').textContent  = f.desc;
$('formula').textContent = f.formula;
$('crumbIdx').textContent = String((idx >= 0 ? idx : 0) + 1).padStart(2, '0');
img.src = f.image;
img.alt = f.name;
document.title = f.name + ' · viewer';

if (f.live && f.href) {
  const live = $('liveBtn');
  live.style.display = 'inline-flex';
  live.href = f.href;
}

/* -------- explore dropdown (place picker) -------- */
const dd = $('dropdown');
const ddBtn = $('ddBtn');
const ddMenu = $('ddMenu');
const ddCurName = $('ddCurName');
ddCurName.textContent = f.name;
FRACTALS.forEach((other, i) => {
  const el = document.createElement('a');
  el.className = 'dropdown__item' + (other.id === f.id ? ' active' : '');
  el.href = other.href || `Fractal.html?type=${other.id}`;
  el.innerHTML = `
    <span class="meta">${String(i+1).padStart(2,'0')}</span>
    <span>${other.name}</span>
    <span class="meta">${other.live ? 'live' : 'still'}</span>
  `;
  ddMenu.appendChild(el);
});
ddBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  dd.classList.toggle('open');
});
document.addEventListener('click', () => dd.classList.remove('open'));

/* -------- palette swatches -------- */
const swatches = $('swatches');
const paletteRow = $('paletteRow');
let palIdx = 0;
function applyPalette(i) {
  palIdx = ((i % FILTER_PALETTES.length) + FILTER_PALETTES.length) % FILTER_PALETTES.length;
  const p = FILTER_PALETTES[palIdx];
  img.style.filter = p.filter;
  [...swatches.children].forEach((s, k) => s.classList.toggle('active', k === palIdx));
  // persist
  try { localStorage.setItem('fractal-palette-' + f.id, p.id); } catch {}
}
FILTER_PALETTES.forEach((p, i) => {
  const b = document.createElement('button');
  b.className = 'swatch';
  b.title = p.name;
  b.style.background = p.swatch;
  b.addEventListener('click', () => { applyPalette(i); toastMsg('palette: ' + p.name); });
  swatches.appendChild(b);
});
// restore saved palette
let restored = 0;
try {
  const saved = localStorage.getItem('fractal-palette-' + f.id);
  if (saved) restored = Math.max(0, FILTER_PALETTES.findIndex(x => x.id === saved));
} catch {}
applyPalette(restored);

/* -------- menu toggle -------- */
let menuOpen = true;
function setMenu(open) {
  menuOpen = open;
  menu.classList.toggle('hidden', !open);
}
handle.addEventListener('click', () => setMenu(!menuOpen));

/* -------- copy / screenshot -------- */
$('copyBtn').addEventListener('click', copyLink);
$('shotBtn').addEventListener('click', savePng);

async function copyLink() {
  const url = location.origin + location.pathname.replace(/[^/]*$/, '') + 'Fractal.html?type=' + f.id + '&pal=' + FILTER_PALETTES[palIdx].id;
  try {
    await navigator.clipboard.writeText(url);
    toastMsg('link copied');
  } catch (err) { toastMsg('copy failed'); }
}

async function savePng() {
  // composite the image + current filter into a downloadable PNG
  try {
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext('2d');
    ctx.filter = FILTER_PALETTES[palIdx].filter || 'none';
    ctx.drawImage(img, 0, 0);
    c.toBlob((blob) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${f.id}_${FILTER_PALETTES[palIdx].id}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      toastMsg('saved ' + a.download);
    }, 'image/png');
  } catch (err) {
    toastMsg('save failed');
  }
}

/* -------- hotkeys -------- */
window.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea')) return;
  // ctrl/cmd + c / shift
  if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C')) {
    const sel = window.getSelection();
    if (sel && sel.toString().length > 0) return;
    e.preventDefault();
    if (e.shiftKey) savePng();
    else            copyLink();
    return;
  }
  if (e.key === 'm' || e.key === 'M') { setMenu(!menuOpen); }
  else if (e.key === 'Escape')         { location.href = 'Home.html'; }
  else if (e.key === 'p' || e.key === 'P') { applyPalette(palIdx + 1); toastMsg('palette: ' + FILTER_PALETTES[palIdx].name); }
  else if (e.key === 'ArrowLeft')      { goNeighbor(-1); }
  else if (e.key === 'ArrowRight')     { goNeighbor(+1); }
});

function goNeighbor(delta) {
  const here = FRACTALS.findIndex(x => x.id === f.id);
  const next = (here + delta + FRACTALS.length) % FRACTALS.length;
  const n = FRACTALS[next];
  location.href = n.href || `Fractal.html?type=${n.id}`;
}

/* -------- toast -------- */
let toastTimer = 0;
function toastMsg(t) {
  toast.textContent = t;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 1200);
}

/* -------- read ?pal=xxx from URL -------- */
const palParam = params.get('pal');
if (palParam) {
  const i = FILTER_PALETTES.findIndex(p => p.id === palParam);
  if (i >= 0) applyPalette(i);
}

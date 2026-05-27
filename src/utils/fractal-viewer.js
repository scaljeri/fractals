/* Generic viewer logic shared by src/<fractal>/index.html for the 9
   non-deep-zoom fractals. Picks the fractal id from (in order):
   (1) ?type= URL param, (2) <body data-fractal-id="...">, (3) 'julia' default.
   Picks the right renderer module and wires up the chrome
   (palette swatches, hotkeys). */

(async function () {
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const type = params.get('type')
    || document.body.dataset.fractalId
    || 'julia';

  // Exclude mandelbrot + game_of_life from the generic viewer; they have
  // dedicated pages with very different chrome.
  const ROUTED = FRACTALS.filter(f => f.id !== 'mandelbrot' && f.id !== 'game_of_life');
  const idx = ROUTED.findIndex(f => f.id === type);
  const f = ROUTED[idx >= 0 ? idx : 0];

  if (!f) {
    location.href = '../../index.html';
    return;
  }

  const canvas = $('canvas');
  const stage  = $('stage');
  const menu   = $('menu');
  const handle = $('handle');
  const toast  = $('toast');
  const progress = $('progress');
  const swatchesEl = $('swatches');
  const renderTimeEl = $('renderTime');
  const iterMaxEl = $('iterMax');
  const cpusEl = $('cpus');

  /* ---------- header ---------- */
  $('title').textContent = f.name;
  $('desc').textContent = f.desc;
  $('formula').textContent = f.formula || '';
  $('crumbIdx').textContent = String((FRACTALS.findIndex(x => x.id === f.id) + 1) || 1).padStart(2, '0');
  document.title = f.name + ' · viewer';

  // Brand-bar (top-left): fractal name + info button. Click → fractal-info modal.
  const brandNameEl = $('brand-fractal-name');
  if (brandNameEl) brandNameEl.textContent = f.name;
  const infoBtn = $('info-btn');
  if (infoBtn && typeof window.showFractalInfo === 'function') {
    infoBtn.addEventListener('click', () => window.showFractalInfo(f.id));
  }

  /* ---------- canvas sizing ---------- */
  function fitCanvas() {
    const { changed } = CanvasUtils.sizeCanvasToViewport(canvas);
    return changed;
  }
  fitCanvas();

  /* ---------- palette ---------- */
  const PAL_IDS = ['phosphor', 'warm', 'ember', 'abyss', 'ivory', 'spectrum', 'aurora'];
  // Resolution order: ?palette= URL param → localStorage → fractal's
  // defaultPalette → first in PAL_IDS.
  let palIdx = 0;
  const palParam = params.get('palette');
  let savedPal = null;
  try { savedPal = localStorage.getItem('fractal-palette-' + f.id); } catch {}
  const palPick = (palParam && PAL_IDS.includes(palParam)) ? palParam
               : (savedPal  && PAL_IDS.includes(savedPal))  ? savedPal
               : (f.defaultPalette && PAL_IDS.includes(f.defaultPalette)) ? f.defaultPalette
               : PAL_IDS[0];
  palIdx = PAL_IDS.indexOf(palPick);

  PAL_IDS.forEach((id, i) => {
    const p = PALETTES[id];
    const b = document.createElement('button');
    b.className = 'swatch' + (i === palIdx ? ' active' : '');
    b.title = p.name;
    b.style.background = p.swatch;
    b.addEventListener('click', () => applyPalette(i));
    swatchesEl.appendChild(b);
  });

  function applyPalette(i) {
    palIdx = ((i % PAL_IDS.length) + PAL_IDS.length) % PAL_IDS.length;
    [...swatchesEl.children].forEach((s, k) => s.classList.toggle('active', k === palIdx));
    try { localStorage.setItem('fractal-palette-' + f.id, PAL_IDS[palIdx]); } catch {}
    if (typeof stopDive === 'function' && diveActive) stopDive({ settle: false });
    if (renderer) renderer.setPalette(PALETTES[PAL_IDS[palIdx]]);
    toastMsg('palette: ' + PALETTES[PAL_IDS[palIdx]].name);
  }

  /* ---------- renderer ---------- */
  function pickRenderer(kind) {
    switch (kind) {
      case 'escape-time': return EscapeTimeRenderer;
      case 'ifs':         return IFSRenderer;
      case 'lsystem':     return LSystemRenderer;
      case 'subdivision': return SubdivisionRenderer;
      case 'ode':         return ODERenderer;
      default: return null;
    }
  }

  const RendererModule = pickRenderer(f.kind);
  if (!RendererModule) {
    toastMsg('no renderer for: ' + f.kind);
    return;
  }

  function onProgress({ pct, pass, maxIter, elapsed }) {
    progress.style.setProperty('--p', (pct * 100).toFixed(1) + '%');
    if (pass === 'done') {
      progress.classList.remove('busy');
      renderTimeEl.textContent = Math.round(elapsed) + 'ms';
      if (maxIter !== undefined) iterMaxEl.textContent = maxIter;
      // Dive listens for completion of its committed render — once the new
      // (deeper) frame is on canvas, rebase diveAccum so visible magnification
      // is continuous through the swap.
      notifyDiveFirstFrame();
    } else {
      progress.classList.add('busy');
      if (maxIter !== undefined) iterMaxEl.textContent = maxIter;
    }
  }

  /* ---------- variant dropdown (e.g. Lorenz parameter presets) ---------- */
  let initialVariantKey = null;
  if (f.variants) {
    const variantKeys = Object.keys(f.variants);
    const fromUrl = params.get('variant');
    let saved = null;
    try { saved = localStorage.getItem('fractal-variant-' + f.id); } catch {}
    initialVariantKey = (fromUrl && f.variants[fromUrl]) ? fromUrl
                      : (saved   && f.variants[saved])   ? saved
                      : (f.defaultVariant && f.variants[f.defaultVariant]) ? f.defaultVariant
                      : variantKeys[0];
  }
  const initialParams = { ...(f.params || {}) };
  if (initialVariantKey) initialParams.variant = f.variants[initialVariantKey];

  const renderer = await RendererModule.create({
    canvas,
    palette: PALETTES[PAL_IDS[palIdx]],
    params: initialParams,
    onProgress,
  });

  // Surface the backend (gpu / cpu) where the legacy "cpus" stat lives.
  cpusEl.textContent = renderer.backend === 'webgpu' ? 'gpu' : (renderer.workerCount ?? 'cpu');

  if (f.variants && renderer.setVariant) {
    const variantRow = $('variantRow');
    const variantSelect = $('variantSelect');
    Object.entries(f.variants).forEach(([key, v]) => {
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = v.name;
      if (key === initialVariantKey) opt.selected = true;
      variantSelect.appendChild(opt);
    });
    variantSelect.addEventListener('change', () => {
      const key = variantSelect.value;
      try { localStorage.setItem('fractal-variant-' + f.id, key); } catch {}
      if (typeof stopDive === 'function' && diveActive) stopDive({ settle: false });
      renderer.setVariant(f.variants[key]);
      toastMsg('variant: ' + f.variants[key].name);
    });
    variantRow.style.display = 'flex';
  }

  renderer.render();

  /* ===================================================================
     Continuous dive — rAF-driven CSS-transform glide on the canvas, with
     view.extent /= 2 committed once per octave and the transform rebased
     when the deeper render's first frame lands (onProgress 'done').

     Diving requires the renderer to expose a mutable .view with .extent.
     Click/palette/reset/neighbour-nav all stop the dive cleanly.
     =================================================================== */
  const DIVE_COMMIT_FACTOR = 2;
  const DIVE_MAX_ACCUM = 8;
  const DIVE_ZOOM_PER_SEC = 1.6;
  const diveBtn = $('diveBtn');

  let diveActive = false;
  let diveRafId = 0;
  let diveLastT = 0;
  let diveAccum = 1;
  let divePending = false;

  function diveSupported() {
    return !!(renderer && renderer.view && typeof renderer.view.extent === 'number'
              && typeof renderer.render === 'function');
  }

  function startDive() {
    if (diveActive) return;
    if (!diveSupported()) { toastMsg('dive not supported here'); return; }
    diveActive = true;
    diveAccum = 1;
    divePending = false;
    diveLastT = performance.now();
    canvas.style.transformOrigin = '50% 50%';
    canvas.style.transform = '';
    if (diveBtn) { diveBtn.classList.add('active'); diveBtn.querySelector('span').textContent = '⏸ dive'; }
    console.log(`[dive] start — ${DIVE_ZOOM_PER_SEC}×/s, commit at ${DIVE_COMMIT_FACTOR}×, clamp ${DIVE_MAX_ACCUM}×, extent=${renderer.view.extent}`);
    diveRafId = requestAnimationFrame(diveTick);
  }

  function stopDive(opts = { settle: true }) {
    if (!diveActive) return;
    diveActive = false;
    if (diveRafId) { cancelAnimationFrame(diveRafId); diveRafId = 0; }
    divePending = false;
    diveAccum = 1;
    canvas.style.transform = '';
    canvas.style.transformOrigin = '';
    if (diveBtn) { diveBtn.classList.remove('active'); diveBtn.querySelector('span').textContent = '▶ dive'; }
    console.log(`[dive] stop`);
    if (opts.settle && renderer.render) renderer.render();
  }

  function diveTick(now) {
    if (!diveActive) return;
    const dt = Math.max(0, Math.min(0.1, (now - diveLastT) * 0.001));
    diveLastT = now;

    diveAccum = Math.min(DIVE_MAX_ACCUM, diveAccum * Math.exp(Math.log(DIVE_ZOOM_PER_SEC) * dt));
    canvas.style.transform = `scale(${diveAccum})`;

    if (diveAccum >= DIVE_COMMIT_FACTOR && !divePending) {
      // Underflow guard: many renderers run into f32 precision well before
      // the f64 view.extent could underflow, but be safe anyway.
      if (renderer.view.extent <= Number.EPSILON * 4) {
        console.log('[dive] view.extent floor reached — stopping');
        stopDive({ settle: true });
        return;
      }
      renderer.view.extent /= DIVE_COMMIT_FACTOR;
      divePending = true;
      console.log(`[dive] commit octave: extent=${renderer.view.extent.toExponential(2)} accum=${diveAccum.toFixed(2)} (kept; rebases on render done)`);
      renderer.render();
    }

    diveRafId = requestAnimationFrame(diveTick);
  }

  function notifyDiveFirstFrame() {
    if (!diveActive || !divePending) return;
    diveAccum = diveAccum / DIVE_COMMIT_FACTOR;
    divePending = false;
    canvas.style.transform = `scale(${diveAccum})`;
    console.log(`[dive] rebase: render done → accum=${diveAccum.toFixed(2)}`);
  }

  if (diveBtn) {
    diveBtn.addEventListener('click', () => {
      if (diveActive) stopDive({ settle: true });
      else startDive();
    });
  }

  /* ---------- interaction ---------- */
  stage.addEventListener('click', (e) => {
    if (typeof renderer.zoomAt !== 'function') return;
    if (diveActive) {
      // User is taking over — stop the dive but don't trigger a settling
      // render since the click's own zoomAt will dispatch one.
      stopDive({ settle: false });
    }
    const factor = e.shiftKey ? 1 / 2.5 : 2.5;
    renderer.zoomAt(e.clientX, e.clientY, factor);
  });

  /* ---------- menu toggle ---------- */
  let menuOpen = true;
  function setMenu(open) {
    menuOpen = open;
    menu.classList.toggle('hidden', !open);
  }
  handle.addEventListener('click', () => setMenu(!menuOpen));

  /* ---------- reset / save ---------- */
  $('resetBtn').addEventListener('click', () => {
    if (diveActive) stopDive({ settle: false });
    renderer.reset?.();
    toastMsg('reset');
  });
  $('shotBtn').addEventListener('click', savePng);

  function savePng() {
    canvas.toBlob((blob) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${f.id}_${PAL_IDS[palIdx]}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      toastMsg('saved ' + a.download);
    }, 'image/png');
  }

  /* ---------- hotkeys ---------- */
  window.addEventListener('keydown', (e) => {
    if (e.target.matches('input, select, textarea')) return;
    if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C')) {
      const sel = window.getSelection();
      if (sel && sel.toString().length > 0) return;
      if (e.shiftKey) { e.preventDefault(); savePng(); }
      return;
    }
    if (e.key === 'm' || e.key === 'M') setMenu(!menuOpen);
    else if (e.key === 'Escape') location.href = '../../index.html';
    else if (e.key === 'p' || e.key === 'P') applyPalette(palIdx + 1);
    else if (e.key === 'ArrowLeft')  goNeighbor(-1);
    else if (e.key === 'ArrowRight') goNeighbor(+1);
    else if (e.key === 'r' || e.key === 'R') {
      if (diveActive) stopDive({ settle: false });
      renderer.reset?.();
      toastMsg('reset');
    }
    else if (e.key === ' ' || e.code === 'Space') {
      // space toggles dive — feels natural for a "go deeper" gesture
      e.preventDefault();
      if (diveActive) stopDive({ settle: true });
      else startDive();
    }
  });

  function goNeighbor(delta) {
    if (diveActive) stopDive({ settle: false });
    const all = FRACTALS;
    const here = all.findIndex(x => x.id === f.id);
    const next = (here + delta + all.length) % all.length;
    const n = all[next];
    // From a per-fractal page (src/<current>/), siblings live at ../<id>/.
    // Underscored ids (burning_ship, game_of_life) map to dashed folders.
    const slug = n.id.replace(/_/g, '-');
    location.href = `../${slug}/`;
  }

  /* ---------- toast ---------- */
  let toastTimer = 0;
  function toastMsg(t) {
    toast.textContent = t;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 1200);
  }

  /* ---------- resize ---------- */
  let resizeT = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeT);
    resizeT = setTimeout(() => {
      if (fitCanvas()) renderer.render();
    }, 150);
  });
})();

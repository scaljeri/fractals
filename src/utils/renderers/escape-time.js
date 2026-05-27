/* Renderer for "escape-time" fractals: julia, burning_ship, mandelbulb_slice.
   Two-pass: a low-resolution preview, then full-resolution. */

(function () {
  const WORKER_COUNT = Math.min(Math.max(navigator.hardwareConcurrency || 4, 2), 12);

  function createCPU({ canvas, palette, params, onProgress }) {
    const ctx = canvas.getContext('2d', { alpha: false });
    const pool = EscapeTimePool.makeEscapeTimePool(WORKER_COUNT);

    let lut = PaletteLUT.buildLUT(palette.stops);
    let currentPaletteShift = 0;

    const view = {
      cx: params.center?.[0] ?? 0,
      cy: params.center?.[1] ?? 0,
      extent: params.extent ?? 3.0,    // vertical complex extent
    };

    let gen = 0;
    let totalJobs = 0, doneJobs = 0;
    let pendingPass = null;
    let renderStartTime = 0;
    let lastIterCount = 256;

    function scalePerPx() { return view.extent / canvas.height; }

    function computeMaxIter() {
      // shallow zoom: a fixed iteration ceiling is fine.
      // Scale modestly with extent so deeper zooms (smaller extent) get more iters.
      // Burning ship's antennas are razor-thin; needs ~2x the iters of Mandelbrot
      // to resolve them at the same zoom.
      const base = params.kind === 'burning_ship' ? 768 : 384;
      const zoomFactor = (params.extent ?? 3.0) / Math.max(1e-12, view.extent);
      const m = Math.round(base + 80 * Math.log10(Math.max(1, zoomFactor)));
      lastIterCount = Math.max(64, Math.min(8000, m));
      return lastIterCount;
    }

    function buildJobs(pass, maxIter) {
      const div = pass === 'low' ? 4 : 1;
      const fullW = Math.max(2, Math.round(canvas.width / div));
      const fullH = Math.max(2, Math.round(canvas.height / div));
      const sc = scalePerPx() * div;
      const stripes = pass === 'low' ? WORKER_COUNT : WORKER_COUNT * 3;
      const stripeH = Math.max(2, Math.ceil(fullH / stripes));
      const jobs = [];
      for (let y = 0; y < fullH; y += stripeH) {
        const h = Math.min(stripeH, fullH - y);
        jobs.push({
          id: 0, gen,
          kind: params.kind,
          px0: 0, py0: y,
          w: fullW, h,
          fullW, fullH,
          cx: view.cx, cy: view.cy,
          scale: sc,
          maxIter,
          juliaCr: params.cr ?? 0,
          juliaCi: params.ci ?? 0,
        });
      }
      return { jobs, fullW, fullH, div };
    }

    function drawStripe(msg, div) {
      const { px0, py0, w, h, out } = msg;
      const img = PaletteLUT.colorizeIters(out, lut, w, h, currentPaletteShift);
      if (div === 1) {
        canvas.classList.add('smooth');
        ctx.putImageData(img, px0, py0);
      } else {
        canvas.classList.remove('smooth');
        const off = document.createElement('canvas');
        off.width = w; off.height = h;
        off.getContext('2d').putImageData(img, 0, 0);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(off, 0, 0, w, h, px0 * div, py0 * div, w * div, h * div);
      }
    }

    let currentDiv = 4;

    pool.onResult((msg) => {
      if (msg.gen !== gen) return;
      drawStripe(msg, currentDiv);
      doneJobs++;
      onProgress?.({
        pct: totalJobs ? doneJobs / totalJobs : 0,
        pass: pendingPass,
        maxIter: lastIterCount,
        elapsed: performance.now() - renderStartTime,
      });
      if (doneJobs >= totalJobs) finishPass();
    });

    function finishPass() {
      if (pendingPass === 'low') {
        startPass('full');
      } else {
        pendingPass = null;
        onProgress?.({
          pct: 1, pass: 'done',
          maxIter: lastIterCount,
          elapsed: performance.now() - renderStartTime,
        });
      }
    }

    function startPass(pass) {
      pendingPass = pass;
      const maxIter = computeMaxIter();
      const { jobs, div } = buildJobs(pass, maxIter);
      currentDiv = div;
      totalJobs = jobs.length;
      doneJobs = 0;
      pool.submitAll(jobs);
    }

    function render() {
      gen++;
      pool.cancelPending();
      renderStartTime = performance.now();
      startPass('low');
    }

    function setPalette(p) {
      lut = PaletteLUT.buildLUT(p.stops);
      // best-effort re-render since the renderer doesn't keep iter values cached
      render();
    }

    function setView(partial) {
      Object.assign(view, partial);
      render();
    }

    function zoomAt(cssX, cssY, factor) {
      const rect = canvas.getBoundingClientRect();
      const u = (cssX - rect.left) / rect.width;
      const v = (cssY - rect.top) / rect.height;
      const halfW = view.extent * (rect.width / rect.height) * 0.5;
      const halfH = view.extent * 0.5;
      view.cx = (view.cx - halfW + u * halfW * 2);
      view.cy = (view.cy - halfH + v * halfH * 2);
      view.extent /= factor;
      render();
    }

    function reset() {
      view.cx = params.center?.[0] ?? 0;
      view.cy = params.center?.[1] ?? 0;
      view.extent = params.extent ?? 3.0;
      render();
    }

    return { render, setPalette, setView, zoomAt, reset, view, workerCount: WORKER_COUNT, backend: 'cpu' };
  }

  async function create(opts) {
    if (window.GPUEscapeTimeRenderer) {
      const gpu = await GPUEscapeTimeRenderer.tryCreate(opts);
      if (gpu) return gpu;
    }
    return createCPU(opts);
  }

  window.EscapeTimeRenderer = { create };
})();

/* ODE-trajectory renderer.
   Integrates a continuous dynamical system (Lorenz, etc.) with RK4, accumulates
   per-pixel hit counts plus a per-pixel sum of the orthogonal "depth" axis,
   then colorizes log-density modulated by the palette gradient sampled by
   average depth — so the two lobes of the Lorenz butterfly pick contrasting
   hues across the palette. */

(function () {
  // y_sum stores per-pixel sum of (y_norm × Y_FP) for fixed-point averaging.
  const Y_FP = 1024;

  const DEFAULT_VARIANT = {
    sigma: 10, rho: 28, beta: 8/3,
    bounds: [-22, 0, 22, 50],
  };

  function yRangeFor(variant) {
    const xExtent = Math.max(Math.abs(variant.bounds[0]), Math.abs(variant.bounds[2]));
    const y = xExtent * 1.4;
    return [-y, y];
  }

  const SYSTEMS = {
    lorenz: {
      derive(state, p) {
        const [x, y, z] = state;
        return [
          p.sigma * (y - x),
          x * (p.rho - z) - y,
          x * y - p.beta * z,
        ];
      },
      project([x, _y, z]) { return [x, z]; },
      depth([_x, y, _z]) { return y; },
      initial: [0.1, 0.0, 0.0],
      steps: 250_000,
      warmup: 1000,
    },
  };

  function rk4(state, dt, derive, p) {
    const [x, y, z] = state;
    const [k1x, k1y, k1z] = derive(state, p);
    const [k2x, k2y, k2z] = derive([x + 0.5*dt*k1x, y + 0.5*dt*k1y, z + 0.5*dt*k1z], p);
    const [k3x, k3y, k3z] = derive([x + 0.5*dt*k2x, y + 0.5*dt*k2y, z + 0.5*dt*k2z], p);
    const [k4x, k4y, k4z] = derive([x +     dt*k3x, y +     dt*k3y, z +     dt*k3z], p);
    return [
      x + dt * (k1x + 2*k2x + 2*k3x + k4x) / 6,
      y + dt * (k1y + 2*k2y + 2*k3y + k4y) / 6,
      z + dt * (k1z + 2*k2z + 2*k3z + k4z) / 6,
    ];
  }

  function createCPU({ canvas, palette, params, onProgress }) {
    const ctx = canvas.getContext('2d', { alpha: false });
    const sys = SYSTEMS[params.kind];
    if (!sys) throw new Error('ode: unknown system ' + params.kind);
    let lut = PaletteLUT.buildLUT(palette.stops);
    let cancelToken = 0;

    const MAX_STEPS = 8_000_000;

    let variant = params.variant || DEFAULT_VARIANT;
    let [yMin, yMax] = yRangeFor(variant);
    let yRangeInv = 1.0 / (yMax - yMin);

    const defaultView = {
      cx: (variant.bounds[0] + variant.bounds[2]) * 0.5,
      cy: (variant.bounds[1] + variant.bounds[3]) * 0.5,
      extent: (variant.bounds[3] - variant.bounds[1]) / 0.88,
    };
    const view = { ...defaultView };

    function viewTransform(w, h) {
      const s = h / view.extent;
      const ox = w * 0.5 - view.cx * s;
      const oy = h * 0.5 + view.cy * s;
      return (x, y) => [ox + x * s, oy - y * s];
    }

    function stepsForView() {
      const zoom = Math.max(1, defaultView.extent / view.extent);
      return Math.min(MAX_STEPS, Math.round(sys.steps * zoom));
    }

    async function render() {
      const myToken = ++cancelToken;
      const w = canvas.width, h = canvas.height;

      ctx.fillStyle = '#08080a';
      ctx.fillRect(0, 0, w, h);

      const project = viewTransform(w, h);
      const density = new Uint32Array(w * h);
      const ySum    = new Uint32Array(w * h);
      const p = { sigma: variant.sigma, rho: variant.rho, beta: variant.beta };
      let state = sys.initial.slice();
      // Faster trajectories at high ρ → shorter dt so consecutive RK4 steps
      // don't span huge distances.
      const dt = 0.005 * Math.sqrt(28 / Math.max(variant.rho, 1));

      for (let i = 0; i < sys.warmup; i++) {
        state = rk4(state, dt, sys.derive, p);
      }

      // Track the previous projected position so we can rasterize a
      // continuous segment per integration step. Point splats alone leave
      // gaps in the fast transit phase between lobes (the trajectory can
      // skip several pixels per step there).
      let [pxPrev2, pyPrev2] = sys.project(state);
      [pxPrev2, pyPrev2] = project(pxPrev2, pyPrev2);

      const total = stepsForView();
      const CHUNK = 8_000;
      const start = performance.now();
      let done = 0;
      while (done < total) {
        const todo = Math.min(CHUNK, total - done);
        for (let i = 0; i < todo; i++) {
          state = rk4(state, dt, sys.derive, p);
          const [px2, py2] = sys.project(state);
          const [pxCur, pyCur] = project(px2, py2);
          const dx = pxCur - pxPrev2;
          const dy = pyCur - pyPrev2;
          const segLen = Math.max(Math.abs(dx), Math.abs(dy));
          const nSub = Math.max(1, Math.min(64, segLen | 0 || 1));
          const stepDx = dx / nSub;
          const stepDy = dy / nSub;
          const yNorm = Math.max(0, Math.min(1, (sys.depth(state) - yMin) * yRangeInv));
          const yQuant = (yNorm * Y_FP) | 0;
          for (let k = 0; k < nSub; k++) {
            const pxS = pxPrev2 + stepDx * (k + 0.5);
            const pyS = pyPrev2 + stepDy * (k + 0.5);
            const ix = Math.floor(pxS);
            const iy = Math.floor(pyS);
            if (ix < 0 || ix >= w || iy < 0 || iy >= h) continue;
            const idx = iy * w + ix;
            density[idx]++;
            ySum[idx] += yQuant;
          }
          pxPrev2 = pxCur;
          pyPrev2 = pyCur;
        }
        done += todo;
        onProgress?.({
          pct: done / total,
          pass: done >= total ? 'done' : 'integrate',
          elapsed: performance.now() - start,
          maxIter: total,
        });
        await CanvasUtils.nextFrame();
        if (myToken !== cancelToken) return;
      }

      let max = 1;
      for (let i = 0; i < density.length; i++) if (density[i] > max) max = density[i];
      const logMax = Math.log(max + 1);
      const LUT_N = lut.length / 4;

      const img = ctx.createImageData(w, h);
      const data = img.data;
      const palLo = 0.08, palHi = 0.92, gamma = 0.9;
      const bgR = 8, bgG = 8, bgB = 10;
      for (let i = 0; i < density.length; i++) {
        const d = density[i];
        if (!d) {
          data[i*4]   = bgR;
          data[i*4+1] = bgG;
          data[i*4+2] = bgB;
          data[i*4+3] = 255;
          continue;
        }
        const t = Math.max(0, Math.min(1, Math.log(d + 1) / logMax * 1.15));
        const bright = Math.pow(t, gamma);
        const yAvg = Math.max(0, Math.min(1, ySum[i] / (d * Y_FP)));
        const palT = palLo + (palHi - palLo) * yAvg;
        const li = Math.min(LUT_N - 1, (palT * (LUT_N - 1)) | 0) * 4;
        data[i*4]   = (bgR + (lut[li]   - bgR) * bright) | 0;
        data[i*4+1] = (bgG + (lut[li+1] - bgG) * bright) | 0;
        data[i*4+2] = (bgB + (lut[li+2] - bgB) * bright) | 0;
        data[i*4+3] = 255;
      }
      ctx.putImageData(img, 0, 0);
    }

    function setPalette(p) {
      lut = PaletteLUT.buildLUT(p.stops);
      render();
    }

    function setVariant(v) {
      variant = v || DEFAULT_VARIANT;
      [yMin, yMax] = yRangeFor(variant);
      yRangeInv = 1.0 / (yMax - yMin);
      defaultView.cx     = (variant.bounds[0] + variant.bounds[2]) * 0.5;
      defaultView.cy     = (variant.bounds[1] + variant.bounds[3]) * 0.5;
      defaultView.extent = (variant.bounds[3] - variant.bounds[1]) / 0.88;
      Object.assign(view, defaultView);
      render();
    }

    function zoomAt(cssX, cssY, factor) {
      const rect = canvas.getBoundingClientRect();
      const projectedPerPx = view.extent / rect.height;
      const dx = (cssX - rect.left - rect.width  * 0.5) * projectedPerPx;
      const dy = (cssY - rect.top  - rect.height * 0.5) * projectedPerPx;
      view.cx += dx;
      view.cy -= dy;
      view.extent /= factor;
      render();
    }

    function reset() {
      Object.assign(view, defaultView);
      render();
    }

    return { render, setPalette, setVariant, zoomAt, reset, view, backend: 'cpu' };
  }

  async function create(opts) {
    if (window.GPUODERenderer) {
      const gpu = await GPUODERenderer.tryCreate(opts);
      if (gpu) return gpu;
    }
    return createCPU(opts);
  }

  window.ODERenderer = { create };
})();

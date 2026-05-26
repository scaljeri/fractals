/* ODE-trajectory renderer.
   Integrates a continuous dynamical system (Lorenz, etc.) with RK4 and
   plots the projected trajectory as a log-density image.

   This is the same "accumulate hits → log-normalize → colorize" pipeline
   used by the IFS renderer; only the point source differs. */

(function () {
  const SYSTEMS = {
    lorenz: {
      // Lorenz '63 — canonical butterfly parameters
      params: { sigma: 10, rho: 28, beta: 8/3 },
      derive(state, p) {
        const [x, y, z] = state;
        return [
          p.sigma * (y - x),
          x * (p.rho - z) - y,
          x * y - p.beta * z,
        ];
      },
      // 2D projection (default = x,z which gives the classic butterfly)
      project([x, _y, z]) { return [x, z]; },
      bounds: [-25, 0, 25, 50],         // xmin, ymin (=zmin), xmax, ymax (=zmax)
      initial: [0.1, 0.0, 0.0],
      dt: 0.005,
      steps: 250_000,
      warmup: 200,
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
    let accent = palette.accent || [124, 255, 107];
    let cancelToken = 0;

    const MAX_STEPS = 8_000_000;
    const [xmin, ymin, xmax, ymax] = sys.bounds;
    const defaultView = {
      cx: (xmin + xmax) * 0.5,
      cy: (ymin + ymax) * 0.5,
      // Fit the y range with a small breathing margin.
      extent: (ymax - ymin) / 0.88,
    };
    const view = { ...defaultView };

    function viewTransform(w, h) {
      const s = h / view.extent;       // pixels per projected-unit (vertical)
      const ox = w * 0.5 - view.cx * s;
      const oy = h * 0.5 + view.cy * s; // y flipped to screen-space
      return (x, y) => [ox + x * s, oy - y * s];
    }

    function stepsForView() {
      const zoom = Math.max(1, defaultView.extent / view.extent);
      return Math.min(MAX_STEPS, Math.round(sys.steps * zoom));
    }

    async function render() {
      const myToken = ++cancelToken;
      const w = canvas.width, h = canvas.height;

      ctx.fillStyle = '#0a0a0a';
      ctx.fillRect(0, 0, w, h);

      const project = viewTransform(w, h);
      const density = new Uint32Array(w * h);
      const p = sys.params;
      let state = sys.initial.slice();
      const dt = sys.dt;

      for (let i = 0; i < sys.warmup; i++) {
        state = rk4(state, dt, sys.derive, p);
      }

      const total = stepsForView();
      const CHUNK = 8_000;
      const start = performance.now();
      let done = 0;
      while (done < total) {
        const todo = Math.min(CHUNK, total - done);
        for (let i = 0; i < todo; i++) {
          state = rk4(state, dt, sys.derive, p);
          const [px2, py2] = sys.project(state);
          const [pxF, pyF] = project(px2, py2);
          const px = pxF | 0, py = pyF | 0;
          if (px >= 0 && px < w && py >= 0 && py < h) {
            density[py * w + px]++;
          }
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

      // normalize density via log
      let max = 1;
      for (let i = 0; i < density.length; i++) if (density[i] > max) max = density[i];
      const logMax = Math.log(max + 1);

      const img = ctx.createImageData(w, h);
      const data = img.data;
      const [ar, ag, ab] = accent;
      for (let i = 0; i < density.length; i++) {
        const d = density[i];
        if (!d) { data[i * 4 + 3] = 255; continue; }
        const t = Math.min(1, Math.log(d + 1) / logMax);
        const tt = Math.pow(t, 0.55);
        data[i * 4    ] = (10 + (ar - 10) * tt) | 0;
        data[i * 4 + 1] = (10 + (ag - 10) * tt) | 0;
        data[i * 4 + 2] = (10 + (ab - 10) * tt) | 0;
        data[i * 4 + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
    }

    function setPalette(p) {
      accent = p.accent || accent;
      render();
    }

    function zoomAt(cssX, cssY, factor) {
      const rect = canvas.getBoundingClientRect();
      const projectedPerPx = view.extent / rect.height;
      const dx = (cssX - rect.left - rect.width  * 0.5) * projectedPerPx;
      const dy = (cssY - rect.top  - rect.height * 0.5) * projectedPerPx;
      // Projected y grows upward; screen y grows downward.
      view.cx += dx;
      view.cy -= dy;
      view.extent /= factor;
      render();
    }

    function reset() {
      Object.assign(view, defaultView);
      render();
    }

    return { render, setPalette, zoomAt, reset, view, backend: 'cpu' };
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

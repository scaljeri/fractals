/* Iterated Function System (chaos game) renderer.
   Used by Sierpiński triangle and Barnsley fern. */

(function () {
  /* Each transform is { p, a, b, c, d, e, f } applying
       x' = a*x + b*y + e
       y' = c*x + d*y + f
     with cumulative probability `p` (sorted ascending). */
  const SYSTEMS = {
    sierpinski: {
      // three transforms — each a halfway step toward one vertex of an
      // equilateral triangle. Equal probability.
      transforms: [
        { p: 1/3, a: 0.5, b: 0,   c: 0,   d: 0.5, e: 0,    f: 0    },
        { p: 2/3, a: 0.5, b: 0,   c: 0,   d: 0.5, e: 0.5,  f: 0    },
        { p: 1.0, a: 0.5, b: 0,   c: 0,   d: 0.5, e: 0.25, f: 0.5  },
      ],
      // viewport in IFS-space (xmin, ymin, xmax, ymax)
      bounds: [0, 0, 1, 0.6],
    },
    barnsley: {
      // canonical Barnsley fern coefficients
      transforms: [
        { p: 0.01, a:  0.00, b:  0.00, c:  0.00, d: 0.16, e: 0.00, f: 0.00 },
        { p: 0.86, a:  0.85, b:  0.04, c: -0.04, d: 0.85, e: 0.00, f: 1.60 },
        { p: 0.93, a:  0.20, b: -0.26, c:  0.23, d: 0.22, e: 0.00, f: 1.60 },
        { p: 1.00, a: -0.15, b:  0.28, c:  0.26, d: 0.24, e: 0.00, f: 0.44 },
      ],
      bounds: [-2.5, 0, 2.5, 10],
    },
  };

  function createCPU({ canvas, palette, params, onProgress }) {
    const ctx = canvas.getContext('2d', { alpha: false });
    const sys = SYSTEMS[params.kind];
    const baseIterations = params.iterations || 400_000;
    const MAX_ITERATIONS = 16_000_000;
    let accent = palette.accent || [124, 255, 107];
    let cancelToken = 0;

    // The view is a (cx, cy, extent) window onto the IFS-space, the same
    // pattern used everywhere else. Default fits the bounds with a little
    // breathing room.
    const [xmin, ymin, xmax, ymax] = sys.bounds;
    const padding = 0.06;
    const defaultView = {
      cx: (xmin + xmax) * 0.5,
      cy: (ymin + ymax) * 0.5,
      extent: (ymax - ymin) / (1 - 2 * padding),
    };
    const view = { ...defaultView };

    function projectorAndIters(w, h) {
      const s = h / view.extent;             // pixels per IFS unit (vertical)
      const ox = w * 0.5 - view.cx * s;
      const oy = h * 0.5 + view.cy * s;      // y flipped for screen-down
      const zoom = Math.max(1, defaultView.extent / view.extent);
      const iterations = Math.min(MAX_ITERATIONS, Math.round(baseIterations * zoom));
      return {
        project: (x, y) => [ox + x * s, oy - y * s],
        iterations,
      };
    }

    function pickTransform() {
      const r = Math.random();
      for (const t of sys.transforms) {
        if (r <= t.p) return t;
      }
      return sys.transforms[sys.transforms.length - 1];
    }

    async function render() {
      const myToken = ++cancelToken;
      const w = canvas.width, h = canvas.height;

      ctx.fillStyle = '#0a0a0a';
      ctx.fillRect(0, 0, w, h);

      const { project, iterations } = projectorAndIters(w, h);

      const density = new Uint32Array(w * h);
      let x = 0, y = 0;
      const stride = w;
      for (let i = 0; i < 20; i++) {
        const t = pickTransform();
        const nx = t.a * x + t.b * y + t.e;
        const ny = t.c * x + t.d * y + t.f;
        x = nx; y = ny;
      }

      const CHUNK = 20_000;
      const start = performance.now();
      let done = 0;
      while (done < iterations) {
        const todo = Math.min(CHUNK, iterations - done);
        for (let i = 0; i < todo; i++) {
          const t = pickTransform();
          const nx = t.a * x + t.b * y + t.e;
          const ny = t.c * x + t.d * y + t.f;
          x = nx; y = ny;
          const [pxF, pyF] = project(x, y);
          const px = pxF | 0, py = pyF | 0;
          if (px >= 0 && px < w && py >= 0 && py < h) {
            density[py * stride + px]++;
          }
        }
        done += todo;
        onProgress?.({
          pct: done / iterations,
          pass: done >= iterations ? 'done' : 'iter',
          elapsed: performance.now() - start,
          maxIter: iterations,
        });
        await CanvasUtils.nextFrame();
        if (myToken !== cancelToken) return;
      }

      // Find max density for normalization (with a percentile clip).
      let max = 1;
      for (let i = 0; i < density.length; i++) if (density[i] > max) max = density[i];
      const logMax = Math.log(max + 1);

      const img = ctx.createImageData(w, h);
      const data = img.data;
      const [ar, ag, ab] = accent;
      for (let i = 0; i < density.length; i++) {
        const d = density[i];
        if (!d) {
          data[i * 4 + 3] = 255;
          continue;
        }
        // log curve gives more visual weight to sparse trails
        const t = Math.min(1, Math.log(d + 1) / logMax);
        // base = ink-0, blend toward accent, then push highlights to ivory
        const tt = Math.pow(t, 0.6);
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
      const ifsPerPx = view.extent / rect.height;
      const dx = (cssX - rect.left - rect.width  * 0.5) * ifsPerPx;
      const dy = (cssY - rect.top  - rect.height * 0.5) * ifsPerPx;
      // y in IFS-space goes up; in CSS it goes down — flip the sign.
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
    if (window.GPUIFSRenderer) {
      const gpu = await GPUIFSRenderer.tryCreate(opts);
      if (gpu) return gpu;
    }
    return createCPU(opts);
  }

  window.IFSRenderer = { create };
})();

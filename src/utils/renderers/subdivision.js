/* Subdivision renderers.

   - Cantor set: stack of rows showing successive middle-third removals.
   - Menger sponge: rendered here as its 2D analogue (Sierpinski carpet),
     i.e. one face of the sponge at increasing depth — keeps the visual
     intent without a 3D pipeline.

   Both use a unit-square view (cx, cy, extent) so dive zooms in continuously
   and the depth auto-bumps to keep matching detail visible. */

(function () {
  function createCPU({ canvas, palette, params, onProgress }) {
    const ctx = canvas.getContext('2d', { alpha: false });
    const accent = (palette.accent || [124, 255, 107]).slice();
    let cancelToken = 0;

    const baseDepth = params.depth ?? (params.kind === 'cantor' ? 8 : 5);
    const maxDepth  = params.kind === 'cantor' ? 18 : 9;
    const defaultView = { cx: 0.5, cy: 0.5, extent: 1.0 };
    const view = { ...defaultView };

    function chooseDepth() {
      if (view.extent >= 1) return baseDepth;
      // Each octave of zoom (×3 in base-3) reveals one more level of detail.
      const bump = Math.ceil(Math.log(1 / view.extent) / Math.log(3));
      return Math.min(maxDepth, baseDepth + bump);
    }

    /* True if x ∈ [0,1] survives the first `level` Cantor removals. */
    function inCantor(x, level) {
      let xx = x;
      for (let i = 0; i < level; i++) {
        xx *= 3;
        const d = Math.floor(xx);
        if (d === 1) return false;
        xx -= d;
      }
      return true;
    }

    /* True if (x, y) ∈ [0,1]² survives the Sierpinski-carpet removals. */
    function inMenger(x, y, depth) {
      let xx = x, yy = y;
      for (let i = 0; i < depth; i++) {
        xx *= 3; yy *= 3;
        const dx = Math.floor(xx), dy = Math.floor(yy);
        if (dx === 1 && dy === 1) return false;
        xx -= dx; yy -= dy;
      }
      return true;
    }

    function clearBg() {
      ctx.fillStyle = '#0a0a0a';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    // Cantor's unit-square layout: rows stack vertically inside an 84%-of-
    // height band, top-padded by 8%. Each row corresponds to one removal
    // level. dive scales extent → both x and y zoom; depth bumps in step.
    const CANTOR_Y_PAD = 0.08;
    const CANTOR_Y_USABLE = 0.84;

    async function renderCantor() {
      const myToken = ++cancelToken;
      clearBg();
      const w = canvas.width, h = canvas.height;
      const aspect = w / h;
      const depth = chooseDepth();
      const rowH_unit = CANTOR_Y_USABLE / (depth + 1);
      const halfX = view.extent * aspect * 0.5;
      const halfY = view.extent * 0.5;
      const xmin = view.cx - halfX, ymin = view.cy - halfY;
      const xRange = view.extent * aspect;

      const [r, g, b] = accent;
      const start = performance.now();

      for (let level = 0; level <= depth; level++) {
        if (myToken !== cancelToken) return;
        const yTop_unit = CANTOR_Y_PAD + level * rowH_unit;
        const yBot_unit = yTop_unit + rowH_unit;
        if (yBot_unit < ymin || yTop_unit > ymin + view.extent) continue;
        const yTop_px = ((yTop_unit - ymin) / view.extent) * h;
        const yBot_px = ((yBot_unit - ymin) / view.extent) * h;
        const yHeight = Math.max(1, Math.floor(yBot_px - yTop_px) - 2);
        const yDraw = Math.max(0, yTop_px | 0);

        let cur = [[0, 1]];
        for (let l = 0; l < level; l++) {
          const next = [];
          for (const [a, b2] of cur) {
            const third = (b2 - a) / 3;
            next.push([a, a + third]);
            next.push([b2 - third, b2]);
          }
          cur = next;
        }

        const fade = Math.max(0.4, 1 - level / (maxDepth * 1.2));
        ctx.fillStyle = `rgba(${r},${g},${b},${fade.toFixed(3)})`;
        for (const [a, b2] of cur) {
          const x0_px = ((a - xmin) / xRange) * w;
          const x1_px = ((b2 - xmin) / xRange) * w;
          if (x1_px < 0 || x0_px > w) continue;
          const xC = Math.max(0, x0_px);
          const xW = Math.min(w, x1_px) - xC;
          if (xW < 0.5) continue;
          ctx.fillRect(xC | 0, yDraw, Math.ceil(xW), yHeight);
        }

        if (level % 2 === 0 || level === depth) {
          onProgress?.({
            pct: (level + 1) / (depth + 1),
            pass: level >= depth ? 'done' : 'level',
            elapsed: performance.now() - start,
            maxIter: depth,
          });
          await CanvasUtils.nextFrame();
        }
      }
    }

    // Menger as a per-scanline base-3 digit test. Slower than the original
    // recursive subdivider but composes cleanly with an arbitrary view —
    // the recursive approach can't easily clip to a sub-region.
    async function renderMenger() {
      const myToken = ++cancelToken;
      clearBg();
      const w = canvas.width, h = canvas.height;
      const aspect = w / h;
      const depth = chooseDepth();
      const halfX = view.extent * aspect * 0.5;
      const halfY = view.extent * 0.5;
      const xmin = view.cx - halfX, ymin = view.cy - halfY;
      const xRange = view.extent * aspect;

      const img = ctx.createImageData(w, h);
      const data = img.data;
      const [r, g, b] = accent;
      const start = performance.now();
      // Yield to the browser every ~3M tests so chunks stay around 50ms.
      const ROWS_PER_CHUNK = Math.max(4, Math.floor(3_000_000 / w / Math.max(1, depth)));

      // Pre-fill alpha for the whole buffer once.
      for (let i = 3; i < data.length; i += 4) data[i] = 255;

      for (let py = 0; py < h; py += ROWS_PER_CHUNK) {
        if (myToken !== cancelToken) return;
        const pyEnd = Math.min(h, py + ROWS_PER_CHUNK);
        for (let y = py; y < pyEnd; y++) {
          const v = (y / h) * view.extent + ymin;
          if (v < 0 || v >= 1) continue;
          const rowBase = y * w * 4;
          for (let x = 0; x < w; x++) {
            const u = (x / w) * xRange + xmin;
            if (u < 0 || u >= 1) continue;
            if (inMenger(u, v, depth)) {
              const off = rowBase + x * 4;
              data[off    ] = r;
              data[off + 1] = g;
              data[off + 2] = b;
            }
          }
        }
        ctx.putImageData(img, 0, 0);
        onProgress?.({
          pct: pyEnd / h,
          pass: pyEnd >= h ? 'done' : 'subdivide',
          elapsed: performance.now() - start,
          maxIter: depth,
        });
        await CanvasUtils.nextFrame();
      }
    }

    function render() {
      if (params.kind === 'cantor') return renderCantor();
      return renderMenger();
    }

    function setPalette(p) {
      const next = p.accent || accent;
      accent[0] = next[0]; accent[1] = next[1]; accent[2] = next[2];
      render();
    }

    function zoomAt(cssX, cssY, factor) {
      const rect = canvas.getBoundingClientRect();
      const unitPerPx = view.extent / rect.height;
      const dx = (cssX - rect.left - rect.width  * 0.5) * unitPerPx;
      const dy = (cssY - rect.top  - rect.height * 0.5) * unitPerPx;
      view.cx += dx;
      view.cy += dy;
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
    if (window.GPUSubdivisionRenderer) {
      const gpu = await GPUSubdivisionRenderer.tryCreate(opts);
      if (gpu) return gpu;
    }
    return createCPU(opts);
  }

  window.SubdivisionRenderer = { create };
})();

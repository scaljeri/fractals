/* L-system + turtle-graphics renderer.
   Used by Koch snowflake (axiom = closed triangle) and Dragon curve.

   Productions are character substitutions; turtle commands:
     F, G  → forward (drawing)
     +     → turn left by angle
     -     → turn right by angle
   Unknown chars are ignored. */

(function () {
  // stepFactor is the per-depth segment-length contraction. It keeps the
  // figure bounded across depths so deeper expansion = more visible detail,
  // not just a bigger drawing.
  //   Koch:   each F splits into 4 sub-Fs, each 1/3 the length.
  //   Dragon: each F/G splits into 2 sub-segments at 45°, so the new
  //           segment length is 1/√2 of the parent.
  const SYSTEMS = {
    koch: {
      axiom: 'F++F++F',
      rules: { F: 'F-F++F-F' },
      angle: 60,
      stepFactor: 1 / 3,
      initialDepth: 5,
      maxDepth: 9,
      fit: { padding: 0.06 },
    },
    dragon: {
      axiom: 'F',
      rules: { F: 'F+G', G: 'F-G' },
      angle: 90,
      stepFactor: 1 / Math.SQRT2,
      initialDepth: 13,
      maxDepth: 17,
      fit: { padding: 0.08 },
    },
  };

  /* Expand the L-system string `depth` times. */
  function expand(axiom, rules, depth) {
    let s = axiom;
    for (let d = 0; d < depth; d++) {
      let out = '';
      for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        out += rules[ch] !== undefined ? rules[ch] : ch;
      }
      s = out;
    }
    return s;
  }

  /* Walk the string and compute the bounding box of all forward steps,
     with each F-step scaled by `step`. */
  function bounds(str, angleDeg, step) {
    const rad = (Math.PI / 180) * angleDeg;
    let x = 0, y = 0, theta = 0;
    let minX = 0, maxX = 0, minY = 0, maxY = 0;
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      if (ch === 'F' || ch === 'G') {
        x += step * Math.cos(theta);
        y += step * Math.sin(theta);
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      } else if (ch === '+') {
        theta += rad;
      } else if (ch === '-') {
        theta -= rad;
      }
    }
    return { minX, minY, maxX, maxY };
  }

  /* Choose the depth that puts the segment length at roughly `targetPxPerSeg`
     pixels on screen, given the current view extent and canvas height. */
  function chooseDepth(sys, extent, canvasH, targetPxPerSeg = 1.5) {
    const turtlePerPx = extent / Math.max(1, canvasH);
    // step ≤ targetPxPerSeg * turtlePerPx → stepFactor^d ≤ ...
    // d ≥ log(target * turtlePerPx) / log(stepFactor)
    const v = targetPxPerSeg * turtlePerPx;
    if (v <= 0) return sys.maxDepth;
    const d = Math.ceil(Math.log(v) / Math.log(sys.stepFactor));
    return Math.max(sys.initialDepth, Math.min(sys.maxDepth, d));
  }

  function createCPU({ canvas, palette, params, onProgress }) {
    const ctx = canvas.getContext('2d', { alpha: false });
    const sys = SYSTEMS[params.kind];
    let accent = palette.accent || [124, 255, 107];
    let cancelToken = 0;

    // Cache of (depth → { str, bb }) so re-zoom doesn't pay expansion twice.
    const cache = new Map();
    function getExpansion(depth) {
      let hit = cache.get(depth);
      if (hit) return hit;
      const str = expand(sys.axiom, sys.rules, depth);
      const step = Math.pow(sys.stepFactor, depth);
      const bb = bounds(str, sys.angle, step);
      hit = { str, bb, step };
      cache.set(depth, hit);
      return hit;
    }

    // Initial fit-to-bbox view from the initial-depth expansion.
    const initial = getExpansion(sys.initialDepth);
    const bbH = (initial.bb.maxY - initial.bb.minY) || 1;
    const pad = sys.fit.padding;
    const defaultView = {
      cx: (initial.bb.minX + initial.bb.maxX) * 0.5,
      cy: (initial.bb.minY + initial.bb.maxY) * 0.5,
      extent: bbH / (1 - 2 * pad),
    };
    const view = { ...defaultView };

    async function render() {
      const myToken = ++cancelToken;
      const w = canvas.width, h = canvas.height;
      ctx.fillStyle = '#0a0a0a';
      ctx.fillRect(0, 0, w, h);

      // Pick the depth that gives roughly 1.5px per segment at current zoom.
      const depth = chooseDepth(sys, view.extent, h);
      const { str, step } = getExpansion(depth);

      const s = h / view.extent;
      const ox = w * 0.5 - view.cx * s;
      const oy = h * 0.5 - view.cy * s;

      const rad = (Math.PI / 180) * sys.angle;
      let x = 0, y = 0, theta = 0;
      const [r, g, b] = accent;

      const total = str.length;
      const CHUNK = 20_000;
      const t0 = performance.now();

      ctx.lineWidth = Math.max(1, Math.min(w, h) / 1000);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = `rgba(${r},${g},${b},0.92)`;

      let i = 0;
      ctx.beginPath();
      ctx.moveTo(ox + x * s, oy + y * s);
      while (i < total) {
        const end = Math.min(i + CHUNK, total);
        for (; i < end; i++) {
          const ch = str[i];
          if (ch === 'F' || ch === 'G') {
            x += step * Math.cos(theta);
            y += step * Math.sin(theta);
            ctx.lineTo(ox + x * s, oy + y * s);
          } else if (ch === '+') {
            theta += rad;
          } else if (ch === '-') {
            theta -= rad;
          }
        }
        ctx.stroke();
        onProgress?.({
          pct: i / total,
          pass: i >= total ? 'done' : 'draw',
          elapsed: performance.now() - t0,
          maxIter: depth,
        });
        if (i < total) {
          await CanvasUtils.nextFrame();
          if (myToken !== cancelToken) return;
          ctx.beginPath();
          ctx.moveTo(ox + x * s, oy + y * s);
        }
      }
    }

    function setPalette(p) {
      accent = p.accent || accent;
      render();
    }

    function zoomAt(cssX, cssY, factor) {
      const rect = canvas.getBoundingClientRect();
      const turtlePerPx = view.extent / rect.height;
      const dx = (cssX - rect.left - rect.width  * 0.5) * turtlePerPx;
      const dy = (cssY - rect.top  - rect.height * 0.5) * turtlePerPx;
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
    if (window.GPULSystemRenderer) {
      const gpu = await GPULSystemRenderer.tryCreate(opts);
      if (gpu) return gpu;
    }
    return createCPU(opts);
  }

  window.LSystemRenderer = { create };
})();

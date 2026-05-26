/* GPU L-system renderer (koch, dragon).

   CPU expands the L-system into a flat vertex array; GPU rasterizes it
   as a line strip with 4× MSAA. */

(function () {
  // Matches lsystem.js (CPU) — keep stepFactor in sync.
  const SYSTEMS = {
    koch: {
      axiom: 'F++F++F', rules: { F: 'F-F++F-F' }, angle: 60,
      stepFactor: 1/3, initialDepth: 5, maxDepth: 9,
      fit: { padding: 0.06 },
    },
    dragon: {
      axiom: 'F', rules: { F: 'F+G', G: 'F-G' }, angle: 90,
      stepFactor: 1/Math.SQRT2, initialDepth: 13, maxDepth: 17,
      fit: { padding: 0.08 },
    },
  };

  function chooseDepth(sys, extent, canvasH, targetPxPerSeg = 1.5) {
    const turtlePerPx = extent / Math.max(1, canvasH);
    const v = targetPxPerSeg * turtlePerPx;
    if (v <= 0) return sys.maxDepth;
    const d = Math.ceil(Math.log(v) / Math.log(sys.stepFactor));
    return Math.max(sys.initialDepth, Math.min(sys.maxDepth, d));
  }

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

  /* Walk the string into a Float32Array of (x, y) pairs in turtle-space,
     with each F-step scaled by `step` so the figure stays in roughly the
     same bbox as `depth` grows. */
  function buildVertices(str, angleDeg, step) {
    const rad = (Math.PI / 180) * angleDeg;
    let n = 1;
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      if (ch === 'F' || ch === 'G') n++;
    }
    const v = new Float32Array(n * 2);
    let x = 0, y = 0, theta = 0;
    let minX = 0, maxX = 0, minY = 0, maxY = 0;
    let k = 0;
    v[k++] = x; v[k++] = y;
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      if (ch === 'F' || ch === 'G') {
        x += step * Math.cos(theta);
        y += step * Math.sin(theta);
        v[k++] = x; v[k++] = y;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      } else if (ch === '+') {
        theta += rad;
      } else if (ch === '-') {
        theta -= rad;
      }
    }
    return { vertices: v, count: n, bb: { minX, minY, maxX, maxY } };
  }

  const WGSL = `
struct U {
  // Affine 2x2 + offset, mapping turtle-space → NDC ([-1, 1])
  m0 : vec2<f32>,
  m1 : vec2<f32>,
  off: vec2<f32>,
  accent : vec3<f32>,
  _pad : f32,
};

@group(0) @binding(0) var<uniform> u : U;

@vertex
fn vs(@location(0) p : vec2<f32>) -> @builtin(position) vec4<f32> {
  let x = u.m0.x * p.x + u.m0.y * p.y + u.off.x;
  let y = u.m1.x * p.x + u.m1.y * p.y + u.off.y;
  // flip y for screen-down rendering
  return vec4<f32>(x, -y, 0.0, 1.0);
}

@fragment
fn fs() -> @location(0) vec4<f32> {
  return vec4<f32>(u.accent, 1.0);
}
`;

  async function tryCreate({ canvas, palette, params, onProgress }) {
    const sys = SYSTEMS[params.kind];
    if (!sys) return null;
    const prep = await WebGPUDevice.prepare();
    if (!prep) return null;
    const { device, format } = prep;
    let accent = palette.accent || [124, 255, 107];

    const SAMPLE_COUNT = 4;
    let pipeline;
    try {
      const module = device.createShaderModule({ code: WGSL });
      pipeline = device.createRenderPipeline({
        layout: 'auto',
        vertex: {
          module, entryPoint: 'vs',
          buffers: [{
            arrayStride: 8,
            attributes: [{ shaderLocation: 0, format: 'float32x2', offset: 0 }],
          }],
        },
        fragment: { module, entryPoint: 'fs', targets: [{ format }] },
        primitive: { topology: 'line-strip' },
        multisample: { count: SAMPLE_COUNT },
      });
    } catch (err) {
      console.warn('[lsystem-gpu] init failed:', err);
      return null;
    }

    const ctx = WebGPUDevice.attach(canvas, device, format);
    if (!ctx) return null;

    const uniformBuf = device.createBuffer({
      size: 48,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    let msaaTex = null, msaaW = 0, msaaH = 0;
    function ensureMSAA(w, h) {
      if (msaaTex && msaaW === w && msaaH === h) return;
      msaaTex?.destroy?.();
      msaaTex = device.createTexture({
        size: [w, h, 1],
        format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
        sampleCount: SAMPLE_COUNT,
      });
      msaaW = w; msaaH = h;
    }

    // Vertex buffer cache keyed by depth.
    const vboCache = new Map();
    function getBuffer(depth) {
      let hit = vboCache.get(depth);
      if (hit) return hit;
      const str = expand(sys.axiom, sys.rules, depth);
      const step = Math.pow(sys.stepFactor, depth);
      const { vertices, count, bb } = buildVertices(str, sys.angle, step);
      const vbuf = device.createBuffer({
        size: vertices.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(vbuf, 0, vertices.buffer);
      hit = { vbuf, count, bb };
      vboCache.set(depth, hit);
      return hit;
    }

    const initial = getBuffer(sys.initialDepth);
    const bbH0 = (initial.bb.maxY - initial.bb.minY) || 1;
    const padding = sys.fit.padding;
    const defaultView = {
      cx: (initial.bb.minX + initial.bb.maxX) * 0.5,
      cy: (initial.bb.minY + initial.bb.maxY) * 0.5,
      extent: bbH0 / (1 - 2 * padding),
    };
    const view = { ...defaultView };

    function writeUniforms(w, h) {
      const aspect = w / h;
      // ky: NDC units per turtle unit (vertical). view.extent maps to 2 NDC units.
      const ky = 2 / view.extent;
      // kx: aspect-corrected so turtle 1-unit step in x has the same pixel size
      // as in y (the canvas pixels are square).
      const kx = ky / aspect;
      const offX = -view.cx * kx;
      const offY = -view.cy * ky;

      const ab = new ArrayBuffer(48);
      const f = new Float32Array(ab);
      f[0] = kx; f[1] = 0;     // m0
      f[2] = 0;  f[3] = ky;    // m1
      f[4] = offX; f[5] = offY;
      f[8]  = accent[0] / 255;
      f[9]  = accent[1] / 255;
      f[10] = accent[2] / 255;
      device.queue.writeBuffer(uniformBuf, 0, ab);
    }

    async function render() {
      const w = canvas.width, h = canvas.height;
      if (!w || !h) return;
      ensureMSAA(w, h);
      writeUniforms(w, h);

      // Pick the depth that gives roughly 1.5px per segment, build vbuf lazily.
      const depth = chooseDepth(sys, view.extent, h);
      const { vbuf, count } = getBuffer(depth);

      const t0 = performance.now();
      const bg = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: uniformBuf } }],
      });

      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: msaaTex.createView(),
          resolveTarget: ctx.getCurrentTexture().createView(),
          loadOp: 'clear',
          clearValue: { r: 10/255, g: 10/255, b: 10/255, a: 1 },
          storeOp: 'discard',
        }],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bg);
      pass.setVertexBuffer(0, vbuf);
      pass.draw(count);
      pass.end();
      device.queue.submit([encoder.finish()]);
      await device.queue.onSubmittedWorkDone?.();
      onProgress?.({
        pct: 1, pass: 'done',
        elapsed: performance.now() - t0,
        maxIter: depth,
      });
    }

    function setPalette(p) {
      accent = p.accent || accent;
      render();
    }

    function zoomAt(cssX, cssY, factor) {
      const rect = canvas.getBoundingClientRect();
      // turtle units per CSS pixel — driven by visible vertical extent.
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

    return {
      render, setPalette, zoomAt, reset, view,
      backend: 'webgpu',
    };
  }

  window.GPULSystemRenderer = { tryCreate };
})();

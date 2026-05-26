/* GPU subdivision renderer (cantor, menger).
   Fragment shader over a fullscreen quad. Each pixel maps uv → unit-square
   coords via a (cx, cy, extent) view, then tests set membership using base-3
   digit decomposition. */

(function () {
  const KIND_CODE = { cantor: 1, menger: 2 };

  const WGSL = `
struct P {
  resolution : vec2<f32>,
  view_c     : vec2<f32>,
  view_ext   : f32,
  depth      : u32,
  kind       : u32,
  pad0       : u32,
  accent     : vec3<f32>,
};

@group(0) @binding(0) var<uniform> p: P;

struct VsOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VsOut {
  var positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 3.0, -1.0),
    vec2<f32>(-1.0,  3.0),
  );
  var uvs = array<vec2<f32>, 3>(
    vec2<f32>(0.0, 1.0),
    vec2<f32>(2.0, 1.0),
    vec2<f32>(0.0, -1.0),
  );
  var o: VsOut;
  o.pos = vec4<f32>(positions[vi], 0.0, 1.0);
  o.uv  = uvs[vi];
  return o;
}

fn in_cantor(x: f32, d: u32) -> bool {
  var xx = x;
  for (var i = 0u; i < d; i = i + 1u) {
    xx = xx * 3.0;
    let dig = u32(floor(xx));
    if (dig == 1u) { return false; }
    xx = xx - f32(dig);
  }
  return true;
}

fn in_menger(x: f32, y: f32, d: u32) -> bool {
  var xx = x;
  var yy = y;
  for (var i = 0u; i < d; i = i + 1u) {
    xx = xx * 3.0;
    yy = yy * 3.0;
    let dx = u32(floor(xx));
    let dy = u32(floor(yy));
    if (dx == 1u && dy == 1u) { return false; }
    xx = xx - f32(dx);
    yy = yy - f32(dy);
  }
  return true;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4<f32> {
  let u = in.uv.x;
  let v = in.uv.y;
  let bg = vec3<f32>(10.0/255.0, 10.0/255.0, 10.0/255.0);
  let acc = p.accent;

  // Map canvas uv (∈ [0,1]) into unit-square coords via the view window.
  // x spans extent * aspect; y spans extent. Keeps pixels square on
  // non-1:1 canvases.
  let aspect = p.resolution.x / p.resolution.y;
  let xRange = p.view_ext * aspect;
  let xn = p.view_c.x + (u - 0.5) * xRange;
  let yn = p.view_c.y + (v - 0.5) * p.view_ext;

  if (p.kind == 1u) {
    // Cantor: stack of rows in unit-square; 8% top pad, 84% usable
    let yPad = 0.08;
    let yUsable = 0.84;
    let rows = p.depth + 1u;
    let rowH = yUsable / f32(rows);

    if (yn < yPad || yn > yPad + yUsable) { return vec4<f32>(bg, 1.0); }
    let rowIdx = u32(floor((yn - yPad) / rowH));
    if (rowIdx >= rows) { return vec4<f32>(bg, 1.0); }

    // Cantor's x range is [0,1] inside the unit-square; no padding.
    if (xn < 0.0 || xn > 1.0) { return vec4<f32>(bg, 1.0); }

    if (in_cantor(xn, rowIdx)) {
      let fade = max(0.4, 1.0 - f32(rowIdx) / (f32(p.depth) * 1.4));
      return vec4<f32>(mix(bg, acc, fade), 1.0);
    }
    return vec4<f32>(bg, 1.0);
  }

  // Menger: unit-square is the whole carpet.
  if (xn < 0.0 || xn > 1.0 || yn < 0.0 || yn > 1.0) { return vec4<f32>(bg, 1.0); }
  if (in_menger(xn, yn, p.depth)) {
    return vec4<f32>(acc, 1.0);
  }
  return vec4<f32>(bg, 1.0);
}
`;

  async function tryCreate({ canvas, palette, params, onProgress }) {
    const kindCode = KIND_CODE[params.kind];
    if (!kindCode) return null;
    const prep = await WebGPUDevice.prepare();
    if (!prep) return null;
    const { device, format } = prep;

    let module, pipeline;
    try {
      module = device.createShaderModule({ code: WGSL });
      pipeline = device.createRenderPipeline({
        layout: 'auto',
        vertex:   { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format }] },
        primitive: { topology: 'triangle-list' },
      });
    } catch (err) {
      console.warn('[subdivision-gpu] init failed:', err);
      return null;
    }

    const ctx = WebGPUDevice.attach(canvas, device, format);
    if (!ctx) return null;

    // 48-byte uniform layout (WGSL std140-style alignment):
    //  0.. 8  resolution (vec2)
    //  8..16  view_c (vec2)
    // 16..20  view_ext (f32)
    // 20..24  depth (u32)
    // 24..28  kind (u32)
    // 28..32  pad
    // 32..44  accent (vec3 padded to 16)
    const uniformBuf = device.createBuffer({
      size: 48,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    let accent = (palette.accent || [124, 255, 107]).slice();

    const baseDepth = params.depth ?? (params.kind === 'cantor' ? 8 : 5);
    const maxDepth  = params.kind === 'cantor' ? 18 : 9;
    const defaultView = { cx: 0.5, cy: 0.5, extent: 1.0 };
    const view = { ...defaultView };

    function chooseDepth() {
      if (view.extent >= 1) return baseDepth;
      const bump = Math.ceil(Math.log(1 / view.extent) / Math.log(3));
      return Math.min(maxDepth, baseDepth + bump);
    }

    function writeUniforms(w, h, depth) {
      const buf = new ArrayBuffer(48);
      const f = new Float32Array(buf);
      const u = new Uint32Array(buf);
      f[0] = w; f[1] = h;
      f[2] = view.cx; f[3] = view.cy;
      f[4] = view.extent;
      u[5] = depth;
      u[6] = kindCode;
      u[7] = 0;
      f[8] = accent[0] / 255;
      f[9] = accent[1] / 255;
      f[10] = accent[2] / 255;
      device.queue.writeBuffer(uniformBuf, 0, buf);
    }

    async function render() {
      const w = canvas.width, h = canvas.height;
      if (!w || !h) return;
      const depth = chooseDepth();
      writeUniforms(w, h, depth);

      const t0 = performance.now();
      const bg = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: uniformBuf } }],
      });
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: ctx.getCurrentTexture().createView(),
          loadOp: 'clear',
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          storeOp: 'store',
        }],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bg);
      pass.draw(3);
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

    return {
      render, setPalette, zoomAt, reset, view,
      backend: 'webgpu',
    };
  }

  window.GPUSubdivisionRenderer = { tryCreate };
})();

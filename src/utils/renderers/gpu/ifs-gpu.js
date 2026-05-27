/* GPU IFS renderer.

   Three compute passes:
     1) chaos game — N parallel particles, each iterates M steps, atomic-adds into a density buffer
     2) max reduce — atomicMax over the density buffer
     3) colorize  — write rgba storage texture using log(density)/log(max) curve
   Then blit to canvas. */

(function () {
  // Transforms are (a, b, c, d, e, f, p_cumulative). p_cumulative is sorted ascending,
  // chosen per chaos-game step by drawing r ∈ [0,1] and picking the first t with r ≤ p.
  const SYSTEMS = {
    sierpinski: {
      bounds: [0, 0, 1, 0.6],
      transforms: [
        { a: 0.5, b: 0, c: 0, d: 0.5, e: 0,    f: 0,   p: 1/3 },
        { a: 0.5, b: 0, c: 0, d: 0.5, e: 0.5,  f: 0,   p: 2/3 },
        { a: 0.5, b: 0, c: 0, d: 0.5, e: 0.25, f: 0.5, p: 1.0 },
      ],
    },
    barnsley: {
      bounds: [-2.5, 0, 2.5, 10],
      transforms: [
        { a:  0.00, b:  0.00, c:  0.00, d: 0.16, e: 0.00, f: 0.00, p: 0.01 },
        { a:  0.85, b:  0.04, c: -0.04, d: 0.85, e: 0.00, f: 1.60, p: 0.86 },
        { a:  0.20, b: -0.26, c:  0.23, d: 0.22, e: 0.00, f: 1.60, p: 0.93 },
        { a: -0.15, b:  0.28, c:  0.26, d: 0.24, e: 0.00, f: 0.44, p: 1.00 },
      ],
    },
  };

  const CHAOS_WGSL = `
struct Transform {
  abef : vec4<f32>,  // a, b, e, f
  cdp  : vec4<f32>,  // c, d, p_cumulative, _pad
};

struct P {
  resolution        : vec2<f32>,
  view_center       : vec2<f32>,
  view_extent       : f32,        // visible vertical extent in IFS-space
  iter_per_particle : u32,
  num_transforms    : u32,
  warmup            : u32,
  seed_offset       : u32,
};

@group(0) @binding(0) var<storage, read_write> density : array<atomic<u32>>;
@group(0) @binding(1) var<uniform> p : P;
@group(0) @binding(2) var<uniform> transforms : array<Transform, 4>;

fn next_rand(state_ptr: ptr<function, u32>) -> f32 {
  var s = *state_ptr;
  s = s ^ (s << 13u);
  s = s ^ (s >> 17u);
  s = s ^ (s << 5u);
  *state_ptr = s;
  return f32(s) * (1.0 / 4294967296.0);
}

fn step_chaos(x: f32, y: f32, sel: u32) -> vec2<f32> {
  let t = transforms[sel];
  let nx = t.abef.x * x + t.abef.y * y + t.abef.z;
  let ny = t.cdp.x  * x + t.cdp.y  * y + t.abef.w;
  return vec2<f32>(nx, ny);
}

@compute @workgroup_size(64)
fn cs_chaos(@builtin(global_invocation_id) gid: vec3<u32>) {
  // unique RNG seed per invocation; avoid 0 (xorshift fixed point)
  var state: u32 = (gid.x * 2654435761u) ^ p.seed_offset;
  if (state == 0u) { state = 1u; }
  var x: f32 = 0.0;
  var y: f32 = 0.0;

  for (var i = 0u; i < p.warmup; i = i + 1u) {
    let r = next_rand(&state);
    var sel: u32 = p.num_transforms - 1u;
    for (var k = 0u; k < p.num_transforms; k = k + 1u) {
      if (r <= transforms[k].cdp.z) { sel = k; break; }
    }
    let nxy = step_chaos(x, y, sel);
    x = nxy.x; y = nxy.y;
  }

  // pixels per IFS unit, driven by visible vertical extent
  let s = p.resolution.y / p.view_extent;
  let ox = p.resolution.x * 0.5 - p.view_center.x * s;
  let oy = p.resolution.y * 0.5 + p.view_center.y * s;
  let w = u32(p.resolution.x);
  let h = u32(p.resolution.y);

  for (var i = 0u; i < p.iter_per_particle; i = i + 1u) {
    let r = next_rand(&state);
    var sel: u32 = p.num_transforms - 1u;
    for (var k = 0u; k < p.num_transforms; k = k + 1u) {
      if (r <= transforms[k].cdp.z) { sel = k; break; }
    }
    let nxy = step_chaos(x, y, sel);
    x = nxy.x; y = nxy.y;

    let pxF = ox + x * s;
    let pyF = oy - y * s;
    let px = i32(floor(pxF));
    let py = i32(floor(pyF));
    if (px >= 0 && px < i32(w) && py >= 0 && py < i32(h)) {
      let idx = u32(py) * w + u32(px);
      atomicAdd(&density[idx], 1u);
    }
  }
}
`;

  const COLORIZE_WGSL = `
struct C {
  resolution : vec2<f32>,
  accent     : vec3<f32>,
};

@group(0) @binding(0) var<storage, read> density : array<u32>;
@group(0) @binding(1) var<storage, read> max_density : u32;
@group(0) @binding(2) var output : texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(3) var<uniform> c : C;

@compute @workgroup_size(8, 8)
fn cs_color(@builtin(global_invocation_id) gid: vec3<u32>) {
  let w = u32(c.resolution.x);
  let h = u32(c.resolution.y);
  if (gid.x >= w || gid.y >= h) { return; }
  let idx = gid.y * w + gid.x;
  let d = density[idx];
  let bg = vec3<f32>(10.0/255.0, 10.0/255.0, 10.0/255.0);
  var color: vec4<f32>;
  if (d == 0u) {
    color = vec4<f32>(bg, 1.0);
  } else {
    let logMax = max(log(f32(max_density) + 1.0), 0.001);
    let t = log(f32(d) + 1.0) / logMax;
    let tt = pow(min(t, 1.0), 0.6);
    color = vec4<f32>(mix(bg, c.accent, tt), 1.0);
  }
  textureStore(output, vec2<i32>(i32(gid.x), i32(gid.y)), color);
}
`;

  const REDUCE_WGSL = `
@group(0) @binding(0) var<storage, read> density : array<u32>;
@group(0) @binding(1) var<storage, read_write> max_density : atomic<u32>;

struct R { count : u32 };
@group(0) @binding(2) var<uniform> r : R;

@compute @workgroup_size(256)
fn cs_max(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= r.count) { return; }
  let v = density[gid.x];
  atomicMax(&max_density, v);
}
`;

  async function tryCreate({ canvas, palette, params, onProgress }) {
    const sys = SYSTEMS[params.kind];
    if (!sys) return null;
    const prep = await WebGPUDevice.prepare();
    if (!prep) return null;
    const { device, format } = prep;
    let accent = palette.accent || [124, 255, 107];

    let chaosPipeline, reducePipeline, colorizePipeline;
    try {
      const chaosModule    = device.createShaderModule({ code: CHAOS_WGSL });
      const reduceModule   = device.createShaderModule({ code: REDUCE_WGSL });
      const colorizeModule = device.createShaderModule({ code: COLORIZE_WGSL });
      chaosPipeline    = device.createComputePipeline({ layout: 'auto', compute: { module: chaosModule,    entryPoint: 'cs_chaos' } });
      reducePipeline   = device.createComputePipeline({ layout: 'auto', compute: { module: reduceModule,   entryPoint: 'cs_max'   } });
      colorizePipeline = device.createComputePipeline({ layout: 'auto', compute: { module: colorizeModule, entryPoint: 'cs_color' } });
    } catch (err) {
      console.warn('[ifs-gpu] init failed:', err);
      return null;
    }

    const ctx = WebGPUDevice.attach(canvas, device, format);
    if (!ctx) return null;

    // particle dispatch — total points scales linearly with zoom level so a
    // narrower view still gets enough samples landing inside the viewport.
    const BASE_POINTS = params.iterations || 600_000;
    const MAX_POINTS  = 32_000_000;
    const PARTICLES = 4096;     // workgroup count × 64

    // View state in IFS-space.
    const [xmin, ymin, xmax, ymax] = sys.bounds;
    const padding = 0.06;
    const defaultView = {
      cx: (xmin + xmax) * 0.5,
      cy: (ymin + ymax) * 0.5,
      extent: (ymax - ymin) / (1 - 2 * padding),
    };
    const view = { ...defaultView };

    function iterPerParticleForView() {
      const zoom = Math.max(1, defaultView.extent / view.extent);
      const total = Math.min(MAX_POINTS, Math.round(BASE_POINTS * zoom));
      return Math.ceil(total / PARTICLES);
    }

    // ---- transforms uniform (always 4 transforms of 32 bytes = 128) ----
    const transformsBuf = device.createBuffer({
      size: 128,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const tarr = new Float32Array(32); // 4 transforms × 8 floats each
    for (let i = 0; i < 4; i++) {
      const t = sys.transforms[i] || { a: 0, b: 0, c: 0, d: 0, e: 0, f: 0, p: 1.01 };
      // abef
      tarr[i * 8 + 0] = t.a;
      tarr[i * 8 + 1] = t.b;
      tarr[i * 8 + 2] = t.e;
      tarr[i * 8 + 3] = t.f;
      // cdp_pad
      tarr[i * 8 + 4] = t.c;
      tarr[i * 8 + 5] = t.d;
      tarr[i * 8 + 6] = t.p;
      tarr[i * 8 + 7] = 0;
    }
    device.queue.writeBuffer(transformsBuf, 0, tarr.buffer);

    // chaos uniform — 48 bytes
    const chaosUniformBuf = device.createBuffer({
      size: 48,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    let densityBuf = null;
    let maxBuf = null;
    let storageTex = null;
    let bufW = 0, bufH = 0;
    function ensureSizedBuffers(w, h) {
      if (densityBuf && bufW === w && bufH === h) return;
      densityBuf?.destroy?.();
      maxBuf?.destroy?.();
      storageTex?.destroy?.();
      densityBuf = device.createBuffer({
        size: w * h * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      maxBuf = device.createBuffer({
        size: 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      storageTex = device.createTexture({
        size: [w, h, 1],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
      });
      bufW = w; bufH = h;
    }

    function writeChaosUniform(w, h, iterPerParticle) {
      const ab = new ArrayBuffer(48);
      const f = new Float32Array(ab);
      const u = new Uint32Array(ab);
      // struct P layout (WGSL):
      //   0..8   resolution (vec2)
      //   8..16  view_center (vec2)
      //  16..20  view_extent (f32)
      //  20..24  iter_per_particle (u32)
      //  24..28  num_transforms (u32)
      //  28..32  warmup (u32)
      //  32..36  seed_offset (u32)
      f[0] = w; f[1] = h;
      f[2] = view.cx; f[3] = view.cy;
      f[4] = view.extent;
      u[5] = iterPerParticle;
      u[6] = sys.transforms.length;
      u[7] = 20;
      u[8] = (Math.random() * 0xffffffff) >>> 0;
      device.queue.writeBuffer(chaosUniformBuf, 0, ab);
    }

    // reduce uniform — single u32 count
    const reduceUniformBuf = device.createBuffer({
      size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // colorize uniform — 32 bytes (vec2 + vec3 padded)
    const colorizeUniformBuf = device.createBuffer({
      size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    function writeColorizeUniform(w, h) {
      const ab = new ArrayBuffer(32);
      const f = new Float32Array(ab);
      f[0] = w; f[1] = h;
      f[4] = accent[0] / 255;
      f[5] = accent[1] / 255;
      f[6] = accent[2] / 255;
      device.queue.writeBuffer(colorizeUniformBuf, 0, ab);
    }

    async function render() {
      const w = canvas.width, h = canvas.height;
      if (!w || !h) return;
      ensureSizedBuffers(w, h);

      const t0 = performance.now();

      // clear density and max
      device.queue.writeBuffer(densityBuf, 0, new Uint32Array(w * h).buffer);
      device.queue.writeBuffer(maxBuf, 0, new Uint32Array([0]).buffer);

      const iterPerParticle = iterPerParticleForView();
      writeChaosUniform(w, h, iterPerParticle);
      writeColorizeUniform(w, h);
      const count = w * h;
      device.queue.writeBuffer(reduceUniformBuf, 0, new Uint32Array([count, 0, 0, 0]).buffer);

      const encoder = device.createCommandEncoder();

      // pass 1: chaos
      {
        const bg = device.createBindGroup({
          layout: chaosPipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: densityBuf } },
            { binding: 1, resource: { buffer: chaosUniformBuf } },
            { binding: 2, resource: { buffer: transformsBuf } },
          ],
        });
        const pass = encoder.beginComputePass();
        pass.setPipeline(chaosPipeline);
        pass.setBindGroup(0, bg);
        pass.dispatchWorkgroups(Math.ceil(PARTICLES / 64));
        pass.end();
      }

      // pass 2: reduce max
      {
        const bg = device.createBindGroup({
          layout: reducePipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: densityBuf } },
            { binding: 1, resource: { buffer: maxBuf } },
            { binding: 2, resource: { buffer: reduceUniformBuf } },
          ],
        });
        const pass = encoder.beginComputePass();
        pass.setPipeline(reducePipeline);
        pass.setBindGroup(0, bg);
        pass.dispatchWorkgroups(Math.ceil(count / 256));
        pass.end();
      }

      // pass 3: colorize
      {
        const bg = device.createBindGroup({
          layout: colorizePipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: densityBuf } },
            { binding: 1, resource: { buffer: maxBuf } },
            { binding: 2, resource: storageTex.createView() },
            { binding: 3, resource: { buffer: colorizeUniformBuf } },
          ],
        });
        const pass = encoder.beginComputePass();
        pass.setPipeline(colorizePipeline);
        pass.setBindGroup(0, bg);
        pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
        pass.end();
      }

      device.queue.submit([encoder.finish()]);
      WebGPUDevice.blitToCanvas(device, ctx, format, storageTex);
      await device.queue.onSubmittedWorkDone?.();

      onProgress?.({
        pct: 1, pass: 'done',
        elapsed: performance.now() - t0,
        maxIter: iterPerParticle * PARTICLES,
      });
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
      // IFS y increases upward; screen y increases downward.
      view.cx += dx;
      view.cy -= dy;
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

  window.GPUIFSRenderer = { tryCreate };
})();

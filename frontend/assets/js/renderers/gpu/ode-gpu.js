/* GPU ODE renderer (Lorenz attractor).

   Same three-pass structure as the IFS renderer, but the inner kernel
   runs RK4 integration steps instead of chaos-game iterations. Many
   parallel trajectories started from slightly different initial points
   trace out the attractor faster than a single trajectory could. */

(function () {
  const INTEGRATE_WGSL = `
struct P {
  resolution    : vec2<f32>,
  bounds_min    : vec2<f32>,    // (xmin, zmin) in projected space
  bounds_max    : vec2<f32>,    // (xmax, zmax)
  steps_per_particle : u32,
  warmup        : u32,
  seed_offset   : u32,
  _pad          : u32,
  sigma         : f32,
  rho           : f32,
  beta          : f32,
  dt            : f32,
};

@group(0) @binding(0) var<storage, read_write> density : array<atomic<u32>>;
@group(0) @binding(1) var<uniform> p : P;

fn next_rand(state_ptr: ptr<function, u32>) -> f32 {
  var s = *state_ptr;
  s = s ^ (s << 13u);
  s = s ^ (s >> 17u);
  s = s ^ (s << 5u);
  *state_ptr = s;
  return f32(s) * (1.0 / 4294967296.0);
}

fn derive(s: vec3<f32>) -> vec3<f32> {
  return vec3<f32>(
    p.sigma * (s.y - s.x),
    s.x * (p.rho - s.z) - s.y,
    s.x * s.y - p.beta * s.z,
  );
}

fn rk4(s: vec3<f32>) -> vec3<f32> {
  let dt = p.dt;
  let k1 = derive(s);
  let k2 = derive(s + 0.5 * dt * k1);
  let k3 = derive(s + 0.5 * dt * k2);
  let k4 = derive(s + dt * k3);
  return s + dt * (k1 + 2.0 * k2 + 2.0 * k3 + k4) * (1.0 / 6.0);
}

@compute @workgroup_size(64)
fn cs_integrate(@builtin(global_invocation_id) gid: vec3<u32>) {
  var state: u32 = (gid.x * 2654435761u) ^ p.seed_offset;
  if (state == 0u) { state = 1u; }

  // perturb initial conditions so trajectories diverge quickly via SDIC.
  // Sample around (0.1, 0, 0) with small random offsets.
  let rx = (next_rand(&state) - 0.5) * 0.2;
  let ry = (next_rand(&state) - 0.5) * 0.2;
  let rz = (next_rand(&state) - 0.5) * 0.2;
  var s = vec3<f32>(0.1 + rx, 0.0 + ry, 0.0 + rz);

  for (var i = 0u; i < p.warmup; i = i + 1u) {
    s = rk4(s);
  }

  // Projection: (x, z) → 2D
  let bx = p.bounds_min.x;
  let by = p.bounds_min.y;
  let bxr = p.bounds_max.x - bx;
  let byr = p.bounds_max.y - by;
  let sx = (p.resolution.x * 0.88) / bxr;
  let sy = (p.resolution.y * 0.88) / byr;
  let scl = min(sx, sy);
  let xc = (bx + p.bounds_max.x) * 0.5;
  let yc = (by + p.bounds_max.y) * 0.5;
  let ox = p.resolution.x * 0.5 - xc * scl;
  let oy = p.resolution.y * 0.5 + yc * scl;
  let w = u32(p.resolution.x);
  let h = u32(p.resolution.y);

  for (var i = 0u; i < p.steps_per_particle; i = i + 1u) {
    s = rk4(s);
    let pxF = ox + s.x * scl;
    let pyF = oy - s.z * scl;
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
    let tt = pow(min(t, 1.0), 0.55);
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
  atomicMax(&max_density, density[gid.x]);
}
`;

  async function tryCreate({ canvas, palette, params, onProgress }) {
    if (params.kind !== 'lorenz') return null;
    const prep = await WebGPUDevice.prepare();
    if (!prep) return null;
    const { device, format } = prep;
    let accent = palette.accent || [124, 255, 107];

    let integratePipeline, reducePipeline, colorizePipeline;
    try {
      const integrateModule = device.createShaderModule({ code: INTEGRATE_WGSL });
      const reduceModule    = device.createShaderModule({ code: REDUCE_WGSL });
      const colorizeModule  = device.createShaderModule({ code: COLORIZE_WGSL });
      integratePipeline = device.createComputePipeline({ layout: 'auto', compute: { module: integrateModule, entryPoint: 'cs_integrate' } });
      reducePipeline    = device.createComputePipeline({ layout: 'auto', compute: { module: reduceModule,    entryPoint: 'cs_max' } });
      colorizePipeline  = device.createComputePipeline({ layout: 'auto', compute: { module: colorizeModule,  entryPoint: 'cs_color' } });
    } catch (err) {
      console.warn('[ode-gpu] init failed:', err);
      return null;
    }

    const ctx = WebGPUDevice.attach(canvas, device, format);
    if (!ctx) return null;

    // Tuned for ~250k–500k total integration steps at default zoom; scales up
    // with zoom level since less of the attractor is visible.
    const PARTICLES = 2048;
    const BASE_STEPS_PER_PARTICLE = 600;
    const MAX_STEPS_PER_PARTICLE  = 16_000;
    const BOUNDS = [-25, 0, 25, 50]; // x, z, x, z — used to derive the default view

    const defaultView = {
      cx: (BOUNDS[0] + BOUNDS[2]) * 0.5,
      cy: (BOUNDS[1] + BOUNDS[3]) * 0.5,
      extent: (BOUNDS[3] - BOUNDS[1]) / 0.88,
    };
    const view = { ...defaultView };

    function stepsForView() {
      const zoom = Math.max(1, defaultView.extent / view.extent);
      return Math.min(MAX_STEPS_PER_PARTICLE, Math.round(BASE_STEPS_PER_PARTICLE * zoom));
    }

    const integrateUniformBuf = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const reduceUniformBuf    = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const colorizeUniformBuf  = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

    let densityBuf = null, maxBuf = null, storageTex = null;
    let bufW = 0, bufH = 0;
    function ensureSizedBuffers(w, h) {
      if (densityBuf && bufW === w && bufH === h) return;
      densityBuf?.destroy?.(); maxBuf?.destroy?.(); storageTex?.destroy?.();
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

    function writeIntegrateUniform(w, h, steps) {
      const ab = new ArrayBuffer(64);
      const f = new Float32Array(ab);
      const u = new Uint32Array(ab);
      const aspect = w / h;
      const halfX = view.extent * aspect * 0.5;
      const halfY = view.extent * 0.5;
      f[0] = w; f[1] = h;
      f[2] = view.cx - halfX; f[3] = view.cy - halfY; // bounds_min
      f[4] = view.cx + halfX; f[5] = view.cy + halfY; // bounds_max
      u[6] = steps;
      u[7] = 200;
      u[8] = (Math.random() * 0xffffffff) >>> 0;
      u[9] = 0;
      f[10] = 10;
      f[11] = 28;
      f[12] = 8 / 3;
      f[13] = 0.005;
      device.queue.writeBuffer(integrateUniformBuf, 0, ab);
    }

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
      device.queue.writeBuffer(densityBuf, 0, new Uint32Array(w * h).buffer);
      device.queue.writeBuffer(maxBuf, 0, new Uint32Array([0]).buffer);
      const steps = stepsForView();
      writeIntegrateUniform(w, h, steps);
      writeColorizeUniform(w, h);
      device.queue.writeBuffer(reduceUniformBuf, 0, new Uint32Array([w * h, 0, 0, 0]).buffer);

      const encoder = device.createCommandEncoder();
      {
        const bg = device.createBindGroup({
          layout: integratePipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: densityBuf } },
            { binding: 1, resource: { buffer: integrateUniformBuf } },
          ],
        });
        const pass = encoder.beginComputePass();
        pass.setPipeline(integratePipeline);
        pass.setBindGroup(0, bg);
        pass.dispatchWorkgroups(Math.ceil(PARTICLES / 64));
        pass.end();
      }
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
        pass.dispatchWorkgroups(Math.ceil((w * h) / 256));
        pass.end();
      }
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
        maxIter: PARTICLES * steps,
      });
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
      view.cx += dx;
      view.cy -= dy;     // projected y is up; screen y is down
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

  window.GPUODERenderer = { tryCreate };
})();

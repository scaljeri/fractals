/* GPU ODE renderer (Lorenz attractor).

   Many parallel trajectories started from slightly different initial points
   trace out the attractor via RK4. Two accumulator buffers are kept:
   `density` (bilinear-splatted hit count) and `y_sum` (same, weighted by the
   normalized 3rd-axis coordinate). The colorize pass then samples the full
   palette gradient by avg-y at each pixel — front and back lobes of the
   butterfly pick contrasting hues, giving a strong 3D depth cue. */

(function () {
  // Default Lorenz variant — used when params.variant is missing.
  const DEFAULT_VARIANT = {
    sigma: 10, rho: 28, beta: 8/3,
    bounds: [-22, 0, 22, 50],
  };

  // For a given Lorenz variant, the y (depth) range used to normalize the
  // 3rd-axis coordinate into [0,1] for palette sampling. The y excursions
  // grow roughly with the x extent, so we scale from the variant's bounds.
  function yRangeFor(variant) {
    const xExtent = Math.max(Math.abs(variant.bounds[0]), Math.abs(variant.bounds[2]));
    const y = xExtent * 1.4;
    return [-y, y];
  }

  const INTEGRATE_WGSL = `
struct P {
  resolution    : vec2<f32>,
  bounds_min    : vec2<f32>,
  bounds_max    : vec2<f32>,
  steps_per_particle : u32,
  warmup        : u32,
  seed_offset   : u32,
  _pad          : u32,
  sigma         : f32,
  rho           : f32,
  beta          : f32,
  dt            : f32,
  y_min         : f32,
  y_range_inv   : f32,
};

@group(0) @binding(0) var<storage, read_write> density : array<atomic<u32>>;
@group(0) @binding(1) var<uniform> p : P;
@group(0) @binding(2) var<storage, read_write> y_sum : array<atomic<u32>>;

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

  // Disperse initial points across the variant's bounding volume so each
  // particle latches onto the attractor with a different phase. After warmup,
  // the population covers many overlapping orbits across the manifold —
  // visible as the fine spiral filaments inside each wing.
  let y_range = 1.0 / p.y_range_inv;
  let rx = mix(p.bounds_min.x, p.bounds_max.x, next_rand(&state));
  let rz = mix(p.bounds_min.y, p.bounds_max.y, next_rand(&state));
  let ry = p.y_min + next_rand(&state) * y_range;
  var s = vec3<f32>(rx, ry, rz);

  for (var i = 0u; i < p.warmup; i = i + 1u) {
    s = rk4(s);
  }

  // Project (x, z) → screen. bounds_min/max already account for aspect.
  let bxr = p.bounds_max.x - p.bounds_min.x;
  let byr = p.bounds_max.y - p.bounds_min.y;
  let scl = min(p.resolution.x / bxr, p.resolution.y / byr);
  let xc = (p.bounds_min.x + p.bounds_max.x) * 0.5;
  let yc = (p.bounds_min.y + p.bounds_max.y) * 0.5;
  let ox = p.resolution.x * 0.5 - xc * scl;
  let oy = p.resolution.y * 0.5 + yc * scl;
  let iw = i32(p.resolution.x);
  let ih = i32(p.resolution.y);

  // Y-depth is scaled to a fixed-point u32 so we can atomic-add and later
  // divide by density to recover an average. Range [0,1] → [0, Y_FP].
  let Y_FP = 1024.0;

  // Project starting point. Each iteration we'll draw a continuous line
  // segment from the previous projected position to the new one — point
  // splatting alone leaves gaps in the fast transit phase between lobes
  // (RK4 with dt=0.005 can advance ~7 pixels per step there), so the
  // butterfly looks like two disconnected blobs. DDA rasterization between
  // consecutive steps closes those gaps and reveals the spiral filaments.
  var pxPrev = ox + s.x * scl;
  var pyPrev = oy - s.z * scl;

  for (var i = 0u; i < p.steps_per_particle; i = i + 1u) {
    s = rk4(s);
    let pxCur = ox + s.x * scl;
    let pyCur = oy - s.z * scl;
    let dx = pxCur - pxPrev;
    let dy = pyCur - pyPrev;
    let segLen = max(abs(dx), abs(dy));
    let nSub = u32(clamp(segLen, 1.0, 64.0));
    let invN = 1.0 / f32(nSub);
    let stepDx = dx * invN;
    let stepDy = dy * invN;
    let y_norm = clamp((s.y - p.y_min) * p.y_range_inv, 0.0, 1.0);
    let y_quant = u32(y_norm * Y_FP);

    for (var k = 0u; k < nSub; k = k + 1u) {
      let kf = f32(k) + 0.5;
      let pxS = pxPrev + stepDx * kf;
      let pyS = pyPrev + stepDy * kf;
      let ix = i32(floor(pxS));
      let iy = i32(floor(pyS));
      if (ix >= 0 && ix < iw && iy >= 0 && iy < ih) {
        let idx = u32(iy) * u32(iw) + u32(ix);
        atomicAdd(&density[idx], 1u);
        atomicAdd(&y_sum[idx], y_quant);
      }
    }
    pxPrev = pxCur;
    pyPrev = pyCur;
  }
}
`;

  const COLORIZE_WGSL = `
struct C {
  resolution : vec2<f32>,
  pal_lo     : f32,    // palette param at y_norm = 0
  pal_hi     : f32,    // palette param at y_norm = 1
  gamma      : f32,
};

@group(0) @binding(0) var<storage, read> density : array<u32>;
@group(0) @binding(1) var<storage, read> max_density : u32;
@group(0) @binding(2) var output : texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(3) var<uniform> c : C;
@group(0) @binding(4) var<storage, read> y_sum : array<u32>;
@group(0) @binding(5) var palette : texture_1d<f32>;
@group(0) @binding(6) var samp : sampler;

@compute @workgroup_size(8, 8)
fn cs_color(@builtin(global_invocation_id) gid: vec3<u32>) {
  let w = u32(c.resolution.x);
  let h = u32(c.resolution.y);
  if (gid.x >= w || gid.y >= h) { return; }
  let idx = gid.y * w + gid.x;
  let d = density[idx];
  let bg = vec3<f32>(8.0/255.0, 8.0/255.0, 10.0/255.0);
  var color: vec4<f32>;
  if (d == 0u) {
    color = vec4<f32>(bg, 1.0);
  } else {
    let Y_FP = 1024.0;
    let logMax = max(log(f32(max_density) + 1.0), 0.001);
    // Mild stretch so the bright outer spine saturates while the dim transit
    // bridges between lobes (only a handful of hits per pixel) stay visible.
    let t = clamp(log(f32(d) + 1.0) / logMax * 1.15, 0.0, 1.0);
    let bright = pow(t, c.gamma);
    let y_avg = clamp(f32(y_sum[idx]) / (f32(d) * Y_FP), 0.0, 1.0);
    let pal_t = mix(c.pal_lo, c.pal_hi, y_avg);
    let hue = textureSampleLevel(palette, samp, pal_t, 0.0).rgb;
    color = vec4<f32>(mix(bg, hue, bright), 1.0);
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

    let lut = PaletteLUT.buildLUT(palette.stops);
    let paletteTex = WebGPUPalette.uploadPaletteLUT(device, lut);
    const sampler = WebGPUPalette.makeLinearSampler(device);

    const PARTICLES = 2048;
    const BASE_STEPS_PER_PARTICLE = 600;
    const MAX_STEPS_PER_PARTICLE  = 16_000;

    let variant = params.variant || DEFAULT_VARIANT;
    let [yMin, yMax] = yRangeFor(variant);

    const defaultView = {
      cx: (variant.bounds[0] + variant.bounds[2]) * 0.5,
      cy: (variant.bounds[1] + variant.bounds[3]) * 0.5,
      extent: (variant.bounds[3] - variant.bounds[1]) / 0.88,
    };
    const view = { ...defaultView };

    function stepsForView() {
      const zoom = Math.max(1, defaultView.extent / view.extent);
      return Math.min(MAX_STEPS_PER_PARTICLE, Math.round(BASE_STEPS_PER_PARTICLE * zoom));
    }

    const integrateUniformBuf = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const reduceUniformBuf    = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const colorizeUniformBuf  = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

    let densityBuf = null, ySumBuf = null, maxBuf = null, storageTex = null;
    let bufW = 0, bufH = 0;
    function ensureSizedBuffers(w, h) {
      if (densityBuf && bufW === w && bufH === h) return;
      densityBuf?.destroy?.(); ySumBuf?.destroy?.(); maxBuf?.destroy?.(); storageTex?.destroy?.();
      densityBuf = device.createBuffer({
        size: w * h * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      ySumBuf = device.createBuffer({
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
      // Larger-ρ regimes have faster trajectories — shorten dt so consecutive
      // RK4 steps don't span enormous pixel distances. dt scales with the
      // characteristic time 1/sqrt(ρ).
      const dt = 0.005 * Math.sqrt(28 / Math.max(variant.rho, 1));
      f[0] = w; f[1] = h;
      f[2] = view.cx - halfX; f[3] = view.cy - halfY;
      f[4] = view.cx + halfX; f[5] = view.cy + halfY;
      u[6] = steps;
      u[7] = 1000;                                 // warmup
      u[8] = (Math.random() * 0xffffffff) >>> 0;
      u[9] = 0;
      f[10] = variant.sigma;
      f[11] = variant.rho;
      f[12] = variant.beta;
      f[13] = dt;
      f[14] = yMin;
      f[15] = 1.0 / (yMax - yMin);
      device.queue.writeBuffer(integrateUniformBuf, 0, ab);
    }

    function writeColorizeUniform(w, h) {
      const ab = new ArrayBuffer(32);
      const f = new Float32Array(ab);
      f[0] = w; f[1] = h;
      // Sample the palette across most of its range — depth (y) at the
      // extremes of the attractor picks the gradient endpoints, the middle
      // crossings pick the gradient middle. 0.08..0.92 keeps colors lively
      // without clipping to pure black at the ends.
      f[2] = 0.08;
      f[3] = 0.92;
      f[4] = 0.9;    // tone-curve gamma; mild dark-lift after the t-stretch
      device.queue.writeBuffer(colorizeUniformBuf, 0, ab);
    }

    async function render() {
      const w = canvas.width, h = canvas.height;
      if (!w || !h) return;
      ensureSizedBuffers(w, h);

      const t0 = performance.now();
      const zeros = new Uint32Array(w * h);
      device.queue.writeBuffer(densityBuf, 0, zeros.buffer);
      device.queue.writeBuffer(ySumBuf,    0, zeros.buffer);
      device.queue.writeBuffer(maxBuf,     0, new Uint32Array([0]).buffer);
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
            { binding: 2, resource: { buffer: ySumBuf } },
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
            { binding: 4, resource: { buffer: ySumBuf } },
            { binding: 5, resource: paletteTex.createView({ dimension: '1d' }) },
            { binding: 6, resource: sampler },
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
      lut = PaletteLUT.buildLUT(p.stops);
      paletteTex?.destroy?.();
      paletteTex = WebGPUPalette.uploadPaletteLUT(device, lut);
      render();
    }

    function setVariant(v) {
      variant = v || DEFAULT_VARIANT;
      [yMin, yMax] = yRangeFor(variant);
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

    return {
      render, setPalette, setVariant, zoomAt, reset, view,
      backend: 'webgpu',
    };
  }

  window.GPUODERenderer = { tryCreate };
})();

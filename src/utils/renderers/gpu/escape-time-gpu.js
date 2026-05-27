/* GPU escape-time renderer (julia / burning_ship / mandelbulb-slice).
   Single compute pipeline branches on `kind` uniform. */

(function () {
  const KIND_CODE = {
    julia: 1,
    burning_ship: 2,
    mandelbulb_slice: 3,
  };

  const WGSL = `
struct P {
  resolution : vec2<f32>,
  center     : vec2<f32>,
  scale      : f32,
  max_iter   : u32,
  kind       : u32,
  pal_shift  : f32,
  julia_c    : vec2<f32>,
};

@group(0) @binding(0) var output      : texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(1) var<uniform> p  : P;
@group(0) @binding(2) var palette     : texture_1d<f32>;
@group(0) @binding(3) var samp        : sampler;

fn smooth_iter(zr2: f32, zi2: f32, i: f32) -> f32 {
  let log_zn = log(zr2 + zi2) * 0.5;
  let nu = log(log_zn / log(2.0)) / log(2.0);
  return i + 1.0 - nu;
}

@compute @workgroup_size(8, 8)
fn cs_main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let w = u32(p.resolution.x);
  let h = u32(p.resolution.y);
  if (gid.x >= w || gid.y >= h) { return; }

  let cx = p.center.x + (f32(gid.x) - p.resolution.x * 0.5) * p.scale;
  let cy = p.center.y + (f32(gid.y) - p.resolution.y * 0.5) * p.scale;

  var zr: f32;
  var zi: f32;
  var cr: f32;
  var ci: f32;
  if (p.kind == 1u) {           // julia
    zr = cx; zi = cy;
    cr = p.julia_c.x; ci = p.julia_c.y;
  } else {                       // mandelbrot, burning_ship, mandelbulb-slice
    zr = 0.0; zi = 0.0;
    cr = cx;  ci = cy;
  }

  var zr2 = zr * zr;
  var zi2 = zi * zi;
  var i: u32 = 0u;
  let bailout = 256.0;
  let pwr = 8.0;  // mandelbulb power

  loop {
    if (i >= p.max_iter) { break; }
    if (zr2 + zi2 > bailout) { break; }

    if (p.kind == 2u) {
      // burning_ship: z := (|re| + i|im|)^2 + c
      let azr = abs(zr);
      let azi = abs(zi);
      let nzi = 2.0 * azr * azi + ci;
      let nzr = azr*azr - azi*azi + cr;
      zr = nzr; zi = nzi;
    } else if (p.kind == 3u) {
      // mandelbulb 2D slice: z := z^8 + c (in polar)
      let r = sqrt(zr2 + zi2);
      let theta = atan2(zi, zr) * pwr;
      let rp = pow(r, pwr);
      zr = rp * cos(theta) + cr;
      zi = rp * sin(theta) + ci;
    } else {
      // julia / mandelbrot: z := z^2 + c
      let nzi = 2.0 * zr * zi + ci;
      let nzr = zr2 - zi2 + cr;
      zr = nzr; zi = nzi;
    }

    zr2 = zr * zr;
    zi2 = zi * zi;
    i = i + 1u;
  }

  var color: vec4<f32>;
  if (i >= p.max_iter) {
    color = vec4<f32>(0.0, 0.0, 0.0, 1.0);
  } else {
    let si = smooth_iter(zr2, zi2, f32(i));
    var t = log(si + 1.0) * 0.20 + p.pal_shift;
    t = fract(t);
    if (t < 0.0) { t = t + 1.0; }
    color = textureSampleLevel(palette, samp, t, 0.0);
    color.a = 1.0;
  }

  textureStore(output, vec2<i32>(i32(gid.x), i32(gid.y)), color);
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
      pipeline = device.createComputePipeline({
        layout: 'auto',
        compute: { module, entryPoint: 'cs_main' },
      });
    } catch (err) {
      console.warn('[escape-time-gpu] init failed:', err);
      return null;
    }

    // Pipeline built successfully — safe to attach the canvas context now.
    const ctx = WebGPUDevice.attach(canvas, device, format);
    if (!ctx) return null;

    let storageTex = null;
    let storageW = 0, storageH = 0;
    function ensureStorageTexture(w, h) {
      if (storageTex && storageW === w && storageH === h) return;
      storageTex?.destroy?.();
      storageTex = device.createTexture({
        size: [w, h, 1],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
      });
      storageW = w; storageH = h;
    }

    let lut = PaletteLUT.buildLUT(palette.stops);
    let paletteTex = WebGPUPalette.uploadPaletteLUT(device, lut);
    const sampler = WebGPUPalette.makeLinearSampler(device);

    // 64-byte uniform buffer (aligned)
    const uniformBuf = device.createBuffer({
      size: 48,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const view = {
      cx: params.center?.[0] ?? 0,
      cy: params.center?.[1] ?? 0,
      extent: params.extent ?? 3.0,
    };

    function computeMaxIter() {
      const baseExtent = params.extent ?? 3.0;
      const zoomFactor = baseExtent / Math.max(1e-12, view.extent);
      // Burning ship's antennas are razor-thin; needs ~2x the iters of Mandelbrot
      // to resolve them at the same zoom.
      const baseIter = params.kind === 'burning_ship' ? 768 : 384;
      const m = Math.round(baseIter + 80 * Math.log10(Math.max(1, zoomFactor)));
      return Math.max(64, Math.min(8000, m));
    }

    function writeUniforms(w, h, maxIter) {
      const scale = view.extent / h;
      const buf = new ArrayBuffer(48);
      const f32 = new Float32Array(buf);
      const u32 = new Uint32Array(buf);
      f32[0] = w; f32[1] = h;
      f32[2] = view.cx; f32[3] = view.cy;
      f32[4] = scale;
      u32[5] = maxIter;
      u32[6] = kindCode;
      f32[7] = 0;                 // palette shift
      f32[8] = params.cr ?? 0;
      f32[9] = params.ci ?? 0;
      // pad to 48 bytes
      device.queue.writeBuffer(uniformBuf, 0, buf);
    }

    function buildBindGroup() {
      return device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: storageTex.createView() },
          { binding: 1, resource: { buffer: uniformBuf } },
          { binding: 2, resource: paletteTex.createView({ dimension: '1d' }) },
          { binding: 3, resource: sampler },
        ],
      });
    }

    async function render() {
      const w = canvas.width, h = canvas.height;
      if (w === 0 || h === 0) return;
      ensureStorageTexture(w, h);
      const maxIter = computeMaxIter();
      writeUniforms(w, h, maxIter);
      const bg = buildBindGroup();
      const t0 = performance.now();
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bg);
      pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
      pass.end();
      device.queue.submit([encoder.finish()]);

      WebGPUDevice.blitToCanvas(device, ctx, format, storageTex);

      // We don't have a precise "done" signal without onSubmittedWorkDone,
      // but for UI we can report progress 1 immediately.
      await device.queue.onSubmittedWorkDone?.();
      onProgress?.({
        pct: 1, pass: 'done',
        elapsed: performance.now() - t0,
        maxIter,
      });
    }

    function setPalette(p) {
      lut = PaletteLUT.buildLUT(p.stops);
      paletteTex?.destroy?.();
      paletteTex = WebGPUPalette.uploadPaletteLUT(device, lut);
      render();
    }

    function zoomAt(cssX, cssY, factor) {
      const rect = canvas.getBoundingClientRect();
      const u = (cssX - rect.left) / rect.width;
      const v = (cssY - rect.top) / rect.height;
      const halfW = view.extent * (rect.width / rect.height) * 0.5;
      const halfH = view.extent * 0.5;
      view.cx = view.cx - halfW + u * halfW * 2;
      view.cy = view.cy - halfH + v * halfH * 2;
      view.extent /= factor;
      render();
    }

    function reset() {
      view.cx = params.center?.[0] ?? 0;
      view.cy = params.center?.[1] ?? 0;
      view.extent = params.extent ?? 3.0;
      render();
    }

    return {
      render, setPalette, zoomAt, reset, view,
      workerCount: 'gpu',
      backend: 'webgpu',
    };
  }

  window.GPUEscapeTimeRenderer = { tryCreate };
})();

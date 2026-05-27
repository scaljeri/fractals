/* WebGPU device singleton + a blit-storage-to-canvas helper.

   Every GPU renderer goes through getDevice() and is expected to fall
   back to CPU rendering if it returns null. */

(function () {
  let devicePromise = null;

  async function getDevice() {
    if (devicePromise) return devicePromise;
    devicePromise = (async () => {
      if (!('gpu' in navigator)) return null;
      try {
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) return null;
        const device = await adapter.requestDevice();
        if (!device) return null;
        device.lost?.then?.(() => { devicePromise = null; });
        return device;
      } catch (err) {
        console.warn('[webgpu] device init failed:', err);
        return null;
      }
    })();
    return devicePromise;
  }

  /* Two-step canvas attach to keep the CPU fallback possible:
     - prepare() resolves the device + preferred format without touching the canvas
     - attach()  finalises the webgpu context (after which getContext('2d') will fail)
     GPU renderers should call prepare() first, build pipelines, then attach() last. */
  async function prepare() {
    const device = await getDevice();
    if (!device) return null;
    const format = navigator.gpu.getPreferredCanvasFormat();
    return { device, format };
  }

  function attach(canvas, device, format) {
    let ctx;
    try { ctx = canvas.getContext('webgpu'); }
    catch { return null; }
    if (!ctx) return null;
    ctx.configure({
      device,
      format,
      alphaMode: 'opaque',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST,
    });
    return ctx;
  }

  /* Convenience: prepare + attach in one call, for renderers that want it. */
  async function configureCanvas(canvas) {
    const prep = await prepare();
    if (!prep) return null;
    const ctx = attach(canvas, prep.device, prep.format);
    if (!ctx) return null;
    return { device: prep.device, ctx, format: prep.format };
  }

  /* Blit a sampled rgba8unorm texture onto the canvas via a fullscreen quad. */
  function makeBlitPipeline(device, canvasFormat) {
    const module = device.createShaderModule({
      code: `
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
        @group(0) @binding(0) var samp: sampler;
        @group(0) @binding(1) var tex:  texture_2d<f32>;
        @fragment
        fn fs(in: VsOut) -> @location(0) vec4<f32> {
          return textureSample(tex, samp, in.uv);
        }
      `,
    });
    return device.createRenderPipeline({
      layout: 'auto',
      vertex:   { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format: canvasFormat }] },
      primitive: { topology: 'triangle-list' },
    });
  }

  let _blitCache = new WeakMap();
  function getBlitPipeline(device, format) {
    let perFormat = _blitCache.get(device);
    if (!perFormat) { perFormat = new Map(); _blitCache.set(device, perFormat); }
    let pl = perFormat.get(format);
    if (!pl) { pl = makeBlitPipeline(device, format); perFormat.set(format, pl); }
    return pl;
  }

  /* Blit a 2D rgba8unorm `src` texture onto the canvas-bound `dest` view. */
  function blitToCanvas(device, ctx, format, srcTexture) {
    const pipeline = getBlitPipeline(device, format);
    const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    const view = srcTexture.createView();
    const bg = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: sampler },
        { binding: 1, resource: view },
      ],
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
  }

  window.WebGPUDevice = { getDevice, prepare, attach, configureCanvas, blitToCanvas };
})();

/* Upload a palette LUT (Uint8Array, 2048 × 4 RGBA) to a GPU texture.
   We use a 1D texture (WebGPU `1d`) so shaders can sample by smooth-iter. */

(function () {
  function uploadPaletteLUT(device, lut) {
    const size = lut.length / 4;
    const tex = device.createTexture({
      size: [size, 1, 1],
      dimension: '1d',
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture(
      { texture: tex },
      lut,
      { bytesPerRow: size * 4, rowsPerImage: 1 },
      { width: size, height: 1, depthOrArrayLayers: 1 },
    );
    return tex;
  }

  function makeLinearSampler(device) {
    return device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'repeat',
    });
  }

  window.WebGPUPalette = { uploadPaletteLUT, makeLinearSampler };
})();

/* Shared palette LUT + smooth-iter → color mapping.
   Used by every CPU-rendered fractal that produces an iteration-count map. */

const LUT_SIZE = 2048;

function buildLUT(stops) {
  const lut = new Uint8Array(LUT_SIZE * 4);
  for (let i = 0; i < LUT_SIZE; i++) {
    const t = i / (LUT_SIZE - 1);
    let a = stops[0], b = stops[stops.length - 1];
    for (let k = 0; k < stops.length - 1; k++) {
      if (t >= stops[k][0] && t <= stops[k + 1][0]) { a = stops[k]; b = stops[k + 1]; break; }
    }
    const span = b[0] - a[0];
    const f = span > 0 ? (t - a[0]) / span : 0;
    const ff = f * f * (3 - 2 * f);
    lut[i * 4    ] = (a[1][0] + (b[1][0] - a[1][0]) * ff) | 0;
    lut[i * 4 + 1] = (a[1][1] + (b[1][1] - a[1][1]) * ff) | 0;
    lut[i * 4 + 2] = (a[1][2] + (b[1][2] - a[1][2]) * ff) | 0;
    lut[i * 4 + 3] = 255;
  }
  return lut;
}

/* Map a smooth iteration count to a LUT index. The log mapping gives
   nice band density across zoom levels. */
function lutIndex(smoothIter, shift = 0) {
  if (smoothIter < 0) return -1;
  const t = Math.log(smoothIter + 1) * 0.20 + shift;
  let f = t - Math.floor(t);
  if (f < 0) f += 1;
  return (f * (LUT_SIZE - 1)) | 0;
}

/* Colorize a Float32Array of smooth-iter values into ImageData.
   Values <= -1 are treated as "in-set" and rendered black. */
function colorizeIters(iters, lut, w, h, shift = 0) {
  const img = new ImageData(w, h);
  const data = img.data;
  for (let p = 0; p < w * h; p++) {
    const v = iters[p];
    if (v < 0) {
      data[p * 4    ] = 0;
      data[p * 4 + 1] = 0;
      data[p * 4 + 2] = 0;
      data[p * 4 + 3] = 255;
    } else {
      const li = lutIndex(v, shift);
      data[p * 4    ] = lut[li * 4];
      data[p * 4 + 1] = lut[li * 4 + 1];
      data[p * 4 + 2] = lut[li * 4 + 2];
      data[p * 4 + 3] = 255;
    }
  }
  return img;
}

window.PaletteLUT = { LUT_SIZE, buildLUT, lutIndex, colorizeIters };

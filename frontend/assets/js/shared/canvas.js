/* Canvas sizing helpers — keeps a backing buffer at DPR-scaled size
   while CSS pixels stay viewport-sized. */

function sizeCanvasToViewport(canvas, { maxBufferW = 2160 } = {}) {
  const cssW = window.innerWidth;
  const cssH = window.innerHeight;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const bw = Math.min(Math.round(cssW * dpr), maxBufferW);
  const bh = Math.round(bw * (cssH / cssW));
  let changed = false;
  if (canvas.width !== bw)  { canvas.width = bw;  changed = true; }
  if (canvas.height !== bh) { canvas.height = bh; changed = true; }
  return { changed, w: bw, h: bh, cssW, cssH };
}

/* Promise-based requestAnimationFrame so renderers can yield to the
   browser between heavy slices. */
function nextFrame() {
  return new Promise(r => requestAnimationFrame(r));
}

window.CanvasUtils = { sizeCanvasToViewport, nextFrame };

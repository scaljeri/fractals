/* Escape-time worker. Computes a smooth iteration count per pixel for
   one of several "z := f(z, c) + …" type fractals. Inlined as a string so
   the host page can spawn workers without an extra HTTP round-trip. */

const ESCAPE_TIME_WORKER_SRC = `
self.onmessage = (e) => {
  const job = e.data;
  const { id, gen, kind, px0, py0, w, h, fullW, fullH, cx, cy, scale, maxIter, juliaCr, juliaCi } = job;
  const out = new Float32Array(w * h);
  const bailout = 256.0;

  const x0 = cx - (fullW * 0.5) * scale;
  const y0 = cy - (fullH * 0.5) * scale;

  let idx = 0;
  for (let py = 0; py < h; py++) {
    const cIm = y0 + (py0 + py) * scale;
    for (let px = 0; px < w; px++) {
      const cRe = x0 + (px0 + px) * scale;

      let zr, zi, cr, ci;
      if (kind === 'julia') {
        zr = cRe; zi = cIm;
        cr = juliaCr; ci = juliaCi;
      } else {
        // mandelbrot / burning_ship / mandelbulb_slice all parameterise by c
        zr = 0; zi = 0;
        cr = cRe; ci = cIm;
      }

      let zr2 = zr * zr, zi2 = zi * zi;
      let i = 0;

      if (kind === 'burning_ship') {
        while (i < maxIter && (zr2 + zi2) <= bailout) {
          const azr = Math.abs(zr);
          const azi = Math.abs(zi);
          const nzi = 2 * azr * azi + ci;
          const nzr = azr*azr - azi*azi + cr;
          zr = nzr; zi = nzi;
          zr2 = zr * zr; zi2 = zi * zi;
          i++;
        }
      } else if (kind === 'mandelbulb_slice') {
        // 2D slice approximation of the Mandelbulb (power-8 in spherical).
        // Iterates z -> z^8 + c using 2D polar coords (theta in xy-plane).
        const power = 8;
        while (i < maxIter && (zr2 + zi2) <= bailout) {
          const r = Math.sqrt(zr2 + zi2);
          const theta = Math.atan2(zi, zr) * power;
          const rp = Math.pow(r, power);
          zr = rp * Math.cos(theta) + cr;
          zi = rp * Math.sin(theta) + ci;
          zr2 = zr * zr; zi2 = zi * zi;
          i++;
        }
      } else {
        // mandelbrot / julia: z := z² + c
        while (i < maxIter && (zr2 + zi2) <= bailout) {
          zi = 2.0 * zr * zi + ci;
          zr = zr2 - zi2 + cr;
          zr2 = zr * zr;
          zi2 = zi * zi;
          i++;
        }
      }

      if (i >= maxIter) {
        out[idx++] = -1.0;
      } else {
        const log_zn = Math.log(zr2 + zi2) * 0.5;
        const nu = Math.log(log_zn / Math.LN2) / Math.LN2;
        out[idx++] = i + 1 - nu;
      }
    }
  }
  postMessage({ id, gen, px0, py0, w, h, out }, [out.buffer]);
};
`;

/* Worker pool factory. Returns a small object with `dispatch(job, done)`
   that owns N workers and pumps a FIFO of jobs across them. */
function makeEscapeTimePool(count) {
  const workers = [];
  const busy = [];
  const blob = new Blob([ESCAPE_TIME_WORKER_SRC], { type: 'application/javascript' });
  const url = URL.createObjectURL(blob);
  for (let i = 0; i < count; i++) {
    const w = new Worker(url);
    workers.push(w);
    busy.push(false);
  }

  const queue = [];
  let onDone = null;

  function pump() {
    for (let i = 0; i < workers.length; i++) {
      if (!busy[i] && queue.length) {
        const job = queue.shift();
        busy[i] = true;
        workers[i].onmessage = (e) => {
          busy[i] = false;
          if (onDone) onDone(e.data);
          pump();
        };
        workers[i].postMessage(job);
      }
    }
  }

  return {
    submit(job) { queue.push(job); pump(); },
    submitAll(jobs) { for (const j of jobs) queue.push(j); pump(); },
    onResult(cb) { onDone = cb; },
    cancelPending() { queue.length = 0; },
    count() { return workers.length; },
  };
}

window.EscapeTimePool = { makeEscapeTimePool };

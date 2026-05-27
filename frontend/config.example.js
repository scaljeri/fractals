// Copy this file to config.local.js and fill in your deployment specifics.
// config.local.js is gitignored; this example is tracked.
//
// If config.local.js is absent (e.g. fresh clone, or a fork that hasn't been
// configured yet), the frontend falls back to safe defaults: no production
// hostname shortcut, and the Jetson URL is taken from localStorage / prompt.
window.MANDELBROT_CONFIG = {
  // Hostname where this site is served in production. When window.location.hostname
  // matches this, the page assumes /gpu is reverse-proxied to the Jetson on the
  // same origin (no CORS, no prompt).
  productionHost: '',

  // Direct URL to the Jetson render service on your LAN. Used when the page is
  // opened from localhost / 127.0.0.1 (typical dev setup with the Jetson on the
  // same network).
  lanJetsonUrl: 'http://jetson.local:8080',
};

// Apply the stored appearance before first paint to avoid a light/dark flash.
// Kept as a file (not inline) so the strict Content-Security-Policy (script-src 'self') allows it.
try {
  var m = localStorage.getItem('stw.appearance') || 'system';
  var dark = m === 'dark' || (m === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.add(dark ? 'dark' : 'light');
} catch (e) {}

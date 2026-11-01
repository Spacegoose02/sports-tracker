// Registers the service worker (public/sw.js) so the tracker can be
// installed to a phone's home screen and keeps working on flaky connections.
// Loaded with `defer` on every page; does nothing in browsers without
// service worker support.
(function () {
  if (!('serviceWorker' in navigator)) return;
  // Service workers need a secure context; skip plain-HTTP LAN addresses
  // quietly instead of logging an error on every page load.
  if (!window.isSecureContext) return;

  window.addEventListener('load', function () {
    navigator.serviceWorker.register('/sw.js').catch(function (err) {
      console.warn('[pwa] service worker registration failed', err);
    });
  });

  // Mark the page when it runs as an installed app, so CSS can adjust for
  // the missing browser chrome (see the "Mobile / PWA" block in styles.css).
  var standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  if (standalone) document.documentElement.classList.add('is-standalone');
})();

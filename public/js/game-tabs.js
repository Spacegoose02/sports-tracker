// Game page tabs: Gamecast, Box Score, Matchup, Watch & Listen. game.js
// keeps filling the same sections by id; this only shows one group at a
// time, hides tabs with nothing in them, and remembers the choice in the
// URL hash (#box, #matchup, ...) so a link opens the same tab.
(function () {
  const bar = document.getElementById('gameTabs');
  if (!bar) return;
  const tabs = [...bar.querySelectorAll('[data-gtab]')];
  const panels = [...document.querySelectorAll('[data-gpanel]')];
  let chosen = location.hash.replace('#', '') || null;
  let userPicked = !!chosen;

  const hasContent = (panel) => [...panel.children].some((c) => c.textContent.trim() || c.querySelector('svg, iframe, img, audio, video'));

  function show(key) {
    tabs.forEach((t) => {
      const on = t.dataset.gtab === key;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    panels.forEach((p) => { p.hidden = p.dataset.gpanel !== key; });
  }

  function refresh() {
    const filled = new Set(panels.filter(hasContent).map((p) => p.dataset.gpanel));
    tabs.forEach((t) => { t.hidden = !filled.has(t.dataset.gtab); });
    bar.hidden = filled.size === 0;
    if (chosen && filled.has(chosen)) { show(chosen); return; }
    // Before kickoff the matchup is the interesting part; after, the game.
    const pre = document.body.dataset.gameState === 'pre';
    const order = pre ? ['matchup', 'cast', 'watch', 'box'] : ['cast', 'box', 'matchup', 'watch'];
    const first = order.find((k) => filled.has(k));
    if (first) show(first);
    if (!userPicked) chosen = null;
  }

  tabs.forEach((t) => t.addEventListener('click', () => {
    chosen = t.dataset.gtab;
    userPicked = true;
    history.replaceState(null, '', `${location.pathname}${location.search}#${chosen}`);
    show(chosen);
  }));

  let pending = null;
  const observer = new MutationObserver(() => {
    if (pending) return;
    pending = requestAnimationFrame(() => { pending = null; refresh(); });
  });
  panels.forEach((p) => observer.observe(p, { childList: true, subtree: true, characterData: true }));
  show('cast');
  refresh();
})();

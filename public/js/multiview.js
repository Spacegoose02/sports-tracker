// Multiview (public/multiview.html): two or four games on screen at once,
// each drawn with the TV wall's tile (field, diamond or line score).
//
// URL options (all optional):
//   ?games=cfb:401,nfl:9   the games to show, in order
//   ?n=2|4                 how many tiles (default 4 on wide screens)
//
// With no games picked it fills the tiles with the best live games, your
// teams first (the same order as the TV wall).
(function () {
  if (typeof document === 'undefined' || !document.body.classList.contains('multiview')) return;
  const el = (id) => document.getElementById(id);
  const esc = (v) => CFB.esc(v);
  const params = new URLSearchParams(location.search);
  const state = {
    n: [2, 4].includes(Number(params.get('n'))) ? Number(params.get('n')) : (window.innerWidth >= 800 ? 4 : 2),
    chosen: (params.get('games') || '').split(',').map((s) => s.trim()).filter((s) => /^[a-z0-9]{2,10}:[A-Za-z0-9_-]{1,40}$/.test(s)),
    sports: [],
    games: [],
    lastScores: new Map(),
    timer: null,
  };
  const key = (g) => `${g.sport}:${g.id}`;
  const sportOf = (g) => state.sports.find((s) => s.key === g.sport);

  function saveUrl() {
    const p = new URLSearchParams();
    if (state.chosen.length) p.set('games', state.chosen.join(','));
    p.set('n', state.n);
    history.replaceState(null, '', `${location.pathname}?${p}`);
  }

  async function fetchSport(sport) {
    let url = `/api/scoreboard?sport=${encodeURIComponent(sport.key)}`;
    if (sport.groups && sport.groups[0]) url += `&groups=${encodeURIComponent(sport.groups[0].value)}`;
    try {
      const data = await CFB.getJson(url);
      return (data.games || []).map((g) => ({ ...g, sport: sport.key }));
    } catch (err) {
      return [];
    }
  }

  // The games on screen: the chosen ones (in order), then the best of the
  // rest to fill empty tiles.
  function shown() {
    const byKey = new Map(state.games.map((g) => [key(g), g]));
    const picked = state.chosen.map((k) => byKey.get(k)).filter(Boolean);
    if (picked.length >= state.n) return picked.slice(0, state.n);
    const followed = {};
    state.sports.forEach((s) => { followed[s.key] = CFB.follows.ids(s.key); });
    const fill = Wall.pickGames(state.games, followed, { max: 40 })
      .filter((g) => g.status.state === 'in' || state.chosen.length === 0)
      .filter((g) => !picked.some((p) => key(p) === key(g)));
    return [...picked, ...fill].slice(0, state.n);
  }

  function renderGrid() {
    const grid = el('mvGrid');
    grid.className = `mv-grid n${state.n}`;
    const games = shown();
    const tiles = [];
    for (let i = 0; i < state.n; i += 1) {
      const g = games[i];
      if (!g) {
        tiles.push('<div class="mv-tile"><div class="mv-empty">No game here yet.<br><small>Choose games above.</small></div></div>');
        continue;
      }
      const followed = CFB.follows.ids(g.sport);
      const mine = [g.home, g.away].some((t) => t && followed.has(String(t.id)));
      tiles.push(`<div class="mv-tile" data-key="${esc(key(g))}">
        <a class="mv-open" href="/game.html?id=${encodeURIComponent(g.id)}&amp;source=espn&amp;sport=${encodeURIComponent(g.sport)}">Open game &rsaquo;</a>
        ${Wall.stageHtml({ ...g, mine }, sportOf(g))}
      </div>`);
    }
    grid.innerHTML = tiles.join('');
    // Flash a tile when its score changes.
    games.forEach((g) => {
      const k = key(g);
      const now = Wall.scoreKey(g);
      const before = state.lastScores.get(k);
      state.lastScores.set(k, now);
      if (before !== undefined && before !== now) {
        const tile = grid.querySelector(`[data-key="${CSS.escape(k)}"]`);
        if (tile) tile.classList.add('flash');
      }
    });
    document.querySelectorAll('[data-mv-n]').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.mvN) === state.n)));
  }

  function renderChoices() {
    const list = Wall.pickGames(state.games, Object.fromEntries(state.sports.map((s) => [s.key, CFB.follows.ids(s.key)])), { max: 80 });
    el('mvChoices').innerHTML = list.length ? list.map((g) => {
      const live = g.status.state === 'in';
      const on = state.chosen.includes(key(g));
      const sport = sportOf(g);
      return `<button type="button" class="mv-choice ${live ? 'is-live' : ''}" data-key="${esc(key(g))}" aria-pressed="${on}">
        <span>${g.mine ? '&#9733; ' : ''}${esc(g.away.abbreviation || g.away.shortName)} ${live || g.status.state === 'post' ? esc(g.away.score) : ''} @ ${esc(g.home.abbreviation || g.home.shortName)} ${live || g.status.state === 'post' ? esc(g.home.score) : ''}</span>
        <small>${esc((sport && sport.shortLabel) || g.sport)} &middot; ${esc(Wall.statusText(g, sport))}</small>
      </button>`;
    }).join('') : '<p class="mv-help">No games today.</p>';
  }

  async function refresh() {
    clearTimeout(state.timer);
    const results = await Promise.all(state.sports.map(fetchSport));
    state.games = results.flat();
    renderGrid();
    if (!el('mvPicker').hidden) renderChoices();
    const anyLive = state.games.some((g) => g.status && g.status.state === 'in');
    state.timer = setTimeout(refresh, document.hidden ? 60000 : anyLive ? 15000 : 60000);
  }

  el('mvPickBtn').addEventListener('click', () => {
    const picker = el('mvPicker');
    picker.hidden = !picker.hidden;
    el('mvPickBtn').setAttribute('aria-expanded', String(!picker.hidden));
    if (!picker.hidden) renderChoices();
  });
  el('mvChoices').addEventListener('click', (e) => {
    const b = e.target.closest('[data-key]');
    if (!b) return;
    const k = b.dataset.key;
    state.chosen = state.chosen.includes(k) ? state.chosen.filter((x) => x !== k) : [...state.chosen, k].slice(-4);
    if (state.chosen.length > state.n) state.n = 4;
    saveUrl();
    renderChoices();
    renderGrid();
  });
  document.querySelectorAll('[data-mv-n]').forEach((b) => b.addEventListener('click', () => {
    state.n = Number(b.dataset.mvN);
    saveUrl();
    renderGrid();
  }));
  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
  }
  el('mvFull').addEventListener('click', toggleFullscreen);
  document.addEventListener('keydown', (e) => {
    if ((e.key === 'f' || e.key === 'F') && !e.target.closest('input, select, textarea')) toggleFullscreen();
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });

  CFB.loadSports().then(async () => {
    let list = [];
    try { list = (await CFB.getJson('/api/sports')).sports || []; } catch (err) { list = [CFB.sport()]; }
    const all = list.filter((s) => (s.format || 'game') === 'game');
    const wanted = new Set([...state.chosen.map((k) => k.split(':')[0]), ...CFB.follows.all().map((t) => t.sport), CFB.sport().key]);
    // Live games anywhere are fair game, but keep the calls down: the sports
    // you follow or picked, plus the big leagues.
    ['cfb', 'nfl', 'nba', 'nhl', 'mlb', 'epl'].forEach((k) => wanted.add(k));
    state.sports = all.filter((s) => wanted.has(s.key));
    refresh();
  });
})();

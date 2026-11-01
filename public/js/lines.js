// Betting Lines page: every game's spread, total and moneylines for a week
// (or a day for daily sports), with open-to-current movement and, once a
// game is final, whether the favorite covered and the total went over.
(function () {
  const el = CFB.el;
  const esc = CFB.esc;
  const FILTER_KEY = 'tracker-lines-filter';
  const state = { group: null, day: new Date(), data: null, filter: 'all' };

  try { state.filter = localStorage.getItem(FILTER_KEY) || 'all'; } catch (e) { /* ignore */ }

  const fmtSpread = (n) => (n === null || n === undefined ? null : n === 0 ? 'PK' : n > 0 ? `+${n}` : String(n));
  const teamLabel = (t) => (t ? (t.abbreviation || t.shortName || t.name || 'TBD') : 'TBD');

  function populateSelectors(meta) {
    const sport = CFB.sport();
    const currentYear = meta.season || new Date().getFullYear();
    const seasonSelect = el('seasonSelect');
    seasonSelect.innerHTML = '';
    for (let y = currentYear; y >= currentYear - 2; y--) seasonSelect.add(new Option(y, y));
    seasonSelect.value = currentYear;
    const weekSelect = el('weekSelect');
    weekSelect.innerHTML = '';
    for (let w = 1; w <= (sport.maxWeek || 15); w++) weekSelect.add(new Option(`Week ${w}`, w));
    weekSelect.value = meta.week || 1;
    const typeSelect = el('seasonTypeSelect');
    if (sport.seasonTypes) {
      typeSelect.innerHTML = '';
      sport.seasonTypes.forEach((t) => typeSelect.add(new Option(t.label, t.value)));
    }
    typeSelect.value = String(meta.seasonType || 2);
  }

  // One side of the board: team, spread (with its price), moneyline, and
  // the over or under for the total.
  function sideHtml(game, side) {
    const team = game[side];
    const o = game.odds;
    const spread = o.homeSpread === null ? null : side === 'home' ? o.homeSpread : -o.homeSpread;
    const isFav = o.favorite === side;
    const totalSide = side === 'away' ? 'over' : 'under';
    const totalText = o.overUnder !== null ? `${totalSide === 'over' ? 'O' : 'U'} ${o.overUnder}` : '';
    const totalPrice = o.totalOdds ? o.totalOdds[totalSide] : null;
    const result = game.result;
    const covered = result && result.ats && result.ats.winner === side;
    const totalHit = result && result.total && result.total.result === totalSide;
    const score = team && team.score !== null && team.score !== undefined && game.status && game.status.state !== 'pre' ? team.score : '';
    return `
      <div class="line-team">
        <span class="rank">${team && team.curatedRank ? '#' + esc(team.curatedRank) : ''}</span>
        ${team && team.logo ? `<img src="${CFB.safeUrl(team.logo)}" alt="" onerror="this.style.display='none'">` : '<span class="logo-gap"></span>'}
        ${team && team.id ? `<a class="team-link line-team-name" href="${CFB.teamLink(team)}" onclick="event.stopPropagation()"><span class="full">${esc(team.name || team.shortName)}</span><span class="abbr">${esc(teamLabel(team))}</span></a>` : `<span class="line-team-name">${esc(teamLabel(team))}</span>`}
        <span class="line-score">${esc(score)}</span>
      </div>
      <div class="line-cell ${isFav ? 'is-fav' : ''} ${covered ? 'hit' : ''}">
        ${spread !== null ? `<strong>${esc(fmtSpread(spread))}</strong>` : '<span class="dim">&ndash;</span>'}
        ${o.spreadOdds && o.spreadOdds[side] ? `<span class="price">${esc(o.spreadOdds[side])}</span>` : ''}
      </div>
      <div class="line-cell ${totalHit ? 'hit' : ''}">
        ${totalText ? `<strong>${esc(totalText)}</strong>` : '<span class="dim">&ndash;</span>'}
        ${totalPrice ? `<span class="price">${esc(totalPrice)}</span>` : ''}
      </div>
      <div class="line-cell">
        ${o.moneyline && o.moneyline[side] ? `<strong>${esc(o.moneyline[side])}</strong>` : '<span class="dim">&ndash;</span>'}
      </div>`;
  }

  function movementHtml(game) {
    const o = game.odds;
    if (!o.open) return '';
    const parts = [];
    if (o.open.homeSpread !== null && o.homeSpread !== null && o.open.homeSpread !== o.homeSpread) {
      parts.push(`${esc(teamLabel(game.home))} opened ${esc(fmtSpread(o.open.homeSpread))}, now ${esc(fmtSpread(o.homeSpread))}`);
    }
    if (o.open.overUnder !== null && o.overUnder !== null && o.open.overUnder !== o.overUnder) {
      const dir = o.overUnder > o.open.overUnder ? '&#9650;' : '&#9660;';
      parts.push(`Total opened ${esc(o.open.overUnder)} ${dir} ${esc(o.overUnder)}`);
    }
    return parts.length ? `<div class="line-move">Line move: ${parts.join(' &middot; ')}</div>` : '';
  }

  function resultHtml(game) {
    const r = game.result;
    if (!r) return '';
    const parts = [];
    if (r.ats) {
      if (r.ats.push) parts.push('<span class="chip">Push ATS</span>');
      else {
        const who = teamLabel(game[r.ats.winner]);
        const role = r.ats.favoriteCovered === true ? 'favorite' : r.ats.favoriteCovered === false ? 'underdog' : '';
        parts.push(`<span class="chip good">${esc(who)} covered${role ? ` (${role})` : ''} by ${esc(r.ats.margin)}</span>`);
      }
    }
    if (r.total) {
      const label = r.total.result === 'push' ? 'Push' : r.total.result === 'over' ? 'Over' : 'Under';
      parts.push(`<span class="chip">${label} &middot; ${esc(r.total.points)} pts</span>`);
    }
    return `<div class="line-result">${parts.join('')}</div>`;
  }

  function cardHtml(game) {
    const followed = CFB.follows.ids();
    const isMine = [game.home, game.away].some((t) => t && followed.has(String(t.id)));
    const isLive = game.status && game.status.state === 'in';
    return `
      <div class="line-card ${isMine ? 'is-favorite' : ''} ${isLive ? 'is-live' : ''}" data-id="${esc(game.id)}" data-source="${esc(game.source || 'espn')}">
        <div class="status-row">
          <span class="${isLive ? 'live-dot' : ''}">${esc(CFB.statusLabel(game))}</span>
          <span>${[game.broadcast, game.odds.provider ? `via ${game.odds.provider}` : null].filter(Boolean).map(esc).join(' &middot; ')}</span>
        </div>
        <div class="line-grid">
          <div class="line-head"></div><div class="line-head">Spread</div><div class="line-head">Total</div><div class="line-head">Money</div>
          ${sideHtml(game, 'away')}
          ${sideHtml(game, 'home')}
        </div>
        ${movementHtml(game)}
        ${resultHtml(game)}
      </div>`;
  }

  function summaryHtml(summary) {
    const f = summary.favorites;
    const t = summary.totals;
    if (f.won + f.lost + f.push + t.over + t.under + t.push === 0) return '';
    return `
      <span>Favorites ATS <strong>${f.won}-${f.lost}${f.push ? `-${f.push}` : ''}</strong></span>
      <span>Over/Under <strong>${t.over}-${t.under}${t.push ? `-${t.push}` : ''}</strong></span>`;
  }

  function render() {
    const list = el('linesList');
    const data = state.data;
    if (!data) return;
    el('linesSummary').innerHTML = summaryHtml(data.summary);
    let games = data.games;
    if (state.filter === 'ranked') games = games.filter((g) => (g.home && g.home.curatedRank) || (g.away && g.away.curatedRank));
    if (state.filter === 'mine') {
      const ids = CFB.follows.ids();
      games = games.filter((g) => [g.home, g.away].some((t) => t && ids.has(String(t.id))));
    }
    const missing = data.withoutLines ? `<div class="empty-note">${data.withoutLines} more game${data.withoutLines === 1 ? ' has' : 's have'} no line posted.</div>` : '';
    if (!games.length) {
      const why = state.filter === 'mine'
        ? (CFB.follows.list().length ? 'None of the teams you follow have a line posted here.' : 'Follow teams from their team pages to see their lines here.')
        : state.filter === 'ranked' ? 'No ranked matchups have a line posted here.' : 'No lines posted for these games yet. Books usually post them early in the week.';
      list.innerHTML = `<div class="empty-note">${why}</div>${state.filter === 'all' ? '' : missing}`;
      return;
    }
    list.innerHTML = games.map(cardHtml).join('') + missing;
    list.querySelectorAll('.line-card').forEach((card) => {
      card.addEventListener('click', () => { location.href = CFB.gameLink(card.dataset.id, card.dataset.source); });
    });
  }

  async function load() {
    const sport = CFB.sport();
    const params = new URLSearchParams();
    if (sport.schedule === 'day') {
      params.set('dates', CFB.ymd(state.day));
    } else {
      params.set('year', el('seasonSelect').value);
      params.set('week', el('weekSelect').value);
      params.set('seasontype', el('seasonTypeSelect').value);
    }
    if (state.group) params.set('groups', state.group);
    el('linesList').innerHTML = '<div class="empty-note">Loading&hellip;</div>';
    try {
      state.data = await CFB.getJson(CFB.withSport(`/api/lines?${params}`));
      el('sourceNote').textContent = sport.schedule === 'day'
        ? `${sport.label} · ${state.day.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}`
        : `${sport.label} · ${state.data.season} · Week ${state.data.week}`;
      render();
    } catch (err) {
      el('linesList').innerHTML = '<div class="empty-note">Could not load betting lines right now.</div>';
    }
  }

  function initFilter() {
    const sport = CFB.sport();
    const bar = el('linesFilter');
    if (!sport.rankings) {
      bar.querySelector('[data-filter="ranked"]').remove();
      if (state.filter === 'ranked') state.filter = 'all';
    }
    const sync = () => bar.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.filter === state.filter));
    sync();
    bar.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      state.filter = btn.dataset.filter;
      try { localStorage.setItem(FILTER_KEY, state.filter); } catch (err) { /* ignore */ }
      sync();
      render();
    });
  }

  function initDayControls() {
    const toInput = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const setDay = (d) => { state.day = d; el('dayInput').value = toInput(d); load(); };
    el('dayInput').value = toInput(state.day);
    el('dayInput').addEventListener('change', () => {
      const [y, m, d] = el('dayInput').value.split('-').map(Number);
      if (y && m && d) setDay(new Date(y, m - 1, d));
    });
    el('prevDayBtn').addEventListener('click', () => { const d = new Date(state.day); d.setDate(d.getDate() - 1); setDay(d); });
    el('nextDayBtn').addEventListener('click', () => { const d = new Date(state.day); d.setDate(d.getDate() + 1); setDay(d); });
    el('todayBtn').addEventListener('click', () => setDay(new Date()));
  }

  async function init() {
    const sport = await CFB.loadSports();
    CFB.initSportBar();
    if (sport.format && sport.format !== 'game') {
      el('weekControls').hidden = true;
      el('linesFilter').hidden = true;
      el('sourceNote').textContent = sport.label;
      el('linesList').innerHTML = `<div class="empty-note">Point spreads and totals don't apply to ${esc(sport.label)}. Pick another sport above.</div>`;
      return;
    }
    initFilter();
    if (sport.schedule === 'day') {
      el('weekControls').hidden = true;
      el('dayControls').hidden = false;
      initDayControls();
    } else {
      try {
        populateSelectors(await CFB.getJson(CFB.withSport('/api/meta')));
      } catch (err) {
        populateSelectors({ season: new Date().getFullYear(), week: 1, seasonType: 2 });
      }
      el('goBtn').addEventListener('click', load);
    }
    CFB.initDivisionToggle((group) => {
      state.group = group;
      load();
    });
  }

  init();
})();

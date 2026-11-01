// The playoff hub (/brackets.html): the College Football Playoff bracket,
// every bowl game, the March Madness bracket, and the family bracket
// challenge (pick each game before it starts; later rounds are worth more).
// Picks belong to the Kids Zone players and save like the rest of their
// data: on this device, or on the account when signed in (kids.js).
(function () {
  const el = CFB.el;
  const esc = CFB.esc;
  const B = BracketsCore;

  const VIEWS = { cfp: 'cfb', bowls: 'cfb', mm: 'mcbb' };
  const params = new URLSearchParams(location.search);
  const month = new Date().getMonth();
  const state = {
    view: VIEWS[params.get('view')] ? params.get('view') : (month === 2 || month === 3 ? 'mm' : 'cfp'),
    season: { cfb: null, mcbb: null },
    data: {},
    note: null,
    timer: null,
  };
  if (Number(params.get('season'))) state.season[VIEWS[state.view]] = Number(params.get('season'));

  function sportKey() { return VIEWS[state.view]; }
  function seasonFor(sport) { return state.season[sport] || B.defaultSeason(sport); }
  function current() { return state.data[`${sportKey()}:${seasonFor(sportKey())}`] || null; }

  function gameUrl(g, sport) {
    return `/game.html?id=${encodeURIComponent(g.id)}&source=espn&sport=${encodeURIComponent(sport)}`;
  }

  function realTeam(t) {
    return !!(t && t.id && !t.placeholder && Number(t.id) > 0 && !/^TBD\b/i.test(t.name || ''));
  }

  // ---- Loading -------------------------------------------------------------
  async function fetchSeason(sport, season) {
    const key = `${sport}:${season}`;
    state.data[key] = await CFB.getJson(`/api/brackets?sport=${sport}&season=${season}`);
    return state.data[key];
  }

  async function load() {
    const sport = sportKey();
    const season = seasonFor(sport);
    state.note = null;
    el('hubBody').innerHTML = '<div class="empty-note">Loading&hellip;</div>';
    let data;
    try {
      data = await fetchSeason(sport, season);
    } catch (err) {
      el('hubBody').innerHTML = '<div class="empty-note">Could not load the postseason. Try again in a minute.</div>';
      return;
    }
    // Before a postseason exists, show the last one instead of a blank page
    // (the CFP still shows its projection, if there is one).
    const nothing = data.empty && !(sport === 'cfb' && state.view === 'cfp' && data.projected);
    if (nothing && !state.season[sport]) {
      try {
        const prev = await fetchSeason(sport, season - 1);
        if (!prev.empty) {
          state.season[sport] = season - 1;
          state.note = sport === 'mcbb'
            ? `The ${season} bracket fills in on Selection Sunday in mid-March. Here's how ${season - 1} played out.`
            : `The ${season} bowls aren't set yet. Here's the ${season - 1} postseason.`;
        }
      } catch (e) { /* keep the empty season */ }
    }
    render();
    scheduleRefresh();
  }

  // Refresh once a minute while any game is live.
  function scheduleRefresh() {
    clearTimeout(state.timer);
    const data = current();
    if (!data) return;
    const live = [...B.gameIndex(data, sportKey()).values()].some((e) => e.game.status && e.game.status.state === 'in');
    if (live) state.timer = setTimeout(load, 60000);
  }

  // ---- Game cards ------------------------------------------------------------
  function player() { return Kids.players.current(); }

  function picksFor(p) {
    return p ? Kids.brackets.forPlayer(p.id) : {};
  }

  function teamRow(t, g, opts) {
    if (!t) return '<div class="bk-team tbd"><span class="bk-name">TBD</span></div>';
    if (t.placeholder || !realTeam(t)) return `<div class="bk-team tbd"><span class="bk-name">${esc(t.placeholder ? t.name || 'TBD' : 'TBD')}</span></div>`;
    const sport = opts.sport;
    const seed = t.seed || (sport === 'mcbb' ? t.curatedRank : null);
    const prefix = seed ? `<span class="bk-seed">${esc(seed)}</span>` : (t.curatedRank ? `<span class="bk-rank">#${esc(t.curatedRank)}</span>` : '');
    const st = g.status && g.status.state;
    const winnerId = B.winnerOf(g);
    const picked = opts.pick && String(opts.pick.teamId) === String(t.id);
    let mark = '';
    if (picked && winnerId !== undefined) mark = winnerId === String(t.id) ? '<span class="bk-mark" title="Right pick">&#9989;</span>' : '<span class="bk-mark" title="Wrong pick">&#10060;</span>';
    else if (picked) mark = '<span class="bk-mark" title="Your pick">&#11088;</span>';
    const cls = ['bk-team'];
    if (picked) cls.push('picked');
    if (winnerId !== undefined && winnerId !== null) cls.push(winnerId === String(t.id) ? 'won' : 'lost');
    const inner = `
      ${prefix}
      ${t.logo ? `<img src="${CFB.safeUrl(t.logo)}" alt="" loading="lazy" onerror="this.style.display='none'">` : '<span class="bk-logo-gap"></span>'}
      <span class="bk-name">${esc(t.shortName || t.name || 'TBD')}${t.record ? ` <span class="bk-record">${esc(t.record)}</span>` : ''}</span>
      ${mark}
      ${st && st !== 'pre' && t.score !== null && t.score !== undefined ? `<strong class="bk-score">${esc(t.score)}</strong>` : ''}`;
    if (opts.canPick) {
      return `<button type="button" class="${cls.join(' ')}" data-pick-game="${esc(g.id)}" data-pick-team="${esc(t.id)}" aria-pressed="${picked ? 'true' : 'false'}" aria-label="Pick ${esc(t.name || t.shortName)}">${inner}</button>`;
    }
    return `<div class="${cls.join(' ')}">${inner}</div>`;
  }

  function card(g, opts) {
    if (!g) return '';
    const sport = opts.sport;
    const st = g.status && g.status.state;
    const p = player();
    const pick = p && g.id ? picksFor(p)[`${sport}:${g.id}`] : null;
    const canPick = !!(opts.pickable && p && g.id && st === 'pre' && realTeam(g.away) && realTeam(g.home));
    const rowOpts = { sport, pick, canPick };
    const meta = [];
    if (opts.showBowl && g.bowl) meta.push(`<span class="bk-bowl">${esc(g.bowl)}</span>`);
    if (g.status && !g.placeholder && !g.projected) meta.push(`<span class="${st === 'in' ? 'bk-live' : ''}">${esc(CFB.statusLabel(g))}</span>`);
    if (g.broadcast && st !== 'post') meta.push(`<span>${esc(g.broadcast)}</span>`);
    const cls = ['bk-game'];
    if (st === 'in') cls.push('live');
    if (g.placeholder) cls.push('placeholder');
    if (canPick) cls.push('pickable');
    return `
      <div class="${cls.join(' ')}">
        ${meta.length ? `<div class="bk-meta">${meta.join('<span aria-hidden="true"> &middot; </span>')}</div>` : ''}
        ${teamRow(g.away, g, rowOpts)}
        ${teamRow(g.home, g, rowOpts)}
        ${g.venue && opts.showVenue ? `<div class="bk-venue">${esc(g.venue)}</div>` : ''}
        ${g.id && !g.projected ? `<a class="bk-link" href="${esc(gameUrl(g, sport))}">Game details &rsaquo;</a>` : ''}
      </div>`;
  }

  function grid(rounds, opts) {
    return `
      <div class="bk-scroll">
        <div class="bk-grid" style="--rounds:${rounds.length}">
          ${rounds.map((r) => `
            <div class="bk-round">
              <h3 class="bk-round-title">${esc(r.label)}${opts.pickable ? ` <span class="bk-points">${r.points} pt${r.points === 1 ? '' : 's'}</span>` : ''}</h3>
              <div class="bk-games">${r.games.map((g) => card(g, Object.assign({ showBowl: true }, opts))).join('')}</div>
            </div>`).join('')}
        </div>
      </div>`;
  }

  // ---- Views -----------------------------------------------------------------
  function renderCfp(data) {
    const opts = { sport: 'cfb', pickable: true };
    if (data.cfpSet && data.cfp) return grid(data.cfp.rounds, opts);
    if (data.projected) {
      return `
        <div class="hub-note">
          <strong>If the season ended today.</strong> The top ${B.CFP_SIZE} of the ${esc(data.projected.poll)}, seeded in order, with the top four getting a first-round bye.
          The real field also saves spots for the highest-ranked conference champions, so it can differ. The real bracket shows up here on selection day, and picks open then.
        </div>
        ${grid(data.projected.rounds, { sport: 'cfb', pickable: false })}`;
    }
    if (data.cfp) return grid(data.cfp.rounds, opts);
    return '<div class="empty-note">No playoff games for this season yet.</div>';
  }

  function renderBowls(data) {
    const bowls = data.bowls || [];
    if (!bowls.length) return '<div class="empty-note">No bowl games listed for this season yet.</div>';
    const days = new Map();
    bowls.forEach((g) => {
      const d = g.date ? new Date(g.date) : null;
      const label = d ? d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }) : 'Date to be announced';
      if (!days.has(label)) days.set(label, []);
      days.get(label).push(g);
    });
    const cfpCount = data.cfp ? data.cfp.rounds.reduce((n, r) => n + r.games.filter((g) => g.id).length, 0) : 0;
    return `
      <p class="hub-count">${bowls.length} bowl game${bowls.length === 1 ? '' : 's'}${cfpCount ? `, plus ${cfpCount} playoff game${cfpCount === 1 ? '' : 's'} on the playoff tab` : ''}.</p>
      ${[...days.entries()].map(([label, games]) => `
        <h3 class="bk-day">${esc(label)}</h3>
        <div class="bk-list">${games.map((g) => card(g, { sport: 'cfb', pickable: true, showBowl: true, showVenue: true })).join('')}</div>`).join('')}`;
  }

  function renderMm(data) {
    if (data.empty) return '<div class="empty-note">No tournament games for this season yet. The bracket fills in on Selection Sunday in mid-March.</div>';
    const opts = { sport: 'mcbb', pickable: true };
    return `
      ${data.firstFour && data.firstFour.length ? `
        <h3 class="bk-region">First Four <span class="bk-points">1 pt</span></h3>
        <div class="bk-list">${data.firstFour.map((g) => card(g, opts)).join('')}</div>` : ''}
      ${(data.regions || []).map((r) => `
        <h3 class="bk-region">${esc(r.name)} Region</h3>
        ${grid(r.rounds, opts)}`).join('')}
      ${data.finals && data.finals.length ? `
        <h3 class="bk-region">Final Four</h3>
        ${grid(data.finals, opts)}` : ''}`;
  }

  // ---- Challenge ---------------------------------------------------------------
  function renderPlayers() {
    const list = Kids.players.list();
    const me = player();
    el('challengePlayers').innerHTML = list.length
      ? list.map((p) => `
        <span class="player-chip ${me && p.id === me.id ? 'active' : ''}">
          <button type="button" class="player-pick" data-player="${esc(p.id)}" aria-pressed="${me && p.id === me.id}">${esc(p.emoji)} ${esc(p.name)}</button>
        </span>`).join('')
      : '<span class="empty-note">Add a name to start picking. Everyone in the family gets their own bracket.</span>';
  }

  function picksBySport(sport, season) {
    const out = {};
    Object.entries(Kids.brackets.all()).forEach(([pid, list]) => {
      out[pid] = Object.fromEntries(Object.entries(list || {}).filter(([, pk]) => pk.sport === sport && Number(pk.season) === Number(season)));
    });
    return out;
  }

  function renderLocalBoard(data) {
    const players = Kids.players.list();
    if (!players.length || !data) { el('challengeLocal').innerHTML = ''; return; }
    const sport = sportKey();
    const rows = B.standings(players, picksBySport(sport, data.season), B.gameIndex(data, sport));
    const me = player();
    el('challengeLocal').innerHTML = `
      <h3 class="league-sub">${Kids.isSynced() ? 'Your players' : 'On this device'}</h3>
      <ol class="leaderboard">
        ${rows.map((r, i) => `
          <li class="${me && r.player.id === me.id ? 'me' : ''}">
            <span class="lb-place">${i === 0 && r.score.points ? '&#128081;' : i + 1}</span>
            <span class="lb-name">${esc(r.player.emoji)} ${esc(r.player.name)}</span>
            <span class="lb-score">${r.score.points} pt${r.score.points === 1 ? '' : 's'}${r.score.pending ? ` &middot; ${r.score.pending} waiting` : ''}</span>
          </li>`).join('')}
      </ol>`;
  }

  let leagueLoad = 0;
  async function renderLeagueBoard(data) {
    const box = el('challengeLeague');
    if (!data) { box.innerHTML = ''; return; }
    if (!Leagues.signedIn()) { box.innerHTML = Leagues.signInNudge(); return; }
    const leagues = await Leagues.list();
    const lg = Leagues.selected(leagues);
    if (!lg) {
      box.innerHTML = '<p class="league-note">Want grandparents and cousins in on it? <a href="/kids.html">Start a family league</a> in the Kids Zone and share the code.</p>';
      return;
    }
    const n = ++leagueLoad;
    let res;
    try {
      res = await CFB.getJson(`/api/family/leagues/${lg.id}/bracket?sport=${sportKey()}&season=${data.season}`);
    } catch (e) {
      if (n === leagueLoad) box.innerHTML = '<div class="empty-note">Could not load league standings.</div>';
      return;
    }
    if (n !== leagueLoad) return;
    box.innerHTML = `
      <div class="league-head">
        <h3 class="league-sub">&#127942; ${esc(lg.name)}</h3>
        ${Leagues.picker(leagues, lg)}
      </div>
      ${Leagues.standingsList(res.rows, 'bracket')}
      <p class="league-note">League picks count when they're saved before the game starts.</p>`;
    const sel = box.querySelector('[data-role="league-picker"]');
    if (sel) sel.addEventListener('change', () => { Leagues.select(Number(sel.value)); renderLeagueBoard(current()); });
  }

  function renderChallenge(data) {
    const sport = sportKey();
    el('challengeHelp').textContent = sport === 'mcbb'
      ? 'Pick each tournament game before tip-off, round by round as the matchups are set. Points double every round: 1 for the First Four and Round of 64, then 2, 4, 8, 16, and 32 for the title game.'
      : 'Pick the winner of every playoff game and bowl before kickoff. Bowls are worth 1 point. Playoff rounds are worth 1, 2, 4, and 8 points, so the title game can swing it.';
    renderPlayers();
    renderLocalBoard(data);
    renderLeagueBoard(data);
  }

  // ---- Page ------------------------------------------------------------------------
  function render() {
    const sport = sportKey();
    const data = current();
    const season = seasonFor(sport);
    document.querySelectorAll('#hubTabs .tab-btn').forEach((b) => {
      const on = b.dataset.view === state.view;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    el('seasonLabel').textContent = sport === 'mcbb' ? `${season} tournament` : `${season} season`;
    el('seasonNext').disabled = season >= B.defaultSeason(sport);
    if (!data) return;
    const body = state.view === 'cfp' ? renderCfp(data) : state.view === 'bowls' ? renderBowls(data) : renderMm(data);
    el('hubBody').innerHTML = `${state.note ? `<div class="hub-note">${esc(state.note)}</div>` : ''}${body}`;
    renderChallenge(data);
  }

  function setUrl() {
    const q = new URLSearchParams({ view: state.view });
    if (state.season[sportKey()]) q.set('season', state.season[sportKey()]);
    history.replaceState(null, '', `${location.pathname}?${q}`);
  }

  el('hubTabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab-btn');
    if (!btn || btn.dataset.view === state.view) return;
    state.view = btn.dataset.view;
    setUrl();
    if (current()) { render(); scheduleRefresh(); } else load();
  });

  function shiftSeason(delta) {
    const sport = sportKey();
    state.season[sport] = seasonFor(sport) + delta;
    setUrl();
    load();
  }
  el('seasonPrev').addEventListener('click', () => shiftSeason(-1));
  el('seasonNext').addEventListener('click', () => shiftSeason(1));

  el('hubBody').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-pick-game]');
    if (!btn) return;
    const p = player();
    const data = current();
    if (!p || !data) return;
    const sport = sportKey();
    const entry = B.gameIndex(data, sport).get(`${sport}:${btn.dataset.pickGame}`);
    const g = entry && entry.game;
    if (!g || !g.status || g.status.state !== 'pre') return;
    const lite = (t) => (t ? { id: String(t.id), name: t.name || null, logo: t.logo || null, color: t.color || null } : null);
    Kids.brackets.set(p.id, {
      sport,
      season: data.season,
      gameId: String(g.id),
      teamId: btn.dataset.pickTeam,
      round: g.round || 'bowl',
      date: g.date || null,
      away: lite(g.away),
      home: lite(g.home),
    });
    render();
    // Let the save reach the account before the league board refreshes.
    if (Kids.isSynced()) setTimeout(() => renderLeagueBoard(current()), 1500);
  });

  el('challengePlayers').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-player]');
    if (!btn) return;
    Kids.players.setCurrent(btn.dataset.player);
    render();
  });

  el('challengeAddPlayer').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = el('challengeName');
    const added = Kids.players.add(input.value);
    if (added) {
      Kids.players.setCurrent(added.id);
      input.value = '';
      render();
    }
  });

  CFB.loadSports().then(() => Kids.ready).then(() => {
    setUrl();
    load();
  });
})();

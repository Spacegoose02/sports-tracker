(function () {
  const el = CFB.el;
  const state = {
    favoriteTeamId: null,
    season: null,
    week: null,
    seasonType: 2,
    group: null,
    day: null, // Date, for day-based sports
    games: [],
    notable: [],
    pollTimer: null,
    newsLoaded: false,
    videosLoaded: false,
  };

  // UFC / NASCAR: live and upcoming events (soonest first), then recent
  // results (newest first).
  function renderEvents() {
    const list = el('gameList');
    const events = state.events || [];
    if (!events.length) {
      list.innerHTML = '<div class="empty-note">No events scheduled right now.</div>';
      return;
    }
    const ahead = events.filter((e) => !e.status || e.status.state !== 'post');
    const past = events.filter((e) => e.status && e.status.state === 'post').reverse();
    list.innerHTML = `
      <div class="game-list">${ahead.length ? ahead.map(CFB.eventCardHtml).join('') : '<div class="empty-note">No upcoming events in the next two months.</div>'}</div>
      ${past.length ? `<h2 class="section-title list-divider">Recent results</h2><div class="game-list">${past.map(CFB.eventCardHtml).join('')}</div>` : ''}`;
  }

  // The schedule is grouped the way people read a scoreboard: your teams,
  // then what's live (most gripping first), then what's next, then finals.
  // Within each group ranked matchups come first.
  const GAME_FILTER_KEY = 'tracker-game-filter';
  function gameFilter() {
    try { return localStorage.getItem(GAME_FILTER_KEY) || 'all'; } catch (e) { return 'all'; }
  }

  function initGameFilter() {
    const bar = el('gameFilter');
    bar.querySelectorAll('button').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.filter === gameFilter());
      btn.addEventListener('click', () => {
        try { localStorage.setItem(GAME_FILTER_KEY, btn.dataset.filter); } catch (e) { /* ignore */ }
        bar.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
        renderGames();
      });
    });
  }

  function rankWeight(g) {
    const r = (t) => (t && t.curatedRank && Number(t.curatedRank) <= 25 ? Number(t.curatedRank) : 99);
    return Math.min(r(g.home), r(g.away)) + (r(g.home) < 99 && r(g.away) < 99 ? -30 : 0);
  }

  function renderGames() {
    if (state.events) { el('gameFilter').hidden = true; renderEvents(); return; }
    const list = el('gameList');
    if (!state.games.length) {
      el('gameFilter').hidden = true;
      list.innerHTML = '<div class="empty-note">No games found for this week.</div>';
      return;
    }
    const notableIds = new Set(state.notable.map((r) => String(r.event_id)));
    const followed = CFB.follows.ids();
    const isFollowedGame = (g) => (g.home && followed.has(String(g.home.id))) || (g.away && followed.has(String(g.away.id)));
    const isRanked = (g) => [g.home, g.away].some((t) => t && t.curatedRank && Number(t.curatedRank) <= 25);
    const hasRanked = state.games.some(isRanked);
    const hasLive = state.games.some((g) => g.status && g.status.state === 'in');
    const filterBar = el('gameFilter');
    filterBar.hidden = !(hasRanked || hasLive);
    filterBar.querySelector('[data-filter="ranked"]').hidden = !hasRanked;
    filterBar.querySelector('[data-filter="live"]').hidden = !hasLive;
    let filter = gameFilter();
    if ((filter === 'ranked' && !hasRanked) || (filter === 'live' && !hasLive)) filter = 'all';
    filterBar.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.filter === filter));

    let games = state.games;
    if (filter === 'ranked') games = games.filter((g) => isRanked(g) || isFollowedGame(g));
    if (filter === 'live') games = games.filter((g) => g.status && g.status.state === 'in');

    const stateOf = (g) => (g.status && g.status.state) || 'pre';
    const byRank = (a, b) => rankWeight(a) - rankWeight(b);
    const mine = games.filter(isFollowedGame);
    const rest = games.filter((g) => !isFollowedGame(g));
    const groups = [
      { key: 'mine', title: 'Your teams', games: mine },
      { key: 'live', title: 'Live now', games: rest.filter((g) => stateOf(g) === 'in').sort((a, b) => CFB.gameDrama(b).score - CFB.gameDrama(a).score) },
      { key: 'pre', title: 'Coming up', games: rest.filter((g) => stateOf(g) === 'pre').sort((a, b) => (new Date(a.date) - new Date(b.date)) || byRank(a, b)) },
      { key: 'post', title: 'Final', games: rest.filter((g) => stateOf(g) === 'post').sort(byRank) },
    ].filter((grp) => grp.games.length);

    if (!groups.length) {
      list.innerHTML = '<div class="empty-note">No games match this filter.</div>';
      return;
    }
    const canPick = !!(CFB.account.user() && CFB.sport().notable);
    const card = (g) => CFB.gameCardHtml(g, { followedIds: followed, notable: notableIds.has(String(g.id)), notableToggle: canPick });
    list.innerHTML = groups.map((grp) => `
      <section class="game-group group-${grp.key}">
        <h2 class="section-title group-title">${grp.key === 'live' ? '<span class="live-dot"></span>' : ''}${CFB.esc(grp.title)} <span class="group-count">${grp.games.length}</span></h2>
        <div class="game-list">${grp.games.map(card).join('')}</div>
      </section>`).join('');
    CFB.wireGameCardClicks(list);
  }

  // Signed in: the Notable tab shows this account's own picks, and every
  // card has a star to add or remove it. Signed out: the admin's site-wide
  // picks, read-only.
  function renderNotable() {
    const grid = el('notableGrid');
    const signedIn = !!CFB.account.user();
    if (!state.notable.length) {
      if (!signedIn) {
        grid.innerHTML = '<div class="empty-note">No notable games picked for this week yet. <a href="/account.html">Sign in</a> to pick your own.</div>';
        return;
      }
      grid.innerHTML = `
        <div class="empty-note">
          You haven't picked any notable games this week. Tap the &#9734; on any game in Schedule &amp; Scores to add it.
          ${state.siteNotableCount ? `<div class="notable-actions"><button type="button" id="copySiteNotableBtn">Copy this week's site picks (${state.siteNotableCount})</button></div>` : ''}
        </div>`;
      const copyBtn = el('copySiteNotableBtn');
      if (copyBtn) copyBtn.addEventListener('click', copySiteNotable);
      return;
    }
    // Match each pick against the loaded scoreboard so it renders with the
    // exact same card (channel, time, ranking, live status) as the full
    // schedule. Picks that don't match anything loaded (e.g. postseason
    // picks while viewing the regular season) fall back to a minimal card.
    const cards = state.notable.map((row) => {
      const game = state.games.find((g) => String(g.id) === String(row.event_id));
      if (game) {
        return CFB.gameCardHtml(game, { followedIds: CFB.follows.ids(), notable: true, notableToggle: signedIn });
      }
      return `
        <div class="game-card" data-id="${CFB.esc(row.event_id)}" data-source="${CFB.esc(row.source)}">
          <div class="status-row"><span class="notable-ribbon">Notable</span>${signedIn ? `<button type="button" class="notable-toggle on" data-event-id="${CFB.esc(row.event_id)}" aria-pressed="true" title="Remove from your notable games">&#9733; Notable</button>` : ''}</div>
          <div class="team-row"><span class="team-name">${CFB.esc(row.game_name || 'Game')}</span></div>
          ${row.label ? `<div class="venue">${CFB.esc(row.label)}</div>` : ''}
        </div>`;
    });
    grid.innerHTML = cards.join('');
    CFB.wireGameCardClicks(grid);
  }

  async function loadNotable(sport) {
    if (!sport.notable) return { picks: [], siteCount: 0 };
    const q = `season=${state.season}&week=${state.week}`;
    if (!CFB.account.user()) {
      return { picks: await CFB.getJson(`/api/notable?${q}`).catch(() => []), siteCount: 0 };
    }
    const picks = await CFB.getJson(`/api/account/notable?${q}`).catch(() => []);
    // Offer the site's picks when this account has none for the week.
    const site = picks.length ? [] : await CFB.getJson(`/api/notable?${q}`).catch(() => []);
    return { picks, siteCount: site.length };
  }

  async function copySiteNotable(e) {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      await CFB.account.postJson('/api/account/notable/import', { season: state.season, week: state.week });
      state.notable = await CFB.getJson(`/api/account/notable?season=${state.season}&week=${state.week}`);
      renderGames();
      renderNotable();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = err.message || 'Could not copy the site picks';
    }
  }

  // Star on a game card: add the game to this account's notable games, or
  // take it off.
  async function toggleNotable(btn) {
    const eventId = btn.dataset.eventId;
    const picked = state.notable.find((r) => String(r.event_id) === String(eventId));
    btn.disabled = true;
    try {
      if (picked) {
        await CFB.getJson(`/api/account/notable/${encodeURIComponent(picked.id)}`, { method: 'DELETE' });
        state.notable = state.notable.filter((r) => r !== picked);
      } else {
        const game = state.games.find((g) => String(g.id) === String(eventId));
        state.notable = await CFB.account.postJson('/api/account/notable', {
          season: state.season,
          week: state.week,
          eventId: String(eventId),
          source: (game && game.source) || 'espn',
          gameName: game ? (game.shortName || game.name || null) : null,
        });
      }
      renderGames();
      renderNotable();
    } catch (err) {
      btn.disabled = false;
      btn.title = err.message || 'Could not save';
    }
  }

  function initNotableToggles() {
    [el('gameList'), el('notableGrid')].forEach((container) => {
      container.addEventListener('click', (e) => {
        const btn = e.target.closest && e.target.closest('.notable-toggle');
        if (!btn || btn.disabled) return;
        e.preventDefault();
        e.stopPropagation();
        toggleNotable(btn);
      });
    });
  }

  // "My Teams": one card per team this visitor follows in the current
  // sport, each with its record and live or next game.
  function myTeamCardHtml(saved, data) {
    const team = (data && data.team) || saved;
    const schedule = (data && data.schedule) || [];
    const live = schedule.find((g) => g.status && g.status.state === 'in');
    const upcoming = schedule.find((g) => g.status && g.status.state === 'pre');
    const highlight = live || upcoming;
    const side = (g, t) => (g.home && String(g.home.id) === String(t.id) ? g.home : g.away);
    const other = (g, t) => (g.home && String(g.home.id) === String(t.id) ? g.away : g.home);
    let liveScore = '';
    if (live && live.home && live.away) {
      const me = side(live, saved);
      const them = other(live, saved);
      liveScore = `<div class="hero-score"><span class="${Number(me.score) >= Number(them.score) ? 'lead' : ''}">${CFB.esc(me.score)}</span><span class="dash">&ndash;</span><span>${CFB.esc(them.score)}</span></div>`;
    }
    const countdown = !live && upcoming && upcoming.date ? untilLabel(upcoming.date) : '';
    return `
      ${team.logo ? `<img class="logo" src="${CFB.safeUrl(team.logo)}" alt="" onerror="this.style.display='none'">` : ''}
      <div class="team-meta">
        <a class="name team-link" href="${CFB.teamLink({ id: saved.id })}">${CFB.esc(team.name || 'Team')}</a>
        <div class="record">${team.record ? CFB.esc(team.record) : ''}${team.rank ? ' &middot; Rank #' + CFB.esc(team.rank) : ''}</div>
      </div>
      ${highlight ? `
      <a class="next-game" href="${CFB.gameLink(highlight.id, highlight.source)}">
        <div class="label">${live ? 'Live Now' : 'Next Game'}</div>
        <div class="matchup">${CFB.esc(highlight.shortName || highlight.name)}</div>
        ${liveScore}
        <div class="when">${CFB.esc(CFB.statusLabel(highlight))}${countdown ? ` &middot; <strong>${CFB.esc(countdown)}</strong>` : ''}</div>
      </a>` : ''}
      <button type="button" class="unfollow-btn" title="Unfollow" aria-label="Unfollow ${CFB.esc(team.name || 'team')}">&times;</button>`;
  }

  // "in 2d 4h", "in 45m": time left until kickoff.
  function untilLabel(iso) {
    const ms = new Date(iso).getTime() - Date.now();
    if (!(ms > 0)) return '';
    const mins = Math.round(ms / 60000);
    if (mins < 60) return `in ${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `in ${hours}h ${mins % 60}m`;
    const days = Math.floor(hours / 24);
    return days < 14 ? `in ${days}d ${hours % 24}h` : '';
  }

  async function renderMyTeams() {
    const wrap = el('myTeams');
    const teams = CFB.follows.list();
    if (!teams.length) {
      wrap.innerHTML = '<div class="empty-note">You aren\'t following any teams in this sport yet. Open any team and tap <strong>&#9734; Follow</strong> to pin it here.</div>';
      return;
    }
    wrap.innerHTML = teams.map((t) => `<div class="favorite-card" data-team-id="${CFB.esc(t.id)}">${myTeamCardHtml(t, null)}</div>`).join('');
    await Promise.all(teams.map(async (t) => {
      const card = wrap.querySelector(`[data-team-id="${CSS.escape(String(t.id))}"]`);
      try {
        const data = await CFB.getJson(CFB.withSport(`/api/team/${encodeURIComponent(t.id)}?lite=1`));
        card.innerHTML = myTeamCardHtml(t, data);
        const sched = (data && data.schedule) || [];
        card.classList.toggle('is-live', sched.some((g) => g.status && g.status.state === 'in'));
        CFB.applyTeamColor(card, data.team && data.team.color);
      } catch (err) {
        // Keep the saved name/logo if the live lookup fails.
      }
    }));
    wrap.querySelectorAll('.favorite-card').forEach((card) => {
      const btn = card.querySelector('.unfollow-btn');
      if (btn) {
        btn.addEventListener('click', () => {
          CFB.follows.remove(card.dataset.teamId);
          renderMyTeams();
          renderGames();
          state.newsLoaded = false;
        });
      }
    });
  }

  // ‹ Week 10 › stepper. The Season / Week / Type selects still drive the
  // load; they just live in a "Season & bowls" drawer now.
  function updateWeekLabel() {
    const weekSelect = el('weekSelect');
    const typeSelect = el('seasonTypeSelect');
    const typeOpt = typeSelect.options[typeSelect.selectedIndex];
    const isPost = Number(typeSelect.value) === 3;
    el('weekLabel').textContent = isPost
      ? `${typeOpt ? typeOpt.textContent : 'Postseason'}`
      : `Week ${weekSelect.value} · ${el('seasonSelect').value}`;
    el('prevWeekBtn').disabled = isPost || weekSelect.selectedIndex <= 0;
    el('nextWeekBtn').disabled = isPost || weekSelect.selectedIndex >= weekSelect.options.length - 1;
  }

  function initWeekStrip() {
    const step = (delta) => {
      const weekSelect = el('weekSelect');
      const i = weekSelect.selectedIndex + delta;
      if (i < 0 || i >= weekSelect.options.length) return;
      weekSelect.selectedIndex = i;
      updateWeekLabel();
      loadWeek();
    };
    el('prevWeekBtn').addEventListener('click', () => step(-1));
    el('nextWeekBtn').addEventListener('click', () => step(1));
    ['seasonSelect', 'weekSelect', 'seasonTypeSelect'].forEach((id) => el(id).addEventListener('change', updateWeekLabel));
    el('goBtn').addEventListener('click', () => { el('weekControls').querySelector('details').open = false; });
  }

  function populateSelectors(meta) {
    const seasonSelect = el('seasonSelect');
    const weekSelect = el('weekSelect');
    const seasonTypeSelect = el('seasonTypeSelect');

    const sport = CFB.sport();
    const currentYear = meta.season || new Date().getFullYear();
    seasonSelect.innerHTML = '';
    for (let y = currentYear; y >= currentYear - 2; y--) {
      const opt = document.createElement('option');
      opt.value = y;
      opt.textContent = y;
      seasonSelect.appendChild(opt);
    }
    seasonSelect.value = currentYear;

    weekSelect.innerHTML = '';
    for (let w = 1; w <= (sport.maxWeek || 15); w++) {
      const opt = document.createElement('option');
      opt.value = w;
      opt.textContent = `Week ${w}`;
      weekSelect.appendChild(opt);
    }
    weekSelect.value = meta.week || 1;

    if (sport.seasonTypes) {
      seasonTypeSelect.innerHTML = '';
      sport.seasonTypes.forEach((t) => {
        const opt = document.createElement('option');
        opt.value = t.value;
        opt.textContent = t.label;
        seasonTypeSelect.appendChild(opt);
      });
    }
    seasonTypeSelect.value = String(meta.seasonType || 2);
    updateWeekLabel();
  }

  // ---- Day-based sports (NBA, MLB, NHL, college hoops) ----
  function toInputValue(date) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  function setDay(date) {
    state.day = date;
    el('dayInput').value = toInputValue(date);
    loadWeek();
  }

  function shiftDay(delta) {
    const d = new Date(state.day || new Date());
    d.setDate(d.getDate() + delta);
    setDay(d);
  }

  function initDayControls() {
    el('weekControls').hidden = true;
    el('dayControls').hidden = false;
    state.day = new Date();
    el('dayInput').value = toInputValue(state.day);
    el('dayInput').addEventListener('change', () => {
      const [y, m, d] = el('dayInput').value.split('-').map(Number);
      if (y && m && d) setDay(new Date(y, m - 1, d));
    });
    el('prevDayBtn').addEventListener('click', () => shiftDay(-1));
    el('nextDayBtn').addEventListener('click', () => shiftDay(1));
    el('todayBtn').addEventListener('click', () => setDay(new Date()));
  }

  function scoreboardUrl() {
    const sport = CFB.sport();
    const params = new URLSearchParams();
    if (sport.schedule === 'event') {
      // UFC / NASCAR: the last month of results and the next two months.
      const start = new Date();
      start.setDate(start.getDate() - 30);
      const end = new Date();
      end.setDate(end.getDate() + 60);
      params.set('dates', `${CFB.ymd(start)}-${CFB.ymd(end)}`);
    } else if (sport.schedule === 'day') {
      params.set('dates', CFB.ymd(state.day || new Date()));
    } else {
      params.set('year', state.season);
      params.set('week', state.week);
      params.set('seasontype', state.seasonType);
    }
    if (state.group) params.set('groups', state.group);
    return CFB.withSport(`/api/scoreboard?${params.toString()}`);
  }

  function dayLabel(date) {
    return date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  }

  // Score of every game on screen, so a refresh can flash the cards whose
  // score just changed.
  function scoreMap() {
    const map = new Map();
    for (const g of state.games || []) {
      if (g && g.id) map.set(String(g.id), { away: g.away && g.away.score, home: g.home && g.home.score, state: g.status && g.status.state });
    }
    return map;
  }

  // Cards whose score changed since the last refresh flash, and the number
  // that changed pops.
  function flashChanged(before) {
    if (!before) return;
    scoreMap().forEach((v, id) => {
      const old = before.get(id);
      if (!old || (old.away === v.away && old.home === v.home && old.state === v.state)) return;
      document.querySelectorAll(`.game-card[data-id="${CSS.escape(id)}"]`).forEach((card) => {
        card.classList.add('score-flash');
        ['away', 'home'].forEach((side) => {
          if (old[side] === v[side]) return;
          const score = card.querySelector(`.team-row[data-side="${side}"] .score`);
          if (score) score.classList.add('score-bump');
        });
      });
    });
  }

  let loadSeq = 0;

  // `silent` is the background refresh: no "Loading" placeholder, and the
  // last good scores stay up if a refresh fails.
  async function loadWeek(opts) {
    const silent = !!(opts && opts.silent);
    const seq = ++loadSeq;
    const sport = CFB.sport();
    state.season = Number(el('seasonSelect').value);
    state.week = Number(el('weekSelect').value);
    state.seasonType = Number(el('seasonTypeSelect').value);
    const before = silent ? scoreMap() : null;

    if (!silent) {
      el('gameList').innerHTML = `<div class="game-list">${CFB.skeletonCards(6)}</div>`;
      el('notableGrid').innerHTML = CFB.skeletonCards(3);
    }

    try {
      const [scoreboard, notable] = await Promise.all([
        CFB.getJson(scoreboardUrl()),
        loadNotable(sport),
      ]);
      if (seq !== loadSeq) return; // a newer load (e.g. a week change) won
      state.games = scoreboard.games || [];
      state.events = scoreboard.events || null;
      state.notable = notable.picks || [];
      state.siteNotableCount = notable.siteCount || 0;
      state.favoriteTeamId = scoreboard.favoriteTeamId;
      el('sourceNote').textContent = sport.schedule === 'event'
        ? `${sport.label} · Events`
        : sport.schedule === 'day'
          ? `${sport.label} · ${dayLabel(state.day || new Date())}`
          : `${sport.label} · ${scoreboard.season} · Week ${scoreboard.week}`;
      renderGames();
      renderNotable();
      flashChanged(before);
      scheduleAutoRefresh();
      // Confetti and a fanfare when a followed team scores (kids.js).
      if (typeof Kids !== 'undefined') Kids.watchScores(state.games, sport.key);
    } catch (err) {
      if (seq !== loadSeq) return;
      if (silent) {
        scheduleAutoRefresh(); // keep the last good scores, try again
        return;
      }
      el('gameList').innerHTML = '<div class="empty-note">Could not load scoreboard.</div>';
      el('notableGrid').innerHTML = '<div class="empty-note">Could not load notable games.</div>';
    }
  }

  // Live scores update on their own: every 20s while any game on screen is
  // live, every minute when one starts within the next half hour (so the
  // card flips to LIVE without a reload). Paused while the tab is hidden and
  // refreshed as soon as it's visible again.
  function refreshDelay() {
    const all = [...state.games, ...(state.events || [])];
    if (all.some((g) => g.status && g.status.state === 'in')) return 20000;
    const soon = Date.now() + 30 * 60 * 1000;
    if (all.some((g) => g.status && g.status.state === 'pre' && g.date && new Date(g.date).getTime() < soon)) return 60000;
    return null;
  }

  function scheduleAutoRefresh() {
    if (state.pollTimer) clearTimeout(state.pollTimer);
    state.pollTimer = null;
    const delay = refreshDelay();
    const time = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    el('refreshNote').textContent = delay ? `Live · updates every ${delay / 1000}s · ${time}` : '';
    if (delay && !document.hidden) state.pollTimer = setTimeout(() => loadWeek({ silent: true }), delay);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (state.pollTimer) clearTimeout(state.pollTimer);
      state.pollTimer = null;
    } else if (refreshDelay()) {
      loadWeek({ silent: true });
    }
  });

  function initTabs() {
    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
        document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
        btn.classList.add('active');
        el(`tab-${btn.dataset.tab}`).classList.add('active');
        if (btn.dataset.tab === 'news' && !state.newsLoaded) loadNews();
        if (btn.dataset.tab === 'videos' && !state.videosLoaded) loadVideos();
      });
    });
  }

  function formatViews(n) {
    if (n === null || n === undefined) return '';
    if (n >= 1000000) return `${(n / 1000000).toFixed(1).replace(/\.0$/, '')}M views`;
    if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K views`;
    return `${n} views`;
  }

  function timeAgo(iso) {
    if (!iso) return '';
    const diffMs = Date.now() - new Date(iso).getTime();
    const mins = Math.round(diffMs / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
  }

  // News tab: "My teams" (headlines for followed teams) or "All news".
  // Defaults to My teams whenever the visitor follows a team in this sport.
  const NEWS_MODE_KEY = 'tracker-news-mode';

  function newsMode() {
    if (!CFB.follows.list().length) return 'all';
    try { return localStorage.getItem(NEWS_MODE_KEY) === 'all' ? 'all' : 'mine'; } catch (e) { return 'mine'; }
  }

  function initNewsFilter() {
    const filter = el('newsFilter');
    const update = () => {
      const hasFollows = CFB.follows.list().length > 0;
      filter.hidden = !hasFollows;
      filter.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.filter === newsMode()));
    };
    filter.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', () => {
        try { localStorage.setItem(NEWS_MODE_KEY, btn.dataset.filter); } catch (e) { /* ignore */ }
        update();
        loadNews();
      });
    });
    update();
    return update;
  }

  // Four headlines under the scores, so the home page reads like a front page.
  async function loadHeadlines() {
    const strip = el('headlineStrip');
    const followed = CFB.follows.list();
    const url = followed.length
      ? CFB.withSport(`/api/news/teams?teams=${encodeURIComponent(followed.map((t) => t.id).join(','))}`)
      : CFB.withSport('/api/news');
    try {
      let data = await CFB.getJson(url);
      if (!(data.items || []).length && followed.length) data = await CFB.getJson(CFB.withSport('/api/news'));
      const items = (data.items || []).filter((i) => CFB.safeUrl(i.link)).slice(0, 4);
      if (!items.length) return;
      el('headlineList').innerHTML = items.map((item) => `
        <a class="headline-item" href="${CFB.safeUrl(item.link)}" target="_blank" rel="noopener noreferrer">
          ${CFB.safeUrl(item.image) ? `<img src="${CFB.safeUrl(item.image)}" alt="" loading="lazy" onerror="this.remove()">` : ''}
          <span class="headline-text">
            <span class="headline-title">${CFB.esc(item.title)}</span>
            <span class="headline-meta">${CFB.esc(item.source || '')}${item.pubDate ? ` &middot; ${timeAgo(item.pubDate)}` : ''}</span>
          </span>
        </a>`).join('');
      strip.hidden = false;
    } catch (err) {
      // The strip just stays hidden.
    }
  }

  async function loadNews() {
    const list = el('newsList');
    list.innerHTML = '<div class="empty-note">Loading&hellip;</div>';
    if (state.updateNewsFilter) state.updateNewsFilter();
    const mode = newsMode();
    const followed = CFB.follows.list();
    const teamNames = new Map(followed.map((t) => [String(t.id), t.abbreviation || t.name]));
    const url = mode === 'mine'
      ? CFB.withSport(`/api/news/teams?teams=${encodeURIComponent(followed.map((t) => t.id).join(','))}`)
      : CFB.withSport('/api/news');
    try {
      const data = await CFB.getJson(url);
      state.newsLoaded = true;
      const items = data.items || [];
      if (!items.length) {
        list.innerHTML = mode === 'mine'
          ? '<div class="empty-note">No recent headlines for the teams you follow. Try All news.</div>'
          : '<div class="empty-note">No news available right now.</div>';
        return;
      }
      list.innerHTML = items.filter((item) => CFB.safeUrl(item.link)).map((item) => `
        <a class="news-item" href="${CFB.safeUrl(item.link)}" target="_blank" rel="noopener noreferrer">
          ${CFB.safeUrl(item.image)
            ? `<img class="news-thumb" src="${CFB.safeUrl(item.image)}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'news-thumb-placeholder',textContent:'📰'}))">`
            : '<div class="news-thumb-placeholder">&#128240;</div>'}
          <div class="news-item-body">
            <div class="news-item-top">
              <span class="news-source">${CFB.esc(item.source)}${item.teamId && teamNames.get(String(item.teamId)) ? ` &middot; ${CFB.esc(teamNames.get(String(item.teamId)))}` : ''}</span>
              ${item.pubDate ? `<span class="news-time">${timeAgo(item.pubDate)}</span>` : ''}
            </div>
            <div class="news-title">${CFB.esc(item.title)}</div>
            ${item.summary ? `<div class="news-summary">${CFB.esc(item.summary)}</div>` : ''}
          </div>
        </a>`).join('');
    } catch (err) {
      list.innerHTML = '<div class="empty-note">Could not load news right now.</div>';
    }
  }

  // Clicking a video's thumbnail plays it inline — swaps the thumbnail +
  // play button for an embedded YouTube iframe right there in the card,
  // rather than navigating away, so a video feed actually feels like a feed.
  function playVideoInline(card, video) {
    const thumbWrap = card.querySelector('.video-thumb-wrap');
    if (!thumbWrap) return;
    thumbWrap.innerHTML = `
      <div class="video-embed-wrap">
        <iframe src="${CFB.safeUrl(video.embedUrl)}" title="${CFB.esc(video.title)}" frameborder="0"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowfullscreen></iframe>
      </div>`;
  }

  async function loadVideos() {
    const list = el('videoList');
    list.innerHTML = '<div class="empty-note">Loading&hellip;</div>';
    try {
      const data = await CFB.getJson('/api/videos');
      state.videosLoaded = true;
      const items = data.items || [];
      if (!items.length) {
        list.innerHTML = '<div class="empty-note">No videos available right now.</div>';
        return;
      }
      list.innerHTML = items.map((v, i) => `
        <div class="video-card" data-index="${i}">
          <div class="video-thumb-wrap">
            <img class="video-thumb" src="${CFB.safeUrl(v.thumbnail)}" alt="" loading="lazy" onerror="this.style.display='none'">
            <span class="video-play-btn">&#9658;</span>
          </div>
          <div class="video-item-body">
            <div class="video-title">${CFB.esc(v.title)}</div>
            <div class="video-meta">
              <span class="video-channel">${CFB.esc(v.channel)}</span>
              ${v.views !== null ? `<span>&middot; ${formatViews(v.views)}</span>` : ''}
              ${v.publishedAt ? `<span>&middot; ${timeAgo(v.publishedAt)}</span>` : ''}
            </div>
          </div>
        </div>`).join('');

      list.querySelectorAll('.video-card').forEach((card) => {
        const video = items[Number(card.dataset.index)];
        card.querySelector('.video-thumb-wrap').addEventListener('click', () => playVideoInline(card, video));
      });
    } catch (err) {
      list.innerHTML = '<div class="empty-note">Could not load videos right now.</div>';
    }
  }

  // Hide the pieces that only exist for college football: the pinned
  // "My Team" card, Notable Games, and the CFB YouTube feed.
  function applySportLayout(sport) {
    document.title = sport.key === 'cfb' ? 'Stat Scraps' : `${sport.label} · Stat Scraps`;
    const isCfb = sport.key === 'cfb';
    // UFC and NASCAR have fighters and drivers, not teams to follow.
    el('favoriteSection').hidden = sport.teams === false;
    document.querySelector('.tab-btn[data-tab="notable"]').hidden = !sport.notable;
    document.querySelector('.tab-btn[data-tab="videos"]').hidden = !isCfb;
  }

  async function init() {
    const sport = await CFB.loadSports();
    CFB.initSportBar();
    applySportLayout(sport);
    if (sport.schedule === 'event') {
      el('weekControls').hidden = true;
    } else if (sport.schedule === 'day') {
      initDayControls();
    } else {
      try {
        const meta = await CFB.getJson(CFB.withSport('/api/meta'));
        state.favoriteTeamId = meta.favoriteTeamId;
        if (sport.key === 'cfb') CFB.follows.seedDefault(meta.favoriteTeamId, meta.favoriteTeamName);
        populateSelectors(meta);
        el('sourceNote').textContent = `${sport.label} · ${meta.season} · Week ${meta.week}`;
      } catch (err) {
        populateSelectors({ season: new Date().getFullYear(), week: 1, seasonType: 2 });
      }
      el('goBtn').addEventListener('click', loadWeek);
      initWeekStrip();
    }
    initTabs();
    initGameFilter();
    initNotableToggles();
    el('moreNewsBtn').addEventListener('click', () => {
      const btn = document.querySelector('.tab-btn[data-tab="news"]');
      btn.click();
      btn.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    loadHeadlines();
    CFB.initDivisionToggle((group) => {
      state.group = group;
      loadWeek();
    });
    state.updateNewsFilter = initNewsFilter();
    if (sport.teams !== false) renderMyTeams();
  }

  init();
})();

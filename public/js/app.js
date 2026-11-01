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
      ${ahead.length ? ahead.map(CFB.eventCardHtml).join('') : '<div class="empty-note">No upcoming events in the next two months.</div>'}
      ${past.length ? `<h2 class="section-title list-divider">Recent results</h2>${past.map(CFB.eventCardHtml).join('')}` : ''}`;
  }

  function renderGames() {
    if (state.events) { renderEvents(); return; }
    const list = el('gameList');
    if (!state.games.length) {
      list.innerHTML = '<div class="empty-note">No games found for this week.</div>';
      return;
    }
    const notableIds = new Set(state.notable.map((r) => String(r.event_id)));
    // Games involving a followed team go first, in their original order.
    const followed = CFB.follows.ids();
    const isFollowedGame = (g) => (g.home && followed.has(String(g.home.id))) || (g.away && followed.has(String(g.away.id)));
    const ordered = [...state.games.filter(isFollowedGame), ...state.games.filter((g) => !isFollowedGame(g))];
    list.innerHTML = ordered.map((g) => CFB.gameCardHtml(g, {
      followedIds: followed,
      notable: notableIds.has(String(g.id)),
    })).join('');
    CFB.wireGameCardClicks(list);
  }

  function renderNotable() {
    const grid = el('notableGrid');
    if (!state.notable.length) {
      grid.innerHTML = '<div class="empty-note">No notable games picked for this week yet. Add some in the admin section.</div>';
      return;
    }
    // Match each pick against the loaded scoreboard so it renders with the
    // exact same card (channel, time, ranking, live status) as the full
    // schedule. Picks that don't match anything loaded (e.g. postseason
    // picks while viewing the regular season) fall back to a minimal card.
    const cards = state.notable.map((row) => {
      const game = state.games.find((g) => String(g.id) === String(row.event_id));
      if (game) {
        return CFB.gameCardHtml(game, { followedIds: CFB.follows.ids(), notable: true });
      }
      return `
        <div class="game-card" data-id="${CFB.esc(row.event_id)}" data-source="${CFB.esc(row.source)}">
          <div class="status-row"><span class="notable-ribbon">Notable</span></div>
          <div class="team-row"><span class="team-name">${CFB.esc(row.game_name || 'Game')}</span></div>
          ${row.label ? `<div class="venue">${CFB.esc(row.label)}</div>` : ''}
        </div>`;
    });
    grid.innerHTML = cards.join('');
    CFB.wireGameCardClicks(grid);
  }

  // "My Teams": one card per team this visitor follows in the current
  // sport, each with its record and live or next game.
  function myTeamCardHtml(saved, data) {
    const team = (data && data.team) || saved;
    const schedule = (data && data.schedule) || [];
    const live = schedule.find((g) => g.status && g.status.state === 'in');
    const upcoming = schedule.find((g) => g.status && g.status.state === 'pre');
    const highlight = live || upcoming;
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
        <div class="when">${CFB.esc(CFB.statusLabel(highlight))}</div>
      </a>` : ''}
      <button type="button" class="unfollow-btn" title="Unfollow" aria-label="Unfollow ${CFB.esc(team.name || 'team')}">&times;</button>`;
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

  async function loadWeek() {
    const sport = CFB.sport();
    state.season = Number(el('seasonSelect').value);
    state.week = Number(el('weekSelect').value);
    state.seasonType = Number(el('seasonTypeSelect').value);

    el('gameList').innerHTML = '<div class="empty-note">Loading&hellip;</div>';
    el('notableGrid').innerHTML = '<div class="empty-note">Loading&hellip;</div>';

    try {
      const [scoreboard, notable] = await Promise.all([
        CFB.getJson(scoreboardUrl()),
        sport.notable
          ? CFB.getJson(`/api/notable?season=${state.season}&week=${state.week}`).catch(() => [])
          : Promise.resolve([]),
      ]);
      state.games = scoreboard.games || [];
      state.events = scoreboard.events || null;
      state.notable = notable || [];
      state.favoriteTeamId = scoreboard.favoriteTeamId;
      el('sourceNote').textContent = sport.schedule === 'event'
        ? `${sport.label} · Events`
        : sport.schedule === 'day'
          ? `${sport.label} · ${dayLabel(state.day || new Date())}`
          : `${sport.label} · ${scoreboard.season} · Week ${scoreboard.week}`;
      renderGames();
      renderNotable();
      scheduleAutoRefresh();
    } catch (err) {
      el('gameList').innerHTML = '<div class="empty-note">Could not load scoreboard.</div>';
      el('notableGrid').innerHTML = '<div class="empty-note">Could not load notable games.</div>';
    }
  }

  function scheduleAutoRefresh() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    const anyLive = [...state.games, ...(state.events || [])].some((g) => g.status && g.status.state === 'in');
    el('refreshNote').textContent = anyLive ? 'Auto-refreshing live games every 20s' : '';
    if (anyLive) {
      state.pollTimer = setInterval(loadWeek, 20000);
    }
  }

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
  // "My Team" card, admin-curated Notable Games, and the CFB YouTube feed.
  function applySportLayout(sport) {
    document.title = sport.key === 'cfb' ? 'CFB Tracker' : `${sport.label} · CFB Tracker`;
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
    }
    initTabs();
    CFB.initDivisionToggle((group) => {
      state.group = group;
      loadWeek();
    });
    state.updateNewsFilter = initNewsFilter();
    if (sport.teams !== false) renderMyTeams();
  }

  init();
})();

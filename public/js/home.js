// The all-sports home page (home.html). One call to /api/home returns the
// visitor's followed teams, the biggest live games across every league, a
// summary card per league and mixed headlines (see src/home.js). Each sport's
// full scoreboard lives at /scores?sport=...
(function () {
  const { el, esc, safeUrl } = CFB;
  const REFRESH_LIVE_MS = 30 * 1000;
  const REFRESH_IDLE_MS = 2 * 60 * 1000;
  let timer = null;
  let sportsByKey = {};

  const q = (k) => encodeURIComponent(k);
  const scoresUrl = (sport) => `/scores?sport=${q(sport)}`;
  const gameUrl = (g) => `/game.html?id=${q(g.id)}&source=${q(g.source || 'espn')}&sport=${q(g.sport)}`;
  const teamUrl = (sport, id) => `/team.html?id=${q(id)}&source=espn&sport=${q(sport)}`;
  const shortLabel = (key) => (sportsByKey[key] && sportsByKey[key].shortLabel) || key.toUpperCase();
  const isLive = (g) => g && g.status && g.status.state === 'in';
  const isFinal = (g) => g && g.status && g.status.state === 'post';

  // "Today 7:30 PM", "Tomorrow 7:30 PM" ("Sun 7:30 PM" when compact),
  // "Sat 3:30 PM", "Nov 14".
  function whenLabel(iso, timeValid, compact) {
    if (!iso) return '';
    const d = new Date(iso);
    const today = new Date();
    const days = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - new Date(today.getFullYear(), today.getMonth(), today.getDate())) / 86400000);
    const time = timeValid === false ? 'TBA' : d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    if (days === 0) return `Today ${time}`;
    if (days === 1 && !compact) return `Tomorrow ${time}`;
    if (days >= 1 && days < 7) return `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`;
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function gameStatus(g) {
    if (isLive(g)) return CFB.statusLabel(g);
    if (isFinal(g)) return CFB.statusLabel(g);
    return whenLabel(g.date, g.timeValid, true);
  }

  function teamName(t) {
    return (t && (t.shortName || t.abbreviation || t.name)) || 'TBD';
  }

  function rowHtml(t, g) {
    if (!t) return '<div class="hg-team"><span class="hg-name">TBD</span></div>';
    const showScore = (isLive(g) || isFinal(g)) && t.score !== null && t.score !== undefined;
    const lost = isFinal(g) && !t.winner;
    return `
      <div class="hg-team ${lost ? 'lost' : ''} ${isFinal(g) && t.winner ? 'won' : ''}">
        ${t.logo ? `<img src="${safeUrl(t.logo)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">` : '<span class="hg-logo-gap"></span>'}
        <span class="hg-name">${t.curatedRank ? `<span class="hg-rank">${esc(t.curatedRank)}</span>` : ''}${esc(teamName(t))}</span>
        <span class="hg-score">${showScore ? esc(t.score) : ''}</span>
      </div>`;
  }

  // A compact two-row game, used in the live strip and the league cards.
  function gameHtml(g, opts) {
    opts = opts || {};
    return `
      <a class="home-game ${isLive(g) ? 'is-live' : ''} ${isFinal(g) ? 'is-final' : ''}" href="${esc(gameUrl(g))}">
        <div class="hg-status">
          ${opts.sportTag ? `<span class="sport-tag">${esc(shortLabel(g.sport))}</span>` : ''}
          <span class="${isLive(g) ? 'live-dot' : ''}">${esc(gameStatus(g))}</span>
          ${g.broadcast && !isFinal(g) ? `<span class="hg-tv">${esc(g.broadcast)}</span>` : ''}
        </div>
        ${rowHtml(g.away, g)}
        ${rowHtml(g.home, g)}
        ${opts.headline && g.headline ? `<div class="hg-headline">${esc(g.headline)}</div>` : ''}
      </a>`;
  }

  function eventHtml(e) {
    const live = isLive(e);
    const status = live ? 'Live' : isFinal(e) ? 'Final' : whenLabel(e.date, true, true);
    return `
      <a class="home-game home-event ${live ? 'is-live' : ''}" href="${esc(scoresUrl(e.sport))}">
        <div class="hg-status"><span class="${live ? 'live-dot' : ''}">${esc(status)}</span>${e.broadcast ? `<span class="hg-tv">${esc(e.broadcast)}</span>` : ''}</div>
        <div class="he-name">${esc(e.name)}</div>
        ${e.summary ? `<div class="he-summary">${esc(e.summary)}</div>` : ''}
        ${e.venue ? `<div class="he-venue">${esc(e.venue)}</div>` : ''}
      </a>`;
  }

  // ---- My teams -----------------------------------------------------------
  function myTeamHtml(t) {
    const g = t.liveGame || t.nextGame || t.lastGame;
    let body = '<div class="ht-line ht-dim">No games scheduled</div>';
    if (g && g.home && g.away) {
      const mine = String(g.home.id) === String(t.id) ? g.home : g.away;
      const them = mine === g.home ? g.away : g.home;
      const vs = mine === g.home ? 'vs' : 'at';
      const slim = { ...g, sport: t.sport };
      if (t.liveGame) {
        const ahead = Number(mine.score) >= Number(them.score);
        body = `
          <div class="ht-label live"><span class="live-dot"></span>Live</div>
          ${hasScore(mine) && hasScore(them) ? `<div class="ht-score"><span class="${ahead ? 'lead' : ''}">${esc(mine.score)}</span><span class="dash">&ndash;</span><span>${esc(them.score)}</span></div>` : ''}
          <div class="ht-line">${vs} ${esc(teamName(them))} &middot; ${esc(CFB.statusLabel(slim))}</div>`;
      } else if (t.nextGame) {
        body = `
          <div class="ht-label">Next</div>
          <div class="ht-line ht-strong">${vs} ${esc(teamName(them))}</div>
          <div class="ht-line ht-dim">${esc(whenLabel(g.date, g.timeValid))}${g.broadcast ? ` &middot; ${esc(g.broadcast)}` : ''}</div>`;
      } else {
        const won = mine.winner || Number(mine.score) > Number(them.score);
        body = `
          <div class="ht-label">Last</div>
          <div class="ht-line ht-strong"><span class="wl-badge ${won ? 'win' : 'loss'}">${won ? 'W' : 'L'}</span> ${esc(mine.score)}&ndash;${esc(them.score)} ${vs} ${esc(teamName(them))}</div>`;
      }
      return `
        <a class="home-team ${t.liveGame ? 'is-live' : ''}" href="${esc(gameUrl({ ...slim, source: 'espn' }))}" style="${teamColor(t.color)}">
          ${teamHead(t)}
          ${body}
        </a>`;
    }
    return `<a class="home-team" href="${esc(teamUrl(t.sport, t.id))}" style="${teamColor(t.color)}">${teamHead(t)}${body}</a>`;
  }

  function hasScore(team) {
    return !!team && team.score !== null && team.score !== undefined && team.score !== '';
  }

  function teamColor(color) {
    return color && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(color) ? `--team-color:${color}` : '';
  }

  function teamHead(t) {
    return `
      <div class="ht-head">
        ${t.logo ? `<img src="${safeUrl(t.logo)}" alt="" loading="lazy" onerror="this.style.display='none'">` : ''}
        <div class="ht-meta">
          <div class="ht-name">${t.rank ? `<span class="hg-rank">${esc(t.rank)}</span>` : ''}${esc(t.name || 'Team')}</div>
          <div class="ht-sub"><span class="sport-tag">${esc(shortLabel(t.sport))}</span>${t.record ? ` ${esc(t.record)}` : ''}</div>
        </div>
      </div>`;
  }

  function renderMyTeams(teams, followed) {
    const wrap = el('homeTeams');
    if (!followed.length) {
      wrap.innerHTML = `
        <div class="home-empty">
          <strong>Follow your teams to see them here.</strong>
          <span>Search for any team in any sport and tap <strong>&#9734; Follow</strong>. Their live scores and next games will show up first.</span>
          <button type="button" class="home-search-btn" id="homeSearchBtn">Find a team</button>
        </div>`;
      const btn = el('homeSearchBtn');
      btn.addEventListener('click', () => {
        const open = document.querySelector('.search-btn, [data-search-open]');
        if (open) open.click();
      });
      return;
    }
    const list = teams && teams.length ? teams : followed;
    // Live first, then soonest next game.
    const sortKey = (t) => (t.liveGame ? 0 : t.nextGame ? 1 + (Date.parse(t.nextGame.date) || 0) / 1e15 : 3);
    wrap.innerHTML = list.slice().sort((a, b) => sortKey(a) - sortKey(b)).map(myTeamHtml).join('');
  }

  // ---- Leagues ------------------------------------------------------------
  function countsHtml(c) {
    const parts = [];
    if (c.live) parts.push(`<span class="lc-live"><span class="live-dot"></span>${c.live} live</span>`);
    if (c.upcoming) parts.push(`<span>${c.upcoming} upcoming</span>`);
    if (c.final) parts.push(`<span>${c.final} final</span>`);
    return parts.join('');
  }

  function leagueHtml(l) {
    const items = l.events && l.events.length
      ? l.events.map((e) => eventHtml(e)).join('')
      : l.games.map((g) => gameHtml(g, { headline: true })).join('');
    return `
      <article class="league-card ${l.counts.live ? 'has-live' : ''}">
        <header class="lc-head">
          <a class="lc-title" href="${esc(scoresUrl(l.key))}">
            <span class="lc-short">${esc(l.shortLabel)}</span>
            <span class="lc-label">${esc(l.label)}${l.period ? ` &middot; ${esc(l.period)}` : ''}</span>
          </a>
          <div class="lc-counts">${countsHtml(l.counts)}</div>
        </header>
        <div class="lc-games">${items || '<div class="empty-note">Nothing on right now.</div>'}</div>
        <a class="lc-more" href="${esc(scoresUrl(l.key))}">All ${esc(l.shortLabel)} scores &rsaquo;</a>
      </article>`;
  }

  function renderLeagues(leagues) {
    const on = leagues.filter((l) => l.inSeason);
    const off = leagues.filter((l) => !l.inSeason);
    el('homeLeagues').innerHTML = on.length
      ? on.map(leagueHtml).join('')
      : '<div class="empty-note">No league has games this week.</div>';
    const offWrap = el('homeOffseason');
    offWrap.hidden = !off.length;
    offWrap.innerHTML = off.length
      ? `<span class="home-note">Off-season:</span> ${off.map((l) => `<a href="${esc(scoresUrl(l.key))}">${esc(l.label)}</a>`).join('')}`
      : '';
  }

  function renderJump(leagues) {
    el('leagueJump').innerHTML = leagues.map((l) => `
      <a href="${esc(scoresUrl(l.key))}" class="${l.inSeason ? '' : 'off'}" title="${esc(l.label)}">
        ${esc(l.shortLabel)}${l.counts.live ? `<span class="jump-live">${l.counts.live}</span>` : ''}
      </a>`).join('');
  }

  // ---- Headlines ----------------------------------------------------------
  function timeAgo(iso) {
    const ms = Date.now() - new Date(iso).getTime();
    if (!(ms >= 0)) return '';
    const mins = Math.round(ms / 60000);
    if (mins < 60) return `${Math.max(1, mins)}m ago`;
    const hours = Math.round(mins / 60);
    if (hours < 48) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
  }

  function renderHeadlines(items) {
    const list = (items || []).filter((i) => safeUrl(i.link));
    el('headlinesSection').hidden = !list.length;
    el('homeHeadlines').innerHTML = list.map((item) => `
      <a class="headline-item" href="${safeUrl(item.link)}" target="_blank" rel="noopener noreferrer">
        ${safeUrl(item.image) ? `<img src="${safeUrl(item.image)}" alt="" loading="lazy" onerror="this.remove()">` : ''}
        <span class="headline-text">
          <span class="headline-title">${esc(item.title)}</span>
          <span class="headline-meta"><span class="sport-tag">${esc(shortLabel(item.sport))}</span> ${esc(item.source || '')}${item.pubDate ? ` &middot; ${timeAgo(item.pubDate)}` : ''}</span>
        </span>
      </a>`).join('');
  }

  // ---- Load ---------------------------------------------------------------
  function renderSummary(data) {
    el('homeDate').textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
    const live = data.counts.live;
    const leagues = data.counts.leaguesInSeason;
    el('homeSummary').textContent = live
      ? `${live} game${live === 1 ? '' : 's'} live right now across ${leagues} league${leagues === 1 ? '' : 's'} in season.`
      : `${leagues} league${leagues === 1 ? '' : 's'} in season. Nothing live at the moment.`;
  }

  function renderLive(live) {
    el('liveSection').hidden = !live.length;
    el('homeLive').innerHTML = live.map((g) => gameHtml(g, { sportTag: true })).join('');
    el('liveNote').textContent = live.length ? 'Closest and latest games first' : '';
  }

  async function load() {
    clearTimeout(timer);
    const followed = CFB.follows.all().filter((t) => t.sport && t.id);
    const teamsParam = followed.map((t) => `${t.sport}:${t.id}`).join(',');
    let data;
    try {
      data = await CFB.getJson(`/api/home${teamsParam ? `?teams=${encodeURIComponent(teamsParam)}` : ''}`);
    } catch (err) {
      el('homeSummary').textContent = 'Could not load scores right now. Trying again shortly.';
      timer = setTimeout(load, REFRESH_IDLE_MS);
      return;
    }
    renderSummary(data);
    renderMyTeams(data.myTeams, followed);
    renderLive(data.live || []);
    renderJump(data.leagues || []);
    renderLeagues(data.leagues || []);
    renderHeadlines(data.headlines);
    const anyLive = (data.live || []).length || (data.myTeams || []).some((t) => t.liveGame);
    timer = setTimeout(load, anyLive ? REFRESH_LIVE_MS : REFRESH_IDLE_MS);
  }

  async function init() {
    await CFB.loadSports();
    try {
      const data = await CFB.getJson('/api/sports');
      (data.sports || []).forEach((s) => { sportsByKey[s.key] = s; });
    } catch (e) { /* fall back to upper-case keys */ }
    // New visitors used to start out following the site's favorite team on
    // the Scores page; keep doing that here, where they now land.
    let seeded = '1';
    try { seeded = localStorage.getItem('tracker-follows-seeded'); } catch (e) { /* ignore */ }
    if (!seeded) {
      try {
        const meta = await CFB.getJson('/api/meta?sport=cfb');
        CFB.follows.seedDefault(meta.favoriteTeamId, meta.favoriteTeamName);
      } catch (e) { /* ignore */ }
    }
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) clearTimeout(timer);
      else load();
    });
    load();
  }

  init();
})();

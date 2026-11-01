// Shared helpers used by index.js, team.js, rankings.js, standings.js.
// Everything here assumes the page includes a #modalBackdrop / #modalContent
// pair (see index.html / team.html) for the game-detail popup.

const CFB = (function () {
  const el = (id) => document.getElementById(id);

  // Escape text before it goes into an innerHTML template. Everything that
  // comes from outside this app (ESPN, RSS feeds, YouTube, admin notes)
  // must go through this, so a stray "<" can't turn into markup or script.
  function esc(value) {
    if (value === null || value === undefined) return '';
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Only http(s) and same-site relative URLs may be used for links and
  // images; anything else (javascript:, data:, ...) becomes empty. The
  // result is attribute-escaped and safe to drop into src="" or href="".
  function safeUrl(value) {
    if (!value) return '';
    const str = String(value).trim();
    if (/^\/(?!\/)/.test(str)) return esc(str);
    try {
      const url = new URL(str);
      return url.protocol === 'http:' || url.protocol === 'https:' ? esc(url.toString()) : '';
    } catch (err) {
      return '';
    }
  }

  // ---- Sport selection -------------------------------------------------
  // The current sport comes from ?sport= in the URL (so links are
  // shareable), else the last one picked (localStorage), else college
  // football. The list of sports is fetched once from /api/sports.
  const SPORT_STORAGE_KEY = 'tracker-sport';
  const DEFAULT_SPORT = 'cfb';

  function readSportKey() {
    const fromUrl = new URLSearchParams(location.search).get('sport');
    if (fromUrl) return fromUrl;
    try { return localStorage.getItem(SPORT_STORAGE_KEY) || DEFAULT_SPORT; } catch (e) { return DEFAULT_SPORT; }
  }

  let sportKey = readSportKey();
  let sportList = null;
  let sportInfo = null;

  async function loadSports() {
    if (sportInfo) return sportInfo;
    try {
      const data = await getJson('/api/sports');
      sportList = data.sports || [];
    } catch (err) {
      sportList = [];
    }
    sportInfo = sportList.find((s) => s.key === sportKey) || sportList.find((s) => s.key === DEFAULT_SPORT) || {
      key: DEFAULT_SPORT, label: 'College Football', shortLabel: 'CFB', schedule: 'week', maxWeek: 15,
      seasonTypes: [{ value: 2, label: 'Regular Season' }, { value: 3, label: 'Postseason / Bowls' }],
      groups: [{ key: 'fbs', label: 'FBS', value: 80 }, { key: 'fcs', label: 'FCS', value: 81 }],
      rankings: true, field: true, notable: true, periodPrefix: 'Q',
    };
    sportKey = sportInfo.key;
    try { localStorage.setItem(SPORT_STORAGE_KEY, sportKey); } catch (e) { /* ignore */ }
    return sportInfo;
  }

  function sport() {
    return sportInfo || { key: sportKey, periodPrefix: 'Q' };
  }

  // Adds ?sport= to an API or page URL.
  function withSport(url) {
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}sport=${encodeURIComponent(sportKey)}`;
  }

  // Sport picker row at the top of <main>, plus sport-aware nav links.
  // Changing sport reloads the current list page for the new sport; on a
  // team or game page (which belong to one sport) it goes to the home page.
  function initSportBar() {
    const main = document.querySelector('main');
    if (!main || !sportList || sportList.length < 2) return;
    const bar = document.createElement('nav');
    bar.className = 'sport-bar';
    bar.setAttribute('aria-label', 'Sport');
    sportList.forEach((s) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = s.shortLabel;
      btn.title = s.label;
      btn.className = s.key === sportKey ? 'active' : '';
      btn.setAttribute('aria-pressed', s.key === sportKey ? 'true' : 'false');
      btn.addEventListener('click', () => {
        if (s.key === sportKey) return;
        try { localStorage.setItem(SPORT_STORAGE_KEY, s.key); } catch (e) { /* ignore */ }
        const listPages = ['/', '/index.html', '/upcoming.html', '/rankings.html', '/standings.html', '/lines.html'];
        let page = listPages.includes(location.pathname) ? location.pathname : '/';
        if (page === '/rankings.html' && !s.rankings) page = '/';
        if (page === '/standings.html' && s.standings === false) page = '/';
        location.href = `${page}?sport=${encodeURIComponent(s.key)}`;
      });
      bar.appendChild(btn);
    });
    main.insertBefore(bar, main.firstChild);

    document.querySelectorAll('nav.top-nav a').forEach((a) => {
      const href = a.getAttribute('href');
      if (!href || !href.startsWith('/') || href.startsWith('/admin')) return;
      if (href === '/rankings.html' && !sport().rankings) { a.remove(); return; }
      if (href === '/standings.html' && sport().standings === false) { a.remove(); return; }
      // Recruiting is college football only; lines need two-team games.
      if (href === '/recruiting.html' && sportKey !== DEFAULT_SPORT) { a.remove(); return; }
      if (href === '/lines.html' && sport().format && sport().format !== 'game') { a.remove(); return; }
      a.setAttribute('href', withSport(href));
    });

    const foot = document.querySelector('footer.foot');
    if (foot && sportKey !== DEFAULT_SPORT) foot.textContent = `CFB Tracker · ${sport().label}`;
  }

  async function getJson(url, opts) {
    const res = await fetch(url, opts);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Request failed: ${res.status}`);
    }
    return res.json();
  }

  // ---- Followed teams ----------------------------------------------------
  // Each visitor follows their own teams, any number per sport, saved in
  // their browser. Entries are { sport, id, name, abbreviation, logo }.
  const FOLLOW_KEY = 'tracker-follows';
  const FOLLOW_SEEDED_KEY = 'tracker-follows-seeded';
  const MAX_FOLLOWS = 30;

  function readFollows() {
    try {
      const list = JSON.parse(localStorage.getItem(FOLLOW_KEY) || '[]');
      return Array.isArray(list) ? list.filter((t) => t && t.sport && t.id) : [];
    } catch (e) {
      return [];
    }
  }

  function writeFollows(list) {
    try { localStorage.setItem(FOLLOW_KEY, JSON.stringify(list.slice(0, MAX_FOLLOWS))); } catch (e) { /* ignore */ }
  }

  const follows = {
    // Followed teams for one sport (default: the current sport).
    list(sportKeyArg) {
      const key = sportKeyArg || sportKey;
      return readFollows().filter((t) => t.sport === key);
    },
    ids(sportKeyArg) {
      return new Set(follows.list(sportKeyArg).map((t) => String(t.id)));
    },
    has(teamId, sportKeyArg) {
      return follows.ids(sportKeyArg).has(String(teamId));
    },
    add(team, sportKeyArg) {
      const key = sportKeyArg || sportKey;
      if (!team || !team.id || follows.has(team.id, key)) return;
      const list = readFollows();
      list.push({ sport: key, id: String(team.id), name: team.name || null, abbreviation: team.abbreviation || null, logo: team.logo || null });
      writeFollows(list);
    },
    remove(teamId, sportKeyArg) {
      const key = sportKeyArg || sportKey;
      writeFollows(readFollows().filter((t) => !(t.sport === key && String(t.id) === String(teamId))));
    },
    toggle(team, sportKeyArg) {
      if (follows.has(team.id, sportKeyArg)) { follows.remove(team.id, sportKeyArg); return false; }
      follows.add(team, sportKeyArg);
      return true;
    },
    // The server's FAVORITE_TEAM_ID used to be the only "my team". Follow
    // it once on a visitor's first visit so nothing disappears for them;
    // if they unfollow it later it stays unfollowed.
    seedDefault(teamId, name) {
      if (!teamId) return;
      try {
        if (localStorage.getItem(FOLLOW_SEEDED_KEY)) return;
        localStorage.setItem(FOLLOW_SEEDED_KEY, '1');
      } catch (e) {
        return;
      }
      follows.add({ id: teamId, name }, 'cfb');
    },
  };

  function fmtTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
  }

  function statusLabel(game) {
    if (!game || !game.status) return '';
    if (game.status.state === 'in') return game.status.shortDetail || `${sport().periodPrefix || 'Q'}${game.status.period} ${game.status.clock}`;
    if (game.status.state === 'post') return 'Final' + (game.status.detail && game.status.detail !== 'Final' ? ` (${game.status.detail})` : '');
    return fmtTime(game.date);
  }

  function teamLink(team) {
    if (!team || !team.id) return '';
    return withSport(`/team.html?id=${encodeURIComponent(team.id)}&source=espn`);
  }

  function gameLink(id, source) {
    if (!id) return '';
    return withSport(`/game.html?id=${encodeURIComponent(id)}&source=${encodeURIComponent(source || 'espn')}`);
  }

  function teamRowHtml(team, rowOpts) {
    rowOpts = rowOpts || {};
    if (!team) return '<div class="team-row"><span class="team-name">TBD</span></div>';
    const isWinner = team.winner && team.score !== null;
    // Once a game is final, don't make people compare two numbers to see
    // who won — show an explicit W/L chip next to each side.
    let wlBadge = '';
    if (rowOpts.completed && team.score !== null) {
      if (team.winner) wlBadge = '<span class="wl-badge win">W</span>';
      else wlBadge = '<span class="wl-badge loss">L</span>';
    }
    // Small football icon marks whichever team currently has the ball —
    // only meaningful (and only shown) while the game is actually live.
    const possessionIcon = rowOpts.hasPossession ? '<span class="possession-icon" title="Has possession">&#127944;</span>' : '';
    return `
      <div class="team-row">
        <span class="rank">${team.curatedRank ? '#' + team.curatedRank : ''}</span>
        ${team.logo ? `<img src="${safeUrl(team.logo)}" alt="" onerror="this.style.display='none'">` : ''}
        <a class="team-name team-link ${isWinner ? 'winner' : ''}" href="${teamLink(team)}" onclick="event.stopPropagation()">${esc(team.name || team.shortName || 'TBD')}</a>
        ${possessionIcon}
        <span class="score">${team.score !== null && team.score !== undefined ? esc(team.score) : ''}</span>
        ${wlBadge}
      </div>`;
  }

  function oddsLine(game) {
    if (!game.odds) return '';
    const parts = [];
    if (game.odds.details) parts.push(esc(game.odds.details));
    else if (game.odds.spread !== null) parts.push(`Spread ${game.odds.spread > 0 ? '+' : ''}${game.odds.spread}`);
    if (game.odds.overUnder !== null) parts.push(`O/U ${game.odds.overUnder}`);
    if (!parts.length) return '';
    return `<div class="odds-line">${parts.join(' &middot; ')}</div>`;
  }

  // Full game card — used on Schedule & Scores AND Notable Games, so both
  // look and behave identically (channel, time, rank, live indicator).
  function gameCardHtml(game, opts) {
    opts = opts || {};
    const followed = opts.followedIds || new Set();
    const isFollowed = (team) => team && (followed.has(String(team.id)) || (opts.favoriteTeamId && String(team.id) === String(opts.favoriteTeamId)));
    const isFav = isFollowed(game.home) || isFollowed(game.away);
    const isLive = game.status && game.status.state === 'in';
    const isCompleted = !!(game.status && game.status.completed);
    const possessionId = isLive && game.situation ? game.situation.possession : null;
    const awayHasBall = !!(possessionId && game.away && String(possessionId) === String(game.away.id));
    const homeHasBall = !!(possessionId && game.home && String(possessionId) === String(game.home.id));
    return `
      <div class="game-card ${isFav ? 'is-favorite' : ''} ${isLive ? 'is-live' : ''}" data-id="${esc(game.id)}" data-source="${esc(game.source || 'espn')}">
        <div class="status-row">
          <span class="${isLive ? 'live-dot' : ''}">${esc(statusLabel(game))}</span>
          <span style="display:flex;align-items:center;gap:6px;">
            ${opts.notable ? '<span class="notable-ribbon">Notable</span>' : ''}
            ${game.broadcast ? `<span>${esc(game.broadcast)}</span>` : ''}
          </span>
        </div>
        ${teamRowHtml(game.away, { completed: isCompleted, hasPossession: awayHasBall })}
        ${teamRowHtml(game.home, { completed: isCompleted, hasPossession: homeHasBall })}
        ${game.venue ? `<div class="venue">${esc(game.venue)}</div>` : ''}
        ${oddsLine(game)}
      </div>`;
  }

  // UFC fight cards and NASCAR races: one card per event, listing the
  // fights (winner marked) or the top of the running order.
  function eventCardHtml(event) {
    const isLive = event.status && event.status.state === 'in';
    const when = isLive ? 'LIVE' : event.status && event.status.state === 'post' ? 'Final' : fmtTime(event.date);
    let body = '';
    if (event.bouts) {
      body = event.bouts.map((b, i) => {
        const [x, y] = b.fighters;
        const side = (f) => (f ? `<span class="fighter ${f.winner ? 'winner' : ''}">${esc(f.name || 'TBD')}${f.record ? ` <span class="fighter-record">${esc(f.record)}</span>` : ''}${f.winner ? ' <span class="wl-badge win">W</span>' : ''}</span>` : '<span class="fighter">TBD</span>');
        return `
          <div class="bout ${i === 0 ? 'main-event' : ''}">
            ${i === 0 ? '<div class="bout-label">Main event</div>' : ''}
            <div class="bout-row">${side(x)}<span class="bout-vs">vs</span>${side(y)}</div>
            ${b.weightClass || b.result ? `<div class="bout-meta">${[b.weightClass, b.result].filter(Boolean).map(esc).join(' &middot; ')}</div>` : ''}
          </div>`;
      }).join('');
    } else if (event.race) {
      body = event.race.length
        ? `<ol class="race-order">${event.race.map((d) => `
            <li class="${d.winner ? 'winner' : ''}"><span class="race-place">${esc(d.place || '')}</span>${d.number ? `<span class="car-number">#${esc(d.number)}</span>` : ''}<span>${esc(d.name)}</span></li>`).join('')}
          </ol>${event.fieldSize > event.race.length ? `<div class="bout-meta">Top ${event.race.length} of ${esc(event.fieldSize)}</div>` : ''}`
        : '<div class="bout-meta">Running order appears once the race starts.</div>';
    }
    return `
      <div class="game-card event-card ${isLive ? 'is-live' : ''}">
        <div class="status-row">
          <span class="${isLive ? 'live-dot' : ''}">${esc(when)}</span>
          ${event.broadcast ? `<span>${esc(event.broadcast)}</span>` : ''}
        </div>
        <div class="event-name">${esc(event.name || event.shortName || 'Event')}</div>
        ${event.venue ? `<div class="venue">${esc(event.venue)}</div>` : ''}
        ${body}
      </div>`;
  }

  // Clicking a game card navigates to that game's own dedicated page
  // (game.html) rather than popping up a modal — it's shareable/bookmarkable
  // and doesn't compete for space with a team-name click inside the same
  // card. Team-name links inside the card call stopPropagation() so they
  // still go to the team page instead.
  function wireGameCardClicks(container) {
    container.querySelectorAll('.game-card').forEach((card) => {
      card.style.cursor = 'pointer';
      card.addEventListener('click', () => {
        location.href = gameLink(card.dataset.id, card.dataset.source);
      });
    });
  }

  // Renders a game's live/final detail (score, leaders, team stats, latest
  // drive) as an HTML string. Used by game.html's dedicated page. Kept here
  // so any future page can reuse the same rendering.
  function gameDetailSectionsHtml(detail) {
    const oddsHtml = detail.odds && (detail.odds.details || detail.odds.overUnder !== null)
      ? `<section><h2 class="section-title">Odds</h2><div class="odds-box">
          ${detail.odds.details ? `<div>${esc(detail.odds.details)}</div>` : ''}
          ${detail.odds.overUnder !== null ? `<div>Over/Under: <strong>${esc(detail.odds.overUnder)}</strong></div>` : ''}
          ${detail.odds.provider ? `<div class="odds-provider">via ${esc(detail.odds.provider)}</div>` : ''}
        </div></section>`
      : '';
    const leadersHtml = (detail.leaders || []).map((teamLeaders) => `
      <div><strong>${esc(teamLeaders.team)}</strong>
        ${(teamLeaders.categories || []).map((c) => `<div class="stat-row"><span>${esc(c.name)}</span><span>${c.athlete ? esc(c.athlete) + ' &middot; ' : ''}${esc(c.value || '')}</span></div>`).join('')}
      </div>`).join('');
    const boxHtml = detail.boxscore ? detail.boxscore.teams.map((t) => `
      <div><strong>${esc(t.team)}</strong>
        ${t.stats.map((s) => `<div class="stat-row"><span>${esc(s.name)}</span><span>${esc(s.value)}</span></div>`).join('')}
      </div>`).join('') : '';
    const playsHtml = detail.drives ? `<div class="plays"><strong>${esc(detail.drives.description || 'Latest drive')}</strong><br>${(detail.drives.plays || []).map(esc).join('<br>')}</div>` : '';
    // Full play-by-play — only really meaningful once the game has actually
    // started (pregame there's nothing to show), shown newest-first in a
    // scrollable feed so it doesn't dominate the page for a long game.
    const pbpHtml = detail.playByPlay && detail.playByPlay.length
      ? `<section><h2 class="section-title">Play-by-Play</h2><div class="pbp-feed">
          ${detail.playByPlay.map((p) => `
            <div class="pbp-play ${p.scoringPlay ? 'scoring' : ''}">
              <span class="pbp-meta">${[p.drive, p.period ? `${sport().periodPrefix || 'Q'}${p.period}` : null, p.clock].filter(Boolean).map(esc).join(' &middot; ')}</span>
              <span class="pbp-text">${esc(p.text)}</span>
            </div>`).join('')}
        </div></section>`
      : '';
    const note = detail.status && detail.status.state === 'pre'
      ? '<p class="empty-note">This game hasn\'t started yet &mdash; check back once it starts for live stats and play-by-play.</p>'
      : '';
    return `
      ${note}
      ${oddsHtml}
      ${leadersHtml ? `<section><h2 class="section-title">Leaders</h2>${leadersHtml}</section>` : ''}
      ${boxHtml ? `<section><h2 class="section-title">Team Stats</h2>${boxHtml}</section>` : ''}
      ${playsHtml ? `<section><h2 class="section-title">Latest Drive</h2>${playsHtml}</section>` : ''}
      ${pbpHtml}
    `;
  }

  // Sets a team's real color as a CSS custom property on an element, so
  // that element's border/accent (see .favorite-card / .team-hero in
  // styles.css) reflects THAT team's branding instead of a hardcoded
  // team's colors everywhere. Falls back to leaving the CSS default
  // (neutral accent / favorite amber) when ESPN didn't give us a color.
  function applyTeamColor(element, hexColor) {
    if (element && hexColor && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(hexColor)) {
      element.style.setProperty('--team-color', hexColor);
    }
  }

  // Shared division toggle (FBS/FCS for college football). Built from the
  // current sport's groups and hidden when there's nothing to choose.
  // Persists the choice per sport in localStorage and calls
  // onChange(groupValue) whenever it changes, including once on init with
  // the restored value (null when the sport has no divisions).
  function initDivisionToggle(onChange) {
    const container = el('divisionToggle');
    const groups = sport().groups || [];
    if (!container || groups.length < 2) {
      if (container) container.style.display = 'none';
      onChange(groups.length ? groups[0].value : null);
      return;
    }
    const storageKey = `division:${sportKey}`;
    let saved = groups[0].key;
    try {
      // Older versions stored the CFB choice under 'cfb-division'.
      saved = localStorage.getItem(storageKey) || (sportKey === 'cfb' && localStorage.getItem('cfb-division')) || groups[0].key;
    } catch (e) { /* ignore */ }
    if (!groups.some((g) => g.key === saved)) saved = groups[0].key;
    container.innerHTML = '';
    groups.forEach((g) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.division = g.key;
      btn.textContent = g.label;
      btn.classList.toggle('active', g.key === saved);
      btn.addEventListener('click', () => {
        container.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        try { localStorage.setItem(storageKey, g.key); } catch (e) { /* ignore */ }
        onChange(g.value);
      });
      container.appendChild(btn);
    });
    onChange(groups.find((g) => g.key === saved).value);
  }

  // YYYYMMDD for ESPN's `dates` parameter, in the viewer's local time.
  function ymd(date) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  }

  return {
    el, esc, safeUrl, getJson, fmtTime, statusLabel, teamLink, gameLink, teamRowHtml, gameCardHtml,
    wireGameCardClicks, gameDetailSectionsHtml, eventCardHtml,
    applyTeamColor, initDivisionToggle, ymd,
    loadSports, sport, withSport, initSportBar, follows,
  };
})();

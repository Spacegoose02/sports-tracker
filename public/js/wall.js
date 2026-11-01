// TV wall mode (public/wall.html): a full-screen scoreboard for a TV or a
// wall tablet that rotates through live games and the teams you follow,
// sized to read from across the room.
//
// URL options (all optional):
//   ?sports=cfb,nfl   sports to show (default: every sport you follow a
//                     team in, plus the last sport you looked at)
//   ?every=15         seconds per game, 5-120 (default 12)
//   ?mine=1           only games with a team you follow
//
// Keys: Left/Right step through games, Space pauses, F goes full screen.
//
// The pure parts (which games to show, the field and diamond drawings)
// live in the Wall object so tests can load this file in a sandbox, the
// same way they load shared.js. The page wiring at the bottom only runs on
// wall.html.
const Wall = (function () {
  const esc = (v) => CFB.esc(v);
  const HOUR = 60 * 60 * 1000;
  const MAX_GAMES = 16;
  // How long a final stays in the rotation, and how far ahead an upcoming
  // game gets in.
  const FINAL_FOR_MS = 10 * HOUR;
  const UPCOMING_WITHIN_MS = 6 * HOUR;
  const FOLLOWED_UPCOMING_WITHIN_MS = 7 * 24 * HOUR;

  const hex = (c, fallback) => (/^#[0-9a-f]{6}$/i.test(c || '') ? c : fallback);
  const time = (g) => { const t = Date.parse(g && g.date); return Number.isNaN(t) ? null : t; };
  const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

  // Light team colors (white, yellow) need dark text on top of them.
  function inkOn(color) {
    const c = hex(color, '#444444');
    const r = parseInt(c.slice(1, 3), 16);
    const g = parseInt(c.slice(3, 5), 16);
    const b = parseInt(c.slice(5, 7), 16);
    return (0.299 * r + 0.587 * g + 0.114 * b) > 170 ? '#111111' : '#ffffff';
  }

  // Two teams with near-identical colors: draw the home side neutral so the
  // end zones still read as two different teams.
  function distinct(a, b) {
    const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    const [x, y] = [rgb(a), rgb(b)];
    return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]) > 90 ? b : '#5f6b7a';
  }

  function rank(team) {
    const r = team && (team.curatedRank || team.rank);
    return r && r < 99 ? r : null;
  }

  // Bigger is shown first. Live games lead, then games about to start,
  // then fresh finals; a followed team lifts any of them, and close,
  // ranked games beat blowouts. Games that don't make the cut return null.
  function priority(game, followed, now) {
    const state = game.status && game.status.state;
    const t = time(game);
    const mine = followed(game);
    const ranked = (rank(game.home) ? 1 : 0) + (rank(game.away) ? 1 : 0);
    if (state === 'in') {
      const margin = Math.abs((num(game.home && game.home.score) || 0) - (num(game.away && game.away.score) || 0));
      return 3000 + (mine ? 1000 : 0) + ranked * 60 + Math.max(0, 40 - margin);
    }
    if (state === 'pre') {
      if (t === null) return null;
      const until = t - now;
      if (until < -HOUR) return null;
      if (mine && until < FOLLOWED_UPCOMING_WITHIN_MS) return 1500 - until / HOUR;
      if (until < UPCOMING_WITHIN_MS) return 1000 + ranked * 60 - until / HOUR * 10;
      return null;
    }
    if (state === 'post') {
      if (t === null || now - t > FINAL_FOR_MS + 4 * HOUR) return mine && t !== null && now - t < 48 * HOUR ? 400 : null;
      return (mine ? 2000 : 500) + ranked * 60 - (now - t) / HOUR;
    }
    return null;
  }

  // games: [{ ...scoreboard game, sport }]; followedIds: { sport: Set(ids) }.
  function pickGames(games, followedIds, opts) {
    const o = opts || {};
    const now = o.now || Date.now();
    const followed = (g) => {
      const ids = followedIds[g.sport];
      return !!(ids && [g.home, g.away].some((t) => t && ids.has(String(t.id))));
    };
    return (games || [])
      .filter((g) => g && g.home && g.away && g.status)
      .filter((g) => !o.mineOnly || followed(g))
      .map((g) => ({ game: g, score: priority(g, followed, now), mine: followed(g) }))
      .filter((x) => x.score !== null)
      .sort((a, b) => b.score - a.score)
      .slice(0, o.max || MAX_GAMES)
      .map((x) => ({ ...x.game, mine: x.mine }));
  }

  // "SMU 35" -> yards from the possessing team's own goal line. ESPN's
  // possessionText names the side of the field, which is unambiguous; the
  // raw yardLine is the fallback (same rule as src/scorecard.js).
  function yardsFromOwnGoal(situation, possessor) {
    const text = String(situation.possessionText || '').trim();
    const m = /^([A-Za-z&.'\- ]+?)\s+(\d{1,2})$/.exec(text);
    if (m && possessor) {
      const n = Number(m[2]);
      const side = m[1].trim().toUpperCase();
      const own = [possessor.abbreviation, possessor.shortName].filter(Boolean).map((s) => String(s).toUpperCase());
      return own.includes(side) ? n : 100 - n;
    }
    if (text === '50') return 50;
    return num(situation.yardLine);
  }

  // Ball and first-down line as 0-100 from the left edge. The away team
  // defends the left goal and the home team the right, like the game page.
  function fieldData(game) {
    const s = game.situation;
    if (!s || !s.possession || (game.status && game.status.state) !== 'in') return null;
    const awayBall = game.away && String(s.possession) === String(game.away.id);
    const homeBall = game.home && String(s.possession) === String(game.home.id);
    if (!awayBall && !homeBall) return null;
    const y = yardsFromOwnGoal(s, awayBall ? game.away : game.home);
    if (y === null) return null;
    const flip = (v) => (awayBall ? v : 100 - v);
    const dist = num(s.distance);
    return {
      possession: awayBall ? 'away' : 'home',
      ball: Math.max(0, Math.min(100, flip(y))),
      firstDown: dist !== null && dist > 0 ? Math.max(0, Math.min(100, flip(Math.min(100, y + dist)))) : null,
      redZone: !!s.isRedZone,
    };
  }

  // Football field, drawn like the Home Assistant card's: 1 yard = 2 units,
  // field runs x=20..220 with the end zones outside it.
  function fieldSvg(game) {
    const fd = fieldData(game);
    const ac = hex(game.away && game.away.color, '#1f6feb');
    const hc = distinct(ac, hex(game.home && game.home.color, '#d1242f'));
    const X = (yd) => 20 + yd * 2;
    let lines = '';
    for (let yd = 5; yd < 100; yd += 5) {
      lines += `<line x1="${X(yd)}" y1="4" x2="${X(yd)}" y2="96" stroke="#fff" stroke-opacity="${yd % 10 ? 0.25 : 0.55}" stroke-width="${yd % 10 ? 0.5 : 0.8}"/>`;
      if (yd % 10 === 0) {
        const label = yd <= 50 ? yd : 100 - yd;
        lines += `<text x="${X(yd)}" y="17" class="yd">${label}</text><text x="${X(yd)}" y="91" class="yd">${label}</text>`;
      }
    }
    const ez = (x, team, c, rot) => `<text x="${x}" y="50" class="ez" fill="${inkOn(c)}" transform="rotate(${rot} ${x} 50)">${esc((team && (team.abbreviation || team.shortName)) || '')}</text>`;
    let marks = '';
    if (fd) {
      const bx = X(fd.ball);
      const dir = fd.possession === 'away' ? 1 : -1;
      const holder = fd.possession === 'away' ? ac : hc;
      const rz = fd.redZone
        ? `<rect x="${fd.possession === 'away' ? X(80) : X(0)}" y="4" width="40" height="92" class="redzone"/>`
        : '';
      marks = `${rz}
        ${fd.firstDown !== null ? `<line x1="${X(fd.firstDown)}" y1="4" x2="${X(fd.firstDown)}" y2="96" class="firstdown"/>` : ''}
        <line x1="${bx}" y1="4" x2="${bx}" y2="96" class="scrimmage"/>
        <g transform="translate(${bx} 50)">
          <polygon points="${dir * 9},-6 ${dir * 15},0 ${dir * 9},6" fill="${holder}" stroke="#fff" stroke-width=".8"/>
          <ellipse rx="6.5" ry="4" fill="#8b4513" stroke="#3b1d08" stroke-width=".6"/>
          <line x1="-2.5" y1="0" x2="2.5" y2="0" stroke="#fff" stroke-width=".7"/>
        </g>`;
    }
    return `<svg viewBox="0 0 240 100" class="wall-field" role="img" aria-label="Football field">
      <rect x="0" y="0" width="240" height="100" rx="4" fill="#2e7d32"/>
      ${Array.from({ length: 10 }, (_, i) => `<rect x="${X(i * 10)}" y="4" width="20" height="92" fill="#000" fill-opacity="${i % 2 ? 0.06 : 0}"/>`).join('')}
      <rect x="0" y="4" width="20" height="92" fill="${ac}"/>
      <rect x="220" y="4" width="20" height="92" fill="${hc}"/>
      ${ez(10, game.away, ac, -90)}
      ${ez(230, game.home, hc, 90)}
      <rect x="0" y="4" width="240" height="92" fill="none" stroke="#fff" stroke-width="1"/>
      <line x1="20" y1="4" x2="20" y2="96" stroke="#fff" stroke-width="1"/>
      <line x1="220" y1="4" x2="220" y2="96" stroke="#fff" stroke-width="1"/>
      ${lines}
      ${marks}
    </svg>`;
  }

  function diamondSvg(game) {
    const b = (game.situation && game.situation.baseball) || {};
    const base = (x, y, on) => `<rect x="${x - 8}" y="${y - 8}" width="16" height="16" transform="rotate(45 ${x} ${y})" class="base ${on ? 'on' : ''}"/>`;
    const dots = (n, max, cls) => Array.from({ length: max }, (_, i) => `<i class="${i < (n || 0) ? cls : ''}"></i>`).join('');
    return `<div class="wall-diamond">
      <svg viewBox="0 0 240 130" role="img" aria-label="Baseball diamond">
        <rect width="240" height="130" rx="4" fill="#2e7d32"/>
        <path d="M120 122 L30 40 A110 110 0 0 1 210 40 Z" fill="#388e3c"/>
        <polygon points="120,118 165,73 120,28 75,73" fill="#b5835a"/>
        <polygon points="120,106 153,73 120,40 87,73" fill="#43a047"/>
        ${base(165, 73, b.onFirst)}${base(120, 28, b.onSecond)}${base(75, 73, b.onThird)}
        <polygon points="114,114 126,114 126,119 120,124 114,119" fill="#fff"/>
      </svg>
      <div class="wall-count"><span>B ${dots(b.balls, 3, 'ball')}</span><span>S ${dots(b.strikes, 2, 'strike')}</span><span>O ${dots(b.outs, 2, 'out')}</span></div>
    </div>`;
  }

  // Score by period, for the sports without a field drawing (and for any
  // final, where there's no ball to show).
  function linescoreHtml(game, sport) {
    const a = (game.away && game.away.linescores) || [];
    const h = (game.home && game.home.linescores) || [];
    const n = Math.max(a.length, h.length);
    if (!n) return '';
    const prefix = (sport && sport.periodPrefix) || 'Q';
    const regulation = sport && sport.key === 'mlb' ? 9 : (prefix === 'H' ? 2 : (prefix === 'P' ? 3 : 4));
    const isMlb = sport && sport.key === 'mlb';
    const extra = n - regulation;
    const label = (i) => {
      if (isMlb) return i + 1;
      if (i < regulation) return `${prefix}${i + 1}`;
      return extra > 1 ? `OT${i - regulation + 1}` : 'OT';
    };
    const head = Array.from({ length: n }, (_, i) => `<th>${label(i)}</th>`).join('');
    const row = (team, list) => `<tr><th>${esc(team.abbreviation || team.shortName || '')}</th>${Array.from({ length: n }, (_, i) => `<td>${esc(list[i] === undefined ? '' : list[i])}</td>`).join('')}<td class="tot">${esc(team.score === null || team.score === undefined ? '' : team.score)}</td></tr>`;
    return `<table class="wall-lines"><thead><tr><th></th>${head}<th>T</th></tr></thead><tbody>${row(game.away, a)}${row(game.home, h)}</tbody></table>`;
  }

  function statusText(game, sport) {
    const s = game.status || {};
    if (s.state === 'in') return s.shortDetail || `${(sport && sport.periodPrefix) || 'Q'}${s.period} ${s.clock || ''}`;
    if (s.state === 'post') return s.shortDetail || 'Final';
    const t = time(game);
    if (t === null) return s.shortDetail || '';
    const d = new Date(t);
    const sameDay = d.toDateString() === new Date().toDateString();
    const when = game.timeValid === false ? 'TBA' : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return sameDay ? when : `${d.toLocaleDateString([], { weekday: 'short' })} ${when}`;
  }

  // "in 2h 15m" before a game starts.
  function countdown(game, now) {
    const t = time(game);
    if (t === null || game.timeValid === false) return '';
    const mins = Math.round((t - (now || Date.now())) / 60000);
    if (mins <= 0) return 'Starting soon';
    if (mins < 60) return `in ${mins}m`;
    if (mins < 48 * 60) return `in ${Math.floor(mins / 60)}h ${mins % 60}m`;
    return '';
  }

  function sideHtml(team, side, hasBall) {
    const r = rank(team);
    return `<div class="wall-team wall-${side} ${team.winner ? 'won' : ''}">
      ${team.logo ? `<img class="wall-logo" src="${CFB.safeUrl(team.logo)}" alt="" onerror="this.style.visibility='hidden'">` : '<div class="wall-logo"></div>'}
      <div class="wall-name">${r ? `<span class="wall-rank">${esc(r)}</span>` : ''}${esc(team.shortName || team.name || '')}${hasBall ? ' <span class="wall-ball" title="Has the ball">&#127944;</span>' : ''}</div>
      ${team.records && team.records[0] ? `<div class="wall-record">${esc(team.records[0].summary)}</div>` : ''}
    </div>`;
  }

  function stageHtml(game, sport) {
    const s = game.status || {};
    const live = s.state === 'in';
    const pre = s.state === 'pre';
    const sit = game.situation || {};
    const poss = live && sit.possession ? String(sit.possession) : null;
    const score = (t) => (pre || t.score === null || t.score === undefined ? '' : esc(t.score));
    let visual = '';
    if (live && sport && sport.field) visual = fieldSvg(game);
    else if (live && sport && sport.key === 'mlb') visual = diamondSvg(game);
    else if (!pre) visual = linescoreHtml(game, sport);
    const situation = live ? [sit.down, sit.possessionText ? `at ${sit.possessionText}` : null].filter(Boolean).join(' ') : '';
    const lastPlay = live && sit.lastPlay ? sit.lastPlay : '';
    const ac = hex(game.away.color, '#1f6feb');
    const hc = hex(game.home.color, '#d1242f');
    return `<div class="wall-game ${live ? 'is-live' : ''} ${game.mine ? 'is-mine' : ''}" style="--away:${ac};--home:${hc}">
      <div class="wall-meta">
        ${live ? '<span class="wall-live">&#9679; LIVE</span>' : ''}
        ${game.mine ? '<span class="wall-mine">&#9733; Your team</span>' : ''}
        <span class="wall-league">${esc((sport && sport.shortLabel) || '')}</span>
        ${game.broadcast ? `<span class="wall-tv">&#128250; ${esc(game.broadcast)}</span>` : ''}
      </div>
      <div class="wall-board">
        ${sideHtml(game.away, 'away', poss && String(game.away.id) === poss)}
        <div class="wall-score wall-score-away ${game.away.winner ? 'won' : ''}">${score(game.away)}</div>
        <div class="wall-status">${esc(statusText(game, sport))}${pre ? `<small>${esc([countdown(game), game.venue].filter(Boolean).join(' \u00b7 '))}</small>` : ''}</div>
        <div class="wall-score wall-score-home ${game.home.winner ? 'won' : ''}">${score(game.home)}</div>
        ${sideHtml(game.home, 'home', poss && String(game.home.id) === poss)}
      </div>
      ${situation ? `<div class="wall-situation">${esc(situation)}${sit.isRedZone ? ' <span class="wall-rz">RED ZONE</span>' : ''}</div>` : ''}
      ${visual ? `<div class="wall-visual">${visual}</div>` : ''}
      ${lastPlay ? `<div class="wall-lastplay">${esc(lastPlay)}</div>` : ''}
    </div>`;
  }

  function chipHtml(game, i, active) {
    const s = game.status || {};
    const pre = s.state === 'pre';
    const t = (team) => `<span class="chip-team ${team.winner ? 'won' : ''}">${esc(team.abbreviation || team.shortName || '')}${pre ? '' : ` <b>${esc(team.score === null || team.score === undefined ? '' : team.score)}</b>`}</span>`;
    return `<button type="button" class="wall-chip ${active ? 'active' : ''} ${s.state === 'in' ? 'is-live' : ''} ${game.mine ? 'is-mine' : ''}" data-wall-go="${i}">
      ${t(game.away)}${t(game.home)}<span class="chip-status">${esc(s.state === 'in' ? (s.shortDetail || '') : (s.state === 'post' ? 'Final' : statusText(game)))}</span>
    </button>`;
  }

  function scoreKey(game) {
    return `${game.away && game.away.score}-${game.home && game.home.score}`;
  }

  return { pickGames, priority, fieldData, fieldSvg, diamondSvg, linescoreHtml, stageHtml, chipHtml, statusText, scoreKey, yardsFromOwnGoal };
})();

// ---- Page wiring (wall.html only) ------------------------------------------
(function () {
  if (typeof document === 'undefined' || !document.body || !document.body.classList.contains('wall')) return;
  const el = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const every = Math.min(120, Math.max(5, Number(params.get('every')) || 12)) * 1000;
  const mineOnly = params.get('mine') === '1';

  const state = {
    sports: [],        // sport objects being shown
    games: [],         // rotation, in order
    index: 0,
    currentId: null,
    paused: false,
    shownAt: Date.now(),
    lastScores: new Map(),
    alertUntil: 0,
    rotateTimer: null,
    refreshTimer: null,
    wakeLock: null,
  };
  const gameKey = (g) => `${g.sport}:${g.id}`;
  const sportOf = (g) => state.sports.find((s) => s.key === g.sport);

  function chooseSports(list) {
    const games = list.filter((s) => (s.format || 'game') === 'game');
    const wanted = (params.get('sports') || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (wanted.length) return games.filter((s) => wanted.includes(s.key));
    const keys = new Set(CFB.follows.all().map((t) => t.sport));
    keys.add(CFB.sport().key);
    const picked = games.filter((s) => keys.has(s.key));
    return picked.length ? picked : games.filter((s) => s.key === 'cfb');
  }

  async function fetchSport(sport) {
    let url = `/api/scoreboard?sport=${encodeURIComponent(sport.key)}`;
    // College scoreboards only list featured games without a division.
    if (sport.groups && sport.groups[0]) url += `&groups=${encodeURIComponent(sport.groups[0].value)}`;
    try {
      const data = await CFB.getJson(url);
      return (data.games || []).map((g) => ({ ...g, sport: sport.key }));
    } catch (err) {
      return null; // keep this sport's last games
    }
  }

  async function refresh() {
    const results = await Promise.all(state.sports.map(fetchSport));
    const prevBySport = {};
    state.allGames = state.allGames || [];
    state.allGames.forEach((g) => { (prevBySport[g.sport] = prevBySport[g.sport] || []).push(g); });
    const all = results.flatMap((r, i) => r || prevBySport[state.sports[i].key] || []);
    state.allGames = all;
    const followed = {};
    state.sports.forEach((s) => { followed[s.key] = CFB.follows.ids(s.key); });
    const games = Wall.pickGames(all, followed, { mineOnly });

    // A score change on a live game jumps the wall to it for one turn.
    let scored = null;
    games.forEach((g) => {
      const key = gameKey(g);
      const before = state.lastScores.get(key);
      const now = Wall.scoreKey(g);
      if (before !== undefined && before !== now && g.status.state === 'in' && (!scored || (g.mine && !scored.mine))) scored = g;
      state.lastScores.set(key, now);
    });

    state.games = games;
    const keepAt = state.currentId ? games.findIndex((g) => gameKey(g) === state.currentId) : -1;
    if (scored) {
      state.index = games.indexOf(scored);
      showAlert(scored);
      state.shownAt = Date.now();
    } else {
      state.index = keepAt >= 0 ? keepAt : 0;
    }
    render();

    clearTimeout(state.refreshTimer);
    const anyLive = all.some((g) => g.status && g.status.state === 'in');
    state.refreshTimer = setTimeout(refresh, anyLive ? 20000 : 60000);
  }

  function showAlert(game) {
    const box = el('wallAlert');
    box.textContent = `Score! ${game.away.abbreviation || game.away.shortName} ${game.away.score} – ${game.home.abbreviation || game.home.shortName} ${game.home.score}`;
    box.hidden = false;
    box.classList.remove('flash');
    void box.offsetWidth;
    box.classList.add('flash');
    state.alertUntil = Date.now() + 8000;
    setTimeout(() => { if (Date.now() >= state.alertUntil) box.hidden = true; }, 8100);
  }

  function render() {
    const stage = el('wallStage');
    const ticker = el('wallTicker');
    const dots = el('wallDots');
    if (!state.games.length) {
      state.currentId = null;
      const names = state.sports.map((s) => s.label).join(', ');
      stage.innerHTML = `<div class="wall-empty">No live or upcoming games right now${names ? ` in ${CFB.esc(names)}` : ''}.<small>This screen checks again every minute.</small></div>`;
      ticker.innerHTML = '';
      dots.innerHTML = '';
      return;
    }
    if (state.index >= state.games.length) state.index = 0;
    const game = state.games[state.index];
    const key = gameKey(game);
    const changed = key !== state.currentId;
    state.currentId = key;
    stage.innerHTML = Wall.stageHtml(game, sportOf(game));
    if (changed) {
      stage.classList.remove('enter');
      void stage.offsetWidth;
      stage.classList.add('enter');
    }
    ticker.innerHTML = state.games.map((g, i) => Wall.chipHtml(g, i, i === state.index)).join('');
    const active = ticker.querySelector('.active');
    if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest', inline: 'center', behavior: changed ? 'smooth' : 'auto' });
    dots.innerHTML = state.games.length > 1 ? state.games.map((g, i) => `<i class="${i === state.index ? 'on' : ''}"></i>`).join('') : '';
  }

  function go(step) {
    if (!state.games.length) return;
    state.index = (state.index + step + state.games.length) % state.games.length;
    state.shownAt = Date.now();
    render();
  }

  function goTo(i) {
    state.index = i;
    state.shownAt = Date.now();
    render();
  }

  // One timer drives both the rotation and the progress bar.
  function tick() {
    const bar = el('wallProgress');
    const elapsed = Date.now() - state.shownAt;
    if (!state.paused && state.games.length > 1 && elapsed >= every) go(1);
    const frac = state.paused || state.games.length < 2 ? 0 : Math.min(1, (Date.now() - state.shownAt) / every);
    bar.style.transform = `scaleX(${frac})`;
    const clock = el('wallClock');
    clock.textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  function setPaused(p) {
    state.paused = p;
    if (!p) state.shownAt = Date.now();
    const btn = document.querySelector('[data-wall="pause"]');
    btn.innerHTML = p ? '&#9654;&#xFE0E;' : '&#10074;&#10074;';
    btn.setAttribute('aria-pressed', p ? 'true' : 'false');
    document.body.classList.toggle('wall-paused', p);
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
  }

  // Keep a TV or tablet from going to sleep while this page is up.
  async function holdScreen() {
    if (!('wakeLock' in navigator) || document.hidden) return;
    try { state.wakeLock = await navigator.wakeLock.request('screen'); } catch (err) { /* not allowed here */ }
  }

  // Controls and the cursor fade out after a few seconds without input.
  let idleTimer = null;
  function wake() {
    document.body.classList.remove('wall-idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => document.body.classList.add('wall-idle'), 3000);
  }

  document.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-wall-go]');
    if (chip) { goTo(Number(chip.dataset.wallGo)); return; }
    const btn = e.target.closest('[data-wall]');
    if (!btn) return;
    const action = btn.dataset.wall;
    if (action === 'prev') go(-1);
    else if (action === 'next') go(1);
    else if (action === 'pause') setPaused(!state.paused);
    else if (action === 'fullscreen') toggleFullscreen();
  });

  document.addEventListener('keydown', (e) => {
    wake();
    if (e.key === 'ArrowRight') go(1);
    else if (e.key === 'ArrowLeft') go(-1);
    else if (e.key === ' ') { e.preventDefault(); setPaused(!state.paused); }
    else if (e.key === 'f' || e.key === 'F') toggleFullscreen();
  });
  ['mousemove', 'touchstart'].forEach((ev) => document.addEventListener(ev, wake, { passive: true }));

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    holdScreen();
    refresh();
  });

  CFB.loadSports().then(async () => {
    let list = [];
    try { list = (await CFB.getJson('/api/sports')).sports || []; } catch (err) { list = [CFB.sport()]; }
    state.sports = chooseSports(list);
    wake();
    holdScreen();
    setInterval(tick, 250);
    tick();
    refresh();
  });
})();

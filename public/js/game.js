(function () {
  const el = CFB.el;
  const params = new URLSearchParams(location.search);
  const gameId = params.get('id');
  const source = params.get('source') || 'espn';
  let pollTimer = null;

  if (!gameId) {
    el('gameScorebug').innerHTML = '<div class="empty-note">No game specified.</div>';
    return;
  }

  function teamSideHtml(team, side, hasPossession) {
    if (!team) return `<div class="game-side game-side-${side}"><span class="team-name">TBD</span></div>`;
    const isWinner = team.winner && team.score !== null && team.score !== undefined;
    const possessionIcon = hasPossession ? '<span class="possession-icon" title="Has possession">&#127944;</span>' : '';
    return `
      <div class="game-side game-side-${side}">
        ${team.logo ? `<img class="logo" src="${CFB.safeUrl(team.logo)}" alt="" onerror="this.style.display='none'">` : ''}
        <div class="game-side-meta">
          <a class="team-name team-link ${isWinner ? 'winner' : ''}" href="${CFB.teamLink(team)}">${team.rank ? '#' + CFB.esc(team.rank) + ' ' : ''}${CFB.esc(team.name)}</a>
          ${possessionIcon}
          ${team.record ? `<div class="record">${CFB.esc(team.record)}</div>` : ''}
        </div>
        <div class="game-side-score ${isWinner ? 'winner' : ''}">${team.score !== null && team.score !== undefined ? CFB.esc(team.score) : ''}</div>
      </div>`;
  }

  // Turns ESPN's live situation into field-relative percentages. Our own
  // diagram convention (not ESPN's — this app defines it): the AWAY team's
  // own goal line is the LEFT edge (0%) and the HOME team's own goal line
  // is the RIGHT edge (100%), regardless of the real stadium's layout.
  // ESPN's `yardLine` is 0-100 measured from the POSSESSING team's own
  // goal line, so: if the away team has the ball, their yardLine already
  // IS the left-edge-relative percentage; if the home team has the ball,
  // it has to be flipped (100 - yardLine) since their own goal is on the
  // right. See the longer comment in src/espn.js next to parseSituation.
  function computeFieldData(situation, away, home) {
    if (!situation || situation.yardLine === null || situation.yardLine === undefined) return null;
    const possessionIsAway = !!(away && situation.possession && String(situation.possession) === String(away.id));
    const possessionIsHome = !!(home && situation.possession && String(situation.possession) === String(home.id));
    if (!possessionIsAway && !possessionIsHome) return null;
    const yardLine = situation.yardLine;
    const ballPercent = possessionIsAway ? yardLine : (100 - yardLine);
    let firstDownPercent = null;
    if (situation.distance !== null && situation.distance !== undefined) {
      const firstDownYard = Math.min(100, yardLine + situation.distance);
      firstDownPercent = possessionIsAway ? firstDownYard : (100 - firstDownYard);
    }
    return { ballPercent, firstDownPercent, possessionIsAway, possessionIsHome };
  }

  function fieldSvgHtml(fd, away, home) {
    const EZ = 70, FIELD_W = 860, VIEW_W = 1000, VIEW_H = 170, MID = VIEW_H / 2;
    const toX = (pct) => EZ + (pct / 100) * FIELD_W;
    const ballX = toX(fd.ballPercent);
    const fdX = fd.firstDownPercent !== null ? toX(fd.firstDownPercent) : null;
    const hex = (c) => (c && /^#[0-9a-f]{3,8}$/i.test(c) ? c : null);
    const awayColor = hex(away && away.color) || '#4f8dfd';
    const homeColor = hex(home && home.color) || '#4f8dfd';

    const yardMarks = [10, 20, 30, 40, 50, 60, 70, 80, 90].map((y) => {
      const x = toX(y);
      const label = y <= 50 ? y : 100 - y;
      return `
        <line x1="${x}" y1="20" x2="${x}" y2="${VIEW_H - 20}" stroke="rgba(255,255,255,0.22)" stroke-width="2"/>
        <text x="${x}" y="34" text-anchor="middle" font-size="20" fill="rgba(255,255,255,0.55)" font-weight="700">${label}</text>
        <text x="${x}" y="${VIEW_H - 16}" text-anchor="middle" font-size="20" fill="rgba(255,255,255,0.55)" font-weight="700">${label}</text>`;
    }).join('');

    // Small triangle just ahead of the ball, pointing the direction the
    // offense is driving — away attacks right-to-goal (toward home's end
    // zone), home attacks left (toward away's end zone).
    const arrowAhead = 26;
    const arrowX = fd.possessionIsAway ? ballX + arrowAhead : ballX - arrowAhead;
    const arrowPoints = fd.possessionIsAway
      ? `${arrowX},${MID} ${arrowX - 12},${MID - 8} ${arrowX - 12},${MID + 8}`
      : `${arrowX},${MID} ${arrowX + 12},${MID - 8} ${arrowX + 12},${MID + 8}`;

    const endzone = (side, color, team) => {
      const cx = side === 'left' ? EZ / 2 : VIEW_W - EZ / 2;
      const logo = team && team.logo
        ? `<image href="${CFB.safeUrl(team.logo)}" x="${cx - 20}" y="${MID - 42}" width="40" height="40" preserveAspectRatio="xMidYMid meet"/>`
        : '';
      return `
        ${logo}
        <text x="${cx}" y="${MID + (team && team.logo ? 32 : 8)}" text-anchor="middle" font-size="22" fill="#fff" font-weight="800" style="text-shadow:0 1px 3px rgba(0,0,0,0.6)">${team ? CFB.esc(team.abbreviation || '') : ''}</text>`;
    };

    return `
      <svg viewBox="0 0 ${VIEW_W} ${VIEW_H}" class="field-svg" preserveAspectRatio="xMidYMid meet">
        <rect x="0" y="0" width="${VIEW_W}" height="${VIEW_H}" fill="#0a2e16"/>
        <rect x="${EZ}" y="0" width="${FIELD_W}" height="${VIEW_H}" fill="#14532d"/>
        <rect x="0" y="0" width="${EZ}" height="${VIEW_H}" fill="${awayColor}" fill-opacity="0.82"/>
        <rect x="${VIEW_W - EZ}" y="0" width="${EZ}" height="${VIEW_H}" fill="${homeColor}" fill-opacity="0.82"/>
        ${endzone('left', awayColor, away)}
        ${endzone('right', homeColor, home)}
        ${yardMarks}
        <line x1="${toX(50)}" y1="0" x2="${toX(50)}" y2="${VIEW_H}" stroke="rgba(255,255,255,0.35)" stroke-width="3"/>
        <line x1="${EZ}" y1="0" x2="${EZ}" y2="${VIEW_H}" stroke="#fff" stroke-width="4"/>
        <line x1="${VIEW_W - EZ}" y1="0" x2="${VIEW_W - EZ}" y2="${VIEW_H}" stroke="#fff" stroke-width="4"/>
        ${fdX !== null ? `<line x1="${fdX}" y1="0" x2="${fdX}" y2="${VIEW_H}" stroke="#facc15" stroke-width="4" stroke-dasharray="7,5"/>` : ''}
        <polygon points="${arrowPoints}" fill="#fff" opacity="0.9"/>
        <ellipse cx="${ballX}" cy="${MID}" rx="13" ry="8" fill="#8a4b24" stroke="#2a1708" stroke-width="1.5"/>
        <line x1="${ballX - 6}" y1="${MID}" x2="${ballX + 6}" y2="${MID}" stroke="#fff" stroke-width="1.5"/>
      </svg>`;
  }

  // Only rendered for a live game with a usable yard line — hidden
  // pregame/final (no ball to show) and hidden if ESPN's situation data is
  // incomplete, rather than guessing at a field position.
  function renderFieldPosition(detail, away, home) {
    const wrap = el('fieldPositionWrap');
    if (!wrap) return;
    const isLive = detail.status && detail.status.state === 'in';
    // The yard-line diagram only makes sense for football.
    const fd = isLive && CFB.sport().field ? computeFieldData(detail.situation, away, home) : null;
    if (!fd) { wrap.innerHTML = ''; return; }

    const timeoutsRow = (detail.situation.homeTimeouts !== null || detail.situation.awayTimeouts !== null)
      ? `<div class="field-timeouts">
          <span>${away ? CFB.esc(away.abbreviation || '') : ''} timeouts: ${detail.situation.awayTimeouts !== null ? '&#9679;'.repeat(detail.situation.awayTimeouts) + '&#9675;'.repeat(Math.max(0, 3 - detail.situation.awayTimeouts)) : '&mdash;'}</span>
          <span>${home ? CFB.esc(home.abbreviation || '') : ''} timeouts: ${detail.situation.homeTimeouts !== null ? '&#9679;'.repeat(detail.situation.homeTimeouts) + '&#9675;'.repeat(Math.max(0, 3 - detail.situation.homeTimeouts)) : '&mdash;'}</span>
        </div>`
      : '';

    wrap.innerHTML = `
      <div class="field-position">
        <div class="field-svg-wrap">
          ${fieldSvgHtml(fd, away, home)}
          ${detail.situation.isRedZone ? '<div class="redzone-badge">RED ZONE</div>' : ''}
        </div>
        ${timeoutsRow}
      </div>`;
  }

  function statusLine(detail) {
    if (!detail.status) return '';
    if (detail.status.state === 'in') return detail.status.shortDetail || `${CFB.sport().periodPrefix || 'Q'}${detail.status.period} ${detail.status.clock}`;
    if (detail.status.state === 'post') return 'Final' + (detail.status.detail && detail.status.detail !== 'Final' ? ` (${detail.status.detail})` : '');
    return detail.date ? CFB.fmtTime(detail.date) : (detail.status.detail || '');
  }

  // "2 outs · 1-2 count · Runners on 1st, 3rd" for a live baseball game.
  function baseballLine(b) {
    if (!b) return '';
    const parts = [];
    if (b.outs !== null) parts.push(`${b.outs} out${b.outs === 1 ? '' : 's'}`);
    if (b.balls !== null && b.strikes !== null) parts.push(`${b.balls}-${b.strikes} count`);
    const runners = [b.onFirst && '1st', b.onSecond && '2nd', b.onThird && '3rd'].filter(Boolean);
    parts.push(runners.length ? `Runner${runners.length > 1 ? 's' : ''} on ${runners.join(', ')}` : 'Bases empty');
    return parts.join(' · ');
  }

  // Kid mode: "What just happened?" in plain words, for the last play and
  // the latest scoring play.
  function renderKidExplainer(detail) {
    let box = el('kidExplainer');
    if (!CFB.kidMode() || !window.KidsCore) {
      if (box) box.remove();
      return;
    }
    const sportKey = CFB.sport().key;
    const plays = detail.playByPlay || [];
    const lastText = (detail.situation && detail.situation.lastPlay) || (plays[0] && plays[0].text) || null;
    const scoring = plays.find((p) => p.scoringPlay);
    const items = [];
    const lastExplained = KidsCore.explainPlay(lastText, sportKey);
    if (lastExplained) items.push({ title: 'What just happened?', text: lastExplained, play: lastText });
    const scoreExplained = scoring && scoring.text !== lastText ? KidsCore.explainPlay(scoring.text, sportKey) : null;
    if (scoreExplained) items.push({ title: 'Last time someone scored', text: scoreExplained, play: scoring.text });
    if (!items.length) {
      if (box) box.remove();
      return;
    }
    if (!box) {
      box = document.createElement('section');
      box.id = 'kidExplainer';
      box.className = 'kid-explainer';
      el('gameSituation').insertAdjacentElement('afterend', box);
    }
    box.innerHTML = items.map((i) => `
      <div class="kid-explainer-item">
        <div class="kid-explainer-title">${CFB.esc(i.title)}</div>
        <div class="kid-explainer-text">${CFB.esc(i.text)}</div>
        <div class="kid-explainer-play">${CFB.esc(i.play)}</div>
      </div>`).join('');
  }

  // Remembered across refreshes so a live update doesn't snap the page back:
  // which box-score team tab is open, and how far the play-by-play feed is
  // scrolled.
  const ui = { boxTab: '0', lastScores: null, matchupLoaded: false, lastLoaded: null };

  function captureUi() {
    const feed = document.querySelector('.pbp-feed');
    return { pbpScroll: feed ? feed.scrollTop : 0 };
  }

  function restoreUi(saved) {
    const feed = document.querySelector('.pbp-feed');
    if (feed && saved.pbpScroll) feed.scrollTop = saved.pbpScroll;
    selectBoxTab(ui.boxTab);
  }

  function selectBoxTab(idx) {
    const tabs = document.querySelectorAll('[data-box-tab]');
    if (!tabs.length) return;
    if (!document.querySelector(`[data-box-panel="${idx}"]`)) idx = '0';
    ui.boxTab = idx;
    tabs.forEach((b) => b.classList.toggle('active', b.dataset.boxTab === idx));
    document.querySelectorAll('[data-box-panel]').forEach((p) => p.classList.toggle('active', p.dataset.boxPanel === idx));
  }

  document.addEventListener('click', (e) => {
    const tab = e.target.closest && e.target.closest('[data-box-tab]');
    if (tab) selectBoxTab(tab.dataset.boxTab);
  });

  // Hover/touch readout on the win probability line.
  function wireWinProb() {
    const wrap = document.querySelector('.wp-chart');
    if (!wrap) return;
    const pts = (wrap.dataset.points || '').split(',').map(Number).filter((n) => !Number.isNaN(n));
    if (pts.length < 2) return;
    const svg = wrap.querySelector('svg');
    const cross = wrap.querySelector('.wp-cross');
    const tip = wrap.querySelector('.wp-tip');
    const move = (clientX) => {
      const rect = svg.getBoundingClientRect();
      const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      const i = Math.round(frac * (pts.length - 1));
      const home = Math.round(pts[i] * 100);
      const vbX = 4 + (i / (pts.length - 1)) * (600 - 8);
      cross.setAttribute('x1', vbX);
      cross.setAttribute('x2', vbX);
      cross.style.display = '';
      tip.style.display = '';
      tip.style.left = `${(i / (pts.length - 1)) * 100}%`;
      tip.textContent = home >= 50 ? `${wrap.dataset.home} ${home}%` : `${wrap.dataset.away} ${100 - home}%`;
    };
    const hide = () => { cross.style.display = 'none'; tip.style.display = 'none'; };
    svg.addEventListener('mousemove', (e) => move(e.clientX));
    svg.addEventListener('touchmove', (e) => { if (e.touches[0]) move(e.touches[0].clientX); }, { passive: true });
    svg.addEventListener('mouseleave', hide);
    svg.addEventListener('touchend', hide);
  }

  // Highlights are fetched once the game is final (clips show up over the
  // following hours, so a page left open re-checks every 10 minutes until
  // some arrive). A live poll never re-renders them, so a playing clip
  // isn't interrupted.
  const HIGHLIGHT_RETRY_MS = 10 * 60 * 1000;
  let highlightClips = [];
  let highlightsCheckedAt = 0;

  async function loadHighlights() {
    const box = el('gameHighlights');
    if (!box || source !== 'espn') return;
    if (highlightClips.length || Date.now() - highlightsCheckedAt < HIGHLIGHT_RETRY_MS - 5000) return;
    highlightsCheckedAt = Date.now();
    try {
      const data = await CFB.getJson(CFB.withSport(`/api/game/${encodeURIComponent(gameId)}/highlights`));
      highlightClips = data.clips || [];
      box.innerHTML = CFBGame.highlightsHtml(data);
    } catch (err) {
      box.innerHTML = '';
    }
    if (!highlightClips.length) setTimeout(loadHighlights, HIGHLIGHT_RETRY_MS);
  }

  document.addEventListener('click', (e) => {
    const card = e.target.closest && e.target.closest('[data-hl]');
    if (!card) return;
    const clip = highlightClips[Number(card.dataset.hl)];
    const player = el('hlPlayer');
    if (!clip || !player) return;
    player.innerHTML = CFBGame.highlightPlayerHtml(clip);
    player.hidden = false;
    document.querySelectorAll('.hl-card.active').forEach((c) => c.classList.remove('active'));
    card.classList.add('active');
    player.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });

  async function loadMatchup() {
    const box = el('gameMatchup');
    if (!box || source !== 'espn') return;
    try {
      const m = await CFB.getJson(CFB.withSport(`/api/game/${encodeURIComponent(gameId)}/matchup`));
      box.innerHTML = CFBGame.matchupHtml(m);
      ui.matchupLoaded = true;
    } catch (err) {
      box.innerHTML = '';
    }
  }

  // How often to refresh: every 15s while live, every minute in the half
  // hour before kickoff (to catch the start), otherwise not at all.
  function refreshDelay(detail) {
    const state = detail.status && detail.status.state;
    if (state === 'in') return 15000;
    if (state === 'pre' && detail.date) {
      const until = new Date(detail.date).getTime() - Date.now();
      if (until < 30 * 60 * 1000) return 60000;
    }
    return null;
  }

  function scheduleNext(detail) {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
    const delay = refreshDelay(detail);
    const note = el('gameRefreshNote');
    if (note) {
      note.textContent = delay
        ? `Updates on its own every ${delay / 1000}s · last updated ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}`
        : '';
    }
    // Paused while the tab is hidden; picked back up on visibilitychange.
    if (delay && !document.hidden) pollTimer = setTimeout(load, delay);
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && ui.lastLoaded && refreshDelay(ui.lastLoaded)) load();
    else if (document.hidden && pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  });

  async function load() {
    try {
      const detail = await CFB.getJson(CFB.withSport(`/api/game/${encodeURIComponent(gameId)}?source=${encodeURIComponent(source)}`));
      ui.lastLoaded = detail;
      const saved = captureUi();
      document.title = `${(detail.teams || []).map((t) => t.abbreviation || t.shortName || t.name).join(' @ ')} · Stat Scraps`;

      const away = (detail.teams || []).find((t) => t.homeAway === 'away');
      const home = (detail.teams || []).find((t) => t.homeAway === 'home');
      const isLive = detail.status && detail.status.state === 'in';
      const possessionId = isLive && detail.situation ? detail.situation.possession : null;
      const awayHasBall = !!(possessionId && away && String(possessionId) === String(away.id));
      const homeHasBall = !!(possessionId && home && String(possessionId) === String(home.id));
      const networks = (detail.broadcasts || []).filter((b) => !b.market || /national/i.test(b.market)).map((b) => b.network);
      const tvText = (networks.length ? networks : [detail.broadcast]).filter(Boolean).join(' / ');

      el('statusNote').textContent = [statusLine(detail), tvText, detail.venue].filter(Boolean).join(' · ');

      const scores = `${away && away.score}-${home && home.score}`;
      const scoreChanged = ui.lastScores !== null && ui.lastScores !== scores;
      ui.lastScores = scores;

      el('gameScorebug').innerHTML = `
        <div class="game-status-row">
          ${isLive ? '<span class="live-dot">&#9679; LIVE</span>' : ''}
          <span>${CFB.esc(statusLine(detail))}</span>
          ${tvText ? `<span class="tv-badge" title="TV channel">&#128250; ${CFB.esc(tvText)}</span>` : ''}
        </div>
        <div class="game-sides">
          ${teamSideHtml(away, 'away', awayHasBall)}
          <div class="game-vs">@</div>
          ${teamSideHtml(home, 'home', homeHasBall)}
        </div>`;
      if (scoreChanged) {
        const bug = el('gameScorebug');
        bug.classList.remove('score-flash');
        void bug.offsetWidth; // restart the animation
        bug.classList.add('score-flash');
      }

      // Kids Zone: confetti when a followed team scores, and a sticker for
      // watching it live.
      if (typeof Kids !== 'undefined') {
        Kids.watchScores([detail], CFB.sport().key);
        Kids.awardWatched(detail, CFB.sport().key);
      }

      el('gameWatch').innerHTML = CFBGame.watchHtml(detail);

      renderFieldPosition(detail, away, home);

      const situationEl = el('gameSituation');
      const baseball = isLive && detail.situation ? baseballLine(detail.situation.baseball) : '';
      if (detail.situation && (detail.situation.down || detail.situation.lastPlay || baseball)) {
        situationEl.classList.remove('empty-note');
        situationEl.innerHTML = `
          ${detail.situation.down ? `<div><strong>${CFB.esc(detail.situation.down)}</strong></div>` : ''}
          ${baseball ? `<div><strong>${CFB.esc(baseball)}</strong></div>` : ''}
          ${detail.situation.lastPlay ? `<div>${CFB.esc(detail.situation.lastPlay)}</div>` : ''}`;
      } else {
        situationEl.classList.add('empty-note');
        situationEl.textContent = '';
      }

      el('gameWinProb').innerHTML = CFBGame.winProbHtml(detail, away, home);
      wireWinProb();
      el('gameBoxScore').innerHTML = CFBGame.boxScoreHtml(detail);
      el('gameDetailSections').innerHTML = CFB.gameDetailSectionsHtml(detail);
      renderKidExplainer(detail);

      el('gameInjuries').innerHTML = CFBGame.injuriesHtml(detail);
      el('gameForm').innerHTML = CFBGame.recentFormHtml(detail);
      restoreUi(saved);

      if (!ui.matchupLoaded) loadMatchup();
      if (detail.status && detail.status.state === 'post') loadHighlights();
      scheduleNext(detail);
    } catch (err) {
      // Keep showing the last good data during a live game; just retry.
      if (ui.lastLoaded) {
        scheduleNext(ui.lastLoaded);
        return;
      }
      el('gameScorebug').innerHTML = '<div class="empty-note">Could not load this game.</div>';
    }
  }

  CFB.loadSports().then(() => {
    CFB.initSportBar();
    load();
  });
})();

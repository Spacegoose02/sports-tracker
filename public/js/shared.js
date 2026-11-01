// Shared helpers used by index.js, team.js, rankings.js, standings.js.
// Everything here assumes the page includes a #modalBackdrop / #modalContent
// pair (see index.html / team.html) for the game-detail popup.

const CFB = (function () {
  const el = (id) => document.getElementById(id);

  async function getJson(url, opts) {
    const res = await fetch(url, opts);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Request failed: ${res.status}`);
    }
    return res.json();
  }

  function fmtTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
  }

  function statusLabel(game) {
    if (!game || !game.status) return '';
    if (game.status.state === 'in') return game.status.shortDetail || `Q${game.status.period} ${game.status.clock}`;
    if (game.status.state === 'post') return 'Final' + (game.status.detail && game.status.detail !== 'Final' ? ` (${game.status.detail})` : '');
    return fmtTime(game.date);
  }

  function teamLink(team) {
    if (!team || !team.id) return '';
    return `/team.html?id=${encodeURIComponent(team.id)}&source=espn`;
  }

  function gameLink(id, source) {
    if (!id) return '';
    return `/game.html?id=${encodeURIComponent(id)}&source=${encodeURIComponent(source || 'espn')}`;
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
        ${team.logo ? `<img src="${team.logo}" alt="" onerror="this.style.display='none'">` : ''}
        <a class="team-name team-link ${isWinner ? 'winner' : ''}" href="${teamLink(team)}" onclick="event.stopPropagation()">${team.name || team.shortName || 'TBD'}</a>
        ${possessionIcon}
        <span class="score">${team.score !== null && team.score !== undefined ? team.score : ''}</span>
        ${wlBadge}
      </div>`;
  }

  function oddsLine(game) {
    if (!game.odds) return '';
    const parts = [];
    if (game.odds.details) parts.push(game.odds.details);
    else if (game.odds.spread !== null) parts.push(`Spread ${game.odds.spread > 0 ? '+' : ''}${game.odds.spread}`);
    if (game.odds.overUnder !== null) parts.push(`O/U ${game.odds.overUnder}`);
    if (!parts.length) return '';
    return `<div class="odds-line">${parts.join(' &middot; ')}</div>`;
  }

  // Full game card — used on Schedule & Scores AND Notable Games, so both
  // look and behave identically (channel, time, rank, live indicator).
  function gameCardHtml(game, opts) {
    opts = opts || {};
    const isFav = opts.favoriteTeamId && ((game.home && String(game.home.id) === String(opts.favoriteTeamId)) ||
      (game.away && String(game.away.id) === String(opts.favoriteTeamId)));
    const isLive = game.status && game.status.state === 'in';
    const isCompleted = !!(game.status && game.status.completed);
    const possessionId = isLive && game.situation ? game.situation.possession : null;
    const awayHasBall = !!(possessionId && game.away && String(possessionId) === String(game.away.id));
    const homeHasBall = !!(possessionId && game.home && String(possessionId) === String(game.home.id));
    return `
      <div class="game-card ${isFav ? 'is-favorite' : ''} ${isLive ? 'is-live' : ''}" data-id="${game.id}" data-source="${game.source || 'espn'}">
        <div class="status-row">
          <span class="${isLive ? 'live-dot' : ''}">${statusLabel(game)}</span>
          <span style="display:flex;align-items:center;gap:6px;">
            ${opts.notable ? '<span class="notable-ribbon">Notable</span>' : ''}
            ${game.broadcast ? `<span>${game.broadcast}</span>` : ''}
          </span>
        </div>
        ${teamRowHtml(game.away, { completed: isCompleted, hasPossession: awayHasBall })}
        ${teamRowHtml(game.home, { completed: isCompleted, hasPossession: homeHasBall })}
        ${game.venue ? `<div class="venue">${game.venue}</div>` : ''}
        ${oddsLine(game)}
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
          ${detail.odds.details ? `<div>${detail.odds.details}</div>` : ''}
          ${detail.odds.overUnder !== null ? `<div>Over/Under: <strong>${detail.odds.overUnder}</strong></div>` : ''}
          ${detail.odds.provider ? `<div class="odds-provider">via ${detail.odds.provider}</div>` : ''}
        </div></section>`
      : '';
    const leadersHtml = (detail.leaders || []).map((teamLeaders) => `
      <div><strong>${teamLeaders.team}</strong>
        ${(teamLeaders.categories || []).map((c) => `<div class="stat-row"><span>${c.name}</span><span>${c.athlete ? c.athlete + ' &middot; ' : ''}${c.value || ''}</span></div>`).join('')}
      </div>`).join('');
    const boxHtml = detail.boxscore ? detail.boxscore.teams.map((t) => `
      <div><strong>${t.team}</strong>
        ${t.stats.map((s) => `<div class="stat-row"><span>${s.name}</span><span>${s.value}</span></div>`).join('')}
      </div>`).join('') : '';
    const playsHtml = detail.drives ? `<div class="plays"><strong>${detail.drives.description || 'Latest drive'}</strong><br>${(detail.drives.plays || []).join('<br>')}</div>` : '';
    // Full play-by-play — only really meaningful once the game has actually
    // started (pregame there's nothing to show), shown newest-first in a
    // scrollable feed so it doesn't dominate the page for a long game.
    const pbpHtml = detail.playByPlay && detail.playByPlay.length
      ? `<section><h2 class="section-title">Play-by-Play</h2><div class="pbp-feed">
          ${detail.playByPlay.map((p) => `
            <div class="pbp-play ${p.scoringPlay ? 'scoring' : ''}">
              <span class="pbp-meta">${[p.drive, p.period ? `Q${p.period}` : null, p.clock].filter(Boolean).join(' &middot; ')}</span>
              <span class="pbp-text">${p.text}</span>
            </div>`).join('')}
        </div></section>`
      : '';
    const note = detail.status && detail.status.state === 'pre'
      ? '<p class="empty-note">This game hasn\'t started yet &mdash; check back once it kicks off for live stats and play-by-play.</p>'
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

  // Shared FBS/FCS division toggle. Persists the choice in localStorage
  // (this is a real self-hosted app running in the user's own browser,
  // not a hosted preview, so localStorage is safe/appropriate here) and
  // calls onChange('fbs' | 'fcs') whenever it changes, including once on
  // init with the restored value.
  function initDivisionToggle(onChange) {
    const container = el('divisionToggle');
    if (!container) return;
    let saved = 'fbs';
    try { saved = localStorage.getItem('cfb-division') || 'fbs'; } catch (e) { /* ignore */ }
    const buttons = container.querySelectorAll('button');
    buttons.forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.division === saved);
      btn.addEventListener('click', () => {
        buttons.forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        try { localStorage.setItem('cfb-division', btn.dataset.division); } catch (e) { /* ignore */ }
        onChange(btn.dataset.division);
      });
    });
    onChange(saved);
  }

  return {
    el, getJson, fmtTime, statusLabel, teamLink, gameLink, teamRowHtml, gameCardHtml,
    wireGameCardClicks, gameDetailSectionsHtml,
    applyTeamColor, initDivisionToggle,
  };
})();

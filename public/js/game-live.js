// Live sections of the game page: the play-by-play feed (with filters),
// the momentum chart, the drive tracker and the biggest win-probability
// swings. Pure functions of the /api/game/:id data (no DOM access) so
// tests can load this file in a sandbox like game-sections.js. Every
// outside string goes through CFB.esc / CFB.safeUrl. Styles live in
// css/game-live.css.
const CFBLive = (function () {
  const esc = (v) => CFB.esc(v);
  const hex = (c) => (c && /^#[0-9a-f]{6}$/i.test(c) ? c : null);
  const abbr = (t) => (t ? (t.abbreviation || t.shortName || t.name || '') : '');
  const periodLabel = (p) => (p ? `${CFB.sport().periodPrefix || 'Q'}${p}` : '');

  function colors(away, home) {
    return { away: hex(away && away.color) || '#98a0b3', home: hex(home && home.color) || '#4f8dfd' };
  }

  function sideOf(teamId, away, home) {
    if (!teamId) return null;
    if (home && String(home.id) === String(teamId)) return 'home';
    if (away && String(away.id) === String(teamId)) return 'away';
    return null;
  }

  // Football "big play": 20+ yards from scrimmage.
  const isBig = (p) => p.yards !== null && p.yards !== undefined && Math.abs(p.yards) >= 20;

  const FILTERS = ['all', 'scoring', 'big', 'away', 'home'];

  function filterPlays(plays, filter, away, home) {
    switch (filter) {
      case 'scoring': return plays.filter((p) => p.scoringPlay);
      case 'big': return plays.filter(isBig);
      case 'away': return plays.filter((p) => sideOf(p.teamId, away, home) === 'away');
      case 'home': return plays.filter((p) => sideOf(p.teamId, away, home) === 'home');
      default: return plays;
    }
  }

  // The play-by-play feed, newest first, grouped under period headers.
  // `opts.filter` is one of FILTERS; `opts.newIds` is a Set of play ids
  // that arrived since the last refresh, which get a highlight.
  function feedHtml(detail, away, home, opts) {
    const plays = detail.playByPlay || [];
    if (!plays.length) return '';
    opts = opts || {};
    const c = colors(away, home);
    const hasTeams = plays.some((p) => p.teamId);
    const hasBig = plays.some(isBig);
    const filter = FILTERS.includes(opts.filter) ? opts.filter : 'all';
    const chips = [
      ['all', 'All plays'],
      ['scoring', 'Scoring'],
      hasBig ? ['big', 'Big plays'] : null,
      hasTeams && away ? ['away', abbr(away)] : null,
      hasTeams && home ? ['home', abbr(home)] : null,
    ].filter(Boolean).map(([k, label]) => `<button type="button" class="live-chip ${k === filter ? 'active' : ''}" data-feed-filter="${k}" aria-pressed="${k === filter}">${esc(label)}</button>`).join('');

    const shown = filterPlays(plays, filter, away, home);
    let lastPeriod = null;
    const rows = shown.map((p) => {
      const side = sideOf(p.teamId, away, home);
      const team = side === 'home' ? home : side === 'away' ? away : null;
      const header = p.period && p.period !== lastPeriod
        ? `<div class="live-period">${esc(periodLabel(p.period))}</div>` : '';
      lastPeriod = p.period || lastPeriod;
      const score = p.scoringPlay && p.awayScore !== null && p.awayScore !== undefined && p.homeScore !== null && p.homeScore !== undefined
        ? `<span class="live-score">${esc(abbr(away))} ${esc(p.awayScore)} &ndash; ${esc(abbr(home))} ${esc(p.homeScore)}</span>` : '';
      const tags = [
        p.scoringPlay ? '<span class="live-tag live-tag-score">Score</span>' : '',
        isBig(p) && !p.scoringPlay ? `<span class="live-tag">${esc(p.yards)} yds</span>` : '',
      ].join('');
      return `${header}
        <div class="live-play ${p.scoringPlay ? 'scoring' : ''} ${p.id && opts.newIds && opts.newIds.has(p.id) ? 'live-new' : ''}" style="--side-color:${side ? c[side] : 'transparent'}">
          <div class="live-play-meta">
            ${team ? `<span class="live-team">${team.logo ? `<img src="${CFB.safeUrl(team.logo)}" alt="" onerror="this.remove()">` : ''}${esc(abbr(team))}</span>` : ''}
            <span>${esc(p.clock || '')}</span>
            ${p.type ? `<span class="live-type">${esc(p.type)}</span>` : ''}
            ${tags}
          </div>
          <div class="live-play-text">${esc(p.text)}</div>
          ${score}
        </div>`;
    }).join('');
    const live = detail.status && detail.status.state === 'in';
    return `
      <section>
        <h2 class="section-title">${live ? '<span class="live-dot">&#9679;</span> ' : ''}Play-by-Play</h2>
        <div class="live-chips" role="group" aria-label="Filter plays">${chips}</div>
        <div class="live-feed pbp-feed" aria-live="${live ? 'polite' : 'off'}">
          ${rows || '<div class="empty-note">No plays match this filter yet.</div>'}
        </div>
        <div class="wp-dim live-count">${shown.length} of ${plays.length} plays</div>
      </section>`;
  }

  // Momentum: diverging bars, home swings up, away swings down, oldest on
  // the left. Each bar is one slice of the game.
  function momentumHtml(detail, away, home) {
    const m = detail.momentum;
    if (!m || !m.bars || !m.bars.length) return '';
    const c = colors(away, home);
    const W = 600; const H = 140; const MID = H / 2; const GAP = 3;
    const max = Math.max(...m.bars.map((b) => Math.abs(b.value)), m.basis === 'points' ? 3 : 0.1);
    const bw = W / m.bars.length;
    const unit = m.basis === 'points' ? 'pts' : '%';
    const fmt = (v) => (m.basis === 'points' ? Math.abs(v) : Math.round(Math.abs(v) * 100));
    const bars = m.bars.map((b, i) => {
      const h = (Math.abs(b.value) / max) * (MID - 6);
      if (!h) return '';
      const up = b.value > 0;
      const team = up ? home : away;
      return `<rect x="${(i * bw + GAP / 2).toFixed(1)}" y="${(up ? MID - h : MID).toFixed(1)}" width="${(bw - GAP).toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="${up ? c.home : c.away}"><title>${esc(abbr(team))} +${fmt(b.value)}${unit === '%' ? '% win chance' : ' pts'}</title></rect>`;
    }).join('');
    // Who had the better last quarter of the bars.
    const recent = m.bars.slice(-Math.max(2, Math.round(m.bars.length / 4))).reduce((s, b) => s + b.value, 0);
    const hot = recent > 0 ? home : recent < 0 ? away : null;
    return `
      <section>
        <h2 class="section-title">Momentum</h2>
        <div class="wp-box momentum-box">
          <div class="wp-headline">${hot ? `<strong>${esc(abbr(hot))}</strong> <span class="wp-dim">has the momentum lately</span>` : '<span class="wp-dim">Even lately</span>'}</div>
          <div class="momentum-chart">
            <div class="wp-axis-label">${esc(abbr(home))} &uarr;</div>
            <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Momentum through the game, ${esc(abbr(home))} swings up and ${esc(abbr(away))} swings down">
              <line x1="0" x2="${W}" y1="${MID}" y2="${MID}" class="wp-mid"/>
              ${bars}
            </svg>
            <div class="wp-axis-label">${esc(abbr(away))} &darr;</div>
          </div>
          <div class="momentum-x wp-dim"><span>Start</span><span>${detail.status && detail.status.state === 'post' ? 'Final' : 'Now'}</span></div>
          <div class="wp-dim wp-source">${m.basis === 'points' ? 'Points scored in each stretch of the game' : 'Change in ESPN win probability in each stretch of the game'}</div>
        </div>
      </section>`;
  }

  // Biggest swings, shown inside the Win Probability box.
  function swingsHtml(detail, away, home) {
    const list = detail.wpSwings || [];
    if (!list.length) return '';
    const c = colors(away, home);
    return `
      <div class="wp-swings">
        <div class="watch-label">Biggest swings</div>
        <ol>
          ${list.map((s) => {
            const helped = s.delta > 0 ? home : away;
            const color = s.delta > 0 ? c.home : c.away;
            return `<li><span class="swing-badge" style="--side-color:${color}">${esc(abbr(helped))} +${Math.round(Math.abs(s.delta) * 100)}%</span>
              <span>${esc(s.text)} <span class="wp-dim">${esc([periodLabel(s.period), s.clock].filter(Boolean).join(' '))}</span></span></li>`;
          }).join('')}
        </ol>
      </div>`;
  }

  const KIND_LABEL = { td: 'TD', fg: 'FG', punt: 'Punt', turnover: 'Turnover', end: 'End', live: 'Live', other: '' };

  function driveSummary(drives, team) {
    const mine = drives.filter((d) => team && String(d.teamId) === String(team.id));
    if (!mine.length) return '';
    const count = (k) => mine.filter((d) => d.kind === k).length;
    const bits = [
      [count('td'), 'TD'], [count('fg'), 'FG'], [count('punt'), 'punt'], [count('turnover'), 'turnover'],
    ].filter(([n]) => n).map(([n, l]) => `${n} ${l}${n > 1 && l !== 'TD' && l !== 'FG' ? 's' : ''}`);
    return `<span><strong>${esc(abbr(team))}</strong> ${mine.length} drives${bits.length ? ` &middot; ${bits.join(', ')}` : ''}</span>`;
  }

  // Drive tracker: newest first, live drive on top, each with a strip of
  // field from the offense's own goal line (left) to the end zone (right).
  function drivesHtml(detail, away, home) {
    const drives = detail.driveChart || [];
    if (!drives.length || !CFB.sport().field) return '';
    const c = colors(away, home);
    const row = (d) => {
      const side = sideOf(d.teamId, away, home);
      const team = side === 'home' ? home : side === 'away' ? away : null;
      const color = side ? c[side] : '#98a0b3';
      const hasSpan = d.start !== null && d.end !== null;
      const lo = hasSpan ? Math.max(0, Math.min(d.start, d.end)) : 0;
      const hi = hasSpan ? Math.min(100, Math.max(d.start, d.end)) : 0;
      const stats = [
        d.plays !== null && d.plays !== undefined ? `${d.plays} play${d.plays === 1 ? '' : 's'}` : null,
        d.yards !== null && d.yards !== undefined ? `${d.yards} yds` : null,
        d.time,
      ].filter(Boolean).join(' &middot; ');
      return `
        <li class="drive-row ${d.live ? 'drive-live' : ''}">
          <div class="drive-team">
            ${team && team.logo ? `<img src="${CFB.safeUrl(team.logo)}" alt="" onerror="this.remove()">` : ''}
            <strong>${esc(d.team || abbr(team))}</strong>
            <span class="wp-dim">${esc([periodLabel(d.period), d.clock].filter(Boolean).join(' '))}</span>
          </div>
          <div class="drive-field" aria-hidden="true">
            <span class="drive-mid"></span>
            ${hasSpan ? `<span class="drive-span" style="left:${lo}%;width:${Math.max(1.5, hi - lo)}%;background:${color}"></span>
            <span class="drive-ball" style="left:${d.end}%"></span>` : ''}
          </div>
          <div class="drive-result">
            ${d.kind ? `<span class="drive-badge drive-${esc(d.kind)}">${esc(KIND_LABEL[d.kind] || d.result || '')}</span>` : ''}
            <span class="wp-dim">${esc(d.startText || '')}${d.endText ? ` &rarr; ${esc(d.endText)}` : ''}</span>
          </div>
          <div class="drive-stats wp-dim">${d.result && d.kind !== 'live' ? `${esc(d.result)} &middot; ` : ''}${stats}</div>
        </li>`;
    };
    const ordered = drives.slice().reverse();
    const first = ordered.slice(0, 6).map(row).join('');
    const rest = ordered.slice(6).map(row).join('');
    return `
      <section>
        <h2 class="section-title">Drive Tracker</h2>
        <div class="wp-box drive-box">
          <div class="drive-summary">${driveSummary(drives, away)}${driveSummary(drives, home)}</div>
          <div class="drive-legend wp-dim"><span>Own goal</span><span>50</span><span>End zone</span></div>
          <ol class="drive-list">${first}</ol>
          ${rest ? `<details class="drive-more"><summary>Show ${ordered.length - 6} earlier drives</summary><ol class="drive-list">${rest}</ol></details>` : ''}
        </div>
      </section>`;
  }

  return { feedHtml, momentumHtml, swingsHtml, drivesHtml, filterPlays, FILTERS };
})();

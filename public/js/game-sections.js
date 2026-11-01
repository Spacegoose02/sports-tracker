// HTML builders for the richer game page: where to watch, win probability,
// player box score, injuries, recent form, weather and head-to-head. Pure
// functions of the API data (no DOM access) so tests can load this file in
// a sandbox the same way they load shared.js. Every outside string goes
// through CFB.esc / CFB.safeUrl.
const CFBGame = (function () {
  const esc = (v) => CFB.esc(v);

  function teamLabel(t) {
    return t ? (t.abbreviation || t.shortName || t.name || '') : '';
  }

  // TV channels first (the thing most people look for), then the apps that
  // stream those channels.
  function watchHtml(detail) {
    const broadcasts = detail.broadcasts && detail.broadcasts.length
      ? detail.broadcasts
      : (detail.broadcast ? [{ network: detail.broadcast, type: 'TV', market: 'National' }] : []);
    // A note or watch link from the site admin (src/overrides.js).
    const note = detail.broadcastNote ? `<p class="watch-admin-note">${esc(detail.broadcastNote)}</p>` : '';
    if (!broadcasts.length && !(detail.streaming || []).length) {
      if (detail.status && detail.status.state === 'post') return '';
      return `<section><h2 class="section-title">Where to Watch</h2><div class="watch-box">${note}<div class="empty-note">TV channel hasn't been announced yet.</div></div></section>`;
    }
    const tv = broadcasts.map((b) => `
      <li class="watch-channel">
        <span class="watch-network">${esc(b.network)}</span>
        ${b.market && !/national/i.test(b.market) ? `<span class="watch-market">${esc(b.market)} only</span>` : ''}
        ${b.type && !/^tv$/i.test(b.type) ? `<span class="watch-market">${esc(b.type)}</span>` : ''}
      </li>`).join('');
    const streams = (detail.streaming || []).map((s) => {
      const name = s.url
        ? `<a href="${CFB.safeUrl(s.url)}" target="_blank" rel="noopener">${esc(s.name)}</a>`
        : `<strong>${esc(s.name)}</strong>`;
      return `<li>${name}<span class="watch-note">${esc(s.note || '')}${s.networks && s.networks.length ? ` &middot; for ${s.networks.map(esc).join(', ')}` : ''}</span></li>`;
    }).join('');
    return `
      <section>
        <h2 class="section-title">Where to Watch</h2>
        <div class="watch-box">
          ${note}
          ${tv ? `<div class="watch-label">TV and streaming channels</div><ul class="watch-channels">${tv}</ul>` : ''}
          ${streams ? `<div class="watch-label">Stream it</div><ul class="watch-streams">${streams}</ul>` : ''}
        </div>
      </section>`;
  }

  // Win probability as a line of the home team's chance, 0-100%, with the
  // 50% line marked. One series, so no legend; the title names it.
  function winProbHtml(detail, away, home) {
    const wp = detail.winProbability;
    if (!wp) return '';
    const homePct = Math.round(wp.home * 100);
    const awayPct = 100 - homePct;
    const leader = homePct >= awayPct ? home : away;
    const leaderPct = Math.max(homePct, awayPct);
    const headline = `${esc(teamLabel(leader))} ${leaderPct}%`;
    const hex = (c) => (c && /^#[0-9a-f]{6}$/i.test(c) ? c : null);
    const homeColor = hex(home && home.color) || '#4f8dfd';
    const awayColor = hex(away && away.color) || '#98a0b3';

    let chart = '';
    const pts = wp.points || [];
    if (pts.length > 1) {
      const W = 600; const H = 160; const PAD = 4;
      const x = (i) => PAD + (i / (pts.length - 1)) * (W - 2 * PAD);
      const y = (p) => PAD + (1 - p) * (H - 2 * PAD);
      const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p).toFixed(1)}`).join(' ');
      chart = `
        <div class="wp-chart" data-points="${esc(pts.join(','))}" data-home="${esc(teamLabel(home))}" data-away="${esc(teamLabel(away))}">
          <div class="wp-axis-label wp-top">${esc(teamLabel(home))} 100%</div>
          <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(teamLabel(home))} win probability over the game, now ${homePct}%">
            <line x1="0" x2="${W}" y1="${y(0.5)}" y2="${y(0.5)}" class="wp-mid"/>
            <path d="${line}" fill="none" stroke="${homeColor}" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>
            <line class="wp-cross" x1="0" x2="0" y1="0" y2="${H}" style="display:none"/>
          </svg>
          <div class="wp-axis-label wp-bottom">${esc(teamLabel(away))} 100%</div>
          <div class="wp-tip" style="display:none"></div>
        </div>`;
    }
    const bar = `
      <div class="wp-bar" aria-hidden="true">
        <span style="width:${awayPct}%;background:${awayColor}"></span><span style="width:${homePct}%;background:${homeColor}"></span>
      </div>
      <div class="wp-bar-labels"><span>${esc(teamLabel(away))} ${awayPct}%</span><span>${esc(teamLabel(home))} ${homePct}%</span></div>`;
    const isPre = !pts.length;
    return `
      <section>
        <h2 class="section-title">Win Probability</h2>
        <div class="wp-box">
          <div class="wp-headline"><strong>${headline}</strong> <span class="wp-dim">${isPre ? 'chance to win, before kickoff' : (detail.status && detail.status.state === 'post' ? 'final' : 'chance to win right now')}</span></div>
          ${bar}
          ${chart}
          <div class="wp-dim wp-source">${isPre && wp.pregame ? esc(wp.pregame.source) : 'ESPN win probability, play by play'}</div>
        </div>
      </section>`;
  }

  // Player box score: a tab per team, one table per stat group.
  function boxScoreHtml(detail) {
    const teams = detail.playerStats || [];
    if (!teams.length) return '';
    const tabs = teams.map((t, i) => `<button type="button" class="box-tab ${i === 0 ? 'active' : ''}" data-box-tab="${i}">${esc(t.team || t.abbreviation || `Team ${i + 1}`)}</button>`).join('');
    const panels = teams.map((t, i) => `
      <div class="box-panel ${i === 0 ? 'active' : ''}" data-box-panel="${i}">
        ${t.groups.map((g) => `
          <div class="box-group">
            <div class="box-group-title">${esc(g.title)}</div>
            <div class="box-table-wrap">
              <table class="box-table">
                <thead><tr><th class="box-name">Player</th>${g.labels.map((l) => `<th>${esc(l)}</th>`).join('')}</tr></thead>
                <tbody>
                  ${g.players.map((p) => `<tr><td class="box-name">${esc(p.name)}${p.position ? ` <span class="box-pos">${esc(p.position)}</span>` : ''}</td>${p.stats.map((s) => `<td>${esc(s)}</td>`).join('')}</tr>`).join('')}
                  ${g.totals && g.totals.some((v) => v !== '') ? `<tr class="box-totals"><td class="box-name">Team</td>${g.totals.map((s) => `<td>${esc(s)}</td>`).join('')}</tr>` : ''}
                </tbody>
              </table>
            </div>
          </div>`).join('')}
      </div>`).join('');
    return `
      <section>
        <h2 class="section-title">Box Score</h2>
        <div class="box-tabs" role="tablist">${tabs}</div>
        ${panels}
      </section>`;
  }

  function injuriesHtml(detail) {
    const teams = detail.injuries || [];
    const state = detail.status && detail.status.state;
    if (!teams.length) {
      return state === 'post' ? '' : `<section><h2 class="section-title">Injury Report</h2><div class="empty-note">No injuries reported for either team.</div></section>`;
    }
    return `
      <section>
        <h2 class="section-title">Injury Report</h2>
        <div class="injury-grid">
          ${teams.map((t) => `
            <div class="injury-team">
              <strong>${esc(t.team)}</strong>
              <ul class="injury-list">
                ${t.players.map((p) => `
                  <li>
                    <span class="injury-status injury-${esc(String(p.status || '').toLowerCase().replace(/[^a-z]/g, ''))}">${esc(p.status || 'Listed')}</span>
                    <span>${esc(p.name)}${p.position ? ` <span class="box-pos">${esc(p.position)}</span>` : ''}${p.injury ? ` <span class="wp-dim">&middot; ${esc(p.injury)}</span>` : ''}</span>
                  </li>`).join('')}
              </ul>
            </div>`).join('')}
        </div>
      </section>`;
  }

  function recentFormHtml(detail) {
    const teams = detail.recentForm || [];
    if (!teams.length) return '';
    return `
      <section>
        <h2 class="section-title">Recent Form</h2>
        <div class="form-grid">
          ${teams.map((t) => `
            <div class="form-team">
              <strong>${esc(t.team)}</strong>
              <ul class="form-list">
                ${t.games.map((g) => `
                  <li>
                    <span class="wl-badge ${g.result === 'W' ? 'win' : g.result === 'L' ? 'loss' : ''}">${esc(g.result || '-')}</span>
                    <span>${esc(g.atVs || '')} ${esc(g.opponent || '')}</span>
                    <span class="wp-dim">${esc(g.score || '')}</span>
                  </li>`).join('')}
              </ul>
            </div>`).join('')}
        </div>
      </section>`;
  }

  function weatherHtml(w) {
    if (!w) return '';
    if (w.indoor) return `<div class="matchup-card"><div class="watch-label">Weather</div><div>Indoors${w.venue ? ` at ${esc(w.venue)}` : ''}, so weather won't be a factor.</div></div>`;
    if (w.tooEarly) return `<div class="matchup-card"><div class="watch-label">Weather</div><div class="wp-dim">Kickoff forecast shows up about two weeks before the game.</div></div>`;
    const bits = [];
    if (w.temperatureF !== null && w.temperatureF !== undefined) bits.push(`<span class="wx-temp">${esc(w.temperatureF)}&deg;F</span>`);
    if (w.conditions) bits.push(`<span>${esc(w.conditions)}</span>`);
    const extra = [];
    if (w.precipitationChance !== null && w.precipitationChance !== undefined) extra.push(`${esc(w.precipitationChance)}% chance of precipitation`);
    if (w.windMph !== null && w.windMph !== undefined) extra.push(`wind ${esc(w.windMph)} mph`);
    return `
      <div class="matchup-card">
        <div class="watch-label">Kickoff weather${w.place ? ` &middot; ${esc(w.place)}` : ''}</div>
        <div class="wx-main">${bits.join(' ')}</div>
        ${extra.length ? `<div class="wp-dim">${extra.join(' &middot; ')}</div>` : ''}
        ${w.roof === 'retractable' ? '<div class="wp-dim">Retractable roof; this is the outdoor forecast if it\'s open.</div>' : ''}
        <div class="wp-dim wp-source">${esc(w.source || '')}</div>
      </div>`;
  }

  function meetingRow(g) {
    const year = g.season || (g.date ? new Date(g.date).getFullYear() : '');
    const winner = [g.away, g.home].find((s) => s && s.winner);
    const score = (s) => (s && s.score !== null && s.score !== undefined ? esc(s.score) : '');
    const team = (s) => (s ? `<span class="${winner === s ? 'winner' : ''}">${esc(s.abbreviation || s.name || '')} ${score(s)}</span>` : '');
    return `<li><span class="wp-dim h2h-year">${esc(year)}</span>${team(g.away)} <span class="wp-dim">${g.neutralSite ? 'vs' : '@'}</span> ${team(g.home)}</li>`;
  }

  function headToHeadHtml(m) {
    if (m.headToHead) {
      const h = m.headToHead;
      return `
        <div class="matchup-card">
          <div class="watch-label">Head to head</div>
          <div class="h2h-summary"><strong>${esc(h.summary)}</strong></div>
          ${h.streak ? `<div class="wp-dim">${esc(h.streak.text)}</div>` : ''}
          ${h.meetings.length ? `<ul class="h2h-list">${h.meetings.slice(0, 10).map(meetingRow).join('')}</ul>` : ''}
          ${h.complete ? '' : '<div class="wp-dim">Some seasons couldn\'t be loaded, so this may be missing games.</div>'}
        </div>`;
    }
    if (m.seasonSeries) {
      const s = m.seasonSeries;
      return `
        <div class="matchup-card">
          <div class="watch-label">${esc(s.title)}</div>
          ${s.summary ? `<div class="h2h-summary"><strong>${esc(s.summary)}</strong></div>` : ''}
          ${s.games.length ? `<ul class="h2h-list">${s.games.filter((g) => g.status === 'post').map((g) => meetingRow({ ...g, season: g.date ? new Date(g.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '' })).join('')}</ul>` : ''}
        </div>`;
    }
    return '';
  }

  function matchupHtml(m) {
    if (!m) return '';
    const parts = [weatherHtml(m.weather), headToHeadHtml(m)].filter(Boolean);
    if (!parts.length) return '';
    return `<section><h2 class="section-title">Matchup</h2><div class="matchup-grid">${parts.join('')}</div></section>`;
  }

  return { watchHtml, winProbHtml, boxScoreHtml, injuriesHtml, recentFormHtml, matchupHtml, weatherHtml, headToHeadHtml };
})();

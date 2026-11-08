// Advanced college football stats (SP+, EPA per play, success rate,
// explosiveness, havoc) on team and game pages. Data from
// /api/team/:id/advanced and /api/game/:id/advanced (src/advanced.js),
// which need a CollegeFootballData.com key on the server.
const CFBAdvanced = (function () {
  const esc = (v) => CFB.esc(v);
  const fmt = (v, digits = 2) => (v === null || v === undefined ? '&ndash;' : esc(Number(v).toFixed(digits)));
  const pct = (v) => (v === null || v === undefined ? '&ndash;' : `${esc(Math.round(Number(v) * 1000) / 10)}%`);
  const ord = (n) => {
    if (!n) return '';
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
  };
  // Top third green, bottom third red, out of every FBS team.
  const tone = (rank, of) => (!rank || !of ? '' : rank <= of / 3 ? 'good' : rank > (2 * of) / 3 ? 'bad' : '');

  const HELP = {
    epa: 'EPA per play: points added on an average play, compared with what an average team would expect from the same down, distance and field position.',
    successRate: 'Success rate: plays that kept the offense on schedule (half the yards needed on 1st down, 70% on 2nd, all of it on 3rd and 4th).',
    explosiveness: 'Explosiveness: how much EPA the successful plays add. Big plays push it up.',
    havoc: 'Havoc: plays where the defense got a tackle for loss, a pass breakup, a fumble or an interception.',
  };

  function statRow(label, s, format, help) {
    if (!s) return '';
    return `<div class="stat-row adv-row" title="${esc(help || '')}"><span>${esc(label)}</span><span>${format(s.value)} ${s.rank ? `<span class="adv-rank ${tone(s.rank, s.of)}">${ord(s.rank)}</span>` : ''}</span></div>`;
  }

  function teamHtml(data) {
    if (!data || !data.available) {
      if (data && data.reason === 'no-key') return '<div class="empty-note adv-note">Advanced stats (SP+, EPA, success rate) appear here when the server has a free CollegeFootballData.com key in <code>CFBD_API_KEY</code>.</div>';
      return '';
    }
    const sp = data.sp;
    return `
      <section class="adv-box">
        <h3 class="section-title">Advanced stats <span class="adv-sub">${esc(data.season)} season &middot; national rank in color</span></h3>
        ${sp ? `<div class="adv-sp">
          <div><span class="adv-big">${fmt(sp.rating, 1)}</span><span class="adv-label">SP+ rating${sp.rank ? ` &middot; ${ord(sp.rank)}` : ''}</span></div>
          <div><span class="adv-big">${fmt(sp.offense, 1)}</span><span class="adv-label">Offense${sp.offenseRank ? ` &middot; ${ord(sp.offenseRank)}` : ''}</span></div>
          <div><span class="adv-big">${fmt(sp.defense, 1)}</span><span class="adv-label">Defense${sp.defenseRank ? ` &middot; ${ord(sp.defenseRank)}` : ''}</span></div>
        </div>` : ''}
        <div class="stats-grid">
          ${data.offense ? `<div class="stat-category"><h4>Offense</h4>
            ${statRow('EPA per play', data.offense.epa, fmt, HELP.epa)}
            ${statRow('Passing EPA', data.offense.passEpa, fmt, HELP.epa)}
            ${statRow('Rushing EPA', data.offense.rushEpa, fmt, HELP.epa)}
            ${statRow('Success rate', data.offense.successRate, pct, HELP.successRate)}
            ${statRow('Explosiveness', data.offense.explosiveness, fmt, HELP.explosiveness)}
          </div>` : ''}
          ${data.defense ? `<div class="stat-category"><h4>Defense (allowed)</h4>
            ${statRow('EPA per play', data.defense.epa, fmt, HELP.epa)}
            ${statRow('Success rate', data.defense.successRate, pct, HELP.successRate)}
            ${statRow('Explosiveness', data.defense.explosiveness, fmt, HELP.explosiveness)}
            ${statRow('Havoc rate', data.defense.havoc, pct, HELP.havoc)}
          </div>` : ''}
        </div>
        <p class="adv-note">Hover or long-press a stat for what it means. Garbage time is left out. Data: CollegeFootballData.com.</p>
      </section>`;
  }

  function gameHtml(data) {
    if (!data || !data.available || !data.teams || data.teams.length < 2) return '';
    const [a, b] = data.teams;
    const rows = [
      ['EPA per play', 'epa', fmt, HELP.epa],
      ['Total EPA', 'totalEpa', (v) => fmt(v, 1), HELP.epa],
      ['Passing EPA/play', 'passEpa', fmt, HELP.epa],
      ['Rushing EPA/play', 'rushEpa', fmt, HELP.epa],
      ['Success rate', 'successRate', pct, HELP.successRate],
      ['Explosiveness', 'explosiveness', fmt, HELP.explosiveness],
      ['Havoc rate', 'havoc', pct, HELP.havoc],
      ['Points per scoring chance', 'pointsPerOpportunity', fmt, 'Points per trip inside the opponent\'s 40.'],
    ].filter(([, k]) => a[k] !== undefined || b[k] !== undefined);
    const better = (k, x, y) => (x === null || y === null || x === undefined || y === undefined || x === y ? '' : x > y ? 'adv-win' : '');
    return `
      <section class="adv-box">
        <h3 class="section-title">Advanced box score</h3>
        <div class="table-wrap"><table class="data-table adv-table">
          <thead><tr><th></th><th>${esc(a.team)}</th><th>${esc(b.team)}</th></tr></thead>
          <tbody>${rows.map(([label, k, f, help]) => `<tr title="${esc(help)}"><th>${esc(label)}</th><td class="${better(k, a[k], b[k])}">${f(a[k])}</td><td class="${better(k, b[k], a[k])}">${f(b[k])}</td></tr>`).join('')}</tbody>
        </table></div>
        <p class="adv-note">Data: CollegeFootballData.com.</p>
      </section>`;
  }

  async function loadTeam(box, teamId) {
    if (!box || CFB.sport().key !== 'cfb') return;
    try {
      box.innerHTML = teamHtml(await CFB.getJson(`/api/team/${encodeURIComponent(teamId)}/advanced?sport=cfb`));
    } catch (e) { box.innerHTML = ''; }
  }

  async function loadGame(box, gameId) {
    if (!box || CFB.sport().key !== 'cfb') return;
    try {
      box.innerHTML = gameHtml(await CFB.getJson(`/api/game/${encodeURIComponent(gameId)}/advanced?sport=cfb`));
    } catch (e) { box.innerHTML = ''; }
  }

  return { teamHtml, gameHtml, loadTeam, loadGame };
})();

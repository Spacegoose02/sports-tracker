// Bowl Watch page (bowls.html): every FBS team's road to six wins, worked
// out from this season's games (src/teamstats.js bowlWatch), and the bowl
// schedule once ESPN lists it.
(function () {
  const el = CFB.el;
  const esc = CFB.esc;
  const state = { rows: [], filter: 'all', conf: '' };
  const STATUS = {
    eligible: { label: 'Bowl eligible', cls: 'ok' },
    alive: { label: 'Still alive', cls: 'maybe' },
    mustWinOut: { label: 'Must win out', cls: 'warn' },
    out: { label: 'Out', cls: 'out' },
  };

  function statusText(r) {
    if (r.status === 'eligible') return 'Bowl eligible';
    if (r.status === 'out') return 'Can’t reach 6 wins';
    if (r.status === 'mustWinOut') return `Must win out (${r.need} more)`;
    return `Needs ${r.need} more of ${r.left}`;
  }

  function render() {
    let rows = state.rows;
    if (state.filter === 'alive') rows = rows.filter((r) => r.status === 'alive' || r.status === 'mustWinOut');
    else if (state.filter !== 'all') rows = rows.filter((r) => r.status === state.filter);
    if (state.conf) rows = rows.filter((r) => r.conference === state.conf);
    el('bwBody').innerHTML = rows.length ? rows.map((r) => `
      <tr class="${CFB.follows.has(r.team.id, 'cfb') ? 'is-favorite-row' : ''}">
        <td><div class="team-cell">${r.team.logo ? `<img src="${CFB.safeUrl(r.team.logo)}" alt="" loading="lazy" onerror="this.style.display='none'">` : ''}<a class="team-link" href="/team.html?id=${encodeURIComponent(r.team.id)}&source=espn&sport=cfb">${esc(r.team.name)}</a></div></td>
        <td>${esc(r.conference || '')}</td>
        <td class="num">${esc(`${r.wins}-${r.losses}`)}</td>
        <td class="num">${esc(r.left)}</td>
        <td><span class="bw-status bw-${STATUS[r.status].cls}">${esc(statusText(r))}</span></td>
      </tr>`).join('') : '<tr><td colspan="5" class="empty-note">No teams match.</td></tr>';
  }

  async function loadSchedule() {
    try {
      const data = await CFB.getJson('/api/cfb/bowls');
      const games = (data.games || []).filter((g) => g.home && g.away);
      if (!games.length) return;
      el('bowlSchedule').innerHTML = games.map((g) => CFB.gameCardHtml({ ...g, headline: g.name, source: 'espn' }, {})).join('');
      CFB.wireGameCardClicks(el('bowlSchedule'));
      el('bowlScheduleSection').hidden = false;
    } catch (err) { /* stays hidden */ }
  }

  async function init() {
    await CFB.loadSports();
    let data;
    try {
      data = await CFB.getJson('/api/cfb/outlook');
    } catch (err) {
      el('bwBody').innerHTML = '<tr><td colspan="5" class="empty-note">Bowl watch isn’t available right now.</td></tr>';
      return;
    }
    const bowls = data.bowls || { rows: [], counts: {} };
    state.rows = bowls.rows || [];
    const c = bowls.counts || {};
    el('bwSummary').innerHTML = `
      <div class="bw-stat"><strong>${esc(c.eligible || 0)}</strong><span>bowl eligible</span></div>
      <div class="bw-stat"><strong>${esc(c.alive || 0)}</strong><span>still alive</span></div>
      <div class="bw-stat"><strong>${esc(c.out || 0)}</strong><span>out</span></div>`;
    const confs = [...new Set(state.rows.map((r) => r.conference).filter(Boolean))].sort();
    el('bwConf').insertAdjacentHTML('beforeend', confs.map((x) => `<option value="${esc(x)}">${esc(x)}</option>`).join(''));
    el('bwFilter').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
      state.filter = b.dataset.f;
      el('bwFilter').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
      render();
    }));
    el('bwConf').addEventListener('change', () => { state.conf = el('bwConf').value; render(); });
    render();
    loadSchedule();
  }

  init();
})();

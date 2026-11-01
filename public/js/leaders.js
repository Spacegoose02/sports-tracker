(function () {
  const el = CFB.el;
  const state = { meta: {}, fantasy: null, role: '', fantasyLoaded: false };

  function playerCell(athlete, team) {
    return `
      <div class="team-cell">
        ${athlete.headshot ? `<img class="headshot" src="${CFB.safeUrl(athlete.headshot)}" alt="" loading="lazy" onerror="this.style.display='none'">` : ''}
        <div>
          <a class="team-link" href="${CFB.playerLink(athlete)}">${CFB.esc(athlete.name)}</a>
          <div class="player-sub">${[athlete.position, team && (team.abbreviation || team.name)].filter(Boolean).map(CFB.esc).join(' &middot; ')}</div>
        </div>
      </div>`;
  }

  async function loadLeaders() {
    const grid = el('leadersGrid');
    try {
      const data = await CFB.getJson(CFB.withSport('/api/leaders'));
      const cats = data.categories || [];
      if (!cats.length) {
        grid.innerHTML = '<div class="empty-note">Stat leaders aren\'t available right now.</div>';
        return;
      }
      grid.innerHTML = cats.map((cat) => `
        <div class="stat-category leader-card">
          <h4>${CFB.esc(cat.label)}</h4>
          ${cat.leaders.map((l) => `
            <div class="leader-row${l.team && CFB.follows.has(l.team.id) ? ' is-favorite-row' : ''}">
              <span class="leader-rank">${CFB.esc(l.rank)}</span>
              ${playerCell(l.athlete, l.team)}
              <strong class="leader-value">${CFB.esc(l.value || '')}</strong>
            </div>`).join('')}
        </div>`).join('');
    } catch (err) {
      grid.innerHTML = '<div class="empty-note">Could not load stat leaders.</div>';
    }
  }

  // ---- Fantasy -----------------------------------------------------------

  function lineText(parts) {
    const shown = parts.filter(([v]) => v);
    return shown.length ? shown.map(([v, unit]) => `${v} ${unit}`).join(', ') : '';
  }

  function renderFantasy() {
    const body = el('fantasyBody');
    const data = state.fantasy;
    if (!data) return;
    const players = data.players.filter((p) => !state.role || p.role === state.role).slice(0, 50);
    el('fantasyNote').textContent = data.gamesTotal
      ? `${data.gamesStarted} of ${data.gamesTotal} games started${data.gamesStarted < data.gamesTotal ? ', updates as games finish' : ''}`
      : '';
    if (!players.length) {
      body.innerHTML = `<tr><td colspan="7" class="empty-note">${data.gamesStarted ? 'No players to show.' : 'No games have kicked off this week yet.'}</td></tr>`;
      return;
    }
    body.innerHTML = players.map((p, i) => {
      const l = p.line;
      return `
        <tr class="${p.team && CFB.follows.has(p.team.id) ? 'is-favorite-row' : ''}">
          <td class="rank-cell">${i + 1}</td>
          <td>${playerCell({ id: p.id, name: p.name, headshot: p.headshot, position: p.position || p.role }, p.team)}</td>
          <td>${p.gameId ? `<a class="team-link" href="${CFB.gameLink(p.gameId)}">${CFB.esc(p.opponent || 'Game')}</a>` : CFB.esc(p.opponent || '')}${p.gameState === 'in' ? ' <span class="live-dot" title="Live">&#9679;</span>' : ''}</td>
          <td><strong>${CFB.esc(p.points.toFixed(1))}</strong></td>
          <td>${CFB.esc(l.passAtt ? lineText([[l.passYds, 'yds'], [l.passTd, 'TD'], [l.int, 'INT']]) : '')}</td>
          <td>${CFB.esc(l.rushAtt ? lineText([[l.rushAtt, 'car'], [l.rushYds, 'yds'], [l.rushTd, 'TD']]) : '')}</td>
          <td>${CFB.esc(l.rec || l.targets ? lineText([[l.rec, 'rec'], [l.recYds, 'yds'], [l.recTd, 'TD']]) : '')}</td>
        </tr>`;
    }).join('');
  }

  async function loadFantasy() {
    el('fantasyBody').innerHTML = '<tr><td colspan="7" class="empty-note">Adding up box scores&hellip;</td></tr>';
    const params = new URLSearchParams({ format: el('fantasyFormat').value });
    const week = el('fantasyWeek').value;
    if (week) {
      const [seasontype, w] = week.split(':');
      params.set('seasontype', seasontype);
      params.set('week', w);
      if (state.meta.season) params.set('season', state.meta.season);
    }
    try {
      state.fantasy = await CFB.getJson(CFB.withSport(`/api/fantasy?${params.toString()}`));
      renderFantasy();
    } catch (err) {
      el('fantasyBody').innerHTML = '<tr><td colspan="7" class="empty-note">Could not load fantasy scores.</td></tr>';
    }
  }

  function initFantasy() {
    const sport = CFB.sport();
    el('fantasyTabBtn').hidden = false;
    const weeks = ['<option value="">This week</option>'];
    const current = state.meta.seasonType === 2 ? state.meta.week : (sport.maxWeek || 18);
    for (let w = (current || 1) - (state.meta.seasonType === 2 ? 1 : 0); w >= 1; w -= 1) weeks.push(`<option value="2:${w}">Week ${w}</option>`);
    el('fantasyWeek').innerHTML = weeks.join('');
    el('fantasyWeek').onchange = loadFantasy;
    el('fantasyFormat').onchange = loadFantasy;
    el('fantasyRole').querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', () => {
        el('fantasyRole').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
        state.role = btn.dataset.role;
        renderFantasy();
      });
    });
  }

  function showTab(name) {
    document.querySelectorAll('#leaderTabs .tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${name}`));
    if (name === 'fantasy' && !state.fantasyLoaded) {
      state.fantasyLoaded = true;
      loadFantasy();
    }
  }

  CFB.loadSports().then(async (sport) => {
    CFB.initSportBar();
    if (!sport.leaders) {
      el('sourceNote').textContent = sport.label;
      el('leadersGrid').innerHTML = `<div class="empty-note">${CFB.esc(sport.label)} doesn't have stat leaders here.</div>`;
      return;
    }
    state.meta = await CFB.getJson(CFB.withSport('/api/meta')).catch(() => ({}));
    el('sourceNote').textContent = [sport.label, state.meta.season].filter(Boolean).join(' · ');
    document.querySelectorAll('#leaderTabs .tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        showTab(btn.dataset.tab);
        history.replaceState(null, '', `#${btn.dataset.tab}`);
      });
    });
    if (sport.fantasy) initFantasy();
    loadLeaders();
    if (sport.fantasy && location.hash === '#fantasy') showTab('fantasy');
  });
})();

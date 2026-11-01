(function () {
  const el = CFB.el;
  const params = new URLSearchParams(location.search);
  const teamId = params.get('id');

  if (!teamId) {
    el('teamHero').innerHTML = '<div class="empty-note">No team specified.</div>';
    return;
  }

  async function load() {
    try {
      const data = await CFB.getJson(`/api/team/${encodeURIComponent(teamId)}`);
      renderHero(data);
      renderSchedule(data.schedule || []);
      renderStats(data.stats || []);
    } catch (err) {
      el('teamHero').innerHTML = '<div class="empty-note">Could not load this team.</div>';
    }
  }

  function renderHero(data) {
    const team = data.team;
    document.title = `${team ? team.name : 'Team'} · CFB Tracker`;
    el('pageTitle').textContent = team ? team.name : 'Team';
    const hero = el('teamHero');
    hero.innerHTML = `
      ${team && team.logo ? `<img class="logo" src="${team.logo}" alt="" onerror="this.style.display='none'">` : ''}
      <div>
        <div class="name">${team ? team.name : 'Unknown team'} ${data.isFavorite ? '<span class="fav-badge">My Team</span>' : ''}</div>
        <div class="meta">${team && team.record ? team.record + ' overall' : ''} ${team && team.rank ? '&middot; Rank #' + team.rank : ''} ${team && team.standingSummary ? '&middot; ' + team.standingSummary : ''}</div>
      </div>
    `;
    // Brand this page with the team's own color rather than a hardcoded
    // one, so e.g. Miami's page looks like Miami, not like whichever team
    // is pinned as the site favorite.
    CFB.applyTeamColor(hero, team && team.color);
  }

  function renderSchedule(games) {
    const list = el('teamSchedule');
    if (!games.length) {
      list.innerHTML = '<div class="empty-note">No schedule data available.</div>';
      return;
    }
    // No favoriteTeamId here on purpose — every game on this page features
    // this team, so highlighting "is-favorite" on all of them would just
    // be visual noise. The W/L badge (from gameCardHtml's completed-game
    // handling) is what actually answers "who won."
    list.innerHTML = games.map((g) => CFB.gameCardHtml(g, {})).join('');
    CFB.wireGameCardClicks(list);
  }

  function renderStats(categories) {
    const grid = el('teamStats');
    if (!categories.length) {
      grid.innerHTML = '<div class="empty-note">Season stats aren\'t available for this team yet (they usually populate after the first couple of weeks).</div>';
      return;
    }
    grid.innerHTML = categories.map((cat) => `
      <div class="stat-category">
        <h4>${cat.name}</h4>
        ${(cat.stats || []).slice(0, 8).map((s) => `<div class="stat-row"><span>${s.name}</span><span>${s.value}</span></div>`).join('')}
      </div>
    `).join('');
  }

  load();
})();

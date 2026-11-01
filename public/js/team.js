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
      const data = await CFB.getJson(CFB.withSport(`/api/team/${encodeURIComponent(teamId)}`));
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
      ${team && team.logo ? `<img class="logo" src="${CFB.safeUrl(team.logo)}" alt="" onerror="this.style.display='none'">` : ''}
      <div>
        <div class="name">${CFB.esc(team ? team.name : 'Unknown team')}</div>
        <div class="meta">${team && team.record ? CFB.esc(team.record) + ' overall' : ''} ${team && team.rank ? '&middot; Rank #' + CFB.esc(team.rank) : ''} ${team && team.standingSummary ? '&middot; ' + CFB.esc(team.standingSummary) : ''}</div>
      </div>
      ${team ? '<button type="button" class="follow-btn" id="followBtn"></button>' : ''}
    `;
    const followBtn = el('followBtn');
    if (followBtn) {
      const saved = { id: teamId, name: team.name, abbreviation: team.abbreviation, logo: team.logo };
      const paint = () => {
        const on = CFB.follows.has(teamId);
        followBtn.classList.toggle('following', on);
        followBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
        followBtn.innerHTML = on ? '&#9733; Following' : '&#9734; Follow';
      };
      followBtn.addEventListener('click', () => { CFB.follows.toggle(saved); paint(); });
      paint();
    }
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
        <h4>${CFB.esc(cat.name)}</h4>
        ${(cat.stats || []).slice(0, 8).map((s) => `<div class="stat-row"><span>${CFB.esc(s.name)}</span><span>${CFB.esc(s.value)}</span></div>`).join('')}
      </div>
    `).join('');
  }

  CFB.loadSports().then(() => {
    CFB.initSportBar();
    load();
  });
})();

(function () {
  const el = CFB.el;
  const params = new URLSearchParams(location.search);
  const teamId = params.get('id');
  const loaded = {};
  let roster = null;

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
    document.title = `${team ? team.name : 'Team'} · Stat Scraps`;
    el('pageTitle').textContent = team ? team.name : 'Team';
    const hero = el('teamHero');
    hero.innerHTML = `
      ${team && team.logo ? `<img class="logo" src="${CFB.safeUrl(team.logo)}" alt="" onerror="this.style.display='none'">` : ''}
      <div>
        <div class="name">${team && team.rank ? `<span class="rank-badge">${CFB.esc(team.rank)}</span>` : ''}${CFB.esc(team ? team.name : 'Unknown team')}</div>
        <div class="meta">${team && team.record ? CFB.esc(team.record) + ' overall' : ''} ${team && team.standingSummary ? '&middot; ' + CFB.esc(team.standingSummary) : ''}</div>
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

  function side(game) {
    if (game.home && String(game.home.id) === String(teamId)) return { us: game.home, them: game.away, where: 'home' };
    if (game.away && String(game.away.id) === String(teamId)) return { us: game.away, them: game.home, where: 'away' };
    return null;
  }

  // Record splits and scoring averages, worked out from the results so
  // they match the schedule shown below.
  function summaryHtml(games) {
    const done = games.filter((g) => g.status && g.status.completed).map((g) => ({ g, s: side(g) })).filter((x) => x.s && x.s.us && x.s.them);
    if (!done.length) return '';
    const rec = (list) => {
      const w = list.filter((x) => x.s.us.winner).length;
      const l = list.filter((x) => x.s.them.winner).length;
      return `${w}-${l}`;
    };
    const scored = done.filter((x) => x.s.us.score !== null && x.s.them.score !== null);
    const avg = (fn) => (scored.length ? (scored.reduce((a, x) => a + fn(x), 0) / scored.length).toFixed(1) : '–');
    const last5 = done.slice(-5).map((x) => (x.s.us.winner ? 'W' : x.s.them.winner ? 'L' : 'T'));
    const tiles = [
      ['Home', rec(done.filter((x) => x.s.where === 'home' && !x.g.neutralSite))],
      ['Away', rec(done.filter((x) => x.s.where === 'away' && !x.g.neutralSite))],
    ];
    if (done.some((x) => x.g.neutralSite)) tiles.push(['Neutral', rec(done.filter((x) => x.g.neutralSite))]);
    if (done.some((x) => x.g.conferenceCompetition)) tiles.push(['Conference', rec(done.filter((x) => x.g.conferenceCompetition))]);
    tiles.push(['Scored / game', avg((x) => x.s.us.score)], ['Allowed / game', avg((x) => x.s.them.score)]);
    return `
      ${tiles.map(([label, value]) => `<div class="summary-tile"><span>${CFB.esc(label)}</span><strong>${CFB.esc(value)}</strong></div>`).join('')}
      <div class="summary-tile"><span>Last ${last5.length}</span><strong>${last5.map((r) => `<span class="form-${r}">${r}</span>`).join('')}</strong></div>`;
  }

  function renderSchedule(games) {
    el('teamSummary').innerHTML = summaryHtml(games);
    const upcoming = games.filter((g) => !(g.status && g.status.completed));
    const results = games.filter((g) => g.status && g.status.completed).reverse();
    // No favoriteTeamId on purpose: every game here features this team,
    // so highlighting all of them would be noise.
    el('teamUpcoming').innerHTML = upcoming.length
      ? upcoming.map((g) => CFB.gameCardHtml(g, {})).join('')
      : '<div class="empty-note">No games left on the schedule.</div>';
    el('teamResults').innerHTML = results.length
      ? results.map((g) => CFB.gameCardHtml(g, {})).join('')
      : '<div class="empty-note">No results yet this season.</div>';
    CFB.wireGameCardClicks(el('teamUpcoming'));
    CFB.wireGameCardClicks(el('teamResults'));
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
        ${(cat.stats || []).slice(0, 12).map((s) => `<div class="stat-row"><span>${CFB.esc(s.name)}</span><span>${CFB.esc(s.value)}</span></div>`).join('')}
      </div>
    `).join('');
  }

  // ---- Roster ----------------------------------------------------------

  function rosterHtml(filter) {
    const q = (filter || '').trim().toLowerCase();
    const match = (a) => !q || [a.name, a.jersey, a.position, a.positionName, a.hometown].some((v) => v && String(v).toLowerCase().includes(q));
    const groups = roster.groups.map((g) => ({ ...g, athletes: g.athletes.filter(match) })).filter((g) => g.athletes.length);
    if (!groups.length) return '<div class="empty-note">No players match.</div>';
    const cols = [
      ['jersey', '#'], ['position', 'Pos'], ['height', 'Ht'], ['weight', 'Wt'],
      ['experience', CFB.sport().groups ? 'Class' : 'Exp'], ['age', 'Age'], ['hometown', 'Hometown'], ['college', 'College'],
    ];
    return groups.map((g) => {
      const shown = cols.filter(([key]) => g.athletes.some((a) => a[key]));
      return `
        <div class="conference-block">
          <h3>${CFB.esc(g.name)}</h3>
          <div class="table-wrap">
            <table class="data-table roster-table">
              <thead><tr><th>Player</th>${shown.map(([, label]) => `<th>${label}</th>`).join('')}</tr></thead>
              <tbody>
                ${g.athletes.map((a) => `
                  <tr>
                    <td>
                      <div class="team-cell">
                        ${a.headshot ? `<img class="headshot" src="${CFB.safeUrl(a.headshot)}" alt="" loading="lazy" onerror="this.style.display='none'">` : ''}
                        <a class="team-link" href="${CFB.playerLink(a)}">${CFB.esc(a.name)}</a>
                        ${a.injury ? `<span class="injury-tag">${CFB.esc(a.injury)}</span>` : ''}
                      </div>
                    </td>
                    ${shown.map(([key]) => `<td>${CFB.esc(a[key] || '')}</td>`).join('')}
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>
        </div>`;
    }).join('');
  }

  async function loadRoster() {
    const box = el('teamRoster');
    try {
      roster = await CFB.getJson(CFB.withSport(`/api/team/${encodeURIComponent(teamId)}/roster`));
      if (!roster.groups || !roster.groups.length) {
        box.innerHTML = '<div class="empty-note">No roster available for this team.</div>';
        return;
      }
      el('rosterCoach').textContent = roster.coach ? `Head coach: ${roster.coach}` : '';
      box.innerHTML = rosterHtml('');
      el('rosterFilter').addEventListener('input', (e) => { box.innerHTML = rosterHtml(e.target.value); });
    } catch (err) {
      box.innerHTML = '<div class="empty-note">Could not load the roster.</div>';
    }
  }

  // ---- News --------------------------------------------------------------

  async function loadNews() {
    const list = el('teamNews');
    try {
      const data = await CFB.getJson(CFB.withSport(`/api/news/teams?teams=${encodeURIComponent(teamId)}`));
      const items = data.items || [];
      if (!items.length) {
        list.innerHTML = '<div class="empty-note">No recent news for this team.</div>';
        return;
      }
      list.innerHTML = items.map((item) => `
        <a class="news-item" href="${CFB.safeUrl(item.link)}" target="_blank" rel="noopener noreferrer">
          ${CFB.safeUrl(item.image) ? `<img class="news-thumb" src="${CFB.safeUrl(item.image)}" alt="" loading="lazy">` : '<div class="news-thumb-placeholder">&#128240;</div>'}
          <div class="news-item-body">
            <div class="news-item-top">
              <span class="news-source">${CFB.esc(item.source)}</span>
              ${item.pubDate ? `<span class="news-time">${CFB.esc(new Date(item.pubDate).toLocaleDateString())}</span>` : ''}
            </div>
            <div class="news-title">${CFB.esc(item.title)}</div>
            ${item.summary ? `<div class="news-summary">${CFB.esc(item.summary)}</div>` : ''}
          </div>
        </a>`).join('');
    } catch (err) {
      list.innerHTML = '<div class="empty-note">Could not load news right now.</div>';
    }
  }

  // Roster and news load the first time their tab is opened.
  const lazy = { roster: loadRoster, news: loadNews, stats: () => { if (window.CFBAdvanced) CFBAdvanced.loadTeam(el('teamAdvanced'), teamId); } };

  function showTab(name) {
    document.querySelectorAll('#teamTabs .tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${name}`));
    if (lazy[name] && !loaded[name]) {
      loaded[name] = true;
      lazy[name]();
    }
  }

  document.querySelectorAll('#teamTabs .tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      showTab(btn.dataset.tab);
      history.replaceState(null, '', `#${btn.dataset.tab}`);
    });
  });

  CFB.loadSports().then(() => {
    CFB.initSportBar();
    // Nav "Compare" starts with this team on the left.
    const link = document.querySelector('nav.top-nav a[href^="/compare.html"]');
    if (link) link.href = CFB.withSport(`/compare.html?mode=teams&ta=${encodeURIComponent(teamId)}`);
    load();
    const fromHash = location.hash.replace('#', '');
    if (['roster', 'stats', 'news'].includes(fromHash)) showTab(fromHash);
  });
})();

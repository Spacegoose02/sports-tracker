(function () {
  const el = CFB.el;
  const playerId = new URLSearchParams(location.search).get('id');

  // No player in the URL: this page becomes a player finder, searching
  // every league (the same search as the header's search box).
  if (!playerId) {
    initFinder();
    return;
  }

  function initFinder() {
    document.title = 'Find a player · Stat Scraps';
    el('pageTitle').textContent = 'Players';
    el('sourceNote').textContent = 'Search any player in any league';
    const tabs = el('playerTabs');
    if (tabs) tabs.hidden = true;
    document.querySelectorAll('.tab-panel').forEach((p) => { p.hidden = true; });
    el('playerHero').classList.remove('team-hero');
    el('playerHero').innerHTML = `
      <form class="player-finder" role="search" onsubmit="return false">
        <label for="playerQuery" class="sr-only">Player name</label>
        <input id="playerQuery" type="search" placeholder="Search players, e.g. Arch Manning" autocomplete="off" autofocus />
      </form>
      <div id="playerResults" class="player-results" aria-live="polite"><div class="empty-note">Type at least two letters. You can also browse <a href="${CFB.withSport('/leaders.html')}">stat leaders</a> or a team's roster.</div></div>`;
    let timer = null;
    let seq = 0;
    const input = el('playerQuery');
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const q = input.value.trim();
        const mine = ++seq;
        if (q.length < 2) return;
        el('playerResults').innerHTML = '<div class="empty-note">Searching&hellip;</div>';
        try {
          const res = await CFB.getJson(`/api/search?q=${encodeURIComponent(q)}`);
          if (mine !== seq) return;
          const players = res.players || [];
          el('playerResults').innerHTML = players.length
            ? players.map((p) => `
              <a class="player-result" href="/player.html?id=${encodeURIComponent(p.id)}&sport=${encodeURIComponent(p.sport || 'cfb')}">
                ${p.headshot ? `<img src="${CFB.safeUrl(p.headshot)}" alt="" loading="lazy" onerror="this.style.display='none'">` : '<span class="pr-blank" aria-hidden="true"></span>'}
                <span><strong>${CFB.esc(p.name)}</strong><span class="pr-sub">${CFB.esc([String(p.sport || '').toUpperCase(), p.team].filter(Boolean).join(' · '))}</span></span>
              </a>`).join('')
            : '<div class="empty-note">No players found.</div>';
        } catch (err) {
          if (mine === seq) el('playerResults').innerHTML = '<div class="empty-note">Search isn\'t working right now.</div>';
        }
      }, 250);
    });
    CFB.loadSports().then(() => CFB.initSportBar());
  }

  function statTable(labels, rows, firstCols) {
    return `
      <div class="table-wrap">
        <table class="data-table stat-table">
          <thead><tr>${firstCols.map((c) => `<th>${CFB.esc(c)}</th>`).join('')}${labels.map((l) => `<th>${CFB.esc(l)}</th>`).join('')}</tr></thead>
          <tbody>${rows.join('')}</tbody>
        </table>
      </div>`;
  }

  function renderHero(p) {
    document.title = `${p.name || 'Player'} · Stat Scraps`;
    el('pageTitle').textContent = p.name || 'Player';
    el('sourceNote').textContent = [p.position, p.team && p.team.name].filter(Boolean).join(' · ') || CFB.sport().label;
    const hero = el('playerHero');
    hero.innerHTML = `
      ${p.headshot ? `<img class="logo headshot-lg" src="${CFB.safeUrl(p.headshot)}" alt="" onerror="this.style.display='none'">` : ''}
      <div>
        <div class="name">${p.jersey ? `<span class="jersey">#${CFB.esc(p.jersey)}</span> ` : ''}${CFB.esc(p.name || 'Unknown player')}</div>
        <div class="meta">
          ${CFB.esc(p.position || '')}
          ${p.team ? ` &middot; <a class="team-link" href="${CFB.teamLink(p.team)}">${CFB.esc(p.team.name)}</a>` : ''}
          ${p.status && !/active/i.test(p.status) ? ` &middot; ${CFB.esc(p.status)}` : ''}
        </div>
      </div>
      ${p.team && p.team.logo ? `<img class="logo" src="${CFB.safeUrl(p.team.logo)}" alt="" onerror="this.style.display='none'">` : ''}`;
    CFB.applyTeamColor(hero, p.team && p.team.color);
  }

  function renderBio(p) {
    const rows = [
      ['Height', p.height], ['Weight', p.weight], ['Age', p.age], ['Born', p.birthDate],
      ['Birthplace', p.birthPlace], [CFB.sport().groups ? 'Class' : 'Experience', p.experience],
      ['College', p.college], ['Draft', p.draft],
    ].filter(([, v]) => v);
    el('playerBio').innerHTML = rows.length
      ? `<div class="stat-category"><h4>Bio</h4>${rows.map(([k, v]) => `<div class="stat-row"><span>${CFB.esc(k)}</span><span>${CFB.esc(v)}</span></div>`).join('')}</div>`
      : '<div class="empty-note">No bio details available.</div>';
  }

  function renderGameLog(log) {
    const box = el('playerGameLog');
    if (!log || !log.games || !log.games.length) {
      box.innerHTML = '<div class="empty-note">No games logged this season yet.</div>';
      return;
    }
    const rows = log.games.map((g) => `
      <tr>
        <td>${g.date ? CFB.esc(new Date(g.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })) : ''}</td>
        <td>${CFB.esc(g.atVs || '')} ${g.opponent ? `<a class="team-link" href="${CFB.teamLink(g.opponent)}">${CFB.esc(g.opponent.abbreviation || g.opponent.name)}</a>` : ''}</td>
        <td>${g.eventId ? `<a class="team-link result-${CFB.esc(g.result || '')}" href="${CFB.gameLink(g.eventId)}">${CFB.esc(g.result || '')} ${CFB.esc(g.score || '')}</a>` : CFB.esc(g.score || '')}</td>
        ${g.stats.map((s) => `<td>${CFB.esc(s)}</td>`).join('')}
      </tr>`);
    box.innerHTML = statTable(log.labels, rows, ['Date', 'Opp', 'Result']);
  }

  function renderCareer(categories) {
    const box = el('playerCareer');
    if (!categories || !categories.length) {
      box.innerHTML = '<div class="empty-note">No season stats available.</div>';
      return;
    }
    box.innerHTML = categories.map((cat) => {
      const rows = cat.rows.slice().reverse().map((r) => `
        <tr><td>${CFB.esc(r.season || '')}</td><td>${CFB.esc(r.team || '')}</td>${r.stats.map((s) => `<td>${CFB.esc(s)}</td>`).join('')}</tr>`);
      if (cat.totals && cat.totals.length) {
        rows.push(`<tr class="totals-row"><td>Career</td><td></td>${cat.totals.map((s) => `<td>${CFB.esc(s)}</td>`).join('')}</tr>`);
      }
      return `<div class="conference-block"><h3>${CFB.esc(cat.name)}</h3>${statTable(cat.labels, rows, ['Season', 'Team'])}</div>`;
    }).join('');
  }

  function initTabs() {
    document.querySelectorAll('#playerTabs .tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#playerTabs .tab-btn').forEach((b) => b.classList.toggle('active', b === btn));
        document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${btn.dataset.tab}`));
      });
    });
  }

  CFB.loadSports().then(async () => {
    CFB.initSportBar();
    initTabs();
    try {
      const data = await CFB.getJson(CFB.withSport(`/api/player/${encodeURIComponent(playerId)}`));
      renderHero(data.player || {});
      // Nav "Compare" starts with this player on the left.
      const p = data.player || {};
      const link = document.querySelector('nav.top-nav a[href^="/compare.html"]');
      if (link && p.id) link.href = CFB.withSport(`/compare.html?mode=players&a=${encodeURIComponent(p.id)}${p.team ? `&ta=${encodeURIComponent(p.team.id)}` : ''}`);
      renderBio(data.player || {});
      renderGameLog(data.gameLog);
      renderCareer(data.careerStats);
    } catch (err) {
      el('playerHero').innerHTML = '<div class="empty-note">Could not load this player.</div>';
      ['playerGameLog', 'playerCareer', 'playerBio'].forEach((id) => { el(id).innerHTML = ''; });
    }
  });
})();

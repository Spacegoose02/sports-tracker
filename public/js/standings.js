(function () {
  const el = CFB.el;

  // Columns shown when at least one team in the group has a value. College
  // standings carry conference records; pro standings carry win % and
  // games back (NHL: points).
  const COLUMNS = [
    { key: 'conference', label: 'Conf' },
    { key: 'overall', label: 'Overall' },
    { key: 'winPercent', label: 'Pct' },
    { key: 'gamesBehind', label: 'GB' },
    { key: 'points', label: 'Pts' },
    { key: 'home', label: 'Home' },
    { key: 'road', label: 'Away' },
    { key: 'pointsFor', label: 'PF' },
    { key: 'pointsAgainst', label: 'PA' },
    { key: 'differential', label: 'Diff' },
    { key: 'streak', label: 'Streak' },
  ];

  // Team id -> AP rank (college sports), shown as a small number before
  // the team name the way TV graphics do.
  let apRanks = {};

  async function loadApRanks() {
    if (!CFB.sport().rankings) return;
    try {
      const data = await CFB.getJson(CFB.withSport('/api/rankings'));
      const ap = (data.polls || []).find((p) => /\bap\b/i.test(`${p.shortName || ''} ${p.name || ''}`)) || (data.polls || [])[0];
      apRanks = {};
      ((ap && ap.ranks) || []).forEach((r) => { if (r.team) apRanks[r.team.id] = r.rank; });
    } catch (err) { /* standings still render without ranks */ }
  }

  function conferenceHtml(conf, favoriteTeamId) {
    if (!conf.entries || !conf.entries.length) return '';
    // Soccer tables: games played up front, goals instead of points for and
    // against, and sorted by points the way every league table is.
    const soccer = CFB.sport().kind === 'soccer';
    const SOCCER_LABELS = { overall: 'W-L-D', pointsFor: 'GF', pointsAgainst: 'GA', differential: 'GD' };
    const columns = (soccer ? [{ key: 'played', label: 'GP' }, ...COLUMNS] : COLUMNS)
      .filter((c) => conf.entries.some((e) => e[c.key]))
      .map((c) => (soccer && SOCCER_LABELS[c.key] ? { ...c, label: SOCCER_LABELS[c.key] } : c));
    if (soccer) {
      const num = (v) => Number(String(v || '').replace('+', '')) || 0;
      conf = { ...conf, entries: conf.entries.slice().sort((a, b) => num(b.points) - num(a.points) || num(b.differential) - num(a.differential)) };
    }
    return `
      <div class="conference-block">
        <h3>${CFB.esc(conf.name)}</h3>
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>Team</th>
                ${columns.map((c) => `<th>${c.label}</th>`).join('')}
              </tr>
            </thead>
            <tbody>
              ${conf.entries.map((e) => {
                const isFav = e.team && (String(e.team.id) === String(favoriteTeamId) || CFB.follows.has(e.team.id));
                return `
                  <tr class="${isFav ? 'is-favorite-row' : ''}">
                    <td>
                      <div class="team-cell">
                        ${e.team && e.team.logo ? `<img src="${CFB.safeUrl(e.team.logo)}" alt="" onerror="this.style.display='none'">` : ''}
                        ${e.team && apRanks[e.team.id] ? `<span class="rank-badge">${CFB.esc(apRanks[e.team.id])}</span>` : ''}
                        ${e.team ? `<a class="team-link" href="${CFB.teamLink(e.team)}">${CFB.esc(e.team.name)}</a>` : 'TBD'}
                        ${e.clincher ? `<span class="clincher" title="Clinched">${CFB.esc(e.clincher)}</span>` : ''}
                      </div>
                    </td>
                    ${columns.map((c) => `<td>${CFB.esc(e[c.key] || '')}</td>`).join('')}
                  </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>`;
  }

  let cachedMeta = null;

  async function load(group) {
    const sport = CFB.sport();
    const container = el('standingsContainer');
    container.innerHTML = '<div class="empty-note">Loading&hellip;</div>';
    try {
      if (!cachedMeta) {
        cachedMeta = await CFB.getJson(CFB.withSport('/api/meta')).catch(() => ({}));
      }
      el('sourceNote').textContent = sport.key === 'cfb' && cachedMeta.season
        ? `${sport.label} · ${cachedMeta.season} season`
        : sport.label;

      const params = new URLSearchParams();
      // College football standings need an explicit season; the other
      // leagues return the current season when none is given.
      if (sport.key === 'cfb' && cachedMeta.season) params.set('year', cachedMeta.season);
      if (group) params.set('group', group);
      const query = params.toString();
      const [data] = await Promise.all([
        CFB.getJson(CFB.withSport(`/api/standings${query ? `?${query}` : ''}`)),
        loadApRanks(),
      ]);
      const conferences = (data.conferences || []).filter((c) => c.entries && c.entries.length);
      if (!conferences.length) {
        container.innerHTML = '<div class="empty-note">Standings aren\'t available right now.</div>';
        return;
      }
      container.innerHTML = conferences.map((c) => conferenceHtml(c, cachedMeta.favoriteTeamId)).join('');
    } catch (err) {
      container.innerHTML = '<div class="empty-note">Could not load standings.</div>';
    }
  }

  CFB.loadSports().then((sport) => {
    CFB.initSportBar();
    if (sport.standings === false) {
      el('sourceNote').textContent = sport.label;
      el('standingsContainer').innerHTML = `<div class="empty-note">${CFB.esc(sport.label)} doesn't have standings. See the schedule for upcoming events and results.</div>`;
      return;
    }
    CFB.initDivisionToggle((group) => load(group));
  });
})();

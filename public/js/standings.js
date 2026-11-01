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
    { key: 'streak', label: 'Streak' },
  ];

  function conferenceHtml(conf, favoriteTeamId) {
    if (!conf.entries || !conf.entries.length) return '';
    const columns = COLUMNS.filter((c) => conf.entries.some((e) => e[c.key]));
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
                const isFav = e.team && String(e.team.id) === String(favoriteTeamId);
                return `
                  <tr class="${isFav ? 'is-favorite-row' : ''}">
                    <td>
                      <div class="team-cell">
                        ${e.team && e.team.logo ? `<img src="${CFB.safeUrl(e.team.logo)}" alt="" onerror="this.style.display='none'">` : ''}
                        ${e.team ? `<a class="team-link" href="${CFB.teamLink(e.team)}">${CFB.esc(e.team.name)}</a>` : 'TBD'}
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
      const data = await CFB.getJson(CFB.withSport(`/api/standings${query ? `?${query}` : ''}`));
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

  CFB.loadSports().then(() => {
    CFB.initSportBar();
    CFB.initDivisionToggle((group) => load(group));
  });
})();

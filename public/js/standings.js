(function () {
  const el = CFB.el;

  function conferenceHtml(conf, favoriteTeamId) {
    if (!conf.entries || !conf.entries.length) return '';
    return `
      <div class="conference-block">
        <h3>${conf.name}</h3>
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>Team</th>
                <th>Conference</th>
                <th>Overall</th>
                <th>Streak</th>
              </tr>
            </thead>
            <tbody>
              ${conf.entries.map((e) => {
                const isFav = e.team && String(e.team.id) === String(favoriteTeamId);
                return `
                  <tr class="${isFav ? 'is-favorite-row' : ''}">
                    <td>
                      <div class="team-cell">
                        ${e.team && e.team.logo ? `<img src="${e.team.logo}" alt="" onerror="this.style.display='none'">` : ''}
                        ${e.team ? `<a class="team-link" href="${CFB.teamLink(e.team)}">${e.team.name}</a>` : 'TBD'}
                      </div>
                    </td>
                    <td>${e.conference || ''}</td>
                    <td>${e.overall || ''}</td>
                    <td>${e.streak || ''}</td>
                  </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>`;
  }

  let cachedMeta = null;

  async function load(division) {
    const container = el('standingsContainer');
    container.innerHTML = '<div class="empty-note">Loading&hellip;</div>';
    try {
      if (!cachedMeta) {
        cachedMeta = await CFB.getJson('/api/meta');
      }
      el('sourceNote').textContent = `${cachedMeta.season} season`;

      const group = division === 'fcs' ? 81 : 80;
      const data = await CFB.getJson(`/api/standings?year=${cachedMeta.season}&group=${group}`);
      const conferences = (data.conferences || []).filter((c) => c.entries && c.entries.length);
      if (!conferences.length) {
        const divisionLabel = division === 'fcs' ? 'FCS' : 'FBS';
        container.innerHTML = `<div class="empty-note">${divisionLabel} standings aren't available right now.</div>`;
        return;
      }
      container.innerHTML = conferences.map((c) => conferenceHtml(c, cachedMeta.favoriteTeamId)).join('');
    } catch (err) {
      container.innerHTML = '<div class="empty-note">Could not load standings.</div>';
    }
  }

  CFB.initDivisionToggle((division) => load(division));
})();

// Conference race page (/race.html): every FBS conference's title-game race.
(function () {
  const el = CFB.el;
  const esc = CFB.esc;
  const STATUS = {
    clinched: 'Clinched',
    control: 'Controls destiny',
    tiebreak: 'Needs tiebreakers',
    help: 'Needs help',
    out: 'Out',
  };
  let group = 80;

  function teamCell(t) {
    return `
      ${t.team.logo ? `<img src="${CFB.safeUrl(t.team.logo)}" alt="" loading="lazy" onerror="this.style.display='none'">` : '<span class="race-logo-gap"></span>'}
      <a class="team-link" href="${CFB.teamLink(t.team)}">${esc(t.team.shortName || t.team.name)}</a>`;
  }

  function leftHtml(t) {
    if (!t.left.length) return '<span class="race-dim">Done</span>';
    return t.left.map((g) => g.opponent
      ? `<span class="race-opp" title="${esc(g.opponent.name)}">${g.home ? 'vs' : '@'} ${esc(g.opponent.abbreviation || g.opponent.name)}</span>`
      : '').join('');
  }

  function raceHtml(r, followed) {
    const contenders = r.teams.filter((t) => t.status !== 'out').length;
    return `
      <section class="race-card">
        <header class="race-head">
          <h2>${esc(r.name)}</h2>
          <span class="race-dim">${contenders} alive for ${r.spots === 1 ? 'the division title' : '2 title game spots'}</span>
        </header>
        <div class="race-table-wrap">
        <table class="race-table">
          <thead><tr><th scope="col">Team</th><th scope="col">Conf</th><th scope="col">GB</th><th scope="col">Status</th><th scope="col">Conference games left</th></tr></thead>
          <tbody>
            ${r.teams.map((t, i) => `
              <tr class="race-${esc(t.status)} ${followed.has(String(t.team.id)) ? 'is-followed' : ''} ${i === r.spots - 1 ? 'race-cutline' : ''}">
                <td class="race-team"><span class="race-team-inner">${teamCell(t)}</span></td>
                <td class="race-num">${esc(t.conference)}</td>
                <td class="race-num">${t.behind ? esc(t.behind) : '&ndash;'}</td>
                <td><span class="race-chip race-${esc(t.status)}">${esc(STATUS[t.status] || t.status)}</span></td>
                <td class="race-left"><span class="race-left-inner">${leftHtml(t)}</span></td>
              </tr>`).join('')}
          </tbody>
        </table>
        </div>
      </section>`;
  }

  async function load() {
    const list = el('raceList');
    try {
      const data = await CFB.getJson(`/api/race?sport=cfb&group=${group}`);
      const races = data.races || [];
      el('sourceNote').textContent = `College Football · ${data.season || ''}${data.week ? ` · after Week ${Math.max(0, data.week - 1)}` : ''}`;
      if (!races.length) {
        list.innerHTML = '<div class="empty-note">No conference standings yet.</div>';
        return;
      }
      const followed = CFB.follows.ids('cfb');
      // Conferences with a team you follow first.
      const mine = (r) => r.teams.some((t) => followed.has(String(t.team.id)));
      races.sort((a, b) => mine(b) - mine(a));
      list.innerHTML = races.map((r) => raceHtml(r, followed)).join('');
      el('raceNote').textContent = data.postseason ? 'Regular season is over: these are the final races.' : '';
    } catch (err) {
      list.innerHTML = '<div class="empty-note">Could not load the conference races right now.</div>';
    }
  }

  CFB.loadSports().then(() => {
    CFB.initSportBar();
    CFB.initDivisionToggle((value) => { group = value || 80; load(); });
  });
})();

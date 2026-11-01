(function () {
  const el = CFB.el;
  const state = { season: null, week: null, seasonType: 2, division: 'fbs', games: [] };

  function populateSelectors(meta) {
    const seasonSelect = el('seasonSelect');
    const weekSelect = el('weekSelect');
    const seasonTypeSelect = el('seasonTypeSelect');

    const currentYear = meta.season || new Date().getFullYear();
    seasonSelect.innerHTML = '';
    for (let y = currentYear; y >= currentYear - 2; y--) {
      const opt = document.createElement('option');
      opt.value = y;
      opt.textContent = y;
      seasonSelect.appendChild(opt);
    }
    seasonSelect.value = currentYear;

    weekSelect.innerHTML = '';
    for (let w = 1; w <= 15; w++) {
      const opt = document.createElement('option');
      opt.value = w;
      opt.textContent = `Week ${w}`;
      weekSelect.appendChild(opt);
    }
    weekSelect.value = meta.week || 1;

    seasonTypeSelect.value = String(meta.seasonType || 2);
  }

  // Same day-grouped "calendar" the home page used to show inline, now with
  // each game's channel alongside the kickoff time so a full week's slate
  // is easy to scan/sort by broadcast at a glance.
  function renderUpcoming() {
    const strip = el('upcomingStrip');
    const upcoming = state.games
      .filter((g) => g.status && g.status.state === 'pre' && g.date)
      .sort((a, b) => new Date(a.date) - new Date(b.date));
    if (!upcoming.length) {
      strip.innerHTML = '<div class="empty-note">No upcoming games left for this week.</div>';
      return;
    }
    const groups = [];
    const byDay = new Map();
    upcoming.forEach((g) => {
      const d = new Date(g.date);
      const dayKey = d.toDateString();
      if (!byDay.has(dayKey)) {
        const group = { label: d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }), games: [] };
        byDay.set(dayKey, group);
        groups.push(group);
      }
      byDay.get(dayKey).games.push(g);
    });
    strip.innerHTML = groups.map((group) => `
      <div class="upcoming-day">
        <div class="upcoming-day-label">${group.label}</div>
        ${group.games.map((g) => `
          <div class="upcoming-game" data-id="${g.id}" data-source="${g.source || 'espn'}">
            <div class="upcoming-game-top">
              <span class="time">${new Date(g.date).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</span>
              ${g.broadcast ? `<span class="channel">${g.broadcast}</span>` : ''}
            </div>
            <div class="matchup">${g.away ? (g.away.abbreviation || g.away.shortName || 'TBD') : 'TBD'} @ ${g.home ? (g.home.abbreviation || g.home.shortName || 'TBD') : 'TBD'}</div>
          </div>`).join('')}
      </div>`).join('');
    strip.querySelectorAll('.upcoming-game').forEach((row) => {
      row.addEventListener('click', () => {
        location.href = CFB.gameLink(row.dataset.id, row.dataset.source);
      });
    });
  }

  async function loadWeek() {
    state.season = Number(el('seasonSelect').value);
    state.week = Number(el('weekSelect').value);
    state.seasonType = Number(el('seasonTypeSelect').value);

    el('upcomingStrip').innerHTML = '<div class="empty-note">Loading&hellip;</div>';

    const groups = state.division === 'fcs' ? 81 : 80;
    try {
      const scoreboard = await CFB.getJson(`/api/scoreboard?year=${state.season}&week=${state.week}&seasontype=${state.seasonType}&groups=${groups}`);
      state.games = scoreboard.games || [];
      el('sourceNote').textContent = `${scoreboard.season} · Week ${scoreboard.week}`;
      renderUpcoming();
    } catch (err) {
      el('upcomingStrip').innerHTML = '<div class="empty-note">Could not load the schedule.</div>';
    }
  }

  async function init() {
    try {
      const meta = await CFB.getJson('/api/meta');
      populateSelectors(meta);
      el('sourceNote').textContent = `${meta.season} · Week ${meta.week}`;
    } catch (err) {
      populateSelectors({ season: new Date().getFullYear(), week: 1, seasonType: 2 });
    }
    el('goBtn').addEventListener('click', loadWeek);
    CFB.initDivisionToggle((division) => {
      state.division = division;
      loadWeek();
    });
  }

  init();
})();

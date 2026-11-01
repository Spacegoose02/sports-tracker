(function () {
  const el = CFB.el;
  const state = { season: null, week: null, seasonType: 2, group: null, games: [] };

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
    const sport = CFB.sport();
    for (let w = 1; w <= (sport.maxWeek || 15); w++) {
      const opt = document.createElement('option');
      opt.value = w;
      opt.textContent = `Week ${w}`;
      weekSelect.appendChild(opt);
    }
    weekSelect.value = meta.week || 1;

    if (sport.seasonTypes) {
      seasonTypeSelect.innerHTML = '';
      sport.seasonTypes.forEach((t) => {
        const opt = document.createElement('option');
        opt.value = t.value;
        opt.textContent = t.label;
        seasonTypeSelect.appendChild(opt);
      });
    }
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
      strip.innerHTML = `<div class="empty-note">No upcoming games left for this ${CFB.sport().schedule === 'day' ? 'stretch' : 'week'}.</div>`;
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
          <div class="upcoming-game" data-id="${CFB.esc(g.id)}" data-source="${CFB.esc(g.source || 'espn')}">
            <div class="upcoming-game-top">
              <span class="time">${new Date(g.date).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</span>
              ${g.broadcast ? `<span class="channel">${CFB.esc(g.broadcast)}</span>` : ''}
            </div>
            <div class="matchup">${CFB.esc(g.away ? (g.away.abbreviation || g.away.shortName || 'TBD') : 'TBD')} @ ${CFB.esc(g.home ? (g.home.abbreviation || g.home.shortName || 'TBD') : 'TBD')}</div>
          </div>`).join('')}
      </div>`).join('');
    strip.querySelectorAll('.upcoming-game').forEach((row) => {
      row.addEventListener('click', () => {
        location.href = CFB.gameLink(row.dataset.id, row.dataset.source);
      });
    });
  }

  async function loadWeek() {
    const sport = CFB.sport();
    state.season = Number(el('seasonSelect').value);
    state.week = Number(el('weekSelect').value);
    state.seasonType = Number(el('seasonTypeSelect').value);

    el('upcomingStrip').innerHTML = '<div class="empty-note">Loading&hellip;</div>';

    const params = new URLSearchParams();
    if (sport.schedule === 'day') {
      // Daily sports: the next seven days.
      const start = new Date();
      const end = new Date();
      end.setDate(end.getDate() + 6);
      params.set('dates', `${CFB.ymd(start)}-${CFB.ymd(end)}`);
    } else {
      params.set('year', state.season);
      params.set('week', state.week);
      params.set('seasontype', state.seasonType);
    }
    if (state.group) params.set('groups', state.group);
    try {
      const scoreboard = await CFB.getJson(CFB.withSport(`/api/scoreboard?${params.toString()}`));
      state.games = scoreboard.games || [];
      el('sourceNote').textContent = sport.schedule === 'day'
        ? `${sport.label} · Next 7 days`
        : `${sport.label} · ${scoreboard.season} · Week ${scoreboard.week}`;
      renderUpcoming();
    } catch (err) {
      el('upcomingStrip').innerHTML = '<div class="empty-note">Could not load the schedule.</div>';
    }
  }

  async function init() {
    const sport = await CFB.loadSports();
    CFB.initSportBar();
    if (sport.schedule === 'day') {
      el('weekControls').hidden = true;
    } else {
      try {
        const meta = await CFB.getJson(CFB.withSport('/api/meta'));
        populateSelectors(meta);
        el('sourceNote').textContent = `${sport.label} · ${meta.season} · Week ${meta.week}`;
      } catch (err) {
        populateSelectors({ season: new Date().getFullYear(), week: 1, seasonType: 2 });
      }
      el('goBtn').addEventListener('click', loadWeek);
    }
    CFB.initDivisionToggle((group) => {
      state.group = group;
      loadWeek();
    });
  }

  init();
})();

(function () {
  const state = { season: null, week: null, seasonType: 2, games: [], picked: [] };
  const el = (id) => document.getElementById(id);
  // admin.html doesn't load shared.js, so it keeps its own escaper.
  const esc = (value) => (value === null || value === undefined ? '' : String(value))
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  async function getJson(url, opts) {
    const res = await fetch(url, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts));
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Request failed: ${res.status}`);
    }
    return res.json();
  }

  function statusLabel(game) {
    if (!game.status) return '';
    if (game.status.state === 'in') return game.status.shortDetail || `Q${game.status.period} ${game.status.clock}`;
    if (game.status.state === 'post') return 'Final';
    return new Date(game.date).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  async function checkLogin() {
    const status = await getJson('/api/admin/status');
    if (status.loggedIn) {
      el('loginBox').style.display = 'none';
      el('adminPanel').style.display = 'block';
      await initPanel();
    }
  }

  el('loginBtn').addEventListener('click', async () => {
    el('loginError').textContent = '';
    try {
      await getJson('/api/admin/login', { method: 'POST', body: JSON.stringify({ password: el('passwordInput').value }) });
      el('loginBox').style.display = 'none';
      el('adminPanel').style.display = 'block';
      await initPanel();
    } catch (err) {
      el('loginError').textContent = err.message === 'Incorrect password' ? 'Incorrect password.' : err.message;
    }
  });
  el('passwordInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') el('loginBtn').click();
  });

  el('logoutBtn').addEventListener('click', async () => {
    await getJson('/api/admin/logout', { method: 'POST' });
    location.reload();
  });

  function populateSelectors(meta) {
    const seasonSelect = el('seasonSelect');
    const weekSelect = el('weekSelect');
    const seasonTypeSelect = el('seasonTypeSelect');
    const currentYear = meta.season || new Date().getFullYear();

    seasonSelect.innerHTML = '';
    for (let y = currentYear; y >= currentYear - 2; y--) {
      const opt = document.createElement('option');
      opt.value = y; opt.textContent = y;
      seasonSelect.appendChild(opt);
    }
    seasonSelect.value = currentYear;

    weekSelect.innerHTML = '';
    for (let w = 1; w <= 15; w++) {
      const opt = document.createElement('option');
      opt.value = w; opt.textContent = `Week ${w}`;
      weekSelect.appendChild(opt);
    }
    weekSelect.value = meta.week || 1;
    seasonTypeSelect.value = String(meta.seasonType || 2);
  }

  async function initPanel() {
    let meta;
    try {
      meta = await getJson('/api/meta');
    } catch (err) {
      meta = { season: new Date().getFullYear(), week: 1, seasonType: 2 };
    }
    populateSelectors(meta);
    el('loadBtn').addEventListener('click', loadWeek);
    loadWeek();
  }

  async function loadWeek() {
    state.season = Number(el('seasonSelect').value);
    state.week = Number(el('weekSelect').value);
    state.seasonType = Number(el('seasonTypeSelect').value);

    el('allGamesList').innerHTML = 'Loading&hellip;';
    el('pickedList').innerHTML = 'Loading&hellip;';

    const [scoreboard, picked] = await Promise.all([
      getJson(`/api/scoreboard?year=${state.season}&week=${state.week}&seasontype=${state.seasonType}`),
      getJson(`/api/admin/notable?season=${state.season}&week=${state.week}`),
    ]);
    state.games = scoreboard.games || [];
    state.picked = picked || [];
    renderPicked();
    renderAllGames();
  }

  function renderPicked() {
    const list = el('pickedList');
    if (!state.picked.length) {
      list.innerHTML = '<div class="empty-note">No notable games picked yet for this week.</div>';
      return;
    }
    list.innerHTML = state.picked.map((row) => {
      const game = state.games.find((g) => String(g.id) === String(row.event_id));
      const title = game ? (game.shortName || game.name) : (row.game_name || row.event_id);
      return `
        <div class="admin-game-row picked" data-row-id="${esc(row.id)}">
          <span class="matchup">${esc(title)}</span>
          <input class="note-input" placeholder="Optional note (e.g. 'ACC opener')" value="${esc(row.label || '')}" />
          <button class="save">Save note</button>
          <button class="remove">Remove</button>
        </div>`;
    }).join('');

    list.querySelectorAll('.admin-game-row').forEach((row) => {
      const rowId = row.dataset.rowId;
      row.querySelector('.remove').addEventListener('click', async () => {
        await getJson(`/api/admin/notable/${rowId}`, { method: 'DELETE' });
        await loadWeek();
      });
      row.querySelector('.save').addEventListener('click', async () => {
        const pickedRow = state.picked.find((r) => String(r.id) === String(rowId));
        await getJson('/api/admin/notable', {
          method: 'POST',
          body: JSON.stringify({
            season: state.season,
            week: state.week,
            eventId: pickedRow.event_id,
            source: pickedRow.source,
            label: row.querySelector('.note-input').value,
            gameName: pickedRow.game_name,
            sortOrder: pickedRow.sort_order,
          }),
        });
        await loadWeek();
      });
    });
  }

  function renderAllGames() {
    const list = el('allGamesList');
    if (!state.games.length) {
      list.innerHTML = '<div class="empty-note">No games found for this week.</div>';
      return;
    }
    const pickedIds = new Set(state.picked.map((r) => String(r.event_id)));
    list.innerHTML = state.games.map((game) => {
      const isPicked = pickedIds.has(String(game.id));
      const title = `${game.away ? game.away.shortName : 'TBD'} @ ${game.home ? game.home.shortName : 'TBD'}`;
      return `
        <div class="admin-game-row ${isPicked ? 'picked' : ''}" data-id="${esc(game.id)}" data-source="${esc(game.source || 'espn')}">
          <span class="matchup">${esc(title)} &middot; ${esc(statusLabel(game))}</span>
          <button class="${isPicked ? 'remove' : 'add'}">${isPicked ? 'Remove notable' : 'Mark notable'}</button>
        </div>`;
    }).join('');

    list.querySelectorAll('.admin-game-row').forEach((row) => {
      const btn = row.querySelector('button');
      btn.addEventListener('click', async () => {
        const gameId = row.dataset.id;
        const source = row.dataset.source;
        const game = state.games.find((g) => String(g.id) === String(gameId));
        const alreadyPicked = state.picked.find((r) => String(r.event_id) === String(gameId));
        if (alreadyPicked) {
          await getJson(`/api/admin/notable/${alreadyPicked.id}`, { method: 'DELETE' });
        } else {
          await getJson('/api/admin/notable', {
            method: 'POST',
            body: JSON.stringify({
              season: state.season,
              week: state.week,
              eventId: gameId,
              source,
              gameName: game ? (game.shortName || game.name) : null,
              sortOrder: state.picked.length,
            }),
          });
        }
        await loadWeek();
      });
    });
  }

  checkLogin();
})();

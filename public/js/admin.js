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

  el('bbRecheck').addEventListener('click', bbCheck);

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

  // Whether "Watch on BingeBandit" links work, and if not, which setup step
  // is missing (src/bingebandit.js checkBingeBandit).
  async function bbCheck() {
    const box = el('bbStatus');
    box.className = 'bb-status';
    box.textContent = 'Checking\u2026';
    try {
      const s = await getJson('/api/bingebandit/status');
      box.classList.add(s.ok ? 'bb-status-ok' : 'bb-status-bad');
      const links = (s.links || []).map((l) => `<li>${esc(l.network)} &rarr; ${l.channel && l.channel.number != null ? `channel ${esc(l.channel.number)} ` : ''}${esc(l.channel && l.channel.name)}</li>`).join('');
      box.innerHTML = `<strong>${s.ok ? 'Working' : 'Not working yet'}</strong>${s.version ? ` <span class="bb-status-version">BingeBandit ${esc(s.version)}</span>` : ''}<p>${esc(s.message)}</p>${links ? `<ul>${links}</ul>` : ''}`;
    } catch (err) {
      box.classList.add('bb-status-bad');
      box.textContent = `Couldn't check: ${err.message}`;
    }
  }

  async function initPanel() {
    bbCheck();
    let meta;
    try {
      meta = await getJson('/api/meta');
    } catch (err) {
      meta = { season: new Date().getFullYear(), week: 1, seasonType: 2 };
    }
    populateSelectors(meta);
    el('loadBtn').addEventListener('click', loadWeek);
    await initBroadcasts();
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
          ${bcSummaryHtml('game', game.id)}
          <button class="${isPicked ? 'remove' : 'add'}">${isPicked ? 'Remove notable' : 'Mark notable'}</button>
          <button class="bc-edit">Radio/TV</button>
        </div>`;
    }).join('');

    list.querySelectorAll('.admin-game-row').forEach((row) => {
      row.querySelector('.bc-edit').addEventListener('click', () => {
        const game = state.games.find((g) => String(g.id) === String(row.dataset.id));
        const name = game ? `${game.away ? game.away.shortName : 'TBD'} @ ${game.home ? game.home.shortName : 'TBD'}` : '';
        editOverride({ sport: 'cfb', scope: 'game', targetId: row.dataset.id, label: name, espnTv: game && game.broadcast });
      });
      const btn = row.querySelector('button.add, button.remove');
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

  // ---- Radio and TV overrides ---------------------------------------------
  // Saved per game or per team; the server applies them over ESPN's data
  // (src/overrides.js). bc.overrides holds every saved one, all sports.
  const bc = { overrides: [], sports: [], teams: {} };
  const bcKey = (o) => `${o.sport}|${o.scope}|${o.targetId}`;
  const bcFind = (sport, scope, targetId) => bc.overrides
    .find((o) => o.sport === sport && o.scope === scope && String(o.targetId) === String(targetId));

  function bcSummaryText(o) {
    const parts = [];
    if (o.tv.length) parts.push(`TV: ${o.tv.join(', ')}`);
    if (o.radio.length) parts.push(`Radio: ${o.radio.join(', ')}`);
    if (o.watchUrl) parts.push('watch link');
    if (o.listenUrl) parts.push('audio link');
    if (o.note) parts.push('note');
    return parts.join(' · ');
  }

  function bcSummaryHtml(scope, targetId) {
    const o = bcFind('cfb', scope, targetId);
    return o ? `<span class="bc-summary">${esc(bcSummaryText(o))}</span>` : '';
  }

  function bcScopeChanged() {
    const scope = el('bcScope').value;
    el('bcTv').placeholder = 'Comma separated, e.g. ESPN, ESPN+';
    document.querySelectorAll('#bcForm [data-scope]').forEach((node) => {
      node.hidden = node.dataset.scope !== scope;
    });
    el('bcTvLabel').textContent = scope === 'team' ? "Usual TV channel (only used when ESPN lists none)" : 'TV channels';
    el('bcRadioLabel').textContent = scope === 'team' ? 'Radio stations (flagship first)' : 'National radio';
  }

  async function bcLoadTeams(sport) {
    const select = el('bcTeam');
    const cfg = bc.sports.find((s) => s.key === sport);
    const teamOption = el('bcScope').querySelector('option[value="team"]');
    teamOption.disabled = !(cfg && cfg.teams !== false);
    if (teamOption.disabled && el('bcScope').value === 'team') {
      el('bcScope').value = 'game';
      bcScopeChanged();
    }
    if (teamOption.disabled) { select.innerHTML = ''; return; }
    if (!bc.teams[sport]) {
      select.innerHTML = '<option value="">Loading teams&hellip;</option>';
      try {
        bc.teams[sport] = (await getJson(`/api/teams?sport=${encodeURIComponent(sport)}`)).teams || [];
      } catch (err) {
        bc.teams[sport] = [];
      }
    }
    if (el('bcSport').value !== sport) return;
    select.innerHTML = '<option value="">Pick a team</option>' + bc.teams[sport]
      .map((t) => `<option value="${esc(t.id)}">${esc(t.name)}${bcFind(sport, 'team', t.id) ? ' (edited)' : ''}</option>`).join('');
  }

  // Fill the form from the saved override for whatever is picked, if any.
  function bcFillFromSaved() {
    const sport = el('bcSport').value;
    const scope = el('bcScope').value;
    const targetId = scope === 'team' ? el('bcTeam').value : el('bcGameId').value.trim();
    const o = targetId ? bcFind(sport, scope, targetId) : null;
    el('bcTv').value = o ? o.tv.join(', ') : '';
    el('bcRadio').value = o ? o.radio.join(', ') : '';
    el('bcRadioCity').value = (o && o.radioCity) || '';
    el('bcListen').value = (o && o.listenUrl) || '';
    el('bcWatchName').value = (o && o.watchName) || '';
    el('bcWatchUrl').value = (o && o.watchUrl) || '';
    el('bcNote').value = (o && o.note) || '';
    if (o && o.label && scope === 'game') el('bcLabel').value = o.label;
    el('bcStatus').textContent = '';
  }

  async function editOverride({ sport, scope, targetId, label, espnTv }) {
    el('bcSport').value = sport;
    el('bcScope').value = scope;
    bcScopeChanged();
    await bcLoadTeams(sport);
    if (scope === 'team') el('bcTeam').value = targetId;
    else el('bcGameId').value = targetId;
    el('bcLabel').value = label || '';
    bcFillFromSaved();
    el('bcTv').placeholder = espnTv ? `ESPN lists: ${espnTv}` : 'Comma separated, e.g. ESPN, ESPN+';
    el('bcSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function bcSportLabel(key) {
    const s = bc.sports.find((x) => x.key === key);
    return s ? s.label : key;
  }

  function renderBcList() {
    const list = el('bcList');
    if (!bc.overrides.length) {
      list.innerHTML = '<div class="empty-note">No radio or TV changes saved. ESPN\'s info shows everywhere.</div>';
      return;
    }
    list.innerHTML = bc.overrides.map((o) => {
      const team = o.scope === 'team' && (bc.teams[o.sport] || []).find((t) => String(t.id) === String(o.targetId));
      const name = o.label || (team && team.name) || `${o.scope === 'team' ? 'Team' : 'Game'} ${o.targetId}`;
      return `
        <div class="admin-game-row" data-key="${esc(bcKey(o))}">
          <span class="matchup">${esc(bcSportLabel(o.sport))} &middot; ${o.scope === 'team' ? 'Team' : 'Game'}: ${esc(name)}
            <br /><span class="bc-summary">${esc(bcSummaryText(o))}</span></span>
          <button class="bc-edit">Edit</button>
          <button class="remove">Remove</button>
        </div>`;
    }).join('');
    list.querySelectorAll('.admin-game-row').forEach((row) => {
      const o = bc.overrides.find((x) => bcKey(x) === row.dataset.key);
      row.querySelector('.bc-edit').addEventListener('click', () => editOverride(o));
      row.querySelector('.remove').addEventListener('click', async () => {
        await getJson(`/api/admin/broadcasts/${encodeURIComponent(o.sport)}/${o.scope}/${encodeURIComponent(o.targetId)}`, { method: 'DELETE' });
        await bcRefresh();
      });
    });
  }

  async function bcRefresh() {
    bc.overrides = await getJson('/api/admin/broadcasts');
    // Team names for the saved list, without loading every league's teams.
    const teamSports = [...new Set(bc.overrides.filter((o) => o.scope === 'team' && !o.label).map((o) => o.sport))];
    await Promise.all(teamSports.filter((s) => !bc.teams[s]).map(async (s) => {
      try { bc.teams[s] = (await getJson(`/api/teams?sport=${encodeURIComponent(s)}`)).teams || []; } catch (err) { bc.teams[s] = []; }
    }));
    renderBcList();
    if (state.games.length) renderAllGames();
  }

  async function initBroadcasts() {
    try {
      bc.sports = (await getJson('/api/sports')).sports || [];
    } catch (err) {
      bc.sports = [{ key: 'cfb', label: 'College Football' }];
    }
    el('bcSport').innerHTML = bc.sports.map((s) => `<option value="${esc(s.key)}">${esc(s.label)}</option>`).join('');
    el('bcSport').value = 'cfb';
    el('bcSport').addEventListener('change', async () => {
      await bcLoadTeams(el('bcSport').value);
      bcFillFromSaved();
    });
    el('bcScope').addEventListener('change', () => { bcScopeChanged(); bcFillFromSaved(); });
    el('bcTeam').addEventListener('change', bcFillFromSaved);
    el('bcGameId').addEventListener('change', bcFillFromSaved);
    el('bcReset').addEventListener('click', () => {
      el('bcGameId').value = '';
      el('bcLabel').value = '';
      el('bcTeam').value = '';
      bcFillFromSaved();
    });
    el('bcForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const scope = el('bcScope').value;
      const sport = el('bcSport').value;
      const targetId = scope === 'team' ? el('bcTeam').value : el('bcGameId').value.trim();
      if (!targetId) { el('bcStatus').textContent = scope === 'team' ? 'Pick a team first.' : 'Enter a game id first.'; return; }
      const team = scope === 'team' && (bc.teams[sport] || []).find((t) => String(t.id) === String(targetId));
      try {
        const result = await getJson('/api/admin/broadcasts', {
          method: 'POST',
          body: JSON.stringify({
            sport,
            scope,
            targetId,
            label: scope === 'team' ? (team ? team.name : null) : el('bcLabel').value,
            tv: el('bcTv').value,
            radio: el('bcRadio').value,
            radioCity: scope === 'team' ? el('bcRadioCity').value : '',
            listenUrl: scope === 'team' ? el('bcListen').value : '',
            watchName: scope === 'game' ? el('bcWatchName').value : '',
            watchUrl: scope === 'game' ? el('bcWatchUrl').value : '',
            note: scope === 'game' ? el('bcNote').value : '',
          }),
        });
        el('bcStatus').style.color = 'var(--text-dim)';
        el('bcStatus').textContent = result.removed ? 'Cleared. ESPN\'s info shows again.' : 'Saved.';
        await bcRefresh();
        if (scope === 'team') await bcLoadTeams(sport).then(() => { el('bcTeam').value = targetId; });
      } catch (err) {
        el('bcStatus').style.color = '';
        el('bcStatus').textContent = err.message;
      }
    });
    bcScopeChanged();
    await bcLoadTeams('cfb');
    try { await bcRefresh(); } catch (err) { el('bcList').innerHTML = `<div class="empty-note">${esc(err.message)}</div>`; }
  }

  checkLogin();
})();

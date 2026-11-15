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
    initSso();
    initUsers();
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

  // ---- Sign-in providers (single sign-on) -------------------------------

  const ssoState = { providers: [], editing: null };

  function ssoBadges(p) {
    const badges = [];
    if (!p.showOnLogin) badges.push('<span class="sso-badge">Hidden</span>');
    if (p.autoCreate) badges.push('<span class="sso-badge sso-badge-warn">Creates accounts</span>');
    return badges.join('');
  }

  function renderSsoList() {
    const list = el('ssoList');
    if (!ssoState.providers.length) {
      list.innerHTML = '<div class="empty-note">No sign-in providers yet. People sign in with email and password.</div>';
      return;
    }
    list.innerHTML = ssoState.providers.map((p) => `
      <div class="admin-game-row sso-row" data-id="${esc(p.id)}">
        <span class="matchup"><strong>${esc(p.name)}</strong> ${ssoBadges(p)}
          <br /><span class="bc-summary">${esc(p.issuer)}</span></span>
        <button class="sso-edit">Edit</button>
        <button class="remove">Remove</button>
      </div>`).join('');
    list.querySelectorAll('.sso-row').forEach((row) => {
      const p = ssoState.providers.find((x) => String(x.id) === row.dataset.id);
      row.querySelector('.sso-edit').addEventListener('click', () => openSsoDialog(p));
      const remove = row.querySelector('.remove');
      remove.addEventListener('click', async () => {
        // Two clicks instead of confirm(), which some kiosk browsers block.
        if (!remove.dataset.armed) {
          remove.dataset.armed = '1';
          remove.textContent = 'Click again to remove';
          setTimeout(() => { delete remove.dataset.armed; remove.textContent = 'Remove'; }, 4000);
          return;
        }
        await getJson(`/api/admin/sso/${encodeURIComponent(p.id)}`, { method: 'DELETE' });
        await ssoRefresh();
      });
    });
  }

  async function ssoRefresh() {
    try {
      const data = await getJson('/api/admin/sso');
      ssoState.providers = data.providers || [];
      if (usersState.users.length) usersRefresh();
      el('ssoCallback').textContent = data.callbackUrl;
      el('ssoCallbackHint').hidden = !!data.publicUrlSet;
      renderSsoList();
    } catch (err) {
      el('ssoList').innerHTML = `<div class="empty-note">${esc(err.message)}</div>`;
    }
  }

  function openSsoDialog(p) {
    ssoState.editing = p || null;
    el('ssoDialogTitle').textContent = p ? `Edit ${p.name}` : 'Add provider';
    el('ssoName').value = p ? p.name : '';
    el('ssoIssuer').value = p ? p.issuer : '';
    el('ssoClientId').value = p ? p.clientId : '';
    el('ssoClientSecret').value = '';
    el('ssoClientSecret').placeholder = p && p.hasSecret ? 'Saved; leave empty to keep it' : '';
    el('ssoScopes').value = p ? p.scopes : '';
    el('ssoAutoCreate').checked = p ? p.autoCreate : false;
    el('ssoShow').checked = p ? p.showOnLogin : true;
    el('ssoError').textContent = '';
    el('ssoSave').disabled = false;
    el('ssoDialog').showModal();
    el('ssoName').focus();
  }

  function initSso() {
    el('ssoAdd').addEventListener('click', () => openSsoDialog(null));
    el('ssoClose').addEventListener('click', () => el('ssoDialog').close());
    el('ssoCancel').addEventListener('click', () => el('ssoDialog').close());
    el('ssoCopy').addEventListener('click', async () => {
      const text = el('ssoCallback').textContent;
      try {
        await navigator.clipboard.writeText(text);
        el('ssoCopy').textContent = 'Copied';
      } catch (err) {
        const range = document.createRange();
        range.selectNodeContents(el('ssoCallback'));
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        el('ssoCopy').textContent = 'Press Ctrl+C';
      }
      setTimeout(() => { el('ssoCopy').textContent = 'Copy'; }, 2000);
    });
    el('ssoForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const editing = ssoState.editing;
      el('ssoError').textContent = '';
      el('ssoSave').disabled = true;
      try {
        const result = await getJson(editing ? `/api/admin/sso/${encodeURIComponent(editing.id)}` : '/api/admin/sso', {
          method: editing ? 'PUT' : 'POST',
          body: JSON.stringify({
            name: el('ssoName').value,
            issuer: el('ssoIssuer').value,
            clientId: el('ssoClientId').value,
            clientSecret: el('ssoClientSecret').value,
            scopes: el('ssoScopes').value,
            autoCreate: el('ssoAutoCreate').checked,
            showOnLogin: el('ssoShow').checked,
          }),
        });
        await ssoRefresh();
        if (result.warning) {
          // Saved, but discovery failed: keep the dialog open to fix it.
          ssoState.editing = ssoState.providers.find((x) => x.id === result.provider.id) || null;
          el('ssoDialogTitle').textContent = `Edit ${result.provider.name}`;
          el('ssoClientSecret').value = '';
          el('ssoClientSecret').placeholder = 'Saved; leave empty to keep it';
          el('ssoError').textContent = result.warning;
        } else {
          el('ssoDialog').close();
        }
      } catch (err) {
        el('ssoError').textContent = err.message;
      } finally {
        el('ssoSave').disabled = false;
      }
    });
    ssoRefresh();
  }

  // ---- Users and their sign-in logins --------------------------------------

  const usersState = { users: [], providers: [] };

  function userLabel(u) {
    return u.displayName || u.email || `User ${u.id}`;
  }

  function armButton(btn, armedText, action) {
    btn.addEventListener('click', async () => {
      if (!btn.dataset.armed) {
        const text = btn.textContent;
        btn.dataset.armed = '1';
        btn.textContent = armedText;
        setTimeout(() => { delete btn.dataset.armed; btn.textContent = text; }, 4000);
        return;
      }
      await action();
    });
  }

  function renderUsers() {
    const list = el('usersList');
    const q = el('usersFilter').value.trim().toLowerCase();
    const users = usersState.users.filter((u) => !q || [u.displayName, u.email, ...u.logins.map((l) => l.email)].some((v) => v && v.toLowerCase().includes(q)));
    if (!usersState.users.length) {
      list.innerHTML = '<div class="empty-note">No accounts yet.</div>';
      return;
    }
    if (!users.length) {
      list.innerHTML = '<div class="empty-note">No one matches.</div>';
      return;
    }
    const providerOptions = usersState.providers.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
    list.innerHTML = users.map((u) => {
      const others = usersState.users.filter((o) => o.id !== u.id)
        .map((o) => `<option value="${esc(o.id)}">${esc(userLabel(o))}${o.email ? ` (${esc(o.email)})` : ''}</option>`).join('');
      const logins = u.logins.map((l) => `
        <div class="user-login" data-subject="${esc(l.subject)}">
          <span class="user-login-name"><strong>${esc(l.providerName)}</strong> ${esc([l.email, l.name && l.name !== l.email ? l.name : null].filter(Boolean).join(' · '))}</span>
          ${others ? `<select class="move-to" aria-label="Move to account"><option value="">Move to&hellip;</option>${others}</select>` : ''}
          <button type="button" class="remove unlink">Unlink</button>
        </div>`).join('');
      return `
        <div class="user-card" data-id="${esc(u.id)}">
          <div class="user-head">
            <span><strong>${esc(userLabel(u))}</strong> ${u.email ? `<span class="bc-summary">${esc(u.email)}</span>` : ''}
              ${u.hasPassword ? '<span class="sso-badge">Password</span>' : ''}
              ${!u.hasPassword && !u.logins.length ? '<span class="sso-badge sso-badge-warn">No way to sign in</span>' : ''}</span>
          </div>
          ${logins}
          ${providerOptions ? `<div class="user-link-row">
            <select class="invite-provider" aria-label="Provider">${providerOptions}</select>
            <button type="button" class="make-invite">Make a link</button>
          </div>
          <div class="user-invite" hidden></div>` : ''}
        </div>`;
    }).join('');

    list.querySelectorAll('.user-card').forEach((card) => {
      const id = card.dataset.id;
      card.querySelectorAll('.user-login').forEach((row) => {
        const subject = row.dataset.subject;
        armButton(row.querySelector('.unlink'), 'Click again to unlink', async () => {
          await getJson(`/api/admin/users/${encodeURIComponent(id)}/unlink`, { method: 'POST', body: JSON.stringify({ subject }) });
          await usersRefresh();
        });
        const move = row.querySelector('.move-to');
        if (move) {
          move.addEventListener('change', async () => {
            if (!move.value) return;
            try {
              await getJson(`/api/admin/users/${encodeURIComponent(id)}/move-login`, { method: 'POST', body: JSON.stringify({ subject, toUserId: Number(move.value) }) });
              await usersRefresh();
            } catch (err) {
              move.value = '';
              alertInCard(card, err.message);
            }
          });
        }
      });
      const make = card.querySelector('.make-invite');
      if (make) {
        make.addEventListener('click', async () => {
          const box = card.querySelector('.user-invite');
          try {
            const out = await getJson(`/api/admin/users/${encodeURIComponent(id)}/link-invite`, {
              method: 'POST', body: JSON.stringify({ providerId: Number(card.querySelector('.invite-provider').value) }),
            });
            const expires = new Date(out.expiresAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
            box.innerHTML = `<p>Send this to ${esc(userLabel(usersState.users.find((u) => String(u.id) === id)))} only. When they open it and sign in with ${esc(out.provider)}, that login is linked to this account. It works once, until ${esc(expires)}.</p>
              <div class="sso-callback-row"><code>${esc(out.url)}</code><button type="button" class="copy-invite">Copy</button></div>`;
            box.hidden = false;
            box.querySelector('.copy-invite').addEventListener('click', async (e) => {
              try { await navigator.clipboard.writeText(out.url); e.target.textContent = 'Copied'; } catch (err) { e.target.textContent = 'Select and copy'; }
            });
          } catch (err) {
            alertInCard(card, err.message);
          }
        });
      }
    });
  }

  function alertInCard(card, message) {
    const box = card.querySelector('.user-invite') || card;
    box.hidden = false;
    box.insertAdjacentHTML('beforeend', `<div class="error-text">${esc(message)}</div>`);
  }

  async function usersRefresh() {
    try {
      const data = await getJson('/api/admin/users');
      usersState.users = data.users || [];
      usersState.providers = data.providers || [];
      renderUsers();
    } catch (err) {
      el('usersList').innerHTML = `<div class="empty-note">${esc(err.message)}</div>`;
    }
  }

  function initUsers() {
    el('usersFilter').addEventListener('input', renderUsers);
    usersRefresh();
  }

  checkLogin();
})();

// Recruiting & Transfer Portal page (college football only). News comes
// from /api/recruiting/news; the portal, top recruits and class rankings
// come from CollegeFootballData.com through /api/recruiting/*, which needs
// the server's CFBD_API_KEY.
(function () {
  const el = CFB.el;
  const esc = CFB.esc;
  const MAX_ROWS = 250;
  const state = { status: null, newsTopic: 'all', news: null, portal: null, players: null, teams: null };

  function timeAgo(iso) {
    if (!iso) return '';
    const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
  }

  const stars = (n) => (n ? `<span class="stars" title="${esc(n)}-star">${'&#9733;'.repeat(Math.min(Number(n), 5))}</span>` : '');
  const rating = (r) => (r === null || r === undefined ? '' : esc(r < 1.5 ? r.toFixed(4) : r.toFixed(2)));
  const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '');

  // ---- Followed teams ----------------------------------------------------
  // Follows store ESPN names ("Texas A&M Aggies"); the data uses school
  // names ("Texas A&M"). A follow matches a school when its name is the
  // school plus a mascot, and the next word isn't part of a longer school
  // name ("Texas" must not match "Texas State Bobcats").
  const SCHOOL_WORDS = /^(state|st\.?|tech|a&m|christian|southern|international|atlantic|poly|(\(.*\)))\b/i;
  function followNames() {
    return CFB.follows.list('cfb').map((t) => String(t.name || '').toLowerCase()).filter(Boolean);
  }
  function isMySchool(school, names) {
    if (!school) return false;
    const s = school.toLowerCase();
    return names.some((name) => {
      if (name === s) return true;
      if (!name.startsWith(`${s} `)) return false;
      return !SCHOOL_WORDS.test(name.slice(s.length + 1));
    });
  }

  // ---- Tabs ----------------------------------------------------------------
  const loaders = { news: loadNews, portal: loadPortal, players: loadPlayers, teams: loadTeams };
  function showTab(tab) {
    document.querySelectorAll('#recruitTabs .tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${tab}`));
    if (history.replaceState) history.replaceState(null, '', `#${tab}`);
    if (!state[tab]) loaders[tab]();
  }

  function needsKeyHtml() {
    return `<div class="key-note">
      <strong>One step to turn this on.</strong>
      The transfer portal, top recruits and class rankings come from CollegeFootballData.com.
      Get a free API key at <a href="https://collegefootballdata.com/key" target="_blank" rel="noopener noreferrer">collegefootballdata.com/key</a>
      and set it as <code>CFBD_API_KEY</code> in the server's <code>.env</code> or Docker settings, then restart.
    </div>`;
  }

  function fillYears(select, current) {
    if (select.options.length) return;
    for (let y = current; y >= current - 4; y--) select.add(new Option(y, y));
  }

  function fillPositions(select, rows) {
    const keep = select.value;
    const positions = [...new Set(rows.map((r) => r.position).filter(Boolean))].sort();
    select.innerHTML = '<option value="">All positions</option>' + positions.map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
    if (positions.includes(keep)) select.value = keep;
  }

  async function fetchData(kind, yearSelect) {
    const year = yearSelect.value;
    const data = await CFB.getJson(`/api/recruiting/${kind}${year && yearSelect.dataset.touched ? `?year=${encodeURIComponent(year)}` : ''}`);
    if (String(yearSelect.value) !== String(data.year)) {
      if (![...yearSelect.options].some((o) => o.value === String(data.year))) yearSelect.add(new Option(data.year, data.year));
      yearSelect.value = data.year;
    }
    return data;
  }

  // ---- News ----------------------------------------------------------------
  async function loadNews() {
    const list = el('recruitNews');
    try {
      const data = await CFB.getJson('/api/recruiting/news');
      state.news = data.items || [];
      renderNews();
    } catch (err) {
      list.innerHTML = '<div class="empty-note">Could not load recruiting news right now.</div>';
    }
  }

  function renderNews() {
    const list = el('recruitNews');
    let items = state.news || [];
    if (state.newsTopic !== 'all') items = items.filter((i) => i.topic === state.newsTopic);
    if (!items.length) {
      list.innerHTML = '<div class="empty-note">No recent stories here. Check back soon.</div>';
      return;
    }
    list.innerHTML = items.map((item) => `
        <a class="news-item" href="${CFB.safeUrl(item.link)}" target="_blank" rel="noopener noreferrer">
          ${item.image ? `<img class="news-thumb" src="${CFB.safeUrl(item.image)}" alt="" loading="lazy" onerror="this.remove()">` : ''}
          <div class="news-item-body">
            <div class="news-item-top">
              <span class="news-source">${esc(item.source)} &middot; ${item.topic === 'portal' ? 'Portal' : 'Recruiting'}</span>
              ${item.pubDate ? `<span class="news-time">${timeAgo(item.pubDate)}</span>` : ''}
            </div>
            <div class="news-title">${esc(item.title)}</div>
            ${item.summary && item.summary !== item.title ? `<div class="news-summary">${esc(item.summary)}</div>` : ''}
          </div>
        </a>`).join('');
  }

  // ---- Transfer portal -------------------------------------------------------
  async function loadPortal() {
    const body = el('portalBody');
    if (!state.status.cfbd) { body.innerHTML = needsKeyHtml(); state.portal = []; return; }
    body.innerHTML = '<div class="empty-note">Loading&hellip;</div>';
    try {
      const data = await fetchData('portal', el('portalYear'));
      state.portal = data.items || [];
      fillPositions(el('portalPos'), state.portal);
      renderPortal();
    } catch (err) {
      state.portal = null;
      body.innerHTML = `<div class="empty-note">Could not load the transfer portal: ${esc(err.message)}</div>`;
    }
  }

  function renderPortal() {
    if (!state.portal) return;
    const q = el('portalSearch').value.trim().toLowerCase();
    const pos = el('portalPos').value;
    const status = el('portalStatus').value;
    const mineOnly = el('portalMine').checked;
    const names = followNames();
    const rows = state.portal.filter((p) => {
      if (pos && p.position !== pos) return false;
      if (status === 'open' && p.destination) return false;
      if (status === 'committed' && !p.destination) return false;
      if (mineOnly && !isMySchool(p.origin, names) && !isMySchool(p.destination, names)) return false;
      if (q && ![p.name, p.origin, p.destination].some((v) => v && v.toLowerCase().includes(q))) return false;
      return true;
    });
    const committed = state.portal.filter((p) => p.destination).length;
    const header = `<div class="recruit-count">${state.portal.length.toLocaleString()} players in the portal &middot; ${committed.toLocaleString()} committed &middot; showing ${Math.min(rows.length, MAX_ROWS).toLocaleString()}${rows.length > MAX_ROWS ? ` of ${rows.length.toLocaleString()}` : ''}</div>`;
    if (!rows.length) {
      el('portalBody').innerHTML = header + `<div class="empty-note">${mineOnly && !names.length ? 'Follow teams from their team pages to filter by them.' : 'No players match.'}</div>`;
      return;
    }
    el('portalBody').innerHTML = header + `
      <div class="table-wrap"><table class="data-table recruit-table">
        <thead><tr><th>Player</th><th>Pos</th><th>From</th><th>To</th><th>Rating</th><th>Elig.</th><th>Entered</th></tr></thead>
        <tbody>${rows.slice(0, MAX_ROWS).map((p) => {
          const mine = isMySchool(p.origin, names) || isMySchool(p.destination, names);
          return `<tr class="${mine ? 'is-favorite-row' : ''}">
            <td><strong>${esc(p.name)}</strong></td>
            <td>${esc(p.position || '')}</td>
            <td>${esc(p.origin || '')}</td>
            <td>${p.destination ? `<span class="to-team">${esc(p.destination)}</span>` : '<span class="dim">Available</span>'}</td>
            <td>${stars(p.stars)} ${rating(p.rating)}</td>
            <td>${esc(p.eligibility || '')}</td>
            <td>${esc(fmtDate(p.transferDate))}</td>
          </tr>`;
        }).join('')}</tbody>
      </table></div>`;
  }

  // ---- Top recruits ------------------------------------------------------------
  async function loadPlayers() {
    const body = el('playersBody');
    if (!state.status.cfbd) { body.innerHTML = needsKeyHtml(); state.players = []; return; }
    body.innerHTML = '<div class="empty-note">Loading&hellip;</div>';
    try {
      const data = await fetchData('players', el('playersYear'));
      state.players = data.items || [];
      fillPositions(el('playersPos'), state.players);
      renderPlayers();
    } catch (err) {
      state.players = null;
      body.innerHTML = `<div class="empty-note">Could not load recruits: ${esc(err.message)}</div>`;
    }
  }

  function renderPlayers() {
    if (!state.players) return;
    const q = el('playersSearch').value.trim().toLowerCase();
    const pos = el('playersPos').value;
    const status = el('playersStatus').value;
    const mineOnly = el('playersMine').checked;
    const names = followNames();
    const rows = state.players.filter((r) => {
      if (pos && r.position !== pos) return false;
      if (status === 'open' && r.committedTo) return false;
      if (status === 'committed' && !r.committedTo) return false;
      if (mineOnly && !isMySchool(r.committedTo, names)) return false;
      if (q && ![r.name, r.school, r.committedTo, r.state, r.city].some((v) => v && v.toLowerCase().includes(q))) return false;
      return true;
    });
    if (!rows.length) {
      el('playersBody').innerHTML = `<div class="empty-note">${mineOnly && !names.length ? 'Follow teams from their team pages to filter by them.' : 'No recruits match.'}</div>`;
      return;
    }
    el('playersBody').innerHTML = `
      <div class="table-wrap"><table class="data-table recruit-table">
        <thead><tr><th class="rank-cell">Rk</th><th>Player</th><th>Pos</th><th>High school</th><th>Rating</th><th>Size</th><th>Committed</th></tr></thead>
        <tbody>${rows.slice(0, MAX_ROWS).map((r) => `
          <tr class="${isMySchool(r.committedTo, names) ? 'is-favorite-row' : ''}">
            <td class="rank-cell">${esc(r.rank || '')}</td>
            <td><strong>${esc(r.name)}</strong></td>
            <td>${esc(r.position || '')}</td>
            <td>${esc(r.school || '')}${r.city || r.state ? `<div class="dim">${esc([r.city, r.state].filter(Boolean).join(', '))}</div>` : ''}</td>
            <td>${stars(r.stars)} ${rating(r.rating)}</td>
            <td>${r.height ? esc(`${Math.floor(r.height / 12)}'${Math.round(r.height % 12)}"`) : ''}${r.weight ? ` ${esc(r.weight)}` : ''}</td>
            <td>${r.committedTo ? `<span class="to-team">${esc(r.committedTo)}</span>` : '<span class="dim">Uncommitted</span>'}</td>
          </tr>`).join('')}</tbody>
      </table></div>`;
  }

  // ---- Class rankings -------------------------------------------------------------
  async function loadTeams() {
    const body = el('teamsBody');
    if (!state.status.cfbd) { body.innerHTML = needsKeyHtml(); state.teams = []; return; }
    body.innerHTML = '<div class="empty-note">Loading&hellip;</div>';
    try {
      const data = await fetchData('teams', el('teamsYear'));
      state.teams = data.items || [];
      const names = followNames();
      body.innerHTML = state.teams.length ? `
        <div class="table-wrap"><table class="data-table">
          <thead><tr><th class="rank-cell">Rk</th><th>Team</th><th>Points</th></tr></thead>
          <tbody>${state.teams.map((t) => `
            <tr class="${isMySchool(t.team, names) ? 'is-favorite-row' : ''}">
              <td class="rank-cell">${esc(t.rank || '')}</td>
              <td><strong>${esc(t.team)}</strong></td>
              <td>${t.points !== null ? esc(t.points.toFixed(2)) : ''}</td>
            </tr>`).join('')}</tbody>
        </table></div>` : '<div class="empty-note">No class rankings for this year yet.</div>';
    } catch (err) {
      state.teams = null;
      body.innerHTML = `<div class="empty-note">Could not load class rankings: ${esc(err.message)}</div>`;
    }
  }

  // ---- Wiring --------------------------------------------------------------------
  function wire() {
    document.querySelectorAll('#recruitTabs .tab-btn').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
    el('recruitNewsFilter').addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      state.newsTopic = btn.dataset.topic;
      el('recruitNewsFilter').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
      renderNews();
    });
    ['portalSearch', 'portalPos', 'portalStatus', 'portalMine'].forEach((id) => el(id).addEventListener('input', renderPortal));
    ['playersSearch', 'playersPos', 'playersStatus', 'playersMine'].forEach((id) => el(id).addEventListener('input', renderPlayers));
    [['portalYear', loadPortal], ['playersYear', loadPlayers], ['teamsYear', loadTeams]].forEach(([id, fn]) => {
      el(id).addEventListener('change', () => { el(id).dataset.touched = '1'; fn(); });
    });
  }

  async function init() {
    try {
      state.status = await CFB.getJson('/api/recruiting/status');
    } catch (err) {
      state.status = { cfbd: false, defaultYear: new Date().getFullYear() };
    }
    el('sourceNote').textContent = `College Football · Class of ${state.status.defaultYear}`;
    ['portalYear', 'playersYear', 'teamsYear'].forEach((id) => fillYears(el(id), state.status.defaultYear));
    wire();
    const start = location.hash.replace('#', '');
    showTab(loaders[start] ? start : 'news');
  }

  init();
})();

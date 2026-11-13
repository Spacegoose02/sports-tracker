// Team Stats page (stats.html): every FBS team ranked in one stat at a
// time, plus strength of schedule (src/teamstats.js). The stat and
// conference picks live in the URL (?stat=, ?conf=) so a table can be
// linked to.
(function () {
  const el = CFB.el;
  const esc = CFB.esc;
  const params = new URLSearchParams(location.search);
  const state = { data: null, outlook: null, confByTeam: new Map(), stat: params.get('stat') || 'scoring', conf: params.get('conf') || '', query: '' };
  const SOS = { key: 'sos', label: 'Strength of schedule', unit: 'Opponents’ win % in games not against this team (FBS opponents)' };

  const fmt = (v, key) => {
    if (v === null || v === undefined) return '-';
    if (key === 'sos') return `${(v * 100).toFixed(1)}%`;
    if (key === 'margin' || key === 'turnovers') return `${v > 0 ? '+' : ''}${Number.isInteger(v) ? v : v.toFixed(1)}`;
    return Number.isInteger(v) ? String(v) : v.toFixed(1);
  };

  function syncUrl() {
    const q = new URLSearchParams();
    q.set('sport', 'cfb');
    if (state.stat !== 'scoring') q.set('stat', state.stat);
    if (state.conf) q.set('conf', state.conf);
    history.replaceState(null, '', `${location.pathname}?${q.toString()}`);
  }

  function teamCell(team) {
    const followed = CFB.follows.has(team.id, 'cfb');
    return `<div class="team-cell">${team.logo ? `<img src="${CFB.safeUrl(team.logo)}" alt="" loading="lazy" onerror="this.style.display='none'">` : ''}<a class="team-link" href="/team.html?id=${encodeURIComponent(team.id)}&source=espn&sport=cfb">${esc(team.name)}</a>${followed ? ' <span class="ts-star" title="You follow this team">&#9733;</span>' : ''}</div>`;
  }

  function rowsFor() {
    let rows;
    let head;
    if (state.stat === 'sos') {
      rows = ((state.outlook && state.outlook.sos) || []).map((r) => ({ ...r, cells: [r.record, fmt(r.sos, 'sos'), r.remainingSos === null ? '-' : fmt(r.remainingSos, 'sos')] }));
      head = ['Rank', 'Team', 'Record', 'Played SOS', 'Remaining SOS'];
    } else {
      const table = state.data && state.data.stats.find((s) => s.key === state.stat);
      rows = ((table && table.rows) || []).map((r) => ({ ...r, cells: [r.games || '-', fmt(r.value, state.stat)] }));
      head = ['Rank', 'Team', 'G', (table && table.label) || 'Value'];
    }
    if (state.conf) rows = rows.filter((r) => state.confByTeam.get(String(r.team.id)) === state.conf);
    if (state.query) {
      const q = state.query.toLowerCase();
      rows = rows.filter((r) => String(r.team.name || '').toLowerCase().includes(q));
    }
    return { rows, head };
  }

  function render() {
    const meta = state.stat === 'sos' ? SOS : (state.data && state.data.stats.find((s) => s.key === state.stat)) || {};
    el('tsUnit').textContent = meta.unit ? `${meta.label}: ${meta.unit}${meta.lower ? ' (lowest ranks first)' : ''}` : '';
    const { rows, head } = rowsFor();
    el('tsHead').innerHTML = `<tr>${head.map((h, i) => `<th${i > 1 ? ' class="num"' : ''}>${esc(h)}</th>`).join('')}</tr>`;
    if (!rows.length) {
      el('tsBody').innerHTML = `<tr><td colspan="${head.length}" class="empty-note">${state.data || state.outlook ? 'No teams match.' : 'Team stats aren’t available right now.'}</td></tr>`;
      return;
    }
    el('tsBody').innerHTML = rows.map((r) => `
      <tr class="${CFB.follows.has(r.team.id, 'cfb') ? 'is-favorite-row' : ''}">
        <td class="ts-rank">${esc(r.rank)}</td>
        <td>${teamCell(r.team)}</td>
        ${r.cells.map((c) => `<td class="num">${esc(c)}</td>`).join('')}
      </tr>`).join('');
  }

  function fillStats() {
    const stats = [...((state.data && state.data.stats) || []), SOS];
    el('tsStat').innerHTML = stats.map((s) => `<option value="${esc(s.key)}">${esc(s.label)}</option>`).join('');
    if (!stats.some((s) => s.key === state.stat)) state.stat = 'scoring';
    el('tsStat').value = state.stat;
  }

  async function loadOutlook() {
    if (state.outlook) return;
    try { state.outlook = await CFB.getJson('/api/cfb/outlook'); } catch (err) { state.outlook = { sos: [] }; }
  }

  async function init() {
    await CFB.loadSports();
    const [stats, standings] = await Promise.all([
      CFB.getJson('/api/cfb/team-stats').catch(() => null),
      CFB.getJson('/api/standings?sport=cfb').catch(() => null),
    ]);
    state.data = stats;
    const confs = ((standings && standings.conferences) || []).filter((c) => (c.entries || []).length);
    confs.forEach((c) => {
      const label = String(c.name || '').replace(/\s+Conference$/i, '');
      (c.entries || []).forEach((e) => { if (e.team) state.confByTeam.set(String(e.team.id), label); });
    });
    el('tsConf').insertAdjacentHTML('beforeend', confs.map((c) => {
      const label = String(c.name || '').replace(/\s+Conference$/i, '');
      return `<option value="${esc(label)}">${esc(label)}</option>`;
    }).join(''));
    el('tsConf').value = state.conf;
    if (el('tsConf').value !== state.conf) state.conf = '';
    if (stats && stats.season) el('sourceNote').textContent = `College Football · ${stats.season} FBS${stats.week ? ` · through Week ${stats.week}` : ''}`;
    el('tsFoot').textContent = 'Team stats from ESPN, updated hourly. Strength of schedule is worked out here from every FBS game this season.';
    fillStats();
    if (state.stat === 'sos') await loadOutlook();
    render();

    el('tsStat').addEventListener('change', async () => {
      state.stat = el('tsStat').value;
      syncUrl();
      if (state.stat === 'sos' && !state.outlook) {
        el('tsBody').innerHTML = '<tr><td colspan="5" class="empty-note">Working out strength of schedule&hellip;</td></tr>';
        await loadOutlook();
      }
      render();
    });
    el('tsConf').addEventListener('change', () => { state.conf = el('tsConf').value; syncUrl(); render(); });
    let t = null;
    el('tsQuery').addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { state.query = el('tsQuery').value.trim(); render(); }, 120); });
  }

  init();
})();

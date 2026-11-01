// Compare tool (compare.html): two players or two teams side by side, with
// mirrored bars for every shared stat and, for players, a recent-games
// trend line. Built only on existing routes: /api/teams, /api/team/:id,
// /api/team/:id/roster and /api/player/:id, all with ?sport=.
//
// CFBCompare holds the pure pieces (no DOM) so tests can load this file in
// a sandbox; the page controller at the bottom only runs on compare.html.
// Styles live in css/compare.css.
const CFBCompare = (function () {
  const esc = (v) => CFB.esc(v);
  const COLOR_A = '#4f8dfd';
  const COLOR_B = '#f2b705';

  // "1,234" -> 1234, "45.6%" -> 45.6, "31:24" -> 1884 (seconds), "-3" -> -3.
  // Made/attempted pairs ("20/30", "3-5") have no single number: null.
  function toNumber(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    const s = String(v === null || v === undefined ? '' : v).trim().replace(/,/g, '');
    if (!s || s === '-' || s === '--') return null;
    let m = s.match(/^(\d+):(\d{2})$/);
    if (m) return Number(m[1]) * 60 + Number(m[2]);
    m = s.match(/^([+-]?\d*\.?\d+)%?$/);
    return m ? Number(m[1]) : null;
  }

  // Stats where the smaller number is the better one. `group` is the
  // category ("Passing", "Pitching", "Defense"...), because INT is bad for
  // a quarterback but good for a defender.
  const LOWER_ALWAYS = /turnover|giveaway|fumbles? lost|sacks? allowed|times sacked|penalt|fouls|points allowed|yards allowed|goals against|^gaa$|^l$|losses|^pa$|opp(onent)?s? |allowed/i;
  const LOWER_PITCHING = /^(era|whip|h|bb|er|hr|r|l|bs)$/i;
  function lowerIsBetter(label, group) {
    const l = String(label || '');
    const g = String(group || '');
    if (/pitching/i.test(g)) return LOWER_PITCHING.test(l) || /earned run|walks|hits allowed/i.test(l);
    if (/defen|interception|kick ?return|punt ?return/i.test(g)) return LOWER_ALWAYS.test(l) && !/^int/i.test(l);
    if (/^int|interception/i.test(l) && /pass/i.test(g)) return true;
    return LOWER_ALWAYS.test(l);
  }

  // 'a', 'b' or null (tie / not comparable).
  function edge(a, b, lower) {
    if (a === null || b === null || a === b) return null;
    return (lower ? a < b : a > b) ? 'a' : 'b';
  }

  function row(group, label, aText, bText, aNum, bNum, extra) {
    const lower = lowerIsBetter(label, group);
    return {
      group,
      label,
      a: aText === undefined || aText === null ? '' : String(aText),
      b: bText === undefined || bText === null ? '' : String(bText),
      aNum: aNum !== undefined && aNum !== null ? aNum : toNumber(aText),
      bNum: bNum !== undefined && bNum !== null ? bNum : toNumber(bText),
      lower,
      ...(extra || {}),
    };
  }
  function withEdge(r) { return { ...r, edge: edge(r.aNum, r.bNum, r.lower) }; }

  // Team stats from /api/team/:id: [{ name, stats: [{ name, value, number, rank }] }].
  // Only stats both teams have, in team A's order.
  function teamRows(catsA, catsB) {
    const out = [];
    const bIndex = new Map();
    (catsB || []).forEach((c) => (c.stats || []).forEach((s) => bIndex.set(`${c.name}|${s.name}`, s)));
    (catsA || []).forEach((c) => (c.stats || []).forEach((s) => {
      const other = bIndex.get(`${c.name}|${s.name}`);
      if (!other) return;
      out.push(withEdge(row(c.name, s.name, s.value, other.value, s.number, other.number, { aRank: s.rank || null, bRank: other.rank || null })));
    }));
    return out;
  }

  // The newest season row of a career-stats category ("2024", "2024-25").
  function latestRow(cat) {
    const rows = (cat.rows || []).slice();
    if (!rows.length) return null;
    rows.sort((x, y) => (parseInt(x.season, 10) || 0) - (parseInt(y.season, 10) || 0));
    return rows[rows.length - 1];
  }

  // Player stats from /api/player/:id careerStats, matched by category and
  // column label. scope 'season' = each player's latest season, 'career' =
  // ESPN's career totals row.
  function playerRows(careerA, careerB, scope) {
    const out = [];
    const bByName = new Map((careerB || []).map((c) => [c.name, c]));
    for (const ca of careerA || []) {
      const cb = bByName.get(ca.name);
      if (!cb) continue;
      const pick = (c) => (scope === 'career' ? c.totals : (latestRow(c) || {}).stats);
      const va = pick(ca);
      const vb = pick(cb);
      if (!va || !vb) continue;
      ca.labels.forEach((label, i) => {
        const j = cb.labels.indexOf(label);
        if (j < 0) return;
        out.push(withEdge(row(ca.name, label, va[i], vb[j])));
      });
    }
    return out;
  }

  function seasonOf(career) {
    const seasons = (career || []).map((c) => (latestRow(c) || {}).season).filter(Boolean);
    return seasons.sort().pop() || null;
  }

  // Count of stats each side leads.
  function tally(rows) {
    return rows.reduce((t, r) => {
      if (r.edge) t[r.edge] += 1;
      return t;
    }, { a: 0, b: 0 });
  }

  // Mirrored bars, one row per stat: A grows left from the middle, B grows
  // right. Each row is scaled to its own larger value, so the bar length
  // shows the gap, not the size of the stat.
  function barsHtml(rows, nameA, nameB) {
    if (!rows.length) return '<div class="empty-note">No stats in common to compare.</div>';
    const groups = [];
    rows.forEach((r) => {
      let g = groups.find((x) => x.name === r.group);
      if (!g) { g = { name: r.group, rows: [] }; groups.push(g); }
      g.rows.push(r);
    });
    const bar = (r) => {
      const max = Math.max(Math.abs(r.aNum || 0), Math.abs(r.bNum || 0));
      const w = (v) => (max && v !== null ? Math.max(2, (Math.abs(v) / max) * 100) : 0);
      const title = r.lower ? ' title="Lower is better"' : '';
      return `
        <div class="cmp-row"${title}>
          <div class="cmp-val cmp-a ${r.edge === 'a' ? 'cmp-lead' : ''}">${esc(r.a)}${r.aRank ? ` <span class="cmp-rank">${esc(r.aRank)}</span>` : ''}</div>
          <div class="cmp-bar cmp-bar-a"><span style="width:${w(r.aNum)}%"></span></div>
          <div class="cmp-label">${esc(r.label)}${r.lower ? ' <span class="cmp-low" aria-label="lower is better">&darr;</span>' : ''}</div>
          <div class="cmp-bar cmp-bar-b"><span style="width:${w(r.bNum)}%"></span></div>
          <div class="cmp-val cmp-b ${r.edge === 'b' ? 'cmp-lead' : ''}">${r.bRank ? `<span class="cmp-rank">${esc(r.bRank)}</span> ` : ''}${esc(r.b)}</div>
        </div>`;
    };
    return groups.map((g, i) => {
      const t = tally(g.rows);
      return `
        <details class="cmp-group" ${i < 3 ? 'open' : ''}>
          <summary><span>${esc(g.name)}</span><span class="wp-dim">${esc(nameA)} ${t.a} &middot; ${esc(nameB)} ${t.b}</span></summary>
          ${g.rows.map(bar).join('')}
        </details>`;
    }).join('');
  }

  // Labels both game logs share that have numbers in them, best first.
  function trendLabels(logA, logB) {
    const a = (logA && logA.labels) || [];
    const b = (logB && logB.labels) || [];
    const shared = a.filter((l) => b.includes(l));
    const numeric = shared.filter((l) => {
      const i = a.indexOf(l);
      return ((logA.games || []).slice(0, 5)).some((g) => toNumber(g.stats[i]) !== null);
    });
    const prefer = ['YDS', 'PTS', 'TD', 'REB', 'AST', 'H', 'HR', 'RBI', 'G', 'A', 'SOG', 'K', 'REC'];
    return numeric.sort((x, y) => {
      const px = prefer.indexOf(x); const py = prefer.indexOf(y);
      return (px < 0 ? 99 : px) - (py < 0 ? 99 : py);
    });
  }

  // Last `n` games of one stat, oldest first.
  function trendSeries(log, label, n) {
    if (!log || !log.labels) return [];
    const i = log.labels.indexOf(label);
    if (i < 0) return [];
    return (log.games || []).slice(0, n || 10).map((g) => ({
      value: toNumber(g.stats[i]),
      opponent: g.opponent ? (g.opponent.abbreviation || g.opponent.name) : '',
      atVs: g.atVs || '',
    })).filter((p) => p.value !== null).reverse();
  }

  function trendHtml(seriesA, seriesB, label, nameA, nameB) {
    if (seriesA.length < 2 && seriesB.length < 2) return '<div class="empty-note">Not enough games logged this season for a trend yet.</div>';
    const W = 600; const H = 180; const PAD = 14;
    const n = Math.max(seriesA.length, seriesB.length);
    const all = [...seriesA, ...seriesB].map((p) => p.value);
    const lo = Math.min(0, ...all); const hi = Math.max(...all, lo + 1);
    const x = (i) => PAD + (n > 1 ? (i / (n - 1)) * (W - 2 * PAD) : (W - 2 * PAD) / 2);
    const y = (v) => H - PAD - ((v - lo) / (hi - lo)) * (H - 2 * PAD);
    const line = (s, color, name) => {
      if (!s.length) return '';
      // Right-align so both players' latest game sits at the right edge.
      const off = n - s.length;
      const d = s.map((p, i) => `${i ? 'L' : 'M'}${x(i + off).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
      const dots = s.map((p, i) => `<circle cx="${x(i + off).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="3.5" fill="${color}"><title>${esc(name)}: ${esc(p.value)} ${esc(label)} ${esc(p.atVs)} ${esc(p.opponent)}</title></circle>`).join('');
      return `<path d="${d}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>${dots}`;
    };
    const avg = (s) => (s.length ? Math.round((s.reduce((t, p) => t + p.value, 0) / s.length) * 10) / 10 : null);
    return `
      <div class="cmp-trend-legend">
        <span><i style="background:${COLOR_A}"></i>${esc(nameA)}${avg(seriesA) !== null ? ` &middot; avg ${avg(seriesA)}` : ''}</span>
        <span><i style="background:${COLOR_B}"></i>${esc(nameB)}${avg(seriesB) !== null ? ` &middot; avg ${avg(seriesB)}` : ''}</span>
      </div>
      <svg class="cmp-trend" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(label)} in the last ${n} games">
        <line x1="${PAD}" x2="${W - PAD}" y1="${y(hi)}" y2="${y(hi)}" class="wp-mid"/>
        <line x1="${PAD}" x2="${W - PAD}" y1="${y(lo)}" y2="${y(lo)}" class="wp-mid"/>
        ${line(seriesA, COLOR_A, nameA)}
        ${line(seriesB, COLOR_B, nameB)}
      </svg>
      <div class="momentum-x wp-dim"><span>${n} games ago</span><span>High ${esc(hi)}</span><span>Latest</span></div>`;
  }

  return { toNumber, lowerIsBetter, edge, teamRows, playerRows, latestRow, seasonOf, tally, barsHtml, trendLabels, trendSeries, trendHtml, COLOR_A, COLOR_B };
})();

// ---- Page controller -------------------------------------------------
(function () {
  if (typeof document === 'undefined' || !document.getElementById('compareApp')) return;
  const el = CFB.el;
  const esc = CFB.esc;
  const params = new URLSearchParams(location.search);
  const state = {
    mode: params.get('mode') === 'teams' ? 'teams' : 'players',
    scope: params.get('scope') === 'career' ? 'career' : 'season',
    teams: [],
    sides: {
      a: { team: params.get('ta'), id: params.get('a'), data: null },
      b: { team: params.get('tb'), id: params.get('b'), data: null },
    },
    trendLabel: null,
  };

  function syncUrl() {
    const p = new URLSearchParams();
    p.set('sport', CFB.sport().key);
    p.set('mode', state.mode);
    if (state.mode === 'players' && state.scope === 'career') p.set('scope', 'career');
    ['a', 'b'].forEach((k) => {
      const s = state.sides[k];
      if (s.team) p.set(`t${k}`, s.team);
      if (state.mode === 'players' && s.id) p.set(k, s.id);
    });
    history.replaceState(null, '', `${location.pathname}?${p.toString()}`);
  }

  function teamName(id) {
    const t = state.teams.find((x) => x.id === String(id));
    return t ? t.name : '';
  }

  function pickerHtml(k) {
    const s = state.sides[k];
    return `
      <div class="cmp-picker cmp-picker-${k}">
        <label>Team
          <input type="search" list="cmpTeams" data-team-input="${k}" placeholder="Type a team" value="${esc(teamName(s.team))}" autocomplete="off">
        </label>
        ${state.mode === 'players' ? `<label>Player <select data-player-select="${k}" ${s.team ? '' : 'disabled'}><option value="">${s.team ? 'Loading roster&hellip;' : 'Pick a team first'}</option></select></label>` : ''}
      </div>`;
  }

  function renderPickers() {
    el('cmpModeTabs').querySelectorAll('[data-mode]').forEach((b) => {
      b.classList.toggle('active', b.dataset.mode === state.mode);
      b.setAttribute('aria-pressed', b.dataset.mode === state.mode ? 'true' : 'false');
    });
    el('cmpPickers').innerHTML = `${pickerHtml('a')}<div class="cmp-vs">vs</div>${pickerHtml('b')}`;
    el('cmpTeams').innerHTML = state.teams.map((t) => `<option value="${esc(t.name)}"></option>`).join('');
    if (state.mode === 'players') ['a', 'b'].forEach((k) => { if (state.sides[k].team) loadRoster(k); });
  }

  async function loadRoster(k) {
    const s = state.sides[k];
    const sel = document.querySelector(`[data-player-select="${k}"]`);
    if (!sel || !s.team) return;
    try {
      const roster = await CFB.getJson(CFB.withSport(`/api/team/${encodeURIComponent(s.team)}/roster`));
      sel.innerHTML = `<option value="">Pick a player</option>${(roster.groups || []).map((g) => `
        <optgroup label="${esc(g.name)}">${g.athletes.filter((a) => a.id).map((a) => `<option value="${esc(a.id)}" ${a.id === s.id ? 'selected' : ''}>${esc(a.name)}${a.position ? ` (${esc(a.position)})` : ''}</option>`).join('')}</optgroup>`).join('')}`;
      sel.disabled = false;
    } catch (err) {
      sel.innerHTML = '<option value="">Roster unavailable</option>';
    }
  }

  async function loadSide(k) {
    const s = state.sides[k];
    s.data = null;
    if (state.mode === 'teams' && s.team) {
      s.data = await CFB.getJson(CFB.withSport(`/api/team/${encodeURIComponent(s.team)}`)).catch(() => null);
    } else if (state.mode === 'players' && s.id) {
      s.data = await CFB.getJson(CFB.withSport(`/api/player/${encodeURIComponent(s.id)}`)).catch(() => null);
      // A shared link may name only the player; fill in their team.
      const t = s.data && s.data.player && s.data.player.team;
      if (t && !s.team) { s.team = t.id; renderPickers(); }
    }
  }

  function headCard(k) {
    const d = state.sides[k].data;
    const color = k === 'a' ? CFBCompare.COLOR_A : CFBCompare.COLOR_B;
    if (state.mode === 'teams') {
      const t = d && d.team;
      if (!t) return `<div class="cmp-head" style="--cmp-color:${color}"><div class="empty-note">Pick a team</div></div>`;
      return `
        <a class="cmp-head" style="--cmp-color:${color}" href="${CFB.teamLink(t)}">
          ${t.logo ? `<img src="${CFB.safeUrl(t.logo)}" alt="" onerror="this.remove()">` : ''}
          <div><strong>${t.rank ? `#${esc(t.rank)} ` : ''}${esc(t.name)}</strong>
          <div class="wp-dim">${esc([t.record, t.standingSummary].filter(Boolean).join(' · '))}</div></div>
        </a>`;
    }
    const p = d && d.player;
    if (!p) return `<div class="cmp-head" style="--cmp-color:${color}"><div class="empty-note">Pick a player</div></div>`;
    return `
      <a class="cmp-head" style="--cmp-color:${color}" href="${CFB.playerLink(p)}">
        ${p.headshot ? `<img class="cmp-headshot" src="${CFB.safeUrl(p.headshot)}" alt="" onerror="this.remove()">` : ''}
        <div><strong>${esc(p.name)}</strong>
        <div class="wp-dim">${esc([p.positionAbbr || p.position, p.team && p.team.name].filter(Boolean).join(' · '))}</div></div>
      </a>`;
  }

  function shortName(k) {
    const d = state.sides[k].data;
    if (!d) return k.toUpperCase();
    if (state.mode === 'teams') return (d.team && (d.team.abbreviation || d.team.name)) || k.toUpperCase();
    const n = (d.player && d.player.name) || '';
    return n.split(' ').slice(-1)[0] || k.toUpperCase();
  }

  function renderResult() {
    const a = state.sides.a.data;
    const b = state.sides.b.data;
    const out = el('cmpResult');
    const heads = `<div class="cmp-heads">${headCard('a')}<div class="cmp-vs">vs</div>${headCard('b')}</div>`;
    if (!a || !b) {
      out.innerHTML = `${heads}<div class="empty-note">Pick two ${state.mode} to see them side by side.</div>`;
      return;
    }
    const nameA = shortName('a');
    const nameB = shortName('b');
    let rows;
    let toolbar = '';
    let trend = '';
    if (state.mode === 'teams') {
      rows = CFBCompare.teamRows(a.stats, b.stats);
    } else {
      rows = CFBCompare.playerRows(a.careerStats, b.careerStats, state.scope);
      const labels = CFBCompare.trendLabels(a.gameLog, b.gameLog);
      if (!labels.includes(state.trendLabel)) state.trendLabel = labels[0] || null;
      const seasonA = CFBCompare.seasonOf(a.careerStats);
      const seasonB = CFBCompare.seasonOf(b.careerStats);
      toolbar = `
        <div class="cmp-toolbar">
          <div class="division-toggle" role="group" aria-label="Stats to compare">
            <button type="button" data-scope="season" class="${state.scope === 'season' ? 'active' : ''}">Latest season</button>
            <button type="button" data-scope="career" class="${state.scope === 'career' ? 'active' : ''}">Career</button>
          </div>
          ${state.scope === 'season' && seasonA && seasonB && seasonA !== seasonB ? `<span class="wp-dim">${esc(nameA)}: ${esc(seasonA)} &middot; ${esc(nameB)}: ${esc(seasonB)}</span>` : ''}
        </div>`;
      if (labels.length) {
        const sa = CFBCompare.trendSeries(a.gameLog, state.trendLabel, 10);
        const sb = CFBCompare.trendSeries(b.gameLog, state.trendLabel, 10);
        trend = `
          <section class="cmp-section">
            <h2 class="section-title">Recent games</h2>
            <div class="wp-box">
              <label class="cmp-trend-pick">Stat <select id="cmpTrendLabel">${labels.map((l) => `<option ${l === state.trendLabel ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
              ${CFBCompare.trendHtml(sa, sb, state.trendLabel, nameA, nameB)}
            </div>
          </section>`;
      }
    }
    const t = CFBCompare.tally(rows);
    const verdict = rows.length
      ? `<div class="cmp-verdict"><span style="--cmp-color:${CFBCompare.COLOR_A}"><strong>${esc(nameA)}</strong> leads ${t.a}</span><span style="--cmp-color:${CFBCompare.COLOR_B}"><strong>${esc(nameB)}</strong> leads ${t.b}</span><span class="wp-dim">of ${rows.length} stats</span></div>`
      : '';
    out.innerHTML = `
      ${heads}
      ${toolbar}
      ${verdict}
      <section class="cmp-section">
        <h2 class="section-title">${state.mode === 'teams' ? 'Season stats' : state.scope === 'career' ? 'Career stats' : 'Season stats'}</h2>
        ${CFBCompare.barsHtml(rows, nameA, nameB)}
        ${state.mode === 'players' && !rows.length ? '<div class="wp-dim">These players don\'t share a stat category (for example a quarterback and a linebacker).</div>' : ''}
      </section>
      ${trend}`;
  }

  async function refresh(which) {
    syncUrl();
    el('cmpResult').classList.add('cmp-loading');
    await Promise.all((which || ['a', 'b']).map(loadSide));
    el('cmpResult').classList.remove('cmp-loading');
    renderResult();
  }

  // Picking from the team list fires `input` in some browsers and `change`
  // in others; act once the text matches a team exactly.
  function onTeamInput(input) {
    const k = input.dataset.teamInput;
    const t = state.teams.find((x) => x.name.toLowerCase() === input.value.trim().toLowerCase());
    if (!t || t.id === state.sides[k].team) return;
    state.sides[k].team = t.id;
    state.sides[k].id = null;
    if (state.mode === 'players') loadRoster(k);
    refresh([k]);
  }

  document.addEventListener('input', (e) => {
    const input = e.target.closest && e.target.closest('[data-team-input]');
    if (input) onTeamInput(input);
  });

  document.addEventListener('change', (e) => {
    const input = e.target.closest('[data-team-input]');
    if (input) {
      onTeamInput(input);
      return;
    }
    const sel = e.target.closest('[data-player-select]');
    if (sel) {
      const k = sel.dataset.playerSelect;
      state.sides[k].id = sel.value || null;
      refresh([k]);
      return;
    }
    if (e.target.id === 'cmpTrendLabel') {
      state.trendLabel = e.target.value;
      renderResult();
    }
  });

  document.addEventListener('click', (e) => {
    const mode = e.target.closest('[data-mode]');
    if (mode && mode.dataset.mode !== state.mode) {
      state.mode = mode.dataset.mode;
      renderPickers();
      refresh();
      return;
    }
    const scope = e.target.closest('[data-scope]');
    if (scope) {
      state.scope = scope.dataset.scope;
      syncUrl();
      renderResult();
      return;
    }
    if (e.target.closest('#cmpSwap')) {
      const { a, b } = state.sides;
      state.sides = { a: b, b: a };
      renderPickers();
      syncUrl();
      renderResult();
    }
  });

  CFB.loadSports().then(async () => {
    CFB.initSportBar();
    const sport = CFB.sport();
    el('sourceNote').textContent = `${sport.label} · side by side`;
    if (sport.teams === false) {
      el('cmpPickers').innerHTML = `<div class="empty-note">${esc(sport.label)} doesn't have teams or rosters to compare. Pick another sport above.</div>`;
      el('cmpModeTabs').hidden = true;
      return;
    }
    try {
      const data = await CFB.getJson(CFB.withSport('/api/teams'));
      state.teams = data.teams || [];
    } catch (err) {
      state.teams = [];
    }
    renderPickers();
    refresh();
  });
})();

(function () {
  const el = CFB.el;
  const state = { meta: {}, polls: [], selectedPollId: null, view: 'poll' };

  // Lower-division polls stay in the picker but are left out of the
  // side-by-side comparison, which is about the top division.
  const LOWER_DIVISION = /fcs|division ii|division iii|d-ii|d-iii|naia|women/i;

  function pollOrder(p) {
    const name = `${p.type || ''} ${p.shortName || ''} ${p.name || ''}`;
    if (/playoff|cfp/i.test(name)) return 0;
    if (/\bap\b/i.test(name)) return 1;
    if (/coach|usa today|afca/i.test(name) && !LOWER_DIVISION.test(name)) return 2;
    return LOWER_DIVISION.test(name) ? 4 : 3;
  }

  function shortPollName(p) {
    const name = p.name || '';
    if (/playoff|cfp/i.test(name)) return 'CFP';
    if (/\bap\b/i.test(name)) return 'AP';
    if (/coach/i.test(name)) return 'Coaches';
    return p.shortName || name;
  }

  function teamCell(team) {
    if (!team) return 'TBD';
    return `
      <div class="team-cell">
        ${team.logo ? `<img src="${CFB.safeUrl(team.logo)}" alt="" onerror="this.style.display='none'">` : ''}
        <a class="team-link" href="${CFB.teamLink(team)}">${CFB.esc(team.name)}</a>
      </div>`;
  }

  function movementHtml(r) {
    if (r.isNew) return '<span class="badge-new">NEW</span>';
    const move = r.movement !== undefined && r.movement !== null ? r.movement
      : (r.previousRank && r.rank ? r.previousRank - r.rank : null);
    if (!move) return '<span class="trend-flat">&mdash;</span>';
    return move > 0
      ? `<span class="trend-up">&#9650; ${CFB.esc(move)}</span>`
      : `<span class="trend-down">&#9660; ${CFB.esc(-move)}</span>`;
  }

  function isFollowed(team) {
    return team && (String(team.id) === String(state.meta.favoriteTeamId) || CFB.follows.has(team.id));
  }

  // "Biggest riser", "biggest drop", newcomers: the week's story in one line.
  function moversHtml(poll) {
    const moved = poll.ranks.filter((r) => r.movement);
    const up = moved.slice().sort((a, b) => b.movement - a.movement)[0];
    const down = moved.slice().sort((a, b) => a.movement - b.movement)[0];
    const fresh = poll.ranks.filter((r) => r.isNew && r.team);
    const chips = [];
    if (up && up.movement > 0) chips.push(`<span class="mover"><span class="trend-up">&#9650; ${CFB.esc(up.movement)}</span> Biggest rise: <strong>${CFB.esc(up.team && up.team.name)}</strong> to #${CFB.esc(up.rank)}</span>`);
    if (down && down.movement < 0) chips.push(`<span class="mover"><span class="trend-down">&#9660; ${CFB.esc(-down.movement)}</span> Biggest drop: <strong>${CFB.esc(down.team && down.team.name)}</strong> to #${CFB.esc(down.rank)}</span>`);
    if (fresh.length) chips.push(`<span class="mover"><span class="badge-new">NEW</span> ${fresh.map((r) => `${CFB.esc(r.team.name)} (#${CFB.esc(r.rank)})`).join(', ')}</span>`);
    return chips.join('');
  }

  function renderPoll() {
    const poll = state.polls.find((p) => String(p.id) === String(state.selectedPollId));
    el('pollHeadline').textContent = poll ? (poll.headline || poll.name || 'Top 25') : 'Top 25';

    const body = el('rankingsBody');
    if (!poll || !poll.ranks || !poll.ranks.length) {
      body.innerHTML = '<tr><td colspan="7" class="empty-note">No rankings available for this poll right now.</td></tr>';
      el('othersVotes').innerHTML = '';
      el('droppedOut').innerHTML = '';
      el('movers').innerHTML = '';
      return;
    }

    el('movers').innerHTML = moversHtml(poll);
    body.innerHTML = poll.ranks.map((r) => `
        <tr class="${isFollowed(r.team) ? 'is-favorite-row' : ''}">
          <td class="rank-cell">${CFB.esc(r.rank)}</td>
          <td>${teamCell(r.team)}</td>
          <td>${CFB.esc(r.recordSummary || '')}</td>
          <td>${r.points !== null ? CFB.esc(r.points) : ''}</td>
          <td>${CFB.esc(r.firstPlaceVotes || '')}</td>
          <td>${r.previousRank ? CFB.esc(r.previousRank) : '<span class="trend-flat">NR</span>'}</td>
          <td>${movementHtml(r)}</td>
        </tr>`).join('');

    el('othersVotes').innerHTML = poll.others && poll.others.length ? `
        <strong>Others Receiving Votes</strong>
        <div class="others-list">
          ${poll.others.map((o) => `<span>${CFB.esc(o.team ? o.team.name : 'Unknown')}${o.points ? ` (${CFB.esc(o.points)})` : ''}</span>`).join(', ')}
        </div>` : '';

    el('droppedOut').innerHTML = poll.droppedOut && poll.droppedOut.length ? `
        <strong>Dropped Out</strong>
        <div class="others-list">
          ${poll.droppedOut.filter((d) => d.team).map((d) => `<span>${CFB.esc(d.team.name)}${d.previousRank ? ` (was #${CFB.esc(d.previousRank)})` : ''}</span>`).join(', ')}
        </div>` : '';
  }

  // One row per team ranked in any major poll, one column per poll.
  function renderCompare() {
    const polls = state.polls.filter((p) => p.ranks && p.ranks.length && pollOrder(p) < 4).slice(0, 4);
    const head = el('compareHead');
    const body = el('compareBody');
    if (!polls.length) {
      head.innerHTML = '';
      body.innerHTML = '<tr><td class="empty-note">No polls to compare this week.</td></tr>';
      return;
    }
    const teams = new Map();
    polls.forEach((p, i) => {
      p.ranks.forEach((r) => {
        if (!r.team) return;
        const id = String(r.team.id);
        if (!teams.has(id)) teams.set(id, { team: r.team, record: r.recordSummary, ranks: [] });
        teams.get(id).ranks[i] = r;
        if (!teams.get(id).record) teams.get(id).record = r.recordSummary;
      });
    });
    // Sort by the first poll (CFP when it's out, else AP), then by the
    // average of the rest for teams the first poll doesn't rank.
    const sortKey = (t) => {
      if (t.ranks[0]) return t.ranks[0].rank;
      const vals = t.ranks.filter(Boolean).map((r) => r.rank);
      return 100 + vals.reduce((a, b) => a + b, 0) / vals.length;
    };
    const rows = [...teams.values()].sort((a, b) => sortKey(a) - sortKey(b));
    head.innerHTML = `<tr><th>Team</th><th>Record</th>${polls.map((p) => `<th title="${CFB.esc(p.name)}">${CFB.esc(shortPollName(p))}</th>`).join('')}</tr>`;
    body.innerHTML = rows.map((t) => `
      <tr class="${isFollowed(t.team) ? 'is-favorite-row' : ''}">
        <td>${teamCell(t.team)}</td>
        <td>${CFB.esc(t.record || '')}</td>
        ${polls.map((p, i) => {
          const r = t.ranks[i];
          return r ? `<td><strong>${CFB.esc(r.rank)}</strong> <small>${movementHtml(r)}</small></td>` : '<td><span class="trend-flat">NR</span></td>';
        }).join('')}
      </tr>`).join('');
  }

  function render() {
    el('view-poll').hidden = state.view !== 'poll';
    el('view-compare').hidden = state.view !== 'compare';
    el('pollSelect').disabled = state.view === 'compare';
    if (state.view === 'compare') renderCompare(); else renderPoll();
  }

  function initViewTabs() {
    el('viewTabs').querySelectorAll('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.view = btn.dataset.view;
        el('viewTabs').querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b === btn));
        render();
      });
    });
  }

  // Football polls are released weekly; let people look back. Basketball
  // also numbers its poll weeks, but the scoreboard has no week to anchor
  // on, so the picker only appears for week-based sports.
  function initWeekPicker() {
    const sport = CFB.sport();
    const meta = state.meta;
    if (sport.schedule !== 'week' || !meta.week) return;
    const options = ['<option value="">Latest</option>'];
    if (meta.seasonType === 3) options.push('<option value="3:1">Final / Postseason</option>');
    const lastRegular = meta.seasonType === 3 ? (sport.maxWeek || 15) : meta.week;
    // ESPN files the preseason poll as week 1.
    for (let w = lastRegular; w >= 2; w -= 1) options.push(`<option value="2:${w}">Week ${w}</option>`);
    options.push('<option value="2:1">Preseason</option>');
    const select = el('weekSelect');
    select.innerHTML = options.join('');
    select.hidden = false;
    el('weekLabel').hidden = false;
    select.onchange = () => loadRankings(select.value);
  }

  async function loadRankings(weekValue) {
    el('rankingsBody').innerHTML = '<tr><td colspan="7" class="empty-note">Loading&hellip;</td></tr>';
    try {
      const params = new URLSearchParams();
      if (weekValue) {
        const [seasontype, week] = weekValue.split(':');
        params.set('seasontype', seasontype);
        params.set('week', week);
        if (state.meta.season) params.set('year', state.meta.season);
      }
      const query = params.toString();
      const data = await CFB.getJson(CFB.withSport(`/api/rankings${query ? `?${query}` : ''}`));
      state.polls = (data.polls || []).slice().sort((a, b) => pollOrder(a) - pollOrder(b));

      const pollSelect = el('pollSelect');
      if (!state.polls.length) {
        el('rankingsBody').innerHTML = '<tr><td colspan="7" class="empty-note">Rankings aren\'t available for this week (often the case very early in the season before the first poll).</td></tr>';
        pollSelect.innerHTML = '';
        el('othersVotes').innerHTML = '';
        el('droppedOut').innerHTML = '';
        el('movers').innerHTML = '';
        renderCompare();
        return;
      }
      const previous = state.selectedPollId;
      pollSelect.innerHTML = state.polls.map((p) => `<option value="${CFB.esc(p.id)}">${CFB.esc(p.name)}</option>`).join('');
      // Keep the same poll when changing weeks. Otherwise lead with the
      // Playoff Committee rankings once they're out (November on), since
      // they decide the playoff, and fall back to AP before that.
      const keep = state.polls.find((p) => String(p.id) === String(previous));
      const cfp = state.polls.find((p) => pollOrder(p) === 0 && p.ranks && p.ranks.length);
      const ap = state.polls.find((p) => pollOrder(p) === 1);
      state.selectedPollId = (keep || cfp || ap || state.polls[0]).id;
      pollSelect.value = state.selectedPollId;
      pollSelect.onchange = () => {
        state.selectedPollId = pollSelect.value;
        render();
      };
      render();
    } catch (err) {
      el('rankingsBody').innerHTML = '<tr><td colspan="7" class="empty-note">Could not load rankings.</td></tr>';
    }
  }

  CFB.loadSports().then(async (sport) => {
    CFB.initSportBar();
    if (!sport.rankings) {
      el('sourceNote').textContent = sport.label;
      el('rankingsBody').innerHTML = `<tr><td colspan="7" class="empty-note">${CFB.esc(sport.label)} doesn't have polls. Try Standings instead.</td></tr>`;
      el('viewTabs').hidden = true;
      return;
    }
    state.meta = await CFB.getJson(CFB.withSport('/api/meta')).catch(() => ({}));
    el('sourceNote').textContent = state.meta.week
      ? `${sport.label} · ${state.meta.season} · Week ${state.meta.week}`
      : [sport.label, state.meta.season].filter(Boolean).join(' · ');
    initViewTabs();
    initWeekPicker();
    loadRankings('');
  });
})();

(function () {
  const el = CFB.el;
  const state = { favoriteTeamId: null, polls: [], selectedPollId: null };

  function trendHtml(rank) {
    if (!rank.previousRank || !rank.rank) return '<span style="color:var(--text-dim)">&mdash;</span>';
    if (rank.previousRank > rank.rank) return `<span class="trend-up">&#9650; ${rank.previousRank - rank.rank}</span>`;
    if (rank.previousRank < rank.rank) return `<span class="trend-down">&#9660; ${rank.rank - rank.previousRank}</span>`;
    return '<span style="color:var(--text-dim)">&mdash;</span>';
  }

  function renderPoll() {
    const poll = state.polls.find((p) => String(p.id) === String(state.selectedPollId));
    el('pollHeadline').textContent = poll ? (poll.name || 'Top 25') : 'Top 25';

    const body = el('rankingsBody');
    if (!poll || !poll.ranks || !poll.ranks.length) {
      body.innerHTML = '<tr><td colspan="6" class="empty-note">No rankings available for this poll right now.</td></tr>';
      el('othersVotes').innerHTML = '';
      return;
    }

    body.innerHTML = poll.ranks.map((r) => {
      const isFav = r.team && String(r.team.id) === String(state.favoriteTeamId);
      return `
        <tr class="${isFav ? 'is-favorite-row' : ''}">
          <td class="rank-cell">${r.rank}</td>
          <td>
            <div class="team-cell">
              ${r.team && r.team.logo ? `<img src="${r.team.logo}" alt="" onerror="this.style.display='none'">` : ''}
              ${r.team ? `<a class="team-link" href="${CFB.teamLink(r.team)}">${r.team.name}</a>` : 'TBD'}
            </div>
          </td>
          <td>${r.recordSummary || ''}</td>
          <td>${r.points !== null ? r.points : ''}</td>
          <td>${r.firstPlaceVotes || ''}</td>
          <td>${trendHtml(r)}</td>
        </tr>`;
    }).join('');

    const others = el('othersVotes');
    if (poll.others && poll.others.length) {
      others.innerHTML = `
        <strong>Others Receiving Votes</strong>
        <div class="others-list">
          ${poll.others.map((o) => `<span>${o.team ? o.team.name : 'Unknown'}${o.points ? ` (${o.points})` : ''}</span>`).join(', ')}
        </div>`;
    } else {
      others.innerHTML = '';
    }
  }

  let metaLoaded = false;

  async function loadRankings() {
    el('rankingsBody').innerHTML = '<tr><td colspan="6" class="empty-note">Loading&hellip;</td></tr>';
    try {
      if (!metaLoaded) {
        const meta = await CFB.getJson('/api/meta');
        state.favoriteTeamId = meta.favoriteTeamId;
        el('sourceNote').textContent = `${meta.season} · Week ${meta.week}`;
        metaLoaded = true;
      }

      const data = await CFB.getJson('/api/rankings');
      state.polls = data.polls || [];

      const pollSelect = el('pollSelect');
      if (!state.polls.length) {
        el('rankingsBody').innerHTML = '<tr><td colspan="6" class="empty-note">Rankings aren\'t available right now (often the case very early in the season before the first poll).</td></tr>';
        pollSelect.innerHTML = '';
        el('othersVotes').innerHTML = '';
        return;
      }
      pollSelect.innerHTML = state.polls.map((p) => `<option value="${p.id}">${p.name}</option>`).join('');
      // Prefer the AP poll by default if present.
      const ap = state.polls.find((p) => /ap/i.test(p.shortName || p.name || ''));
      state.selectedPollId = (ap || state.polls[0]).id;
      pollSelect.value = state.selectedPollId;
      pollSelect.onchange = () => {
        state.selectedPollId = pollSelect.value;
        renderPoll();
      };
      renderPoll();
    } catch (err) {
      el('rankingsBody').innerHTML = '<tr><td colspan="6" class="empty-note">Could not load rankings.</td></tr>';
    }
  }

  loadRankings();
})();

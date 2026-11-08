// Award races page (/awards.html): Heisman watch and position awards for
// college football, MVP and player of the year races for the NFL. Data from
// /api/awards (src/awards.js).
(function () {
  const el = (id) => document.getElementById(id);
  const esc = (v) => CFB.esc(v);
  const LABELS = { passYds: 'Pass yds', passTd: 'Pass TD', rushYds: 'Rush yds', rushTd: 'Rush TD', recYds: 'Rec yds', recTd: 'Rec TD', tackles: 'Tackles', sacks: 'Sacks', ints: 'INT', rating: 'Rating' };
  let data = null;
  let current = location.hash.replace('#', '') || null;

  function moveHtml(r) {
    if (r.isNew) return '<span class="award-move new" title="New this week">NEW</span>';
    if (!r.lastWeek) return '';
    const d = r.lastWeek - r.rank;
    if (!d) return '<span class="award-move same" title="Same as last week">&ndash;</span>';
    return `<span class="award-move ${d > 0 ? 'up' : 'down'}" title="Last week: ${r.lastWeek}">${d > 0 ? '&#9650;' : '&#9660;'}${Math.abs(d)}</span>`;
  }

  function render() {
    const awards = (data && data.awards) || [];
    if (!awards.length) {
      el('awardTabs').innerHTML = '';
      el('awardList').innerHTML = '<div class="empty-note">Award races are for college football and the NFL. Pick one of those above.</div>';
      return;
    }
    if (!awards.some((a) => a.key === current)) current = awards[0].key;
    const award = awards.find((a) => a.key === current);
    el('awardTabs').innerHTML = awards.map((a) => `<button type="button" class="tab-btn ${a.key === current ? 'active' : ''}" role="tab" aria-selected="${a.key === current}" data-award="${esc(a.key)}">${esc(a.name)}</button>`).join('');
    el('awardBlurb').textContent = award.blurb;
    const followed = CFB.follows.ids();
    el('awardList').innerHTML = award.rows.length ? `<ol class="award-list">${award.rows.map((r) => `
      <li class="award-row ${r.team && followed.has(String(r.team.id)) ? 'is-followed' : ''}">
        <span class="award-rank">${r.rank}</span>
        ${moveHtml(r)}
        ${r.athlete.headshot ? `<img class="award-photo" src="${CFB.safeUrl(r.athlete.headshot)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">` : '<span class="award-photo"></span>'}
        <span class="award-who">
          <a href="/player.html?id=${encodeURIComponent(r.athlete.id)}&amp;sport=${encodeURIComponent(data.sport)}">${esc(r.athlete.name)}</a>
          <small>${r.athlete.position ? `${esc(r.athlete.position)} &middot; ` : ''}${r.team ? `${r.team.logo ? `<img src="${CFB.safeUrl(r.team.logo)}" alt="" onerror="this.style.display='none'">` : ''}${esc(r.team.name || r.team.abbreviation || '')}` : ''}</small>
          <span class="award-stats">${Object.entries(r.stats).filter(([, v]) => v).map(([k, v]) => `<span>${esc(LABELS[k] || k)} <b>${esc(Number(v).toLocaleString())}</b></span>`).join('')}</span>
        </span>
        <span class="award-points" title="Points in this race">${esc(r.points)}</span>
      </li>`).join('')}</ol>` : '<div class="empty-note">No stats yet this season.</div>';
  }

  el('awardTabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-award]');
    if (!b) return;
    current = b.dataset.award;
    history.replaceState(null, '', `${location.pathname}${location.search}#${current}`);
    render();
  });

  CFB.loadSports().then(async () => {
    CFB.initSportBar();
    el('sourceNote').textContent = `${CFB.sport().label} · who's leading the race`;
    try {
      data = await CFB.getJson(CFB.withSport('/api/awards'));
    } catch (err) {
      el('awardList').innerHTML = '<div class="empty-note">Could not load the award races.</div>';
      return;
    }
    render();
  });
})();

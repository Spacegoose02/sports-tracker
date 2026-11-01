// "Where to listen" panel on the game page: radio stations, SiriusXM and
// free audio links. Loaded once per page view (radio info doesn't change
// mid-game), separate from game.js's live polling.
(function () {
  const params = new URLSearchParams(location.search);
  const gameId = params.get('id');
  const sport = params.get('sport') || 'college-football';
  const box = CFB.el('gameRadio');
  if (!box || !gameId || params.get('source') === 'ncaa-api') return;

  const esc = CFB.esc;
  const KIND_LABEL = { radio: 'Radio', satellite: 'SiriusXM', stream: 'Audio stream' };

  function stationHtml(s) {
    const extra = [s.channel ? `Ch. ${s.channel}` : null, s.lang && s.lang !== 'en' ? s.lang.toUpperCase() : null].filter(Boolean);
    return `<li><span class="radio-kind radio-kind-${esc(s.kind)}">${esc(KIND_LABEL[s.kind] || 'Audio')}</span> ${esc(s.name)}${extra.length ? ` <span class="radio-dim">(${extra.map(esc).join(', ')})</span>` : ''}</li>`;
  }

  function teamHtml(t) {
    const rows = [];
    if (t.flagship) {
      rows.push(`<li><span class="radio-kind radio-kind-radio">Flagship</span> ${esc(t.flagship.station)}${t.flagship.city ? ` <span class="radio-dim">${esc(t.flagship.city)}</span>` : ''}</li>`);
    }
    t.stations.forEach((s) => rows.push(stationHtml(s)));
    const links = [];
    if (t.listen) links.push(`<a href="${CFB.safeUrl(t.listen)}" target="_blank" rel="noopener">Official free audio</a>`);
    links.push(`<a href="${CFB.safeUrl(t.tuneIn)}" target="_blank" rel="noopener">Find on TuneIn</a>`);
    return `
      <div class="radio-team">
        <strong>${esc(t.name)}</strong> <span class="radio-dim">${t.homeAway === 'home' ? 'Home' : t.homeAway === 'away' ? 'Away' : ''} broadcast</span>
        ${rows.length ? `<ul class="radio-list">${rows.join('')}</ul>` : '<div class="radio-dim">Local affiliates vary by area.</div>'}
        <div class="radio-links">${links.join(' &middot; ')}</div>
      </div>`;
  }

  async function load() {
    try {
      const info = await CFB.getJson(`/api/game/${encodeURIComponent(gameId)}/radio?sport=${encodeURIComponent(sport)}`);
      const national = info.national && info.national.length
        ? `<div class="radio-team"><strong>National</strong><ul class="radio-list">${info.national.map(stationHtml).join('')}</ul></div>`
        : '';
      const sirius = info.siriusxm
        ? `<p class="radio-sirius">SiriusXM carries many college games, on channels that change week to week. <a href="${CFB.safeUrl(info.siriusxm)}" target="_blank" rel="noopener">See this week's SiriusXM channels</a></p>`
        : '';
      box.innerHTML = `
        <section>
          <h2 class="section-title">Where to Listen</h2>
          <div class="radio-box">
            ${national}
            <div class="radio-teams">${(info.teams || []).map(teamHtml).join('')}</div>
            ${sirius}
          </div>
        </section>`;
    } catch (err) {
      box.innerHTML = '';
    }
  }

  load();
})();

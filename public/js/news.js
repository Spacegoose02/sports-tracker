// News page (news.html): every sport's headlines in one place.
//
// ?sport=all (the "All sports" chip) mixes every league; ?sport=<key> shows
// one league, with "My teams" and a team / conference picker when that
// sport has standings. A text box filters what's loaded. Clicking a story
// opens a short preview here (photo, summary, source) with a link to read
// the full story at its publisher; videos for the sport run down the side.
(function () {
  const el = CFB.el;
  const esc = CFB.esc;
  const params = new URLSearchParams(location.search);
  const rawSport = params.get('sport');
  const MODE_KEY = 'tracker-newspage-mode';

  const state = {
    sport: rawSport === 'all' ? 'all' : null, // resolved after loadSports
    sports: [],
    mode: 'all',
    scope: params.get('team') ? `team:${params.get('team')}` : (params.get('conference') ? `conf:${params.get('conference')}` : ''),
    items: [],
    query: '',
    seq: 0,
  };

  function timeAgo(iso) {
    const ms = Date.now() - new Date(iso).getTime();
    if (!(ms >= 0)) return '';
    const mins = Math.round(ms / 60000);
    if (mins < 60) return `${Math.max(1, mins)}m ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
  }

  function sportLabel(key) {
    const s = state.sports.find((x) => x.key === key);
    return s ? (s.shortLabel || s.label) : String(key || '').toUpperCase();
  }

  function pageUrl(sport) {
    const q = new URLSearchParams();
    q.set('sport', sport);
    return `/news.html?${q.toString()}`;
  }

  function renderSportChips() {
    const chips = [{ key: 'all', label: 'All sports' }, ...state.sports.map((s) => ({ key: s.key, label: s.shortLabel || s.label }))];
    el('newsSports').innerHTML = chips.map((c) => `<a href="${esc(pageUrl(c.key))}" class="news-sport-chip${c.key === state.sport ? ' active' : ''}"${c.key === state.sport ? ' aria-current="page"' : ''}>${esc(c.label)}</a>`).join('');
  }

  function itemMeta(item) {
    const bits = [];
    if (state.sport === 'all' && item.sport) bits.push(`<span class="sport-tag">${esc(sportLabel(item.sport))}</span>`);
    if (item.source) bits.push(`<span>${esc(item.source)}</span>`);
    if (item.pubDate) bits.push(`<span>${esc(timeAgo(item.pubDate))}</span>`);
    return bits.join('<span aria-hidden="true">&middot;</span>');
  }

  function filtered() {
    const q = state.query.toLowerCase();
    const items = state.items.filter((i) => CFB.safeUrl(i.link));
    if (!q) return items;
    return items.filter((i) => `${i.title} ${i.summary || ''} ${i.source || ''}`.toLowerCase().includes(q));
  }

  function render() {
    const items = filtered();
    const lead = el('newsLead');
    const grid = el('newsGrid');
    if (!items.length) {
      lead.innerHTML = '';
      grid.innerHTML = `<div class="empty-note">${state.query ? 'No headlines match that filter.' : state.mode === 'mine' ? 'No recent headlines for the teams you follow. Try All.' : 'No news available right now.'}</div>`;
      return;
    }
    // The newest story with a photo leads the page.
    const leadIdx = items.findIndex((i) => CFB.safeUrl(i.image));
    const first = leadIdx >= 0 ? items[leadIdx] : null;
    lead.innerHTML = first ? `
      <button type="button" class="news-lead" data-idx="${state.items.indexOf(first)}">
        <img src="${CFB.safeUrl(first.image)}" alt="" onerror="this.remove()">
        <span class="news-lead-text">
          <span class="news-meta">${itemMeta(first)}</span>
          <span class="news-lead-title">${esc(first.title)}</span>
          ${first.summary ? `<span class="news-lead-summary">${esc(first.summary)}</span>` : ''}
        </span>
      </button>` : '';
    grid.innerHTML = items.filter((i) => i !== first).map((item) => `
      <button type="button" class="news-card${CFB.safeUrl(item.image) ? '' : ' no-thumb'}" data-idx="${state.items.indexOf(item)}">
        ${CFB.safeUrl(item.image) ? `<img src="${CFB.safeUrl(item.image)}" alt="" loading="lazy" onerror="this.remove()">` : ''}
        <span class="news-card-text">
          <span class="news-card-title">${esc(item.title)}</span>
          <span class="news-meta">${itemMeta(item)}</span>
        </span>
      </button>`).join('');
  }

  function openReader(item) {
    const link = CFB.safeUrl(item.link);
    el('readerBody').innerHTML = `
      ${CFB.safeUrl(item.image) ? `<img class="reader-img" src="${CFB.safeUrl(item.image)}" alt="" onerror="this.remove()">` : ''}
      <div class="news-meta">${itemMeta(item)}</div>
      <h2 id="readerTitle">${esc(item.title)}</h2>
      ${item.summary ? `<p class="reader-summary">${esc(item.summary)}</p>` : '<p class="reader-summary empty-note">No preview for this story.</p>'}
      <div class="reader-actions">
        <a class="reader-go" href="${link}" target="_blank" rel="noopener noreferrer">Read the full story${item.source ? ` at ${esc(item.source)}` : ''} &rarr;</a>
        <button type="button" class="reader-share" id="readerShare">Copy link</button>
      </div>`;
    const reader = el('newsReader');
    reader.hidden = false;
    document.body.classList.add('reader-open');
    el('readerClose').focus();
    el('readerShare').addEventListener('click', async () => {
      try {
        if (navigator.share) await navigator.share({ title: item.title, url: item.link });
        else { await navigator.clipboard.writeText(item.link); el('readerShare').textContent = 'Copied'; }
      } catch (err) { /* cancelled */ }
    });
  }

  function closeReader() {
    el('newsReader').hidden = true;
    document.body.classList.remove('reader-open');
  }

  function newsUrl() {
    if (state.sport === 'all') return '/api/news/all';
    const sp = `sport=${encodeURIComponent(state.sport)}`;
    if (state.mode === 'mine') {
      const ids = CFB.follows.list(state.sport).map((t) => t.id);
      return `/api/news/teams?teams=${encodeURIComponent(ids.join(','))}&${sp}`;
    }
    if (state.scope) {
      const [type, id] = state.scope.split(':');
      return `/api/news?${type === 'team' ? 'team' : 'conference'}=${encodeURIComponent(id || '')}&${sp}`;
    }
    return `/api/news?${sp}`;
  }

  async function loadNews() {
    const mine = ++state.seq;
    el('newsGrid').innerHTML = '<div class="empty-note">Loading&hellip;</div>';
    el('newsLead').innerHTML = '';
    try {
      const data = await CFB.getJson(newsUrl());
      if (mine !== state.seq) return;
      state.items = data.items || [];
    } catch (err) {
      if (mine !== state.seq) return;
      state.items = [];
      el('newsGrid').innerHTML = '<div class="empty-note">Could not load news right now.</div>';
      return;
    }
    render();
  }

  async function loadVideos() {
    const key = state.sport === 'all' ? 'cfb' : state.sport;
    const box = el('newsVideos');
    try {
      const data = await CFB.getJson(`/api/videos?sport=${encodeURIComponent(key)}`);
      const vids = (data.items || []).filter((v) => CFB.safeUrl(v.url || v.embedUrl)).slice(0, 8);
      if (!vids.length) { el('newsSide').hidden = true; return; }
      box.innerHTML = vids.map((v) => `
        <a class="news-video" href="${CFB.safeUrl(v.url || v.embedUrl)}" target="_blank" rel="noopener noreferrer">
          <span class="news-video-thumb">${CFB.safeUrl(v.thumbnail) ? `<img src="${CFB.safeUrl(v.thumbnail)}" alt="" loading="lazy" onerror="this.remove()">` : ''}<span class="news-video-play" aria-hidden="true">&#9654;</span></span>
          <span class="news-video-text"><span class="news-video-title">${esc(v.title)}</span><span class="news-meta">${esc(v.channel || '')}${v.publishedAt ? ` &middot; ${esc(timeAgo(v.publishedAt))}` : ''}</span></span>
        </a>`).join('');
    } catch (err) {
      el('newsSide').hidden = true;
    }
  }

  // Team / conference picker, from the sport's standings (same as the
  // Scores page's News tab).
  async function loadScopes() {
    const wrap = el('newsScopeWrap');
    const select = el('newsScope');
    const s = state.sports.find((x) => x.key === state.sport);
    if (!s || !s.standings || s.teams === false) return;
    try {
      const data = await CFB.getJson(`/api/standings?sport=${encodeURIComponent(state.sport)}`);
      const confs = (data.conferences || []).filter((c) => (c.entries || []).length);
      if (!confs.length) return;
      select.insertAdjacentHTML('beforeend', confs.map((c) => {
        const id = c.abbreviation || c.name;
        const label = String(c.name || id).replace(/\s+Conference$/i, '');
        const teams = (c.entries || []).filter((e) => e.team && e.team.id)
          .slice().sort((a, b) => String(a.team.name).localeCompare(String(b.team.name)))
          .map((e) => `<option value="team:${esc(e.team.id)}">${esc(e.team.name)}</option>`).join('');
        const all = /independent/i.test(label) ? '' : `<option value="conf:${esc(id)}">All ${esc(label)}</option>`;
        return `<optgroup label="${esc(label)}">${all}${teams}</optgroup>`;
      }).join(''));
      wrap.hidden = false;
      select.value = state.scope;
      if (select.value !== state.scope) state.scope = '';
    } catch (err) { /* no picker */ }
  }

  function wire() {
    const modes = el('newsModes');
    const hasFollows = state.sport !== 'all' && CFB.follows.list(state.sport).length > 0;
    modes.hidden = !hasFollows;
    const paintModes = () => modes.querySelectorAll('button').forEach((b) => {
      const on = b.dataset.mode === state.mode && !state.scope;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    modes.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
      state.mode = b.dataset.mode;
      state.scope = '';
      el('newsScope').value = '';
      try { localStorage.setItem(MODE_KEY, state.mode); } catch (e) { /* ignore */ }
      paintModes();
      loadNews();
    }));
    el('newsScope').addEventListener('change', () => {
      state.scope = el('newsScope').value;
      state.mode = 'all';
      paintModes();
      loadNews();
    });
    let t = null;
    el('newsQuery').addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(() => { state.query = el('newsQuery').value.trim(); render(); }, 150);
    });
    const open = (e) => {
      const card = e.target.closest('[data-idx]');
      if (!card) return;
      const item = state.items[Number(card.dataset.idx)];
      if (item) openReader(item);
    };
    el('newsLead').addEventListener('click', open);
    el('newsGrid').addEventListener('click', open);
    el('readerClose').addEventListener('click', closeReader);
    el('newsReader').addEventListener('click', (e) => { if (e.target === el('newsReader')) closeReader(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !el('newsReader').hidden) closeReader(); });
    paintModes();
  }

  CFB.loadSports().then(async (sport) => {
    try {
      const data = await CFB.getJson('/api/sports');
      state.sports = data.sports || [];
    } catch (err) {
      state.sports = [];
    }
    if (!state.sport) state.sport = rawSport && state.sports.some((s) => s.key === rawSport) ? rawSport : sport.key;
    if (state.sport !== 'all' && !state.scope && CFB.follows.list(state.sport).length) {
      let saved = null;
      try { saved = localStorage.getItem(MODE_KEY); } catch (e) { /* ignore */ }
      state.mode = saved === 'all' ? 'all' : 'mine';
    }
    el('sourceNote').textContent = state.sport === 'all' ? 'Every sport' : (state.sports.find((s) => s.key === state.sport) || {}).label || 'Latest headlines';
    document.title = `${state.sport === 'all' ? '' : `${sportLabel(state.sport)} `}News · Stat Scraps`;
    renderSportChips();
    wire();
    loadScopes();
    loadNews();
    loadVideos();
  });
})();

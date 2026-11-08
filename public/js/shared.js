// Shared helpers used by index.js, team.js, rankings.js, standings.js.
// Everything here assumes the page includes a #modalBackdrop / #modalContent
// pair (see index.html / team.html) for the game-detail popup.

const CFB = (function () {
  const el = (id) => document.getElementById(id);

  // Escape text before it goes into an innerHTML template. Everything that
  // comes from outside this app (ESPN, RSS feeds, YouTube, admin notes)
  // must go through this, so a stray "<" can't turn into markup or script.
  function esc(value) {
    if (value === null || value === undefined) return '';
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Only http(s) and same-site relative URLs may be used for links and
  // images; anything else (javascript:, data:, ...) becomes empty. The
  // result is attribute-escaped and safe to drop into src="" or href="".
  function safeUrl(value) {
    if (!value) return '';
    const str = String(value).trim();
    if (/^\/(?!\/)/.test(str)) return esc(str);
    try {
      const url = new URL(str);
      return url.protocol === 'http:' || url.protocol === 'https:' ? esc(url.toString()) : '';
    } catch (err) {
      return '';
    }
  }

  // ---- Sport selection -------------------------------------------------
  // The current sport comes from ?sport= in the URL (so links are
  // shareable), else the last one picked (localStorage), else college
  // football. The list of sports is fetched once from /api/sports.
  const SPORT_STORAGE_KEY = 'tracker-sport';
  const DEFAULT_SPORT = 'cfb';

  function readSportKey() {
    const fromUrl = new URLSearchParams(location.search).get('sport');
    if (fromUrl) return fromUrl;
    try { return localStorage.getItem(SPORT_STORAGE_KEY) || DEFAULT_SPORT; } catch (e) { return DEFAULT_SPORT; }
  }

  let sportKey = readSportKey();
  let sportList = null;
  let sportInfo = null;

  async function loadSports() {
    if (sportInfo) return sportInfo;
    try {
      const data = await getJson('/api/sports');
      sportList = data.sports || [];
    } catch (err) {
      sportList = [];
    }
    sportInfo = sportList.find((s) => s.key === sportKey) || sportList.find((s) => s.key === DEFAULT_SPORT) || {
      key: DEFAULT_SPORT, label: 'College Football', shortLabel: 'CFB', schedule: 'week', maxWeek: 15,
      seasonTypes: [{ value: 2, label: 'Regular Season' }, { value: 3, label: 'Postseason / Bowls' }],
      groups: [{ key: 'fbs', label: 'FBS', value: 80 }, { key: 'fcs', label: 'FCS', value: 81 }],
      rankings: true, field: true, notable: true, periodPrefix: 'Q',
    };
    sportKey = sportInfo.key;
    try { localStorage.setItem(SPORT_STORAGE_KEY, sportKey); } catch (e) { /* ignore */ }
    // Every page loads sports first, so this is where a signed-in user's
    // followed teams are pulled from their account.
    await account.load();
    initAccountLink();
    initSiteNav();
    initLiveTicker();
    return sportInfo;
  }

  function sport() {
    return sportInfo || { key: sportKey, periodPrefix: 'Q' };
  }

  // Adds ?sport= to an API or page URL.
  function withSport(url) {
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}sport=${encodeURIComponent(sportKey)}`;
  }

  // Sport picker row at the top of <main>, plus sport-aware nav links.
  // Changing sport reloads the current list page for the new sport; on a
  // team or game page (which belong to one sport) it goes to that sport's
  // Scores page.
  function initSportBar() {
    const main = document.querySelector('main');
    if (!main || !sportList || sportList.length < 2) return;
    const bar = document.createElement('nav');
    bar.className = 'sport-bar';
    bar.setAttribute('aria-label', 'Sport');
    sportList.forEach((s) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = s.shortLabel;
      btn.title = s.label;
      btn.className = s.key === sportKey ? 'active' : '';
      btn.setAttribute('aria-pressed', s.key === sportKey ? 'true' : 'false');
      btn.addEventListener('click', () => {
        if (s.key === sportKey) return;
        try { localStorage.setItem(SPORT_STORAGE_KEY, s.key); } catch (e) { /* ignore */ }
        const listPages = ['/scores', '/index.html', '/upcoming.html', '/rankings.html', '/standings.html', '/leaders.html', '/lines.html', '/kids.html', '/compare.html'];
        let page = listPages.includes(location.pathname) ? location.pathname : '/scores';
        if (page === '/rankings.html' && !s.rankings) page = '/scores';
        if (page === '/standings.html' && s.standings === false) page = '/scores';
        if (page === '/leaders.html' && !s.leaders) page = '/scores';
        if (page === '/compare.html' && s.teams === false) page = '/scores';
        location.href = `${page}?sport=${encodeURIComponent(s.key)}`;
      });
      bar.appendChild(btn);
    });
    main.insertBefore(bar, main.firstChild);

    document.querySelectorAll('nav.top-nav a').forEach((a) => {
      if (a.closest('.nav-links')) return; // built by initSiteNav, already sport-aware
      const href = a.getAttribute('href');
      if (!href || !href.startsWith('/') || href.startsWith('/admin')) return;
      if (href === '/rankings.html' && !sport().rankings) { a.remove(); return; }
      if (href === '/standings.html' && sport().standings === false) { a.remove(); return; }
      if (href === '/leaders.html' && !sport().leaders) { a.remove(); return; }
      if (href === '/compare.html' && sport().teams === false) { a.remove(); return; }
      // Recruiting is college football only; lines need two-team games.
      if (href === '/recruiting.html' && sportKey !== DEFAULT_SPORT) { a.remove(); return; }
      if (href === '/lines.html' && sport().format && sport().format !== 'game') { a.remove(); return; }
      a.setAttribute('href', withSport(href));
    });

    const foot = document.querySelector('footer.foot');
    if (foot && sportKey !== DEFAULT_SPORT) foot.textContent = `Stat Scraps · ${sport().label}`;
  }

  async function getJson(url, opts) {
    const res = await fetch(url, opts);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Request failed: ${res.status}`);
    }
    return res.json();
  }

  // ---- Followed teams ----------------------------------------------------
  // Each visitor follows their own teams, any number per sport, saved in
  // their browser. Entries are { sport, id, name, abbreviation, logo }.
  const FOLLOW_KEY = 'tracker-follows';
  const FOLLOW_SEEDED_KEY = 'tracker-follows-seeded';
  const MAX_FOLLOWS = 30;

  function readFollows() {
    try {
      const list = JSON.parse(localStorage.getItem(FOLLOW_KEY) || '[]');
      return Array.isArray(list) ? list.filter((t) => t && t.sport && t.id) : [];
    } catch (e) {
      return [];
    }
  }

  function writeFollows(list) {
    try { localStorage.setItem(FOLLOW_KEY, JSON.stringify(list.slice(0, MAX_FOLLOWS))); } catch (e) { /* ignore */ }
  }

  // ---- Account ----------------------------------------------------------
  // Signed-in users keep their followed teams on the server. localStorage
  // stays the working copy every page reads (so follows.* stays
  // synchronous), refreshed from the account on each page load; changes are
  // written to both. FOLLOW_OWNER_KEY records whose account the local list
  // mirrors: the first sign-in on a device merges the teams followed there
  // before signing in into the account, and later page loads just take the
  // account's list.
  const FOLLOW_OWNER_KEY = 'tracker-follows-owner';
  let accountInfo = null;
  let accountLoad = null;

  function storageGet(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }
  function storageSet(key, value) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch (e) { /* ignore */ }
  }

  function postJson(url, body, method) {
    return getJson(url, { method: method || 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  }

  const account = {
    // Resolves to the /api/account/me response ({ user: null } when signed
    // out or the server can't be reached).
    load(force) {
      if (accountLoad && !force) return accountLoad;
      accountLoad = (async () => {
        let me;
        try {
          me = await getJson('/api/account/me');
        } catch (e) {
          accountInfo = { user: null, options: {} };
          return accountInfo;
        }
        accountInfo = me;
        const owner = storageGet(FOLLOW_OWNER_KEY);
        if (me.user) {
          let list = me.follows || [];
          if (owner !== String(me.user.id)) {
            const local = readFollows();
            if (local.length) {
              try { list = (await postJson('/api/account/follows/merge', { follows: local })).follows; } catch (e) { /* keep server list */ }
            }
            storageSet(FOLLOW_OWNER_KEY, String(me.user.id));
            storageSet(FOLLOW_SEEDED_KEY, '1');
          }
          me.follows = list;
          writeFollows(list.map((t) => ({ sport: t.sport, id: String(t.id), name: t.name || null, abbreviation: t.abbreviation || null, logo: t.logo || null })));
        } else if (owner) {
          // Signed out elsewhere or the session expired: keep showing the
          // teams, and merge them back on the next sign-in.
          storageSet(FOLLOW_OWNER_KEY, null);
        }
        return accountInfo;
      })();
      return accountLoad;
    },
    user() {
      return accountInfo && accountInfo.user;
    },
    info() {
      return accountInfo;
    },
    async logout() {
      await postJson('/api/account/logout');
      // Clear this device's copy so the next person to sign in here doesn't
      // inherit these teams.
      writeFollows([]);
      storageSet(FOLLOW_OWNER_KEY, null);
      storageSet(FOLLOW_SEEDED_KEY, '1');
      accountInfo = { user: null, options: accountInfo ? accountInfo.options : {} };
      accountLoad = Promise.resolve(accountInfo);
    },
    postJson,
  };

  // "Sign in" / your name, at the end of the top nav on every page.
  function initAccountLink() {
    const nav = document.querySelector('nav.top-nav');
    if (!nav || nav.querySelector('.account-link')) return;
    const a = document.createElement('a');
    a.className = 'account-link';
    a.href = '/account.html';
    const user = account.user();
    a.textContent = user ? user.displayName : 'Sign in';
    if (user) a.title = 'Your account, alerts and calendar';
    nav.appendChild(a);
  }

  // ---- Site navigation ----------------------------------------------------
  // Every page used to hand-write its own row of 7 to 9 nav pills. This
  // swaps them for one consistent set: four main links plus a "More" menu,
  // and on phones a bottom tab bar. Buttons other scripts add to the nav
  // (theme, language, kid mode, account) are left where they are; any
  // link a script adds later is folded into the More menu.
  function navItems() {
    const s = sport();
    const isCfb = sportKey === DEFAULT_SPORT;
    const twoTeamGames = !s.format || s.format === 'game';
    const kid = kidMode();
    return {
      primary: [
        { href: '/', label: 'Home', icon: '&#127968;', plain: true },
        { href: '/scores', label: 'Scores', icon: '&#127967;', match: ['/scores', '/index.html'] },
        s.rankings ? { href: '/rankings.html', label: 'Rankings', icon: '&#128202;' } : null,
        s.standings !== false && s.teams !== false ? { href: '/standings.html', label: 'Standings', icon: '&#128203;' } : null,
        { href: '/brackets.html', label: 'Playoffs', icon: '&#127942;', cls: 'playoffs-link', plain: true },
      ].filter(Boolean),
      more: [
        { href: '/upcoming.html', label: 'Upcoming', icon: '&#128197;' },
        s.leaders ? { href: '/leaders.html', label: 'Leaders', icon: '&#11088;' } : null,
        s.teams !== false ? { href: '/compare.html', label: 'Compare teams', icon: '&#9878;' } : null,
        twoTeamGames && !kid ? { href: '/lines.html', label: 'Lines & odds', icon: '&#128200;' } : null,
        isCfb ? { href: '/race.html', label: 'Conference race', icon: '&#127937;', plain: true } : null,
        isCfb ? { href: '/recruiting.html', label: 'Recruiting', icon: '&#127891;', plain: true } : null,
        s.key === 'cfb' || s.key === 'nfl' ? { href: '/awards.html', label: s.key === 'nfl' ? 'MVP race' : 'Heisman watch', icon: '&#127941;' } : null,
        { href: '/wall.html', label: 'TV Wall', icon: '&#128250;', plain: true },
        { href: '/multiview.html', label: 'Multiview', icon: '&#9638;', plain: true },
        { href: '/kids.html', label: 'Kids', icon: '&#129437;', cls: 'kids-link', plain: true },
      ].filter(Boolean),
    };
  }

  function navLinkHtml(item, inMenu) {
    const href = item.plain ? item.href : withSport(item.href);
    const paths = item.match || [item.href];
    const current = paths.includes(location.pathname);
    return `<a href="${esc(href)}" class="${item.cls || ''} ${inMenu ? 'nav-menu-link' : 'nav-main-link'}"${current ? ' aria-current="page"' : ''}>${inMenu ? `<span class="nav-icon" aria-hidden="true">${item.icon}</span>` : ''}${esc(item.label)}</a>`;
  }

  function initSiteNav() {
    const nav = document.querySelector('nav.top-nav');
    if (!nav || nav.dataset.siteNav) return;
    nav.dataset.siteNav = '1';
    const items = navItems();
    // Drop the page's own hand-written links; keep buttons and the account link.
    nav.querySelectorAll(':scope > a:not(.account-link)').forEach((a) => a.remove());
    const links = document.createElement('div');
    links.className = 'nav-links';
    links.innerHTML = `
      ${items.primary.map((i) => navLinkHtml(i, false)).join('')}
      <div class="nav-more">
        <button type="button" class="nav-more-btn" aria-expanded="false" aria-controls="navMoreMenu">More <span aria-hidden="true">&#9662;</span></button>
        <div class="nav-more-menu" id="navMoreMenu" hidden>
          ${items.primary.slice(4).map((i) => navLinkHtml({ ...i, cls: `${i.cls || ''} phone-only` }, true)).join('')}
          ${items.more.map((i) => navLinkHtml(i, true)).join('')}
        </div>
      </div>`;
    nav.insertBefore(links, nav.firstChild);

    // The logo and site name go to the home page, like on most sites.
    const brand = document.querySelector('header.top .brand');
    if (brand && !brand.closest('a') && location.pathname !== '/') {
      brand.classList.add('brand-home');
      brand.title = 'Stat Scraps home';
      brand.addEventListener('click', () => { location.href = '/'; });
    }

    const menu = links.querySelector('.nav-more-menu');
    const moreBtn = links.querySelector('.nav-more-btn');
    const moreWrap = links.querySelector('.nav-more');
    const phone = window.matchMedia ? window.matchMedia('(max-width: 720px)') : { matches: false };
    const setOpen = (open) => {
      // On phones the menu is a sheet over the page; the header can be a
      // containing block for fixed children, so the sheet moves to <body>.
      if (open) {
        const home = phone.matches ? document.body : moreWrap;
        if (menu.parentNode !== home) home.appendChild(menu);
        menu.classList.toggle('as-sheet', phone.matches);
      }
      menu.hidden = !open;
      moreBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
      document.body.classList.toggle('nav-menu-open', open);
      const tab = document.querySelector('.bottom-tabs .bottom-more');
      if (tab) tab.setAttribute('aria-expanded', open ? 'true' : 'false');
    };
    moreBtn.addEventListener('click', (e) => { e.stopPropagation(); setOpen(menu.hidden); });
    document.addEventListener('click', (e) => { if (!menu.hidden && !menu.contains(e.target)) setOpen(false); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !menu.hidden) { setOpen(false); moreBtn.focus(); } });

    // Links other scripts append later (kids.js, older pages) go in More,
    // unless one with the same page is already there.
    const hasPage = (href) => {
      const path = href.split('?')[0];
      return [...links.querySelectorAll('a')].some((a) => a.getAttribute('href').split('?')[0] === path);
    };
    const adopt = () => {
      nav.querySelectorAll(':scope > a:not(.account-link)').forEach((a) => {
        const href = a.getAttribute('href') || '';
        if (hasPage(href)) { a.remove(); return; }
        a.classList.add('nav-menu-link');
        menu.appendChild(a);
      });
    };
    new MutationObserver(adopt).observe(nav, { childList: true });
    initSearch(nav);

    // Phones: a bottom tab bar with the same main links.
    if (!document.querySelector('.bottom-tabs')) {
      const bar = document.createElement('nav');
      bar.className = 'bottom-tabs';
      bar.setAttribute('aria-label', 'Main');
      const tabs = items.primary.slice(0, 4);
      bar.innerHTML = `
        ${tabs.map((i) => {
          const paths = i.match || [i.href];
          const current = paths.includes(location.pathname);
          return `<a href="${esc(i.plain ? i.href : withSport(i.href))}"${current ? ' aria-current="page"' : ''}><span class="bt-icon" aria-hidden="true">${i.icon}</span><span>${esc(i.label)}</span></a>`;
        }).join('')}
        <button type="button" class="bottom-more" aria-expanded="false" aria-controls="navMoreMenu"><span class="bt-icon" aria-hidden="true">&#9776;</span><span>More</span></button>`;
      bar.querySelector('.bottom-more').addEventListener('click', (e) => { e.stopPropagation(); setOpen(menu.hidden); });
      document.body.appendChild(bar);
      document.body.classList.add('has-bottom-tabs');
    }
  }

  // ---- Site-wide search ------------------------------------------------
  // A search button in the header (or "/" and Ctrl+K) opens a box that finds
  // teams in every sport, players and pages. Picks are remembered so the box
  // opens on recent ones.
  const SEARCH_RECENT_KEY = 'tracker-search-recent';

  function sportShort(key) {
    const s = (sportList || []).find((x) => x.key === key);
    return s ? s.shortLabel : String(key || '').toUpperCase();
  }

  function searchRecent() {
    try {
      const list = JSON.parse(localStorage.getItem(SEARCH_RECENT_KEY) || '[]');
      return Array.isArray(list) ? list.filter((r) => r && r.href && r.name).slice(0, 6) : [];
    } catch (e) { return []; }
  }

  function rememberSearch(item) {
    const list = [item, ...searchRecent().filter((r) => r.href !== item.href)].slice(0, 6);
    try { localStorage.setItem(SEARCH_RECENT_KEY, JSON.stringify(list)); } catch (e) { /* ignore */ }
  }

  function searchPages(q) {
    const items = navItems();
    const pages = [...items.primary, ...items.more, { href: '/account.html', label: 'Account and settings', icon: '&#128100;', plain: true }];
    const n = q.toLowerCase();
    return pages
      .filter((p) => p.label.toLowerCase().split(/\s+/).some((w) => w.startsWith(n)) || p.label.toLowerCase().includes(n))
      .slice(0, 4)
      .map((p) => ({ kind: 'page', name: p.label, href: p.plain ? p.href : withSport(p.href), icon: p.icon }));
  }

  function searchResultHtml(r, i) {
    const art = r.logo || r.headshot
      ? `<img class="sr-art${r.kind === 'player' ? ' round' : ''}" src="${esc(r.logo || r.headshot)}" alt="" loading="lazy" />`
      : `<span class="sr-art sr-icon" aria-hidden="true">${r.icon || (r.kind === 'player' ? '&#128100;' : '&#127944;')}</span>`;
    return `<a class="sr-item" role="option" id="sr-${i}" href="${esc(r.href)}" data-index="${i}">
      ${art}
      <span class="sr-text"><span class="sr-name">${esc(r.name)}</span>${r.sub ? `<span class="sr-sub">${esc(r.sub)}</span>` : ''}</span>
      ${r.sport ? `<span class="sr-sport">${esc(sportShort(r.sport))}</span>` : ''}
    </a>`;
  }

  function initSearch(nav) {
    if (document.querySelector('.search-btn')) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'search-btn';
    btn.setAttribute('aria-label', 'Search teams and players');
    btn.title = 'Search (/)';
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M15.5 15.5 21 21" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg><span class="search-btn-label">Search</span>';
    nav.insertBefore(btn, nav.querySelector('.nav-links').nextSibling);

    const overlay = document.createElement('div');
    overlay.className = 'search-overlay';
    overlay.hidden = true;
    overlay.innerHTML = `
      <div class="search-panel" role="dialog" aria-modal="true" aria-label="Search">
        <div class="search-field">
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M15.5 15.5 21 21" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>
          <input type="search" class="search-input" placeholder="Teams, players or pages" autocomplete="off" spellcheck="false"
            role="combobox" aria-expanded="true" aria-controls="searchResults" aria-autocomplete="list" />
          <button type="button" class="search-close">Esc</button>
        </div>
        <div class="search-results" id="searchResults" role="listbox" aria-label="Results"></div>
      </div>`;
    document.body.appendChild(overlay);
    const input = overlay.querySelector('.search-input');
    const results = overlay.querySelector('.search-results');
    let flat = [];
    let active = -1;
    let timer = null;
    let seq = 0;
    let lastFocus = null;

    const setActive = (i) => {
      const nodes = results.querySelectorAll('.sr-item');
      nodes.forEach((n) => n.classList.toggle('active', Number(n.dataset.index) === i));
      active = i;
      const node = results.querySelector(`#sr-${i}`);
      if (node) { input.setAttribute('aria-activedescendant', node.id); node.scrollIntoView({ block: 'nearest' }); } else input.removeAttribute('aria-activedescendant');
    };

    const render = (groups, note) => {
      flat = [];
      const html = groups.filter((g) => g.items.length).map((g) => {
        const rows = g.items.map((r) => { flat.push(r); return searchResultHtml(r, flat.length - 1); }).join('');
        return `<div class="sr-group"><div class="sr-head">${esc(g.title)}</div>${rows}</div>`;
      }).join('');
      results.innerHTML = html || `<div class="sr-empty">${esc(note || 'No matches')}</div>`;
      setActive(flat.length ? 0 : -1);
    };

    const showRecent = () => {
      const recent = searchRecent();
      if (recent.length) render([{ title: 'Recent', items: recent }]);
      else results.innerHTML = '<div class="sr-empty">Try a team like &ldquo;Hokies&rdquo;, an abbreviation like &ldquo;KC&rdquo;, or a player&rsquo;s name.</div>';
      if (!recent.length) { flat = []; active = -1; }
    };

    const run = async (q) => {
      const mine = ++seq;
      const pages = searchPages(q);
      if (q.length < 2) { render([{ title: 'Pages', items: pages }], 'Keep typing'); return; }
      results.classList.add('loading');
      try {
        const data = await getJson(`/api/search?q=${encodeURIComponent(q)}`);
        if (mine !== seq) return;
        const followed = new Set();
        try { (follows.all ? follows.all() : []).forEach((f) => followed.add(`${f.sport}:${f.id}`)); } catch (e) { /* ignore */ }
        const teams = (data.teams || []).map((t) => ({
          kind: 'team', name: t.name, sport: t.sport, logo: t.logo,
          sub: followed.has(`${t.sport}:${t.id}`) ? 'Following' : null,
          href: `/team.html?id=${encodeURIComponent(t.id)}&source=espn&sport=${encodeURIComponent(t.sport)}`,
        })).sort((a, b) => (b.sub ? 1 : 0) - (a.sub ? 1 : 0));
        const players = (data.players || []).map((p) => ({
          kind: 'player', name: p.name, sport: p.sport, headshot: p.headshot, sub: p.team,
          href: `/player.html?id=${encodeURIComponent(p.id)}&sport=${encodeURIComponent(p.sport)}`,
        }));
        render([{ title: 'Teams', items: teams }, { title: 'Players', items: players }, { title: 'Pages', items: pages }],
          data.playersError ? 'No teams match, and player search is unavailable right now' : 'No matches');
      } catch (err) {
        if (mine === seq) render([{ title: 'Pages', items: pages }], 'Search is unavailable right now');
      } finally {
        if (mine === seq) results.classList.remove('loading');
      }
    };

    const open = () => {
      if (!overlay.hidden) return;
      lastFocus = document.activeElement;
      overlay.hidden = false;
      document.body.classList.add('search-open');
      input.value = '';
      showRecent();
      setTimeout(() => input.focus(), 0);
    };
    const close = () => {
      if (overlay.hidden) return;
      overlay.hidden = true;
      document.body.classList.remove('search-open');
      seq++;
      if (lastFocus && lastFocus.focus) lastFocus.focus();
    };
    const go = (r) => {
      if (!r) return;
      rememberSearch({ kind: r.kind, name: r.name, href: r.href, sport: r.sport || null, logo: r.logo || null, headshot: r.headshot || null, icon: r.icon || null, sub: r.kind === 'player' ? r.sub : null });
      location.href = r.href;
    };

    btn.addEventListener('click', open);
    overlay.querySelector('.search-close').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    results.addEventListener('click', (e) => {
      const a = e.target.closest('.sr-item');
      if (!a || e.metaKey || e.ctrlKey || e.shiftKey) return;
      e.preventDefault();
      go(flat[Number(a.dataset.index)]);
    });
    input.addEventListener('input', () => {
      clearTimeout(timer);
      const q = input.value.trim();
      if (!q) { seq++; showRecent(); return; }
      timer = setTimeout(() => run(q), 180);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' && flat.length) { e.preventDefault(); setActive((active + 1) % flat.length); }
      else if (e.key === 'ArrowUp' && flat.length) { e.preventDefault(); setActive((active - 1 + flat.length) % flat.length); }
      else if (e.key === 'Enter') { e.preventDefault(); go(flat[active]); }
      else if (e.key === 'Escape') { e.preventDefault(); close(); }
    });
    document.addEventListener('keydown', (e) => {
      const t = e.target;
      const typing = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
      if ((e.key === '/' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k')) {
        e.preventDefault();
        open();
      }
    });
  }

  function syncFollow(method, team, key) {
    if (!account.user()) return;
    const req = method === 'DELETE'
      ? getJson(`/api/account/follows/${encodeURIComponent(key)}/${encodeURIComponent(team.id)}`, { method: 'DELETE' })
      : postJson('/api/account/follows', { sport: key, id: String(team.id), name: team.name || null, abbreviation: team.abbreviation || null, logo: team.logo || null });
    req.catch(() => { /* the next page load re-syncs from the account */ });
  }

  const follows = {
    // Followed teams for one sport (default: the current sport).
    list(sportKeyArg) {
      const key = sportKeyArg || sportKey;
      return readFollows().filter((t) => t.sport === key);
    },
    ids(sportKeyArg) {
      return new Set(follows.list(sportKeyArg).map((t) => String(t.id)));
    },
    has(teamId, sportKeyArg) {
      return follows.ids(sportKeyArg).has(String(teamId));
    },
    add(team, sportKeyArg) {
      const key = sportKeyArg || sportKey;
      if (!team || !team.id || follows.has(team.id, key)) return;
      const list = readFollows();
      list.push({ sport: key, id: String(team.id), name: team.name || null, abbreviation: team.abbreviation || null, logo: team.logo || null });
      writeFollows(list);
      syncFollow('POST', team, key);
    },
    remove(teamId, sportKeyArg) {
      const key = sportKeyArg || sportKey;
      writeFollows(readFollows().filter((t) => !(t.sport === key && String(t.id) === String(teamId))));
      syncFollow('DELETE', { id: teamId }, key);
    },
    // Every followed team in every sport.
    all() {
      return readFollows();
    },
    toggle(team, sportKeyArg) {
      if (follows.has(team.id, sportKeyArg)) { follows.remove(team.id, sportKeyArg); return false; }
      follows.add(team, sportKeyArg);
      return true;
    },
    // The server's FAVORITE_TEAM_ID used to be the only "my team". Follow
    // it once on a visitor's first visit so nothing disappears for them;
    // if they unfollow it later it stays unfollowed.
    seedDefault(teamId, name) {
      if (!teamId) return;
      try {
        if (localStorage.getItem(FOLLOW_SEEDED_KEY)) return;
        localStorage.setItem(FOLLOW_SEEDED_KEY, '1');
      } catch (e) {
        return;
      }
      follows.add({ id: teamId, name }, 'cfb');
    },
  };

  // ---- Kid mode -----------------------------------------------------------
  // Bigger pictures, simpler words, no betting odds. Saved per browser and
  // toggled from the header (public/js/kids.js).
  const KID_MODE_KEY = 'tracker-kid-mode';
  function kidMode() {
    try { return localStorage.getItem(KID_MODE_KEY) === '1'; } catch (e) { return false; }
  }
  function setKidMode(on) {
    try { localStorage.setItem(KID_MODE_KEY, on ? '1' : '0'); } catch (e) { /* ignore */ }
  }

  function fmtTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
  }

  function statusLabel(game) {
    if (!game || !game.status) return '';
    if (kidMode()) {
      if (game.status.state === 'in') return `Playing now! ${game.status.shortDetail || ''}`.trim();
      if (game.status.state === 'post') return 'Game over';
    }
    if (game.status.state === 'in') return game.status.shortDetail || `${sport().periodPrefix || 'Q'}${game.status.period} ${game.status.clock}`;
    if (game.status.state === 'post') return 'Final' + (game.status.detail && game.status.detail !== 'Final' ? ` (${game.status.detail})` : '');
    return fmtTime(game.date);
  }

  function teamLink(team) {
    if (!team || !team.id) return '';
    return withSport(`/team.html?id=${encodeURIComponent(team.id)}&source=espn`);
  }

  function playerLink(player) {
    if (!player || !player.id) return '#';
    return withSport(`/player.html?id=${encodeURIComponent(player.id)}`);
  }

  function gameLink(id, source) {
    if (!id) return '';
    return withSport(`/game.html?id=${encodeURIComponent(id)}&source=${encodeURIComponent(source || 'espn')}`);
  }

  function teamRowHtml(team, rowOpts) {
    rowOpts = rowOpts || {};
    if (!team) return '<div class="team-row"><span class="team-name">TBD</span></div>';
    const isWinner = team.winner && team.score !== null;
    // Once a game is final, don't make people compare two numbers to see
    // who won — show an explicit W/L chip next to each side.
    let wlBadge = '';
    if (rowOpts.completed && team.score !== null) {
      if (team.winner) wlBadge = '<span class="wl-badge win">W</span>';
      else wlBadge = '<span class="wl-badge loss">L</span>';
    }
    // Small football icon marks whichever team currently has the ball —
    // only meaningful (and only shown) while the game is actually live.
    const possessionIcon = rowOpts.hasPossession ? '<span class="possession-icon" title="Has possession">&#127944;</span>' : '';
    const isLoser = rowOpts.completed && team.score !== null && !team.winner;
    const color = team.color && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(team.color) ? team.color : null;
    return `
      <div class="team-row ${isLoser ? 'loser' : ''}"${color ? ` style="--row-color:${color}"` : ''} data-side="${esc(team.homeAway || '')}">
        <span class="rank">${team.curatedRank ? '#' + team.curatedRank : ''}</span>
        ${team.logo ? `<img src="${safeUrl(team.logo)}" alt="" onerror="this.style.display='none'">` : ''}
        <a class="team-name team-link ${isWinner ? 'winner' : ''}" href="${teamLink(team)}" onclick="event.stopPropagation()">${esc(team.name || team.shortName || 'TBD')}</a>
        ${possessionIcon}
        <span class="score">${team.score !== null && team.score !== undefined ? esc(team.score) : ''}</span>
        ${wlBadge}
      </div>`;
  }

  function oddsLine(game) {
    if (!game.odds || kidMode()) return '';
    const parts = [];
    if (game.odds.details) parts.push(esc(game.odds.details));
    else if (game.odds.spread !== null) parts.push(`Spread ${game.odds.spread > 0 ? '+' : ''}${game.odds.spread}`);
    if (game.odds.overUnder !== null) parts.push(`O/U ${game.odds.overUnder}`);
    if (!parts.length) return '';
    return `<div class="odds-line">${parts.join(' &middot; ')}</div>`;
  }

  // Full game card — used on Schedule & Scores AND Notable Games, so both
  // look and behave identically (channel, time, rank, live indicator).
  function gameCardHtml(game, opts) {
    opts = opts || {};
    const followed = opts.followedIds || new Set();
    const isFollowed = (team) => team && (followed.has(String(team.id)) || (opts.favoriteTeamId && String(team.id) === String(opts.favoriteTeamId)));
    const isFav = isFollowed(game.home) || isFollowed(game.away);
    const isLive = game.status && game.status.state === 'in';
    const isCompleted = !!(game.status && game.status.completed);
    const possessionId = isLive && game.situation ? game.situation.possession : null;
    const awayHasBall = !!(possessionId && game.away && String(possessionId) === String(game.away.id));
    const homeHasBall = !!(possessionId && game.home && String(possessionId) === String(game.home.id));
    const drama = isLive ? gameDrama(game) : null;
    const tags = drama && drama.tags.length
      ? `<div class="drama-tags">${drama.tags.map((t) => `<span class="drama-tag drama-${esc(t.key)}">${esc(t.label)}</span>`).join('')}</div>`
      : '';
    const situation = isLive ? situationLine(game) : '';
    return `
      <div class="game-card ${isFav ? 'is-favorite' : ''} ${isLive ? 'is-live' : ''} ${isCompleted ? 'is-final' : ''}" data-id="${esc(game.id)}" data-source="${esc(game.source || 'espn')}">
        <div class="status-row">
          <span class="${isLive ? 'live-dot' : ''}">${esc(statusLabel(game))}</span>
          <span style="display:flex;align-items:center;gap:6px;">
            ${opts.notableToggle
    ? `<button type="button" class="notable-toggle ${opts.notable ? 'on' : ''}" data-event-id="${esc(game.id)}" aria-pressed="${opts.notable ? 'true' : 'false'}" title="${opts.notable ? 'Remove from your notable games' : 'Add to your notable games'}">${opts.notable ? '&#9733; Notable' : '&#9734;'}</button>`
    : opts.notable ? '<span class="notable-ribbon">Notable</span>' : ''}
            ${game.broadcast ? `<span class="card-tv" title="TV channel">&#128250; ${esc(game.broadcast)}</span>` : ''}
          </span>
        </div>
        ${teamRowHtml(game.away, { completed: isCompleted, hasPossession: awayHasBall })}
        ${teamRowHtml(game.home, { completed: isCompleted, hasPossession: homeHasBall })}
        ${situation}
        ${linescoreHtml(game)}
        ${tags}
        ${game.headline ? `<div class="venue card-headline">${esc(game.headline)}</div>` : ''}
        ${game.venue ? `<div class="venue">${esc(game.venue)}</div>` : ''}
        ${oddsLine(game)}
      </div>`;
  }

  // UFC fight cards and NASCAR races: one card per event, listing the
  // fights (winner marked) or the top of the running order.
  function eventCardHtml(event) {
    const isLive = event.status && event.status.state === 'in';
    const when = isLive ? 'LIVE' : event.status && event.status.state === 'post' ? 'Final' : fmtTime(event.date);
    let body = '';
    if (event.bouts) {
      body = event.bouts.map((b, i) => {
        const [x, y] = b.fighters;
        const side = (f) => (f ? `<span class="fighter ${f.winner ? 'winner' : ''}">${esc(f.name || 'TBD')}${f.record ? ` <span class="fighter-record">${esc(f.record)}</span>` : ''}${f.winner ? ' <span class="wl-badge win">W</span>' : ''}</span>` : '<span class="fighter">TBD</span>');
        return `
          <div class="bout ${i === 0 ? 'main-event' : ''}">
            ${i === 0 ? '<div class="bout-label">Main event</div>' : ''}
            <div class="bout-row">${side(x)}<span class="bout-vs">vs</span>${side(y)}</div>
            ${b.weightClass || b.result ? `<div class="bout-meta">${[b.weightClass, b.result].filter(Boolean).map(esc).join(' &middot; ')}</div>` : ''}
          </div>`;
      }).join('');
    } else if (event.race) {
      body = event.race.length
        ? `<ol class="race-order">${event.race.map((d) => `
            <li class="${d.winner ? 'winner' : ''}"><span class="race-place">${esc(d.position || d.place || '')}</span>${d.number ? `<span class="car-number">#${esc(d.number)}</span>` : ''}<span>${esc(d.name)}</span>${d.score ? `<span class="golf-score ${String(d.score).startsWith('-') ? 'under' : ''}">${esc(d.score)}</span>` : ''}</li>`).join('')}
          </ol>${event.fieldSize > event.race.length ? `<div class="bout-meta">Top ${event.race.length} of ${esc(event.fieldSize)}</div>` : ''}`
        : (event.kind === 'golf' ? '<div class="bout-meta">The leaderboard appears once play starts.</div>' : '<div class="bout-meta">Running order appears once the race starts.</div>');
    }
    return `
      <div class="game-card event-card ${isLive ? 'is-live' : ''}">
        <div class="status-row">
          <span class="${isLive ? 'live-dot' : ''}">${esc(when)}</span>
          ${event.broadcast ? `<span>${esc(event.broadcast)}</span>` : ''}
        </div>
        <div class="event-name">${esc(event.name || event.shortName || 'Event')}</div>
        ${event.venue ? `<div class="venue">${esc(event.venue)}</div>` : ''}
        ${body}
      </div>`;
  }

  // Clicking a game card navigates to that game's own dedicated page
  // (game.html) rather than popping up a modal — it's shareable/bookmarkable
  // and doesn't compete for space with a team-name click inside the same
  // card. Team-name links inside the card call stopPropagation() so they
  // still go to the team page instead.
  function wireGameCardClicks(container) {
    container.querySelectorAll('.game-card').forEach((card) => {
      card.style.cursor = 'pointer';
      card.addEventListener('click', (e) => {
        // The notable star has its own handler (app.js).
        if (e.target.closest && e.target.closest('.notable-toggle')) return;
        location.href = gameLink(card.dataset.id, card.dataset.source);
      });
    });
  }

  // Renders a game's live/final detail (score, leaders, team stats, latest
  // drive) as an HTML string. Used by game.html's dedicated page. Kept here
  // so any future page can reuse the same rendering.
  // opts.playByPlay === false leaves the feed out (the game page draws its
  // own, filterable one in game-live.js).
  function gameDetailSectionsHtml(detail, opts) {
    const oddsHtml = !kidMode() && detail.odds && (detail.odds.details || detail.odds.overUnder !== null)
      ? `<section><h2 class="section-title">Odds</h2><div class="odds-box">
          ${detail.odds.details ? `<div>${esc(detail.odds.details)}</div>` : ''}
          ${detail.odds.overUnder !== null ? `<div>Over/Under: <strong>${esc(detail.odds.overUnder)}</strong></div>` : ''}
          ${detail.odds.provider ? `<div class="odds-provider">via ${esc(detail.odds.provider)}</div>` : ''}
        </div></section>`
      : '';
    const leadersHtml = (detail.leaders || []).map((teamLeaders) => `
      <div><strong>${esc(teamLeaders.team)}</strong>
        ${(teamLeaders.categories || []).map((c) => `<div class="stat-row"><span>${esc(c.name)}</span><span>${c.athlete ? esc(c.athlete) + ' &middot; ' : ''}${esc(c.value || '')}</span></div>`).join('')}
      </div>`).join('');
    const boxHtml = detail.boxscore ? detail.boxscore.teams.map((t) => `
      <div><strong>${esc(t.team)}</strong>
        ${t.stats.map((s) => `<div class="stat-row"><span>${esc(s.name)}</span><span>${esc(s.value)}</span></div>`).join('')}
      </div>`).join('') : '';
    const playsHtml = detail.drives ? `<div class="plays"><strong>${esc(detail.drives.description || 'Latest drive')}</strong><br>${(detail.drives.plays || []).map(esc).join('<br>')}</div>` : '';
    // Full play-by-play — only really meaningful once the game has actually
    // started (pregame there's nothing to show), shown newest-first in a
    // scrollable feed so it doesn't dominate the page for a long game.
    const pbpHtml = !(opts && opts.playByPlay === false) && detail.playByPlay && detail.playByPlay.length
      ? `<section><h2 class="section-title">Play-by-Play</h2><div class="pbp-feed">
          ${detail.playByPlay.map((p) => `
            <div class="pbp-play ${p.scoringPlay ? 'scoring' : ''}">
              <span class="pbp-meta">${[p.drive, p.period ? `${sport().periodPrefix || 'Q'}${p.period}` : null, p.clock].filter(Boolean).map(esc).join(' &middot; ')}</span>
              <span class="pbp-text">${esc(p.text)}</span>
            </div>`).join('')}
        </div></section>`
      : '';
    const note = detail.status && detail.status.state === 'pre'
      ? '<p class="empty-note">This game hasn\'t started yet &mdash; check back once it starts for live stats and play-by-play.</p>'
      : '';
    return `
      ${note}
      ${oddsHtml}
      ${leadersHtml ? `<section><h2 class="section-title">Leaders</h2>${leadersHtml}</section>` : ''}
      ${boxHtml ? `<section><h2 class="section-title">Team Stats</h2>${boxHtml}</section>` : ''}
      ${playsHtml ? `<section><h2 class="section-title">Latest Drive</h2>${playsHtml}</section>` : ''}
      ${pbpHtml}
    `;
  }

  // Sets a team's real color as a CSS custom property on an element, so
  // that element's border/accent (see .favorite-card / .team-hero in
  // styles.css) reflects THAT team's branding instead of a hardcoded
  // team's colors everywhere. Falls back to leaving the CSS default
  // (neutral accent / favorite amber) when ESPN didn't give us a color.
  function applyTeamColor(element, hexColor) {
    if (element && hexColor && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(hexColor)) {
      element.style.setProperty('--team-color', hexColor);
    }
  }

  // Shared division toggle (FBS/FCS for college football). Built from the
  // current sport's groups and hidden when there's nothing to choose.
  // Persists the choice per sport in localStorage and calls
  // onChange(groupValue) whenever it changes, including once on init with
  // the restored value (null when the sport has no divisions).
  function initDivisionToggle(onChange) {
    const container = el('divisionToggle');
    const groups = sport().groups || [];
    if (!container || groups.length < 2) {
      if (container) container.style.display = 'none';
      onChange(groups.length ? groups[0].value : null);
      return;
    }
    const storageKey = `division:${sportKey}`;
    let saved = groups[0].key;
    try {
      // Older versions stored the CFB choice under 'cfb-division'.
      saved = localStorage.getItem(storageKey) || (sportKey === 'cfb' && localStorage.getItem('cfb-division')) || groups[0].key;
    } catch (e) { /* ignore */ }
    if (!groups.some((g) => g.key === saved)) saved = groups[0].key;
    container.innerHTML = '';
    groups.forEach((g) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.division = g.key;
      btn.textContent = g.label;
      btn.classList.toggle('active', g.key === saved);
      btn.addEventListener('click', () => {
        container.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        try { localStorage.setItem(storageKey, g.key); } catch (e) { /* ignore */ }
        onChange(g.value);
      });
      container.appendChild(btn);
    });
    onChange(groups.find((g) => g.key === saved).value);
  }

  // YYYYMMDD for ESPN's `dates` parameter, in the viewer's local time.
  function ymd(date) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  }

  // ---- Games to watch ----------------------------------------------------
  // How gripping a live game is right now, 0 to ~130: close score, late in
  // the game, a ranked team in trouble. Drives the "Live now" sort order on
  // the home page and the Upset alert / Nail-biter tags on game cards.
  const REG_PERIODS = { cfb: 4, nfl: 4, nba: 4, wnba: 4, mcbb: 2, cbb: 2, wcbb: 4, nhl: 3, mlb: 9, epl: 2, mls: 2, ucl: 2 };
  const CLOSE_MARGIN = { cfb: 8, nfl: 8, nba: 6, wnba: 6, mcbb: 6, cbb: 6, wcbb: 6, nhl: 1, mlb: 2, epl: 1, mls: 1, ucl: 1 };

  function gameDrama(game, sportKeyArg) {
    const key = sportKeyArg || sportKey;
    const out = { score: 0, tags: [] };
    if (!game || !game.status || game.status.state !== 'in' || !game.home || !game.away) return out;
    const h = Number(game.home.score);
    const a = Number(game.away.score);
    if (Number.isNaN(h) || Number.isNaN(a)) return out;
    const regulation = REG_PERIODS[key] || 4;
    const close = CLOSE_MARGIN[key] || 8;
    const period = Number(game.status.period) || 1;
    const margin = Math.abs(h - a);
    const overtime = period > regulation;
    const lateness = overtime ? 1.1 : Math.min(1, period / regulation);
    const closeness = Math.max(0, 1 - margin / (close * 2));
    const rank = (t) => (t.curatedRank && Number(t.curatedRank) <= 25 ? Number(t.curatedRank) : null);
    const hr = rank(game.home);
    const ar = rank(game.away);
    // A ranked team losing to an unranked team, or to one ranked at least
    // five spots lower.
    const trailing = h < a ? { me: hr, them: ar } : a < h ? { me: ar, them: hr } : null;
    const upset = !!(trailing && trailing.me && (!trailing.them || trailing.them - trailing.me >= 5));
    out.score = Math.round(closeness * 60 + lateness * 30 + (upset ? 25 : 0) + (hr && ar ? 10 : 0) + (overtime ? 10 : 0));
    if (upset && lateness >= 0.5) out.tags.push({ key: 'upset', label: 'Upset alert' });
    if (overtime) out.tags.push({ key: 'ot', label: 'Overtime' });
    else if (margin <= close && lateness >= 0.75) out.tags.push({ key: 'close', label: 'Nail-biter' });
    if (hr && ar && hr <= 15 && ar <= 15) out.tags.push({ key: 'clash', label: 'Top 15 clash' });
    if (game.situation && game.situation.isRedZone) out.tags.push({ key: 'redzone', label: 'Red zone' });
    return out;
  }

  // One line under a live game's teams: "2nd & 7 at UGA 34" for football,
  // "2-1, 1 out, runners on 1st and 3rd" for baseball.
  function situationLine(game) {
    const s = game && game.situation;
    if (!s || kidMode()) return '';
    if (s.baseball) {
      const b = s.baseball;
      const bases = [b.onFirst && '1st', b.onSecond && '2nd', b.onThird && '3rd'].filter(Boolean);
      const parts = [];
      if (b.balls !== null && b.strikes !== null) parts.push(`${b.balls}-${b.strikes}`);
      if (b.outs !== null) parts.push(`${b.outs} out${b.outs === 1 ? '' : 's'}`);
      parts.push(bases.length ? `on ${bases.join(', ')}` : 'bases empty');
      // A little diamond with the runners, plus the count and outs as dots.
      const base = (on, x, y) => `<rect x="${x}" y="${y}" width="9" height="9" transform="rotate(45 ${x + 4.5} ${y + 4.5})" class="${on ? 'on' : ''}"/>`;
      const dots = (n, max, cls) => Array.from({ length: max }, (_, i) => `<span class="dot ${i < n ? cls : ''}"></span>`).join('');
      return `
        <div class="situation-line diamond-line" aria-label="${esc(parts.join(', '))}">
          <svg class="diamond" viewBox="0 0 34 26" aria-hidden="true">${base(b.onSecond, 12.5, 2)}${base(b.onThird, 3, 12)}${base(b.onFirst, 22, 12)}</svg>
          <span class="count-dots">
            <span class="count-row"><span class="count-k">B</span>${dots(b.balls || 0, 3, 'ball')}</span>
            <span class="count-row"><span class="count-k">S</span>${dots(b.strikes || 0, 2, 'strike')}</span>
            <span class="count-row"><span class="count-k">O</span>${dots(b.outs || 0, 2, 'out')}</span>
          </span>
        </div>`;
    }
    if (s.down) {
      return `<div class="situation-line ${s.isRedZone ? 'red-zone' : ''}">${esc(s.down)}${s.possessionText && !String(s.down).includes(' at ') ? ` at ${esc(s.possessionText)}` : ''}</div>`;
    }
    return '';
  }

  // Inning / period / quarter scores under a live or final game, for the
  // sports where the line score tells the story (not football, which gets
  // down and distance instead).
  const LINESCORE = {
    mlb: { regulation: 9, label: (i) => String(i + 1), extra: (i) => String(i + 1) },
    nhl: { regulation: 3, label: (i) => String(i + 1), extra: (i) => (i === 3 ? 'OT' : i === 4 ? 'SO' : `${i - 2}OT`) },
    nba: { regulation: 4, label: (i) => `Q${i + 1}`, extra: (i) => (i === 4 ? 'OT' : `${i - 3}OT`) },
    wnba: { regulation: 4, label: (i) => `Q${i + 1}`, extra: (i) => (i === 4 ? 'OT' : `${i - 3}OT`) },
    cbb: { regulation: 2, label: (i) => `H${i + 1}`, extra: (i) => (i === 2 ? 'OT' : `${i - 1}OT`) },
    mcbb: { regulation: 2, label: (i) => `H${i + 1}`, extra: (i) => (i === 2 ? 'OT' : `${i - 1}OT`) },
    epl: { regulation: 2, label: (i) => (i === 0 ? '1st' : '2nd'), extra: (i) => (i === 2 ? 'ET1' : i === 3 ? 'ET2' : 'PK') },
    mls: { regulation: 2, label: (i) => (i === 0 ? '1st' : '2nd'), extra: (i) => (i === 2 ? 'ET1' : i === 3 ? 'ET2' : 'PK') },
    ucl: { regulation: 2, label: (i) => (i === 0 ? '1st' : '2nd'), extra: (i) => (i === 2 ? 'ET1' : i === 3 ? 'ET2' : 'PK') },
    wcbb: { regulation: 4, label: (i) => `Q${i + 1}`, extra: (i) => (i === 4 ? 'OT' : `${i - 3}OT`) },
  };

  function linescoreHtml(game, sportKeyArg) {
    const key = sportKeyArg || sportKey;
    const cfg = LINESCORE[key];
    if (!cfg || !game || !game.status || game.status.state === 'pre' || !game.home || !game.away) return '';
    const a = game.away.linescores || [];
    const h = game.home.linescores || [];
    const n = Math.max(a.length, h.length);
    if (!n) return '';
    const head = Array.from({ length: n }, (_, i) => (i < cfg.regulation ? cfg.label(i) : cfg.extra(i)));
    const cell = (v) => (v === undefined || v === null || v === '' ? '&ndash;' : esc(v));
    const abbr = (t) => esc(t.abbreviation || t.shortName || '');
    return `
      <table class="mini-linescore" aria-label="Score by ${key === 'mlb' ? 'inning' : 'period'}">
        <thead><tr><th></th>${head.map((x) => `<th>${esc(x)}</th>`).join('')}<th>T</th></tr></thead>
        <tbody>
          <tr><th>${abbr(game.away)}</th>${head.map((_, i) => `<td>${cell(a[i])}</td>`).join('')}<td class="t">${cell(game.away.score)}</td></tr>
          <tr><th>${abbr(game.home)}</th>${head.map((_, i) => `<td>${cell(h[i])}</td>`).join('')}<td class="t">${cell(game.home.score)}</td></tr>
        </tbody>
      </table>`;
  }

  // Grey placeholder cards shown while a list loads, instead of "Loading...".
  function skeletonCards(n) {
    return Array.from({ length: n || 6 }, () => `
      <div class="game-card skeleton" aria-hidden="true">
        <div class="sk-line sk-short"></div>
        <div class="sk-line"></div>
        <div class="sk-line"></div>
        <div class="sk-line sk-short"></div>
      </div>`).join('') + '<span class="visually-hidden">Loading&hellip;</span>';
  }

  // ---- Live ticker ---------------------------------------------------------
  // A slim strip along the bottom of every page (except the home page, the
  // Scores page and the TV wall, which show every score already) with the live games of the
  // teams you follow and of ranked teams. Hidden when none are live.
  function initLiveTicker() {
    const skip = ['/', '/scores', '/index.html', '/wall.html', '/kids.html', '/admin.html', '/countdown.html'];
    if (skip.includes(location.pathname) || document.querySelector('.live-ticker')) return;
    if (!document.querySelector('main')) return;
    const bar = document.createElement('aside');
    bar.className = 'live-ticker';
    bar.setAttribute('aria-label', 'Live scores');
    bar.hidden = true;
    document.body.appendChild(bar);
    let timer = null;
    const load = async () => {
      clearTimeout(timer);
      if (document.hidden) return;
      let data;
      try { data = await getJson(withSport('/api/scoreboard')); } catch (e) { timer = setTimeout(load, 120000); return; }
      const followed = follows.ids();
      const live = (data.games || []).filter((g) => g.status && g.status.state === 'in');
      const picked = live.filter((g) => {
        const mine = [g.home, g.away].some((t) => t && followed.has(String(t.id)));
        const ranked = [g.home, g.away].some((t) => t && t.curatedRank);
        return mine || ranked;
      });
      const isMine = (g) => [g.home, g.away].some((t) => t && followed.has(String(t.id)));
      picked.sort((x, y) => (isMine(y) - isMine(x)) || (gameDrama(y).score - gameDrama(x).score));
      picked.splice(12);
      bar.hidden = !picked.length;
      document.body.classList.toggle('has-live-ticker', picked.length > 0);
      bar.innerHTML = picked.length ? `
        <span class="ticker-label"><span class="live-dot"></span>Live</span>
        <div class="ticker-track">${picked.map((g) => {
          const mine = [g.home, g.away].some((t) => t && followed.has(String(t.id)));
          const abbr = (t) => esc((t && (t.abbreviation || t.shortName)) || 'TBD');
          return `<a class="ticker-game ${mine ? 'mine' : ''}" href="${gameLink(g.id, g.source)}">
            <span class="tk-team">${abbr(g.away)} <b>${esc(g.away && g.away.score)}</b></span>
            <span class="tk-team">${abbr(g.home)} <b>${esc(g.home && g.home.score)}</b></span>
            <span class="tk-status">${esc(statusLabel(g))}</span></a>`;
        }).join('')}</div>` : '';
      timer = setTimeout(load, picked.length ? 30000 : 120000);
    };
    document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
    load();
  }

  return {
    gameDrama, situationLine, linescoreHtml, skeletonCards, initLiveTicker,
    el, esc, safeUrl, getJson, fmtTime, statusLabel, teamLink, playerLink, gameLink, teamRowHtml, gameCardHtml,
    wireGameCardClicks, gameDetailSectionsHtml, eventCardHtml,
    applyTeamColor, initDivisionToggle, ymd,
    loadSports, sport, withSport, initSportBar, follows, account, kidMode, setKidMode,
  };
})();

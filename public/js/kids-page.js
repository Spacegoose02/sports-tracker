// The Kids Zone page: players, pick'em with a family leaderboard and
// badges, trivia, the sticker book, and celebration settings.
(function () {
  const el = CFB.el;
  const esc = CFB.esc;
  const state = { scoreboard: null, filter: 'top', weekLabel: null };

  // Straight up or against the spread. Grown-ups only: kid mode hides
  // betting lines everywhere, so it always picks straight up.
  const MODE_KEY = 'tracker-pickem-mode';
  function pickMode() {
    if (CFB.kidMode()) return 'su';
    try { return localStorage.getItem(MODE_KEY) === 'ats' ? 'ats' : 'su'; } catch (e) { return 'su'; }
  }
  function homeSpread(g) {
    const n = g && g.odds ? Number(g.odds.homeSpread !== undefined ? g.odds.homeSpread : g.odds.spread) : NaN;
    return g && g.odds && g.odds.homeSpread !== null && Number.isFinite(n) ? n : null;
  }

  // ---- Players ---------------------------------------------------------------
  function currentId() {
    const p = Kids.players.current();
    return p ? p.id : null;
  }

  function renderPlayers() {
    const list = Kids.players.list();
    const current = currentId();
    el('playerChips').innerHTML = list.length
      ? list.map((p) => `
        <span class="player-chip ${p.id === current ? 'active' : ''}" data-id="${esc(p.id)}">
          <button type="button" class="player-pick" aria-pressed="${p.id === current}">${esc(p.emoji)} ${esc(p.name)}</button>
          <button type="button" class="player-remove" aria-label="Remove ${esc(p.name)}" title="Remove">&times;</button>
        </span>`).join('')
      : '<span class="empty-note">Add each kid (and grown-up!) who wants to play.</span>';
    el('playerChips').querySelectorAll('.player-chip').forEach((chip) => {
      chip.querySelector('.player-pick').addEventListener('click', () => {
        Kids.players.setCurrent(chip.dataset.id);
        renderAll();
      });
      chip.querySelector('.player-remove').addEventListener('click', () => {
        const p = Kids.players.list().find((x) => x.id === chip.dataset.id);
        if (p && confirm(`Remove ${p.name}? Their picks, brackets and stickers go too.`)) {
          Kids.players.remove(p.id);
          renderAll();
        }
      });
    });
  }

  el('addPlayerForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = el('playerName');
    const player = Kids.players.add(input.value);
    if (player) {
      Kids.players.setCurrent(player.id);
      input.value = '';
      renderAll();
    }
  });

  // ---- Pick'em ---------------------------------------------------------------
  function weekLabel(sb) {
    const sport = CFB.sport();
    if (sport.schedule === 'week') return `${sport.key}-${sb.season}-${sb.seasonType || 2}-${sb.week}`;
    return `${sport.key}-${sb.day || CFB.ymd(new Date())}`;
  }

  async function loadPickem() {
    const sport = CFB.sport();
    if (sport.teams === false) {
      el('pickemList').innerHTML = `<div class="empty-note">Pick'em works for team sports. Pick another sport above.</div>`;
      el('pickemFilter').hidden = true;
      renderLeaderboard();
      return;
    }
    try {
      state.scoreboard = await CFB.getJson(CFB.withSport('/api/scoreboard'));
      state.weekLabel = weekLabel(state.scoreboard);
      el('sourceNote').textContent = sport.schedule === 'week'
        ? `${sport.label} · Week ${state.scoreboard.week} pick'em`
        : `${sport.label} · Today's pick'em`;
    } catch (err) {
      el('pickemList').innerHTML = '<div class="empty-note">Could not load games.</div>';
      return;
    }
    await resolvePicks();
    renderPickem();
  }

  // Checks finished games for every pick still waiting on a result.
  async function resolvePicks() {
    const results = {};
    const games = (state.scoreboard && state.scoreboard.games) || [];
    games.forEach((g) => {
      const r = KidsCore.gameResult(g);
      if (r) results[`${CFB.sport().key}:${g.id}`] = r;
    });
    const waiting = new Map();
    Object.values(Kids.picks.all()).forEach((list) => Object.values(list).forEach((p) => {
      const key = `${p.sport}:${p.gameId}`;
      if (p.result || results[key] || !p.date || new Date(p.date).getTime() > Date.now()) return;
      waiting.set(key, p);
    }));
    await Promise.all([...waiting.values()].slice(0, 15).map(async (p) => {
      try {
        const detail = await CFB.getJson(`/api/game/${encodeURIComponent(p.gameId)}?sport=${encodeURIComponent(p.sport)}`);
        const r = KidsCore.gameResult(detail);
        if (r) results[`${p.sport}:${p.gameId}`] = r;
      } catch (e) { /* try again next visit */ }
    }));
    const before = Kids.stickers.forPlayer(currentId()).length;
    if (Kids.picks.resolve(results) && Kids.stickers.forPlayer(currentId()).length > before) {
      Kids.toast('You picked right! New stickers are in your sticker book.');
    }
  }

  function isTopGame(g) {
    const followed = CFB.follows.ids();
    const inGame = (t) => t && followed.has(String(t.id));
    const ranked = (t) => t && t.curatedRank;
    return inGame(g.home) || inGame(g.away) || ranked(g.home) || ranked(g.away);
  }

  function renderPickem() {
    renderLeaderboard();
    if (!state.scoreboard) return;
    const player = Kids.players.current();
    const games = ((state.scoreboard && state.scoreboard.games) || []).filter((g) => g.home && g.away);
    const hasTop = games.some(isTopGame);
    el('pickemFilter').hidden = !hasTop || games.length < 6;
    const shown = state.filter === 'top' && hasTop && games.length >= 6 ? games.filter(isTopGame) : games;
    if (!shown.length) {
      el('pickemList').innerHTML = '<div class="empty-note">No games to pick right now.</div>';
      return;
    }
    const myPicks = player ? Kids.picks.forPlayer(player.id) : {};
    const sportKey = CFB.sport().key;
    const mode = pickMode();
    const modeBar = el('pickemMode');
    modeBar.hidden = CFB.kidMode() || !games.some((g) => homeSpread(g) !== null);
    modeBar.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
    el('pickemList').innerHTML = `
      ${player ? '' : '<div class="empty-note">Add a name above to start picking.</div>'}
      ${shown.map((g) => {
        const pick = myPicks[`${sportKey}:${g.id}`];
        const locked = !g.status || g.status.state !== 'pre';
        const outcome = pick ? KidsCore.pickOutcome(Object.assign({}, pick, { result: pick.result || KidsCore.gameResult(g) })) : null;
        // A pick made against the spread keeps showing its own line.
        const lineSpread = pick ? (pick.spread !== undefined && pick.spread !== null ? pick.spread : null) : (mode === 'ats' ? homeSpread(g) : null);
        const noLine = !pick && mode === 'ats' && lineSpread === null;
        const side = (t) => `
          <button type="button" class="pick-side ${pick && String(pick.teamId) === String(t.id) ? 'picked' : ''}" data-team="${esc(t.id)}" ${locked || !player ? 'disabled' : ''}>
            ${t.logo ? `<img src="${CFB.safeUrl(t.logo)}" alt="" onerror="this.style.display='none'">` : ''}
            <span>${t.curatedRank ? `#${esc(t.curatedRank)} ` : ''}${esc(t.shortName || t.name)}</span>
            ${lineSpread !== null ? `<span class="pick-line">${esc(KidsCore.lineFor(t, t === g.home, lineSpread))}</span>` : ''}
            ${t.score !== null && t.score !== undefined && locked ? `<strong>${esc(t.score)}</strong>` : ''}
          </button>`;
        const note = outcome === 'right' ? '<span class="pick-note right">&#9989; You got it!</span>'
          : outcome === 'wrong' ? '<span class="pick-note wrong">&#10060; Not this time</span>'
            : outcome === 'tie' && lineSpread !== null ? '<span class="pick-note">Push: landed right on the line</span>'
            : noLine && !locked ? `<span class="pick-note">No line yet, picks straight up &middot; ${esc(CFB.statusLabel(g))}</span>`
            : locked ? `<span class="pick-note">${pick ? 'Locked in' : 'Too late to pick'} &middot; ${esc(CFB.statusLabel(g))}</span>`
              : `<span class="pick-note">${esc(CFB.statusLabel(g))}</span>`;
        return `<div class="pick-game" data-id="${esc(g.id)}">${side(g.away)}<span class="pick-at">at</span>${side(g.home)}${note}</div>`;
      }).join('')}`;
    el('pickemList').querySelectorAll('.pick-game').forEach((row) => {
      const g = games.find((x) => String(x.id) === row.dataset.id);
      row.querySelectorAll('.pick-side').forEach((btn) => {
        btn.addEventListener('click', () => {
          const p = Kids.players.current();
          if (!p || !g || g.status.state !== 'pre') return;
          const team = (t) => ({ id: String(t.id), name: t.name, logo: t.logo || null, color: t.color || null });
          Kids.picks.set(p.id, {
            sport: sportKey,
            gameId: String(g.id),
            teamId: btn.dataset.team,
            week: state.weekLabel,
            date: g.date,
            away: team(g.away),
            home: team(g.home),
            ranks: { [String(g.away.id)]: g.away.curatedRank || null, [String(g.home.id)]: g.home.curatedRank || null },
            result: null,
            ...(pickMode() === 'ats' && homeSpread(g) !== null ? { spread: homeSpread(g) } : {}),
          });
          renderPickem();
        });
      });
    });
  }

  function renderLeaderboard() {
    const players = Kids.players.list();
    if (!players.length) { el('leaderboard').innerHTML = ''; return; }
    const rows = KidsCore.leaderboard(players, Kids.picks.all());
    el('leaderboard').innerHTML = `
      <h2 class="section-title">Family leaderboard</h2>
      <ol class="leaderboard">
        ${rows.map((r, i) => `
          <li class="${r.player.id === currentId() ? 'me' : ''}">
            <span class="lb-place">${i === 0 && r.stats.right ? '&#128081;' : i + 1}</span>
            <span class="lb-name">${esc(r.player.emoji)} ${esc(r.player.name)}</span>
            <span class="lb-score">${r.stats.right} right${r.stats.pending ? ` &middot; ${r.stats.pending} waiting` : ''}</span>
            <span class="lb-badges">${r.badges.map((b) => `<span class="badge" title="${esc(b.name)}: ${esc(b.desc)}">${b.emoji}</span>`).join('')}</span>
          </li>`).join('')}
      </ol>
      <details class="badge-key"><summary>Badges you can earn</summary>
        ${KidsCore.BADGES.map((b) => `<div>${b.emoji} <strong>${esc(b.name)}</strong>: ${esc(b.desc)}</div>`).join('')}
      </details>`;
  }

  el('pickemMode').querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => {
      try { localStorage.setItem(MODE_KEY, btn.dataset.mode); } catch (e) { /* ignore */ }
      renderPickem();
    });
  });

  el('pickemFilter').querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.filter = btn.dataset.filter;
      el('pickemFilter').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
      renderPickem();
    });
  });

  // ---- Trivia ------------------------------------------------------------------
  const trivia = { questions: [], index: 0, score: 0 };

  async function triviaTeams() {
    const sports = await CFB.getJson('/api/sports').then((d) => d.sports || []).catch(() => []);
    const teamSports = sports.filter((s) => s.teams !== false).map((s) => s.key);
    const followed = [];
    teamSports.forEach((key) => CFB.follows.list(key).forEach((t) => followed.push(Object.assign({}, t, { sport: key }))));
    const sportKeys = [...new Set([...followed.map((t) => t.sport), CFB.sport().key])].filter((k) => teamSports.includes(k));

    // Other teams from each sport's current games, for wrong answers.
    const pool = [];
    await Promise.all(sportKeys.map(async (key) => {
      try {
        const sb = await CFB.getJson(`/api/scoreboard?sport=${encodeURIComponent(key)}`);
        (sb.games || []).forEach((g) => [g.away, g.home].forEach((t) => {
          if (!t || !t.id) return;
          pool.push({ id: String(t.id), sport: key, name: t.name, nickname: t.nickname, location: t.location, logo: t.logo, color: t.color, venue: t === g.home ? g.venue : null });
        }));
      } catch (e) { /* fewer choices, still fine */ }
    }));

    const teams = await Promise.all(KidsCore.shuffle(followed).slice(0, 8).map(async (t) => {
      try {
        const res = await CFB.getJson(`/api/team/${encodeURIComponent(t.id)}?lite=1&sport=${encodeURIComponent(t.sport)}`);
        const home = (res.schedule || []).find((g) => g.home && String(g.home.id) === String(t.id) && g.venue);
        return Object.assign({ sport: t.sport }, res.team || {}, { id: String(t.id), venue: home ? home.venue : null });
      } catch (e) {
        return null;
      }
    }));
    let picked = teams.filter(Boolean);
    // Nobody followed yet: quiz on a few teams playing now instead.
    if (!picked.length) picked = KidsCore.shuffle(pool.filter((t) => t.sport === CFB.sport().key)).slice(0, 3);
    return { teams: picked, pool, sports: sportKeys };
  }

  async function startTrivia() {
    el('triviaBox').innerHTML = '<div class="empty-note">Getting questions ready&hellip;</div>';
    const { teams, pool, sports } = await triviaTeams();
    trivia.questions = KidsCore.buildQuiz({ teams, pool, sports, count: 10 });
    trivia.index = 0;
    trivia.score = 0;
    showQuestion();
  }

  function showQuestion() {
    const q = trivia.questions[trivia.index];
    if (!q) { showTriviaEnd(); return; }
    el('triviaBox').innerHTML = `
      <div class="trivia-progress">Question ${trivia.index + 1} of ${trivia.questions.length} &middot; Score ${trivia.score}</div>
      ${q.image ? `<img class="trivia-image" src="${CFB.safeUrl(q.image)}" alt="Mystery logo" onerror="this.style.display='none'">` : ''}
      <div class="trivia-q">${esc(q.q)}</div>
      <div class="trivia-choices">
        ${q.choices.map((c, i) => q.swatches
          ? `<button type="button" class="trivia-choice swatch" data-i="${i}" style="background:${/^#[0-9a-f]{6}$/i.test(c) ? c : '#888'}" aria-label="Color ${i + 1}"></button>`
          : `<button type="button" class="trivia-choice" data-i="${i}">${esc(c)}</button>`).join('')}
      </div>
      <div class="trivia-feedback" id="triviaFeedback" role="status"></div>`;
    el('triviaBox').querySelectorAll('.trivia-choice').forEach((btn) => {
      btn.addEventListener('click', () => answer(q, q.choices[Number(btn.dataset.i)], btn));
    });
  }

  function answer(q, choice, btn) {
    const right = choice === q.answer;
    if (right) trivia.score += 1;
    el('triviaBox').querySelectorAll('.trivia-choice').forEach((b) => {
      b.disabled = true;
      if (q.choices[Number(b.dataset.i)] === q.answer) b.classList.add('right');
    });
    if (!right) btn.classList.add('wrong');
    el('triviaFeedback').innerHTML = `
      <div class="${right ? 'right' : 'wrong'}">${right ? '&#127881; Yes! Nice job!' : `Not quite. ${q.swatches ? 'The right color is outlined.' : `It's <strong>${esc(q.answer)}</strong>.`}`}</div>
      <button type="button" class="big-btn" id="triviaNext">${trivia.index + 1 < trivia.questions.length ? 'Next question' : 'See my score'}</button>`;
    el('triviaNext').addEventListener('click', () => { trivia.index += 1; showQuestion(); });
    el('triviaNext').focus();
  }

  function showTriviaEnd() {
    const total = trivia.questions.length;
    const best = Kids.store.get('trivia-best', {});
    const who = currentId() || 'family';
    const newBest = trivia.score > (best[who] || 0);
    if (newBest) { best[who] = trivia.score; Kids.store.set('trivia-best', best); }
    // XP for trivia: 3 per right answer, once a day.
    if (Kids.xp && trivia.score) {
      const day = new Date().toISOString().slice(0, 10);
      Kids.xp.award({ key: `trivia:${day}`, points: Math.min(40, trivia.score * 3 + (trivia.score === total ? 10 : 0)), reason: `Trivia: ${trivia.score} of ${total}` });
    }
    const cheer = trivia.score === total ? 'PERFECT! You know your stuff! &#127942;'
      : trivia.score >= total * 0.7 ? 'Great job! &#11088;'
        : 'Good try! Play again to beat your score.';
    el('triviaBox').innerHTML = `
      <div class="trivia-score">${trivia.score} / ${total}</div>
      <div class="trivia-q">${cheer}</div>
      <div class="trivia-progress">${newBest ? 'New best score!' : `Best score: ${best[who] || 0}`}</div>
      <button type="button" class="big-btn" id="triviaStart">Play again</button>`;
    el('triviaStart').addEventListener('click', startTrivia);
    if (trivia.score === total && total > 0) {
      const team = trivia.questions.find((q) => q.teamId);
      Kids.celebrate({ kind: 'win', gameId: 'trivia', team: { id: team ? team.teamId : 'trivia', name: 'Perfect trivia score!' }, points: 0, label: 'PERFECT!' }, CFB.sport().key);
    }
  }

  el('triviaStart').addEventListener('click', startTrivia);

  // ---- Sticker book ------------------------------------------------------------
  function albumHtml(stickers) {
    const slots = KidsCore.albumByTeam(stickers);
    if (!slots.length) return '';
    return `<div class="sticker-grid">${slots.map((slot) => `
      <div class="sticker" data-color="${esc(slot.color || '')}">
        ${slot.logo ? `<img src="${CFB.safeUrl(slot.logo)}" alt="" onerror="this.style.display='none'">` : '<div class="sticker-blank">&#11088;</div>'}
        <div class="sticker-name">${esc(slot.name || 'Team')}</div>
        <div class="sticker-count">&times;${slot.stickers.length}</div>
        <ul class="sticker-list">${slot.stickers.slice(-5).reverse().map((s) => `<li>${s.reason === 'picked' ? '&#127919;' : '&#128064;'} ${esc(s.label || '')}</li>`).join('')}</ul>
      </div>`).join('')}</div>`;
  }

  function renderStickers() {
    const player = Kids.players.current();
    const mine = player ? Kids.stickers.forPlayer(player.id) : [];
    const family = Kids.stickers.forPlayer('family');
    const book = el('stickerBook');
    book.innerHTML = `
      <p class="kids-help">Earn a sticker for every game you watch live on a game's page (&#128064;) and every pick you get right (&#127919;).</p>
      ${player ? `<h2 class="section-title">${esc(player.emoji)} ${esc(player.name)}'s stickers (${mine.length})</h2>${albumHtml(mine) || '<div class="empty-note">No stickers yet. Watch a game or make some picks!</div>'}` : ''}
      ${family.length ? `<h2 class="section-title">Family stickers (${family.length})</h2>${albumHtml(family)}` : ''}
      ${!player && !family.length ? '<div class="empty-note">No stickers yet. Watch a game or make some picks!</div>' : ''}`;
    book.querySelectorAll('.sticker').forEach((s) => CFB.applyTeamColor(s, s.dataset.color));
  }

  // ---- Celebration settings ------------------------------------------------
  function initParty() {
    const s = Kids.settings();
    el('setConfetti').checked = s.confetti;
    el('setSound').checked = s.sound;
    el('setConfetti').addEventListener('change', (e) => Kids.setSetting('confetti', e.target.checked));
    el('setSound').addEventListener('change', (e) => Kids.setSetting('sound', e.target.checked));
    el('testParty').addEventListener('click', () => {
      const t = CFB.follows.list()[0] || { id: 'demo', name: 'Your team' };
      Kids.celebrate({ kind: 'score', gameId: 'demo', team: Object.assign({}, t, { score: null }), points: 6, label: KidsCore.celebrationLabel(CFB.sport().key, 6) }, CFB.sport().key);
    });
  }

  // ---- Tabs ----------------------------------------------------------------------
  function initTabs() {
    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
        document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
        btn.classList.add('active');
        el(`tab-${btn.dataset.tab}`).classList.add('active');
        if (btn.dataset.tab === 'stickers') renderStickers();
        if (btn.dataset.tab === 'level') renderLevel();
        if (btn.dataset.tab === 'cards') renderCards();
      });
    });
  }

  function renderAll() {
    renderPlayers();
    renderPickem();
    renderStickers();
    renderLevel();
    renderCards();
  }

  // ---- Level up: XP, streak and Scrappy's closet --------------------------------
  const GC = window.GamedayCore;
  function renderLevel() {
    const box = el('levelBox');
    if (!box || !GC) return;
    const player = Kids.players.current();
    const rec = Kids.xp.record();
    const lv = GC.levelFor(rec.total);
    const outfit = GC.OUTFITS.find((o) => o.key === rec.outfit) || GC.OUTFITS[0];
    const unlocked = new Set(GC.unlockedOutfits(rec.total).map((o) => o.key));
    const recent = (rec.log || []).slice(-8).reverse();
    box.innerHTML = `
      <div class="level-hero">
        <span class="gd-scrappy" aria-hidden="true">🦝${outfit.emoji}</span>
        <div style="flex:1">
          <div class="level-num">${player ? `${esc(player.emoji)} ${esc(player.name)}: ` : ''}Level ${lv.level}</div>
          <div class="gd-level">${lv.xp} XP &middot; ${lv.next - lv.xp} XP to level ${lv.level + 1}${rec.streak && rec.streak.days ? ` &middot; &#128293; ${rec.streak.days}-day streak (best ${rec.streak.best})` : ''}</div>
          <div class="xp-bar"><span style="width:${Math.round(lv.progress * 100)}%"></span></div>
        </div>
      </div>
      <p class="kids-help">Earn XP by coming back every day, making picks, playing Game Day Bingo and Call it! on a game's Play tab, guessing final scores, acing trivia and collecting trading cards. Every few levels Scrappy unlocks something new to wear.</p>
      <h2 class="section-title">Scrappy's closet</h2>
      <div class="closet">${GC.OUTFITS.map((o) => `
        <button type="button" data-outfit="${esc(o.key)}" aria-pressed="${o.key === outfit.key}" ${unlocked.has(o.key) ? '' : 'disabled'}>
          <span class="closet-emoji">${unlocked.has(o.key) ? o.emoji : '&#128274;'}</span>
          <strong>${esc(o.name)}</strong>
          <span class="gd-note">${unlocked.has(o.key) ? esc(o.desc) : `Level ${o.level}`}</span>
        </button>`).join('')}</div>
      ${recent.length ? `<h2 class="section-title">Latest XP</h2><ol class="leaderboard">${recent.map((l) => `<li><span class="lb-place">&#11088;</span><span class="lb-name">${esc(l.reason)}</span><span class="lb-score">+${esc(l.points)} XP</span></li>`).join('')}</ol>` : ''}
      <div id="leagueXp"></div>`;
    box.querySelectorAll('[data-outfit]').forEach((b) => b.addEventListener('click', () => {
      Kids.xp.setOutfit(b.dataset.outfit);
      renderLevel();
    }));
    loadLeagueXp();
  }

  async function loadLeagueXp() {
    const box = el('leagueXp');
    if (!box || !CFB.account.user()) return;
    try {
      const current = Leagues.selected(await Leagues.list());
      if (!current) return;
      const since = GC.weekStart(Date.now());
      const data = await CFB.getJson(`/api/family/leagues/${current.id}/xp?since=${since}`);
      const rows = data.rows || [];
      if (!rows.length) return;
      box.innerHTML = `
        <h2 class="section-title">${esc(current.name)}: XP this week</h2>
        <ol class="leaderboard league-board">${rows.map((r, i) => {
          const o = GC.OUTFITS.find((x) => x.key === r.outfit) || GC.OUTFITS[0];
          return `<li><span class="lb-place">${i === 0 && r.week ? '&#128081;' : i + 1}</span><span class="lb-name">${esc(r.emoji)} ${esc(r.name)} <span class="lb-member">${esc(r.member)} &middot; level ${esc(r.level)} ${o.emoji}${r.streak > 1 ? ` &middot; &#128293;${esc(r.streak)}` : ''}</span></span><span class="lb-score">${esc(r.week)} XP</span></li>`;
        }).join('')}</ol>`;
    } catch (e) { /* the rest of the tab still works */ }
  }

  // ---- Card binder ------------------------------------------------------------------
  function renderCards() {
    const box = el('cardBinder');
    if (!box || !GC) return;
    const list = Kids.cards.forPlayer().slice().reverse();
    const counts = Object.fromEntries(Object.keys(GC.RARITY).map((r) => [r, list.filter((c) => c.rarity === r).length]));
    box.innerHTML = `
      <p class="kids-help">Collect a trading card for each star player in a game you watch live on its game page, or a game you pick right. Big games make rare, epic and legendary cards. Tap a card to flip it and see the stats.</p>
      <p class="gd-note">${list.length} cards &middot; ${Object.entries(counts).map(([r, n]) => `${esc(GC.RARITY[r].label)}: ${n}`).join(' &middot; ')}</p>
      ${list.length ? `<div class="tc-binder">${list.map((c) => `
        <div class="tc tc-${esc(c.rarity)}" style="--tc:${esc(c.color || '#3a6ea5')}" tabindex="0" role="button" aria-label="${esc(c.name)}, ${esc(c.rarity)} card. ${esc(c.stat || '')} ${esc(c.line || '')}">
          <div class="tc-inner">
            <div class="tc-front">
              <div class="tc-rarity">${esc(GC.RARITY[c.rarity].label)}</div>
              ${c.headshot ? `<img class="tc-photo" src="${CFB.safeUrl(c.headshot)}" alt="" loading="lazy" onerror="this.style.display='none'">` : '<div class="tc-photo tc-photo-empty">&#129437;</div>'}
              <div class="tc-name">${esc(c.name)}</div>
              <div class="tc-team">${c.teamLogo ? `<img src="${CFB.safeUrl(c.teamLogo)}" alt="" onerror="this.style.display='none'">` : ''}${esc(c.team || '')}${c.position ? ` &middot; ${esc(c.position)}` : ''}</div>
            </div>
            <div class="tc-back">
              <div class="tc-stat">${esc(c.stat || 'Big game')}</div>
              <div class="tc-line">${esc(c.line || '')}</div>
              ${c.opponent ? `<div class="tc-vs">vs ${esc(c.opponent)}</div>` : ''}
              ${c.date ? `<div class="tc-vs">${esc(new Date(c.date).toLocaleDateString())}</div>` : ''}
              <a class="tc-vs" href="/game.html?id=${encodeURIComponent(c.gameId)}&amp;source=espn&amp;sport=${encodeURIComponent(c.sport)}">See the game</a>
            </div>
          </div>
        </div>`).join('')}</div>` : '<div class="empty-note">No cards yet. Open a live game and keep watching until it ends!</div>'}`;
  }

  // ---- Family league ------------------------------------------------------------
  // The league panel (start, join, invite) and the league's weekly
  // leaderboard for the sport on screen. Needs an account; signed out it
  // shows a sign-in nudge and everything else still works on this device.
  const league = { week: null };

  function currentWeekKey() {
    const g = state.weekLabel && KidsCore.weekGroup(state.weekLabel);
    return g ? g.key : null;
  }

  function renderLeague() {
    const joinCode = new URLSearchParams(location.search).get('join');
    return Leagues.renderManager(el('leagueBox'), { onChange: loadLeagueBoard, joinCode }).then(loadLeagueBoard);
  }

  async function loadLeagueBoard() {
    const box = el('leagueBoard');
    const leagues = await Leagues.list();
    const current = Leagues.selected(leagues);
    if (!current) { box.innerHTML = ''; return; }
    const sport = CFB.sport();
    const week = league.week || currentWeekKey();
    const params = new URLSearchParams({ sport: sport.key });
    if (week) params.set('week', week);
    let data;
    try {
      data = await CFB.getJson(`/api/family/leagues/${current.id}/leaderboard?${params}`);
    } catch (e) {
      box.innerHTML = '<div class="empty-note">Could not load the league leaderboard.</div>';
      return;
    }
    const weeks = data.weeks || [];
    const thisWeek = currentWeekKey() && KidsCore.weekGroup(state.weekLabel);
    if (thisWeek && !weeks.some((w) => w.key === thisWeek.key)) weeks.unshift({ key: thisWeek.key, label: thisWeek.label });
    const shown = data.week ? data.week.key : (thisWeek && thisWeek.key);
    box.innerHTML = `
      <div class="league-head">
        <h3 class="league-sub">${esc(current.name)} &middot; ${esc(sport.label || '')}</h3>
        ${weeks.length ? `<label class="league-picker">Week
          <select id="leagueWeek">${weeks.map((w) => `<option value="${esc(w.key)}" ${w.key === shown ? 'selected' : ''}>${esc(w.label)}</option>`).join('')}</select>
        </label>` : ''}
      </div>
      ${data.week ? Leagues.standingsList(data.rows, 'week') : '<div class="empty-note">No league picks yet this week. Make your picks below!</div>'}
      <p class="league-note">League picks count when they're saved before kickoff, and they're scored from the final results.</p>`;
    const sel = el('leagueWeek');
    if (sel) sel.addEventListener('change', () => { league.week = sel.value; loadLeagueBoard(); });
  }

  let boardTimer = null;
  window.addEventListener('tracker:kids-data', (e) => {
    if (!Kids.isSynced() || !e.detail || e.detail.key !== 'picks') return;
    // Give the save a moment to reach the server, then refresh.
    clearTimeout(boardTimer);
    boardTimer = setTimeout(loadLeagueBoard, 1500);
  });

  initTabs();
  initParty();
  CFB.loadSports().then(() => Kids.ready).then(() => {
    CFB.initSportBar();
    renderPlayers();
    renderStickers();
    if (Kids.xp) Kids.xp.touchStreak();
    renderLevel();
    renderCards();
    loadPickem().then(renderLeague);
  });
})();

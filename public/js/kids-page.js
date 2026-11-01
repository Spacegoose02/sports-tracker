// The Kids Zone page: players, pick'em with a family leaderboard and
// badges, trivia, the sticker book, and celebration settings.
(function () {
  const el = CFB.el;
  const esc = CFB.esc;
  const state = { scoreboard: null, filter: 'top', weekLabel: null };

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
        if (p && confirm(`Remove ${p.name}? Their picks and stickers go too.`)) {
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
    el('pickemList').innerHTML = `
      ${player ? '' : '<div class="empty-note">Add a name above to start picking.</div>'}
      ${shown.map((g) => {
        const pick = myPicks[`${sportKey}:${g.id}`];
        const locked = !g.status || g.status.state !== 'pre';
        const outcome = pick ? KidsCore.pickOutcome(Object.assign({}, pick, { result: pick.result || KidsCore.gameResult(g) })) : null;
        const side = (t) => `
          <button type="button" class="pick-side ${pick && String(pick.teamId) === String(t.id) ? 'picked' : ''}" data-team="${esc(t.id)}" ${locked || !player ? 'disabled' : ''}>
            ${t.logo ? `<img src="${CFB.safeUrl(t.logo)}" alt="" onerror="this.style.display='none'">` : ''}
            <span>${t.curatedRank ? `#${esc(t.curatedRank)} ` : ''}${esc(t.shortName || t.name)}</span>
            ${t.score !== null && t.score !== undefined && locked ? `<strong>${esc(t.score)}</strong>` : ''}
          </button>`;
        const note = outcome === 'right' ? '<span class="pick-note right">&#9989; You got it!</span>'
          : outcome === 'wrong' ? '<span class="pick-note wrong">&#10060; Not this time</span>'
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
      });
    });
  }

  function renderAll() {
    renderPlayers();
    renderPickem();
    renderStickers();
  }

  initTabs();
  initParty();
  CFB.loadSports().then(() => {
    CFB.initSportBar();
    renderPlayers();
    renderStickers();
    loadPickem();
  });
})();

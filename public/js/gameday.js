// Game page: the "Play" tab (Game Day Bingo, Call it, the score guess,
// trading cards and the family XP board for this game) and the "Chat" tab
// (watch party chat for family league members). Logic lives in
// gameday-core.js; saved data goes through Kids (kids.js).
//
// game.js fires `tracker:game-loaded` with each fresh game detail, and this
// redraws from it.
(function () {
  const playBox = document.getElementById('gamePlay');
  const chatBox = document.getElementById('gameChat');
  if (!playBox || typeof GamedayCore === 'undefined' || typeof Kids === 'undefined') return;
  const GC = GamedayCore;
  const esc = (v) => CFB.esc(v);
  const params = new URLSearchParams(location.search);
  const gameId = params.get('id');
  const sportKey = () => CFB.sport().key;
  const gameKey = () => `${sportKey()}:${gameId}`;

  const local = {
    get(key, fallback) {
      try { const v = JSON.parse(localStorage.getItem(`tracker-gameday:${key}`) || 'null'); return v === null ? fallback : v; } catch (e) { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(`tracker-gameday:${key}`, JSON.stringify(value)); } catch (e) { /* ignore */ }
    },
  };

  let detail = null;
  let leagues = null;
  let leagueId = null;
  const playerId = () => (Kids.players.current() && Kids.players.current().id) || 'family';

  function sides(d) {
    const teams = (d && d.teams) || [];
    return { away: teams.find((t) => t.homeAway === 'away'), home: teams.find((t) => t.homeAway === 'home') };
  }

  function weekLabel(d) {
    const sport = CFB.sport();
    if (sport.schedule === 'week' && d.season && d.week) return `${sport.key}-${d.season}-${d.seasonType || 2}-${d.week}`;
    return `${sport.key}-${CFB.ymd(new Date(d.date || Date.now()))}`;
  }

  // ---- Who's playing -------------------------------------------------------
  function playerBar() {
    const list = Kids.players.list();
    const me = Kids.players.current();
    const lv = Kids.xp.level();
    const rec = Kids.xp.record();
    const outfit = GC.OUTFITS.find((o) => o.key === rec.outfit) || GC.OUTFITS[0];
    return `
      <div class="gd-player">
        <span class="gd-scrappy" title="${esc(outfit.name)}">🦝${outfit.emoji}</span>
        <div class="gd-player-main">
          ${list.length > 1
            ? `<label class="gd-who">Playing: <select id="gdWho">${list.map((p) => `<option value="${esc(p.id)}" ${me && me.id === p.id ? 'selected' : ''}>${esc(p.emoji)} ${esc(p.name)}</option>`).join('')}</select></label>`
            : `<strong>${me ? `${esc(me.emoji)} ${esc(me.name)}` : 'Family'}</strong>`}
          <div class="gd-level">Level ${lv.level} &middot; ${lv.xp} XP${rec.streak && rec.streak.days > 1 ? ` &middot; 🔥 ${rec.streak.days}-day streak` : ''}</div>
          <div class="xp-bar" aria-hidden="true"><span style="width:${Math.round(lv.progress * 100)}%"></span></div>
        </div>
        ${list.length ? '' : '<a class="gd-add" href="/kids.html">Add players</a>'}
      </div>`;
  }

  // ---- Score guess -----------------------------------------------------------
  function guessHtml(d, away, home) {
    const pick = Kids.picks.forPlayer(playerId())[gameKey()];
    const guess = pick && pick.guess;
    const state = d.status && d.status.state;
    if (state === 'pre') {
      return `
        <section class="gd-card">
          <h3>🔮 Guess the final score</h3>
          <form class="gd-guess" id="gdGuess">
            <label>${esc(away.shortName || away.name)} <input type="number" min="0" max="300" inputmode="numeric" name="away" value="${guess ? esc(guess.away) : ''}" required></label>
            <label>${esc(home.shortName || home.name)} <input type="number" min="0" max="300" inputmode="numeric" name="home" value="${guess ? esc(guess.home) : ''}" required></label>
            <button type="submit" class="big-btn">${guess ? 'Change guess' : 'Lock it in'}</button>
          </form>
          <p class="gd-note">Exact score is worth 50 XP. The closer you are, the more you get, plus 10 for the right winner. Your guess also counts as your pick'em pick.</p>
        </section>`;
    }
    if (!guess) return '';
    const final = state === 'post' ? { away: away.score, home: home.score } : null;
    const pts = final ? GC.guessPoints(guess, final) : 0;
    return `
      <section class="gd-card">
        <h3>🔮 Your score guess</h3>
        <p class="gd-big">${esc(away.abbreviation || away.shortName)} ${esc(guess.away)} &ndash; ${esc(guess.home)} ${esc(home.abbreviation || home.shortName)}</p>
        <p class="gd-note">${final ? (pts ? `Off by ${GC.guessError(guess, final)}. You earned ${pts} XP!` : `Off by ${GC.guessError(guess, final)}. Better luck next time!`) : 'Locked in. We will see at the end!'}</p>
      </section>`;
  }

  function saveGuess(form) {
    const d = detail;
    const { away, home } = sides(d);
    if (!d || !away || !home || d.status.state !== 'pre') return;
    const a = Number(form.away.value);
    const h = Number(form.home.value);
    if (!Number.isInteger(a) || !Number.isInteger(h) || a < 0 || h < 0) return;
    const pid = Kids.players.current() && Kids.players.current().id;
    if (!pid) { Kids.toast('Add a player on the Kids page first, so your guess has a name on it.'); return; }
    const old = Kids.picks.forPlayer(pid)[gameKey()];
    const teamId = a > h ? String(away.id) : h > a ? String(home.id) : (old ? old.teamId : String(home.id));
    const team = (t) => ({ id: String(t.id), name: t.name, logo: t.logo || null, color: t.color || null });
    Kids.picks.set(pid, Object.assign({}, old || {}, {
      sport: sportKey(), gameId: String(gameId), teamId, week: (old && old.week) || weekLabel(d), date: d.date,
      away: team(away), home: team(home),
      ranks: (old && old.ranks) || { [String(away.id)]: away.rank || null, [String(home.id)]: home.rank || null },
      result: null, guess: { away: a, home: h },
    }));
    Kids.toast('Score guess locked in!');
    render();
  }

  // ---- Bingo -----------------------------------------------------------------
  function bingoHtml(d) {
    const card = GC.bingoCard(sportKey(), `${playerId()}:${gameId}`);
    if (!card) return '';
    const plays = d.playByPlay || [];
    const marked = GC.markedSquares(card, sportKey(), plays);
    const lines = GC.bingoLines(card, marked);
    const onLine = new Set();
    const n = GC.BINGO_SIZE;
    lines.forEach((l) => {
      for (let i = 0; i < n; i += 1) {
        const idx = l.kind === 'row' ? l.index * n + i : l.kind === 'col' ? i * n + l.index : l.index === 0 ? i * n + i : i * n + (n - 1 - i);
        onLine.add(idx);
      }
    });
    // XP for each line and for a full card.
    if (d.status && d.status.state !== 'pre') {
      lines.forEach((l) => Kids.xp.award({ key: `bingo:${gameKey()}:${l.kind}${l.index}`, points: 30, reason: 'BINGO!', game: gameKey() }));
      if (marked.size === card.length) Kids.xp.award({ key: `bingo:${gameKey()}:blackout`, points: 100, reason: 'Blackout! Every square!', game: gameKey() });
    }
    const seen = local.get(`bingo-lines:${playerId()}:${gameKey()}`, 0);
    if (lines.length > seen) {
      local.set(`bingo-lines:${playerId()}:${gameKey()}`, lines.length);
      if (seen !== null && d.status.state === 'in') Kids.toast(lines.length === 1 ? 'BINGO! 🎉' : `BINGO x${lines.length}! 🎉`);
    }
    return `
      <section class="gd-card">
        <h3>🎲 Game Day Bingo ${lines.length ? `<span class="gd-badge">BINGO${lines.length > 1 ? ` x${lines.length}` : ''}!</span>` : ''}</h3>
        <div class="bingo-grid" style="--n:${n}" role="grid" aria-label="Bingo card, ${marked.size} of ${card.length} squares filled">
          ${card.map((sq, i) => `<div role="gridcell" class="bingo-sq ${marked.has(sq.key) ? 'hit' : ''} ${onLine.has(i) ? 'line' : ''}" aria-label="${esc(sq.label)}${marked.has(sq.key) ? ', filled' : ''}"><span class="bingo-emoji" aria-hidden="true">${sq.emoji}</span><span>${esc(sq.label)}</span></div>`).join('')}
        </div>
        <p class="gd-note">${d.status.state === 'pre' ? 'Squares fill in by themselves when they happen in the game. Get 4 in a row for BINGO (30 XP)!' : `${marked.size} of ${card.length} filled. 4 in a row is a BINGO (30 XP); fill them all for 100.`}</p>
      </section>`;
  }

  // ---- Call it ---------------------------------------------------------------
  const callsKey = () => `calls:${playerId()}:${gameKey()}`;

  function resolveCalls(d, away, home) {
    const calls = local.get(callsKey(), []);
    let changed = false;
    calls.forEach((c) => {
      if (c.result) return;
      const r = GC.resolveCall(c, d.playByPlay || [], { away, home });
      if (!r) return;
      c.result = r;
      changed = true;
      if (r.right) Kids.xp.award({ key: `call:${gameKey()}:${c.kind}:${c.afterId || c.at}`, points: r.points, reason: c.kind === 'play' ? 'Called the play!' : 'Called the next score!', game: gameKey() });
    });
    if (changed) local.set(callsKey(), calls);
    return calls;
  }

  function callHtml(d, away, home) {
    if (!d.status || d.status.state !== 'in') return '';
    const calls = resolveCalls(d, away, home);
    const open = (kind) => calls.find((c) => c.kind === kind && !c.result);
    const last = (kind) => calls.filter((c) => c.kind === kind && c.result).slice(-1)[0];
    const football = GC.family(sportKey()) === 'football';
    const playOpen = open('play');
    const scoreOpen = open('score');
    const tally = calls.filter((c) => c.result);
    const right = tally.filter((c) => c.result.right).length;
    const resultLine = (c, name) => (c ? `<div class="gd-note ${c.result.right ? 'right' : 'wrong'}">${c.result.right ? '✅' : '❌'} Last ${name}: you said ${esc(c.kind === 'play' ? c.guess : teamName(c.guess, away, home))}, it was ${esc(c.kind === 'play' ? c.result.actual : teamName(c.result.actual, away, home))}.</div>` : '');
    return `
      <section class="gd-card">
        <h3>📣 Call it! ${tally.length ? `<span class="gd-badge">${right} of ${tally.length} right</span>` : ''}</h3>
        ${football ? `
          <div class="gd-call">
            <div class="gd-call-q">What's the next play? <span class="gd-note">(10 XP)</span></div>
            <div class="gd-call-btns">${GC.CALL_OPTIONS.map((o) => `<button type="button" class="pick-side ${playOpen && playOpen.guess === o.key ? 'picked' : ''}" data-call="play" data-guess="${o.key}" ${playOpen ? 'disabled' : ''}>${o.emoji} ${esc(o.label)}</button>`).join('')}</div>
            ${playOpen ? '<div class="gd-note">Locked in. Watch the next snap!</div>' : resultLine(last('play'), 'play')}
          </div>` : ''}
        <div class="gd-call">
          <div class="gd-call-q">Who scores next? <span class="gd-note">(25 XP)</span></div>
          <div class="gd-call-btns">${[away, home].map((t) => `<button type="button" class="pick-side ${scoreOpen && String(scoreOpen.guess) === String(t.id) ? 'picked' : ''}" data-call="score" data-guess="${esc(t.id)}" ${scoreOpen ? 'disabled' : ''}>${t.logo ? `<img src="${CFB.safeUrl(t.logo)}" alt="" onerror="this.style.display='none'">` : ''}${esc(t.shortName || t.name)}</button>`).join('')}</div>
          ${scoreOpen ? '<div class="gd-note">Locked in. Next score decides it!</div>' : resultLine(last('score'), 'score call')}
        </div>
      </section>`;
  }

  function teamName(id, away, home) {
    const t = [away, home].find((x) => x && String(x.id) === String(id));
    return t ? (t.shortName || t.name) : 'nobody';
  }

  function makeCall(kind, guess) {
    const d = detail;
    if (!d || d.status.state !== 'in') return;
    const { away, home } = sides(d);
    const calls = local.get(callsKey(), []);
    if (calls.some((c) => c.kind === kind && !c.result)) return;
    const newest = (d.playByPlay || [])[0];
    calls.push({ kind, guess, afterId: newest ? newest.id : null, away: Number(away.score) || 0, home: Number(home.score) || 0, at: Date.now() });
    local.set(callsKey(), calls.slice(-100));
    render();
  }

  // ---- Trading cards -----------------------------------------------------------
  // Watching a game live, or a right pick, earns its stars as cards once
  // it's final.
  function cardsHtml(d) {
    const state = d.status && d.status.state;
    if (state === 'in') local.set(`watched:${playerId()}:${gameKey()}`, 1);
    const pick = Kids.picks.forPlayer(playerId())[gameKey()];
    const pickedRight = pick && KidsCore.pickOutcome(Object.assign({}, pick, { result: pick.result || KidsCore.gameResult(Object.assign({}, d, sides(d))) })) === 'right';
    const earned = state === 'post' && (local.get(`watched:${playerId()}:${gameKey()}`, 0) || pickedRight);
    const list = GC.cardsFromGame(d, sportKey());
    if (!list.length) return '';
    if (earned) Kids.cards.add(list);
    const mine = new Set(Kids.cards.forPlayer().map((c) => c.id));
    return `
      <section class="gd-card">
        <h3>🃏 Trading cards from this game</h3>
        <div class="tc-row">${list.map((c) => cardHtml(c, mine.has(c.id))).join('')}</div>
        <p class="gd-note">${earned ? 'Collected! See them all in your card binder on the Kids page.' : state === 'post' ? 'Watch a game live or pick the winner to collect its cards.' : 'Keep watching! When the game ends, these cards go in your binder.'}</p>
      </section>`;
  }

  function cardHtml(c, owned) {
    return `
      <div class="tc tc-${esc(c.rarity)} ${owned ? '' : 'tc-locked'}" style="--tc:${esc(c.color || '#3a6ea5')}" tabindex="0" role="button" aria-label="${esc(c.name)}, ${esc(c.rarity)} card${owned ? '' : ', not collected yet'}">
        <div class="tc-inner">
          <div class="tc-front">
            <div class="tc-rarity">${esc(GC.RARITY[c.rarity].label)}</div>
            ${c.headshot ? `<img class="tc-photo" src="${CFB.safeUrl(c.headshot)}" alt="" loading="lazy" onerror="this.style.display='none'">` : '<div class="tc-photo tc-photo-empty">🦝</div>'}
            <div class="tc-name">${esc(c.name)}</div>
            <div class="tc-team">${c.teamLogo ? `<img src="${CFB.safeUrl(c.teamLogo)}" alt="" onerror="this.style.display='none'">` : ''}${esc(c.team || '')}${c.position ? ` &middot; ${esc(c.position)}` : ''}</div>
          </div>
          <div class="tc-back">
            <div class="tc-stat">${esc(c.stat || 'Big game')}</div>
            <div class="tc-line">${esc(c.line || '')}</div>
            ${c.opponent ? `<div class="tc-vs">vs ${esc(c.opponent)}</div>` : ''}
            ${c.date ? `<div class="tc-vs">${esc(new Date(c.date).toLocaleDateString())}</div>` : ''}
          </div>
        </div>
      </div>`;
  }

  // ---- Family XP board for this game ---------------------------------------------
  async function loadLeagues() {
    if (leagues !== null) return leagues;
    leagues = [];
    if (!CFB.account || !CFB.account.user()) return leagues;
    try {
      const res = await CFB.getJson('/api/family/leagues');
      leagues = (res && res.leagues) || [];
      leagueId = local.get('chat-league', null);
      if (!leagues.some((l) => String(l.id) === String(leagueId))) leagueId = leagues[0] ? leagues[0].id : null;
    } catch (e) { leagues = []; }
    return leagues;
  }

  async function renderBoard() {
    const box = document.getElementById('gdBoard');
    if (!box || !leagueId) return;
    try {
      const res = await CFB.getJson(`/api/family/leagues/${encodeURIComponent(leagueId)}/xp?game=${encodeURIComponent(gameKey())}`);
      const rows = (res && res.rows) || [];
      box.innerHTML = rows.length ? `
        <h3>🏅 League XP this game</h3>
        <ol class="leaderboard league-board">${rows.map((r, i) => `<li><span class="lb-place">${i === 0 && r.game ? '&#128081;' : i + 1}</span><span class="lb-name">${esc(r.emoji || '⭐')} ${esc(r.name)} <span class="lb-member">${esc(r.member)} &middot; level ${esc(r.level)}</span></span><span class="lb-score">${esc(r.game)} XP</span></li>`).join('')}</ol>` : '';
    } catch (e) { /* keep the last board */ }
  }

  // ---- Draw ------------------------------------------------------------------------
  function render() {
    const d = detail;
    if (!d) return;
    const { away, home } = sides(d);
    if (!away || !home || !GC.family(sportKey())) { playBox.innerHTML = ''; return; }
    Kids.xp.touchStreak();
    playBox.innerHTML = `
      ${playerBar()}
      ${guessHtml(d, away, home)}
      ${callHtml(d, away, home)}
      ${bingoHtml(d)}
      ${cardsHtml(d)}
      <section class="gd-card" id="gdBoard"></section>`;
    // Guess points once the game is final.
    const pick = Kids.picks.forPlayer(playerId())[gameKey()];
    if (pick && pick.guess && d.status.state === 'post') {
      const pts = GC.guessPoints(pick.guess, { away: away.score, home: home.score });
      if (pts) Kids.xp.award({ key: `guess:${gameKey()}`, points: Math.min(60, pts), reason: 'Score guess', game: gameKey() });
    }
    const board = document.getElementById('gdBoard');
    if (board && !leagueId) board.remove();
    else renderBoard();
  }

  playBox.addEventListener('click', (e) => {
    const btn = e.target.closest && e.target.closest('[data-call]');
    if (btn) makeCall(btn.dataset.call, btn.dataset.guess);
  });
  playBox.addEventListener('submit', (e) => {
    if (e.target.id === 'gdGuess') { e.preventDefault(); saveGuess(e.target); }
  });
  playBox.addEventListener('change', (e) => {
    if (e.target.id === 'gdWho') { Kids.players.setCurrent(e.target.value); render(); }
  });

  // ---- Watch party chat --------------------------------------------------------------
  const chat = { after: 0, messages: [], timer: null, reactions: [] };

  function chatShell() {
    if (!chatBox) return;
    if (!CFB.account.user()) {
      chatBox.innerHTML = '<div class="empty-note">Sign in and join a family league to chat with your family during the game.</div>';
      return;
    }
    if (!leagues.length) {
      chatBox.innerHTML = '<div class="empty-note">Start or join a family league on the <a href="/kids.html">Kids page</a> to chat here during games.</div>';
      return;
    }
    const players = Kids.players.list();
    chatBox.innerHTML = `
      <section class="watch-party">
        <div class="wp-head">
          <h3>💬 Watch party</h3>
          ${leagues.length > 1 ? `<select id="wpLeague" aria-label="League">${leagues.map((l) => `<option value="${esc(l.id)}" ${String(l.id) === String(leagueId) ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select>` : `<span class="gd-note">${esc(leagues[0].name)}</span>`}
        </div>
        <div class="wp-log" id="wpLog" aria-live="polite"></div>
        <div class="wp-reactions" id="wpReactions"></div>
        <form class="wp-form" id="wpForm">
          ${players.length ? `<select id="wpAs" aria-label="Post as"><option value="">${esc(CFB.account.user().displayName || 'Me')}</option>${players.map((p) => `<option value="${esc(p.id)}" ${Kids.players.current() && Kids.players.current().id === p.id ? 'selected' : ''}>${esc(p.emoji)} ${esc(p.name)}</option>`).join('')}</select>` : ''}
          <input id="wpText" maxlength="280" placeholder="Say something" autocomplete="off" aria-label="Message">
          <button type="submit" class="big-btn">Send</button>
        </form>
      </section>`;
    chat.after = 0;
    chat.messages = [];
    pollChat();
  }

  function drawChat() {
    const log = document.getElementById('wpLog');
    if (!log) return;
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    log.innerHTML = chat.messages.length
      ? chat.messages.map((m) => `<div class="wp-msg ${m.mine ? 'mine' : ''} ${/^\p{Extended_Pictographic}+$/u.test(m.text) ? 'wp-emoji' : ''}"><span class="wp-who">${esc(m.emoji || '')} ${esc(m.name)}</span><span class="wp-text">${esc(m.text)}</span></div>`).join('')
      : '<div class="gd-note">No messages yet. Say hi!</div>';
    if (atBottom || chat.messages.length < 3) log.scrollTop = log.scrollHeight;
    const r = document.getElementById('wpReactions');
    if (r && !r.childElementCount) r.innerHTML = chat.reactions.map((e) => `<button type="button" class="wp-react" data-react="${esc(e)}" aria-label="Send ${esc(e)}">${esc(e)}</button>`).join('');
  }

  async function pollChat() {
    clearTimeout(chat.timer);
    if (!leagueId || !document.getElementById('wpLog')) return;
    try {
      const res = await CFB.getJson(`/api/family/leagues/${encodeURIComponent(leagueId)}/chat?game=${encodeURIComponent(gameKey())}&after=${chat.after}`);
      chat.reactions = res.reactions || chat.reactions;
      (res.messages || []).forEach((m) => { if (!chat.messages.some((x) => x.id === m.id)) chat.messages.push(m); });
      chat.messages = chat.messages.slice(-200);
      if (chat.messages.length) chat.after = chat.messages[chat.messages.length - 1].id;
      drawChat();
    } catch (e) { /* try again */ }
    const live = detail && detail.status && detail.status.state === 'in';
    chat.timer = setTimeout(pollChat, document.hidden ? 30000 : live ? 4000 : 15000);
  }

  async function sendChat(text) {
    const as = document.getElementById('wpAs');
    try {
      const res = await CFB.account.postJson(`/api/family/leagues/${encodeURIComponent(leagueId)}/chat`, { game: gameKey(), text, playerId: as ? as.value || null : null });
      if (res && res.message && !chat.messages.some((x) => x.id === res.message.id)) {
        chat.messages.push(res.message);
        chat.after = Math.max(chat.after, res.message.id);
        drawChat();
      }
    } catch (e) { Kids.toast(e.message || 'Could not send that.'); }
  }

  if (chatBox) {
    chatBox.addEventListener('submit', (e) => {
      if (e.target.id !== 'wpForm') return;
      e.preventDefault();
      const input = document.getElementById('wpText');
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      sendChat(text);
    });
    chatBox.addEventListener('click', (e) => {
      const b = e.target.closest && e.target.closest('[data-react]');
      if (b) sendChat(b.dataset.react);
    });
    chatBox.addEventListener('change', (e) => {
      if (e.target.id === 'wpLeague') {
        leagueId = e.target.value;
        local.set('chat-league', leagueId);
        chatShell();
        render();
      }
    });
  }

  let started = false;
  window.addEventListener('tracker:game-loaded', async (e) => {
    detail = e.detail;
    if (!started) {
      started = true;
      await Kids.ready;
      await loadLeagues();
      chatShell();
    }
    render();
  });
  window.addEventListener('tracker:kids-synced', () => { if (detail) render(); });
})();

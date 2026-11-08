// Kids' features that run in the browser on every page: the kid mode
// toggle, score celebrations (confetti, a horn or "charge!" fanfare, and a
// `tracker:score` event other code can listen for), and the saved data for
// pick'em players, picks and stickers.
//
// Needs shared.js (CFB) and kids-core.js (KidsCore) loaded first.
//
// Saved data goes through Kids.store. Signed out, it lives in this
// browser. Signed in, players, picks, stickers and bracket picks live on
// the account (src/family.js): whatever this browser saved before is
// merged into the account once, then cleared here, and every change is
// saved back. Settings and "who's playing" stay per device. Wait for
// Kids.ready before reading saved data on page load.

const Kids = (function () {
  // ---- Storage ---------------------------------------------------------------
  const localBackend = {
    get(key) {
      try { return JSON.parse(localStorage.getItem(`tracker-kids:${key}`) || 'null'); } catch (e) { return null; }
    },
    set(key, value) {
      try { localStorage.setItem(`tracker-kids:${key}`, JSON.stringify(value)); } catch (e) { /* ignore */ }
    },
    remove(key) {
      try { localStorage.removeItem(`tracker-kids:${key}`); } catch (e) { /* ignore */ }
    },
  };
  let backend = localBackend;
  const store = {
    get(key, fallback) {
      const v = backend.get(key);
      return v === null || v === undefined ? fallback : v;
    },
    set(key, value) {
      backend.set(key, value);
      window.dispatchEvent(new CustomEvent('tracker:kids-data', { detail: { key } }));
    },
    setBackend(next) { backend = next || localBackend; },
  };

  // ---- Settings ----------------------------------------------------------------
  const DEFAULT_SETTINGS = { confetti: true, sound: true };
  function settings() {
    return Object.assign({}, DEFAULT_SETTINGS, store.get('settings', {}));
  }
  function setSetting(name, value) {
    store.set('settings', Object.assign(settings(), { [name]: value }));
  }

  // ---- Players -----------------------------------------------------------------
  // { id, name, emoji }. Stickers and picks belong to a player; with no
  // players yet, stickers go to the shared "family" album.
  const EMOJIS = ['🦊', '🐯', '🐻', '🐼', '🦁', '🐸', '🐵', '🦄', '🐶', '🐱', '🦖', '🐙'];
  const players = {
    list() { return store.get('players', []); },
    add(name) {
      const clean = String(name || '').trim().slice(0, 20);
      if (!clean) return null;
      const list = players.list();
      if (list.length >= 12) return null;
      const used = new Set(list.map((p) => p.emoji));
      const player = {
        id: `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        name: clean,
        emoji: EMOJIS.find((e) => !used.has(e)) || EMOJIS[list.length % EMOJIS.length],
      };
      store.set('players', [...list, player]);
      if (!players.current()) players.setCurrent(player.id);
      return player;
    },
    remove(id) {
      store.set('players', players.list().filter((p) => p.id !== id));
      ['picks', 'brackets'].forEach((key) => {
        const all = store.get(key, {});
        delete all[id];
        store.set(key, all);
      });
      if (store.get('current', null) === id) store.set('current', null);
    },
    current() {
      const id = store.get('current', null);
      const list = players.list();
      return list.find((p) => p.id === id) || list[0] || null;
    },
    setCurrent(id) { store.set('current', id); },
  };

  // ---- Picks -------------------------------------------------------------------
  // picks[playerId][`${sport}:${gameId}`] = pick (see kids-core.js).
  const picks = {
    all() { return store.get('picks', {}); },
    forPlayer(playerId) { return picks.all()[playerId] || {}; },
    set(playerId, pick) {
      const all = picks.all();
      all[playerId] = all[playerId] || {};
      all[playerId][`${pick.sport}:${pick.gameId}`] = pick;
      store.set('picks', all);
    },
    // Saves finished results and hands out a sticker for each right pick.
    resolve(results) {
      const all = picks.all();
      let changed = false;
      Object.entries(all).forEach(([playerId, list]) => {
        Object.values(list).forEach((p) => {
          const r = results[`${p.sport}:${p.gameId}`];
          if (p.result || !r) return;
          p.result = r;
          changed = true;
          if (KidsCore.pickOutcome(p) === 'right') {
            xp.award({ key: `pick:${p.sport}:${p.gameId}`, points: 20, reason: 'Right pick!', game: `${p.sport}:${p.gameId}` }, playerId, { quiet: true });
            const team = [p.away, p.home].find((t) => t && String(t.id) === String(p.teamId)) || {};
            const opponent = [p.away, p.home].find((t) => t && String(t.id) !== String(p.teamId)) || {};
            stickers.add({ sport: p.sport, gameId: p.gameId, teamId: p.teamId, name: team.name, logo: team.logo, color: team.color, reason: 'picked', label: opponent.name ? `${p.spread !== undefined && p.spread !== null ? 'Covered vs' : 'Beat'} ${opponent.name}` : 'Picked right' }, playerId);
          }
        });
      });
      if (changed) store.set('picks', all);
      return changed;
    },
  };

  // ---- Bracket challenge -------------------------------------------------------
  // brackets[playerId][`${sport}:${gameId}`] = { sport, season, gameId,
  // teamId, round, date, away, home }. Scored by brackets-core.js.
  const brackets = {
    all() { return store.get('brackets', {}); },
    forPlayer(playerId) { return brackets.all()[playerId] || {}; },
    set(playerId, pick) {
      const all = brackets.all();
      all[playerId] = all[playerId] || {};
      all[playerId][`${pick.sport}:${pick.gameId}`] = pick;
      store.set('brackets', all);
    },
  };

  // ---- Stickers ----------------------------------------------------------------
  const stickers = {
    all() { return store.get('stickers', {}); },
    forPlayer(playerId) { return stickers.all()[playerId || 'family'] || []; },
    add(sticker, playerId) {
      const owner = playerId || (players.current() && players.current().id) || 'family';
      const all = stickers.all();
      const list = all[owner] || [];
      const key = KidsCore.stickerKey(sticker);
      if (list.some((s) => KidsCore.stickerKey(s) === key)) return false;
      all[owner] = [...list, Object.assign({}, sticker, { at: Date.now() })].slice(-500);
      store.set('stickers', all);
      return true;
    },
  };

  // A sticker for each followed team in a game that's on right now, for
  // whoever is watching (the current player).
  function awardWatched(game, sportKey) {
    if (!game || !game.status || game.status.state !== 'in') return [];
    const followed = CFB.follows.ids(sportKey);
    const teams = game.teams || [game.away, game.home].filter(Boolean);
    const earned = [];
    teams.forEach((t) => {
      if (!t || !followed.has(String(t.id))) return;
      const opponent = teams.find((o) => o && o !== t);
      const added = stickers.add({
        sport: sportKey, gameId: String(game.id), teamId: String(t.id), name: t.name, logo: t.logo, color: t.color,
        reason: 'watched', label: opponent ? `vs ${opponent.name}` : 'Watched a game',
      });
      if (added) earned.push(t);
    });
    if (earned.length) toast(`New sticker! ${earned.map((t) => t.name).join(' & ')} added to your sticker book.`);
    return earned;
  }

  // ---- Saving to the account ----------------------------------------------------
  const SYNCED = ['players', 'picks', 'stickers', 'brackets', 'xp', 'cards'];
  let synced = false;

  function isEmpty(v) {
    return !v || (Array.isArray(v) ? !v.length : !Object.keys(v).length);
  }

  // Keeps the account's copy in memory and saves each change a moment
  // later (several quick changes become one request).
  function accountBackend(data) {
    const memory = {};
    SYNCED.forEach((k) => { memory[k] = data[k] === undefined ? null : data[k]; });
    const timers = {};
    const versions = {};
    const save = (key, keepalive) => {
      clearTimeout(timers[key]);
      timers[key] = null;
      const version = versions[key];
      return fetch(`/api/family/data/${encodeURIComponent(key)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        keepalive: !!keepalive,
        body: JSON.stringify({ value: memory[key] }),
      }).then((r) => (r.ok ? r.json() : null)).then((r) => {
        // The server adds pick times; take its copy unless something
        // changed again while this save was on its way.
        if (r && r.value !== undefined && versions[key] === version) memory[key] = r.value;
      }).catch(() => { /* saved again on the next change */ });
    };
    window.addEventListener('pagehide', () => {
      Object.keys(timers).forEach((key) => { if (timers[key]) save(key, true); });
    });
    return {
      get(key) {
        if (!SYNCED.includes(key)) return localBackend.get(key);
        return memory[key] === null || memory[key] === undefined ? null : JSON.parse(JSON.stringify(memory[key]));
      },
      set(key, value) {
        if (!SYNCED.includes(key)) { localBackend.set(key, value); return; }
        memory[key] = JSON.parse(JSON.stringify(value));
        versions[key] = (versions[key] || 0) + 1;
        clearTimeout(timers[key]);
        timers[key] = setTimeout(() => save(key), 400);
      },
    };
  }

  const ready = (async () => {
    if (typeof CFB === 'undefined' || !CFB.account) return false;
    let me;
    try { me = await CFB.account.load(); } catch (e) { return false; }
    if (!me || !me.user) return false;
    const local = {};
    SYNCED.forEach((k) => { const v = localBackend.get(k); if (!isEmpty(v)) local[k] = v; });
    try {
      const res = Object.keys(local).length
        ? await CFB.account.postJson('/api/family/data/merge', { data: local })
        : await CFB.getJson('/api/family/data');
      // The account has it now; don't merge it again (or hand it to the
      // next person who signs in on this device).
      Object.keys(local).forEach((k) => localBackend.remove(k));
      store.setBackend(accountBackend((res && res.data) || {}));
      synced = true;
      window.dispatchEvent(new CustomEvent('tracker:kids-synced'));
      return true;
    } catch (e) {
      return false; // keep using this browser's copy
    }
  })();

  // ---- Header: kid mode toggle and Kids link -----------------------------------
  function initHeader() {
    document.body.classList.toggle('kid-mode', CFB.kidMode());
    const nav = document.querySelector('nav.top-nav');
    // No betting page in kid mode.
    if (nav && CFB.kidMode()) nav.querySelectorAll('a[href^="/lines.html"]').forEach((a) => a.remove());
    if (!nav || nav.querySelector('.kids-link')) return;
    if (location.pathname !== '/brackets.html' && !nav.querySelector('a[href^="/brackets.html"]')) {
      const link = document.createElement('a');
      link.href = '/brackets.html';
      link.className = 'playoffs-link';
      link.textContent = '🏆 Playoffs';
      nav.appendChild(link);
    }
    if (location.pathname !== '/kids.html') {
      const link = document.createElement('a');
      link.href = '/kids.html';
      link.className = 'kids-link';
      link.textContent = '⭐ Kids';
      nav.appendChild(link);
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'kid-mode-btn';
    const paint = () => {
      const on = CFB.kidMode();
      btn.textContent = on ? '🧒 Kid mode: on' : '🧒 Kid mode';
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      document.body.classList.toggle('kid-mode', on);
    };
    btn.addEventListener('click', () => {
      CFB.setKidMode(!CFB.kidMode());
      paint();
      // Labels and odds are drawn by each page's own render code, so the
      // simplest way to redraw everything in the new mode is a reload.
      location.reload();
    });
    paint();
    nav.appendChild(btn);

    // Kid mode: Scrappy reads your teams' scores out loud.
    if (CFB.kidMode() && canSpeak && GC) {
      const speakBtn = document.createElement('button');
      speakBtn.type = 'button';
      speakBtn.className = 'kid-mode-btn';
      speakBtn.textContent = '🔊 Read my scores';
      speakBtn.addEventListener('click', readMyScores);
      nav.appendChild(speakBtn);
    }
  }

  async function readMyScores() {
    const followed = CFB.follows.all().filter((t) => t.sport && t.id);
    if (!followed.length) { speak('Follow a team first, and I will tell you how they are doing!'); return; }
    speak('Let me check on your teams.');
    try {
      const teamsParam = followed.map((t) => `${t.sport}:${t.id}`).join(',');
      const data = await CFB.getJson(`/api/home?teams=${encodeURIComponent(teamsParam)}`);
      const when = (iso) => {
        const d = new Date(iso);
        return `on ${d.toLocaleDateString(undefined, { weekday: 'long' })} at ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
      };
      const lines = GC.spokenTeams((data && data.myTeams) || [], when);
      speak(lines.length ? lines.join(' ') : 'No games for your teams right now.');
    } catch (e) {
      speak('Sorry, I could not get the scores right now.');
    }
  }

  // ---- Celebrations ------------------------------------------------------------
  let audioCtx = null;
  function audio() {
    if (audioCtx) return audioCtx;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    try { audioCtx = new Ctx(); } catch (e) { audioCtx = null; }
    return audioCtx;
  }
  // Browsers only allow sound after the visitor has clicked or tapped
  // something, so wake the audio up on the first tap.
  function unlockAudioOnTap() {
    const unlock = () => {
      const ctx = audio();
      if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
  }

  function tone(ctx, { freq, start, length, type, gain }) {
    const osc = ctx.createOscillator();
    const amp = ctx.createGain();
    osc.type = type || 'square';
    osc.frequency.value = freq;
    amp.gain.setValueAtTime(0, start);
    amp.gain.linearRampToValueAtTime(gain || 0.12, start + 0.02);
    amp.gain.setValueAtTime(gain || 0.12, start + length - 0.05);
    amp.gain.linearRampToValueAtTime(0, start + length);
    osc.connect(amp).connect(ctx.destination);
    osc.start(start);
    osc.stop(start + length + 0.02);
  }

  // The stadium "Charge!" bugle call.
  function playCharge(ctx) {
    const t = ctx.currentTime + 0.05;
    const notes = [[392, 0.15], [523, 0.15], [659, 0.15], [784, 0.3], [659, 0.15], [784, 0.6]];
    let at = t;
    notes.forEach(([freq, len]) => { tone(ctx, { freq, start: at, length: len, type: 'square', gain: 0.1 }); at += len + 0.02; });
  }

  // A goal horn: two low, slightly clashing notes held for a moment.
  function playHorn(ctx) {
    const t = ctx.currentTime + 0.05;
    [174, 220, 261].forEach((freq) => tone(ctx, { freq, start: t, length: 1.8, type: 'sawtooth', gain: 0.07 }));
  }

  function playWin(ctx) {
    const t = ctx.currentTime + 0.05;
    [523, 659, 784, 1047].forEach((freq, i) => tone(ctx, { freq, start: t + i * 0.12, length: i === 3 ? 0.7 : 0.14, type: 'triangle', gain: 0.14 }));
  }

  // Your own team's song: drop an mp3 at /sounds/<sport>-<teamId>.mp3
  // (for example /sounds/cfb-259.mp3) and it plays instead of the built-in
  // sound. Returns false when there isn't one.
  const songCache = {};
  async function playTeamSong(sportKey, teamId) {
    const url = `/sounds/${encodeURIComponent(sportKey)}-${encodeURIComponent(teamId)}.mp3`;
    if (!(url in songCache)) {
      songCache[url] = await fetch(url, { method: 'HEAD' })
        .then((r) => r.ok && /^audio\//.test(r.headers.get('content-type') || ''))
        .catch(() => false);
    }
    if (!songCache[url]) return false;
    try {
      const el = new Audio(url);
      el.volume = 0.8;
      await el.play();
      setTimeout(() => el.pause(), 20000);
      return true;
    } catch (e) {
      return false;
    }
  }

  async function playSound(event, sportKey) {
    if (!settings().sound) return;
    if (await playTeamSong(sportKey, event.team.id)) return;
    const ctx = audio();
    if (!ctx || ctx.state === 'suspended') return;
    if (event.kind === 'win') playWin(ctx);
    else if (['hockey', 'soccer'].includes(KidsCore.family(sportKey))) playHorn(ctx);
    else playCharge(ctx);
  }

  // Follows the Display panel's Motion setting (js/i18n.js), which falls
  // back to the OS reduced-motion setting.
  function prefersReducedMotion() {
    if (window.I18n && window.I18n.reducedMotion) return window.I18n.reducedMotion();
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function confetti(color) {
    if (!settings().confetti || prefersReducedMotion()) return;
    const canvas = document.createElement('canvas');
    canvas.className = 'confetti-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    document.body.appendChild(canvas);
    const ctx = canvas.getContext('2d');
    const resize = () => { canvas.width = window.innerWidth; canvas.height = window.innerHeight; };
    resize();
    const colors = [color || '#f2b705', '#ffffff', '#f2b705', color || '#4f8dfd'];
    const bits = Array.from({ length: 160 }, () => ({
      x: canvas.width / 2 + (Math.random() - 0.5) * canvas.width * 0.3,
      y: canvas.height * 0.35,
      vx: (Math.random() - 0.5) * 16,
      vy: -Math.random() * 16 - 4,
      size: 6 + Math.random() * 7,
      spin: Math.random() * Math.PI,
      color: colors[Math.floor(Math.random() * colors.length)],
    }));
    const started = performance.now();
    function frame(now) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      bits.forEach((b) => {
        b.vy += 0.35;
        b.vx *= 0.99;
        b.x += b.vx;
        b.y += b.vy;
        b.spin += 0.2;
        ctx.save();
        ctx.translate(b.x, b.y);
        ctx.rotate(b.spin);
        ctx.fillStyle = b.color;
        ctx.fillRect(-b.size / 2, -b.size / 4, b.size, b.size / 2);
        ctx.restore();
      });
      if (now - started < 3500) requestAnimationFrame(frame);
      else canvas.remove();
    }
    requestAnimationFrame(frame);
  }

  function banner(event) {
    const old = document.querySelector('.celebrate-banner');
    if (old) old.remove();
    const div = document.createElement('div');
    div.className = 'celebrate-banner';
    div.setAttribute('role', 'status');
    const color = event.team.color && /^#[0-9a-f]{3,8}$/i.test(event.team.color) ? event.team.color : null;
    if (color) div.style.setProperty('--team-color', color);
    div.innerHTML = `
      ${event.team.logo ? `<img src="${CFB.safeUrl(event.team.logo)}" alt="" onerror="this.style.display='none'">` : ''}
      <div>
        <div class="celebrate-label">${CFB.esc(event.label)}</div>
        <div class="celebrate-team">${CFB.esc(event.team.name || '')}${event.kind === 'score' && event.team.score !== null && event.team.score !== undefined ? ` &middot; ${CFB.esc(event.team.score)}` : ''}</div>
      </div>`;
    div.addEventListener('click', () => div.remove());
    document.body.appendChild(div);
    setTimeout(() => div.remove(), 6000);
  }

  // Shows the party for one score or win. Also fires a `tracker:score`
  // event on window so other code (a Home Assistant hook, for example)
  // can react, with detail:
  //   { kind: 'score' | 'win', sport, gameId, teamId, teamName, color,
  //     points, label, score, opponent }
  function celebrate(event, sportKey) {
    const detail = {
      kind: event.kind,
      sport: sportKey,
      gameId: event.gameId,
      teamId: String(event.team.id),
      teamName: event.team.name || null,
      color: event.team.color || null,
      points: event.points,
      label: event.label,
      score: event.team.score === undefined ? null : event.team.score,
      opponent: event.opponent ? { id: String(event.opponent.id), name: event.opponent.name || null, score: event.opponent.score === undefined ? null : event.opponent.score } : null,
    };
    window.dispatchEvent(new CustomEvent('tracker:score', { detail }));
    banner(event);
    confetti(event.team.color);
    playSound(event, sportKey);
  }

  // Call with every fresh batch of games (scoreboard games or a game
  // summary). Celebrates when a followed team's score goes up or it wins.
  const seen = {};
  function watchScores(games, sportKey) {
    const followed = CFB.follows.ids(sportKey);
    if (!followed.size) return [];
    const normalized = (games || []).map((g) => (g && g.teams && !g.home
      ? Object.assign({}, g, { away: g.teams.find((t) => t.homeAway === 'away'), home: g.teams.find((t) => t.homeAway === 'home') })
      : g));
    const { next, events } = KidsCore.scoreChanges(seen[sportKey] || {}, normalized, followed, sportKey);
    seen[sportKey] = Object.assign(seen[sportKey] || {}, next);
    events.forEach((e, i) => setTimeout(() => celebrate(e, sportKey), i * 4000));
    return events;
  }

  // ---- Small toast ---------------------------------------------------------------
  function toast(text) {
    const div = document.createElement('div');
    div.className = 'kids-toast';
    div.setAttribute('role', 'status');
    div.textContent = text;
    // Stack on top of any toast still showing.
    const showing = document.querySelectorAll('.kids-toast').length;
    if (showing) div.style.bottom = `${20 + showing * 58}px`;
    document.body.appendChild(div);
    setTimeout(() => div.remove(), 5000);
  }

  // ---- XP, levels, streaks and Scrappy's outfits -----------------------------
  // xp[playerId] = { total, log, streak, outfit } (see gameday-core.js).
  // With no players yet, XP goes to the shared "family" record.
  const GC = typeof GamedayCore !== 'undefined' ? GamedayCore : null;
  const owner = (playerId) => playerId || (players.current() && players.current().id) || 'family';
  const localDay = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const xp = {
    all() { return store.get('xp', {}); },
    record(playerId) { return xp.all()[owner(playerId)] || { total: 0, log: [] }; },
    level(playerId) { return GC ? GC.levelFor(xp.record(playerId).total) : { level: 1, xp: 0, progress: 0 }; },
    // award: { key, points, reason, game }. Each key pays once.
    award(award, playerId, { quiet } = {}) {
      if (!GC) return false;
      const id = owner(playerId);
      const all = xp.all();
      const before = GC.levelFor((all[id] && all[id].total) || 0).level;
      const res = GC.addXp(all[id], award);
      if (!res.added) return false;
      all[id] = res.record;
      store.set('xp', all);
      const after = GC.levelFor(res.record.total).level;
      if (after > before) {
        const outfit = GC.OUTFITS.find((o) => o.level === after);
        toast(`Level ${after}! ${outfit ? `${outfit.emoji} Scrappy unlocked the ${outfit.name}!` : 'Keep it up!'}`);
        confetti('#f5a623');
      } else if (!quiet) {
        toast(`+${res.entry.points} XP · ${res.entry.reason}`);
      }
      return true;
    },
    // Counts today toward the streak, once a day, and pays the streak bonus.
    touchStreak(playerId) {
      if (!GC) return null;
      const id = owner(playerId);
      const all = xp.all();
      const rec = all[id] || { total: 0, log: [] };
      const today = localDay();
      const next = GC.updateStreak(rec.streak, today);
      if (rec.streak && rec.streak.last === today) return next;
      all[id] = Object.assign({}, rec, { streak: next });
      store.set('xp', all);
      xp.award({ key: `streak:${today}`, points: GC.streakBonus(next.days), reason: next.days > 1 ? `${next.days} days in a row!` : 'Daily visit' }, id);
      return next;
    },
    setOutfit(key, playerId) {
      const id = owner(playerId);
      const all = xp.all();
      all[id] = Object.assign({ total: 0, log: [] }, all[id], { outfit: key });
      store.set('xp', all);
    },
  };

  // ---- Player trading cards ------------------------------------------------------
  const cards = {
    all() { return store.get('cards', {}); },
    forPlayer(playerId) { return cards.all()[owner(playerId)] || []; },
    // Adds cards the player doesn't have yet; returns the new ones.
    add(list, playerId) {
      const id = owner(playerId);
      const all = cards.all();
      const mine = all[id] || [];
      const have = new Set(mine.map((c) => c.id));
      const fresh = (list || []).filter((c) => c && c.id && !have.has(c.id)).map((c) => Object.assign({}, c, { at: Date.now() }));
      if (!fresh.length) return [];
      all[id] = [...mine, ...fresh].slice(-300);
      store.set('cards', all);
      fresh.forEach((c) => xp.award({ key: `card:${c.id}`, points: GC ? GC.RARITY[c.rarity].xp : 5, reason: `${c.rarity} card: ${c.name}`, game: `${c.sport}:${c.gameId}` }, id, { quiet: true }));
      const best = fresh.slice().sort((a, b) => Object.keys(GC ? GC.RARITY : {}).indexOf(b.rarity) - Object.keys(GC ? GC.RARITY : {}).indexOf(a.rarity))[0];
      toast(fresh.length === 1 ? `New ${best.rarity} card: ${best.name}!` : `${fresh.length} new trading cards, including ${best.name} (${best.rarity})!`);
      return fresh;
    },
  };

  // ---- Read it out loud ------------------------------------------------------------
  // Uses the browser's own voice (no server, nothing sent anywhere).
  const canSpeak = typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined';
  function speak(text, { lang } = {}) {
    if (!canSpeak || !text) return false;
    try {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(String(text));
      u.lang = lang || (document.documentElement.lang === 'es' ? 'es-US' : 'en-US');
      u.rate = 0.95;
      u.pitch = 1.1;
      window.speechSynthesis.speak(u);
      return true;
    } catch (e) { return false; }
  }

  // Tap a trading card (or press Enter on it) to flip it.
  if (typeof document !== 'undefined') {
    document.addEventListener('click', (e) => {
      const card = e.target.closest && e.target.closest('.tc');
      if (card && !(e.target.closest('a'))) card.classList.toggle('flipped');
    });
    document.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && e.target.classList && e.target.classList.contains('tc')) {
        e.preventDefault();
        e.target.classList.toggle('flipped');
      }
    });
  }

  initHeader();
  unlockAudioOnTap();

  return {
    store, settings, setSetting, players, picks, stickers, brackets,
    awardWatched, watchScores, celebrate, toast, xp, cards, speak, canSpeak,
    ready, isSynced: () => synced,
  };
})();

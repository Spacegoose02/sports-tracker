// Kids' features that run in the browser on every page: the kid mode
// toggle, score celebrations (confetti, a horn or "charge!" fanfare, and a
// `tracker:score` event other code can listen for), and the saved data for
// pick'em players, picks and stickers.
//
// Needs shared.js (CFB) and kids-core.js (KidsCore) loaded first.
//
// Saved data lives in this browser for now. Everything goes through
// Kids.store, so once user accounts land a sync layer can call
// Kids.store.setBackend({ get(key), set(key, value) }) to keep it on the
// server instead, and listen for `tracker:kids-data` to know when to save.

const Kids = (function () {
  // ---- Storage ---------------------------------------------------------------
  const localBackend = {
    get(key) {
      try { return JSON.parse(localStorage.getItem(`tracker-kids:${key}`) || 'null'); } catch (e) { return null; }
    },
    set(key, value) {
      try { localStorage.setItem(`tracker-kids:${key}`, JSON.stringify(value)); } catch (e) { /* ignore */ }
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
      const picks = store.get('picks', {});
      delete picks[id];
      store.set('picks', picks);
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
            const team = [p.away, p.home].find((t) => t && String(t.id) === String(p.teamId)) || {};
            const opponent = [p.away, p.home].find((t) => t && String(t.id) !== String(p.teamId)) || {};
            stickers.add({ sport: p.sport, gameId: p.gameId, teamId: p.teamId, name: team.name, logo: team.logo, color: team.color, reason: 'picked', label: opponent.name ? `Beat ${opponent.name}` : 'Picked right' }, playerId);
          }
        });
      });
      if (changed) store.set('picks', all);
      return changed;
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

  // ---- Header: kid mode toggle and Kids link -----------------------------------
  function initHeader() {
    document.body.classList.toggle('kid-mode', CFB.kidMode());
    const nav = document.querySelector('nav.top-nav');
    if (!nav || nav.querySelector('.kids-link')) return;
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
    else if (KidsCore.family(sportKey) === 'hockey') playHorn(ctx);
    else playCharge(ctx);
  }

  function prefersReducedMotion() {
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
    document.body.appendChild(div);
    setTimeout(() => div.remove(), 5000);
  }

  initHeader();
  unlockAudioOnTap();

  return {
    store, settings, setSetting, players, picks, stickers,
    awardWatched, watchScores, celebrate, toast,
  };
})();

// Pure logic behind the game-day games for kids: Game Day Bingo, Call the
// next play, Who scores next, the score guess, player trading cards and
// XP levels with Scrappy outfits. No DOM, no fetch, no storage, so it runs
// the same in the browser (as the global GamedayCore) and in Node tests
// (require('../public/js/gameday-core.js')).

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GamedayCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const FAMILY = {
    cfb: 'football', nfl: 'football',
    nba: 'basketball', mcbb: 'basketball', wnba: 'basketball',
    mlb: 'baseball', nhl: 'hockey',
    epl: 'soccer', mls: 'soccer', ucl: 'soccer',
  };
  const family = (sportKey) => FAMILY[sportKey] || null;

  // Deterministic random numbers from a string, so the same kid gets the
  // same bingo card for a game on every device and every refresh.
  function seeded(str) {
    let h = 2166136261;
    const s = String(str || '');
    for (let i = 0; i < s.length; i += 1) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return function () {
      h += 0x6D2B79F5;
      let t = h;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function shuffle(list, rng) {
    const a = list.slice();
    for (let i = a.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // ---- Game Day Bingo -----------------------------------------------------
  // Each square fills in by itself when a play's text matches. `not` keeps
  // a near miss ("field goal is no good") from counting.
  const SQUARES = {
    football: [
      { key: 'td', label: 'Touchdown', emoji: '🏈', match: /touchdown|\bTD\b/i },
      { key: 'fg', label: 'Field goal', emoji: '🥅', match: /field goal/i, not: /no good|missed|blocked/i },
      { key: 'int', label: 'Interception', emoji: '🙌', match: /intercept/i },
      { key: 'fumble', label: 'Fumble', emoji: '😬', match: /fumble/i },
      { key: 'sack', label: 'Sack', emoji: '💥', match: /sacked|\bsack\b/i },
      { key: 'punt', label: 'Punt', emoji: '🦶', match: /\bpunt/i },
      { key: 'fourth', label: '4th down try', emoji: '4️⃣', match: /^4th|4th (and|&)|fourth down/i, not: /punt|field goal/i },
      { key: 'flag', label: 'Penalty flag', emoji: '🚩', match: /penalty/i },
      { key: 'long', label: '20+ yard play', emoji: '🚀', match: /for (2\d|[3-9]\d) yds|for (2\d|[3-9]\d) yards/i },
      { key: 'firstdown', label: 'First down', emoji: '⛓️', match: /1st down|first down/i },
      { key: 'incomplete', label: 'Incomplete pass', emoji: '🤷', match: /incomplete/i },
      { key: 'xp', label: 'Extra point', emoji: '☝️', match: /extra point|\bPAT\b|kick\)/i, not: /no good|missed|blocked/i },
      { key: 'twopt', label: 'Two-point try', emoji: '✌️', match: /two-point|2-pt|two point/i },
      { key: 'timeout', label: 'Timeout', emoji: '⏱️', match: /timeout/i },
      { key: 'kickoff', label: 'Kickoff return', emoji: '↩️', match: /kickoff.*return|kicks .* returned|return(ed)? for \d/i },
      { key: 'touchback', label: 'Touchback', emoji: '🛑', match: /touchback/i },
      { key: 'challenge', label: 'Replay review', emoji: '📺', match: /review|challenge|overturned|upheld/i },
      { key: 'loss', label: 'Tackle for loss', emoji: '🧱', match: /for (a )?loss of|for -\d/i },
      { key: 'safety', label: 'Safety', emoji: '🛟', match: /safety/i },
      { key: 'block', label: 'Blocked kick', emoji: '✋', match: /blocked/i },
    ],
    basketball: [
      { key: 'three', label: 'Three-pointer', emoji: '👌', match: /three point|3-pt|three-point/i, not: /miss/i },
      { key: 'dunk', label: 'Dunk', emoji: '🏀', match: /dunk/i, not: /miss/i },
      { key: 'block', label: 'Block', emoji: '✋', match: /block/i },
      { key: 'steal', label: 'Steal', emoji: '🦝', match: /steal/i },
      { key: 'ft', label: 'Free throw made', emoji: '🎯', match: /free throw/i, not: /miss/i },
      { key: 'ftmiss', label: 'Missed free throw', emoji: '😩', match: /free throw/i, also: /miss/i },
      { key: 'timeout', label: 'Timeout', emoji: '⏱️', match: /timeout/i },
      { key: 'offreb', label: 'Offensive rebound', emoji: '🔁', match: /offensive rebound/i },
      { key: 'layup', label: 'Layup', emoji: '🙆', match: /layup/i, not: /miss/i },
      { key: 'foul', label: 'Foul', emoji: '🚨', match: /foul/i },
      { key: 'travel', label: 'Traveling', emoji: '🚶', match: /travel/i },
      { key: 'turnover', label: 'Turnover', emoji: '🙈', match: /turnover|bad pass|lost ball/i },
      { key: 'jumper', label: 'Jump shot', emoji: '🦘', match: /jump shot|jumper/i, not: /miss/i },
      { key: 'alley', label: 'Alley-oop', emoji: '🪂', match: /alley oop|alley-oop/i },
      { key: 'and1', label: 'Shooting foul', emoji: '💪', match: /shooting foul/i },
      { key: 'sub', label: 'Substitution', emoji: '🔄', match: /enters the game|substitution/i },
      { key: 'review', label: 'Replay review', emoji: '📺', match: /review|challenge/i },
      { key: 'tech', label: 'Technical foul', emoji: '😤', match: /technical/i },
    ],
    hockey: [
      { key: 'goal', label: 'Goal', emoji: '🚨', match: /goal/i, not: /on goal|saved|no goal|disallowed/i },
      { key: 'save', label: 'Save', emoji: '🧤', match: /save|saved/i },
      { key: 'penalty', label: 'Penalty', emoji: '⛔', match: /penalty|minutes for|tripping|hooking|slashing|roughing|interference/i },
      { key: 'faceoff', label: 'Faceoff', emoji: '🏒', match: /faceoff/i },
      { key: 'hit', label: 'Big hit', emoji: '💥', match: /\bhit\b|hits/i },
      { key: 'block', label: 'Blocked shot', emoji: '🧱', match: /blocked/i },
      { key: 'miss', label: 'Missed shot', emoji: '↗️', match: /missed|wide of net|over the net/i },
      { key: 'giveaway', label: 'Giveaway', emoji: '🎁', match: /giveaway/i },
      { key: 'takeaway', label: 'Takeaway', emoji: '🦝', match: /takeaway/i },
      { key: 'icing', label: 'Icing', emoji: '🧊', match: /icing/i },
      { key: 'offside', label: 'Offside', emoji: '🚫', match: /offside/i },
      { key: 'shot', label: 'Shot on goal', emoji: '🎯', match: /shot on goal|on goal/i },
      { key: 'pp', label: 'Power play goal', emoji: '⚡', match: /power play|ppg/i },
      { key: 'fight', label: 'Fighting major', emoji: '🥊', match: /fighting/i },
      { key: 'puck', label: 'Puck out of play', emoji: '🏟️', match: /puck in|out of play|delay of game/i },
      { key: 'review', label: 'Video review', emoji: '📺', match: /review|challenge/i },
      { key: 'stoppage', label: 'Stoppage', emoji: '✋', match: /stoppage|tv timeout/i },
    ],
    baseball: [
      { key: 'hr', label: 'Home run', emoji: '💣', match: /homer|home run/i },
      { key: 'k', label: 'Strikeout', emoji: '🔥', match: /struck out|strikes out|strikeout/i },
      { key: 'walk', label: 'Walk', emoji: '🚶', match: /walk/i },
      { key: 'single', label: 'Single', emoji: '1️⃣', match: /singled/i },
      { key: 'double', label: 'Double', emoji: '2️⃣', match: /doubled/i },
      { key: 'triple', label: 'Triple', emoji: '3️⃣', match: /tripled/i },
      { key: 'dp', label: 'Double play', emoji: '✌️', match: /double play/i },
      { key: 'steal', label: 'Stolen base', emoji: '🦝', match: /stole/i },
      { key: 'fly', label: 'Fly out', emoji: '🪁', match: /flied out|fly out|popped out|lined out/i },
      { key: 'ground', label: 'Ground out', emoji: '⚾', match: /grounded out|ground out/i },
      { key: 'run', label: 'Run scores', emoji: '🏃', match: /scored|scores/i },
      { key: 'hbp', label: 'Hit by pitch', emoji: '🤕', match: /hit by pitch/i },
      { key: 'error', label: 'Error', emoji: '🙈', match: /error/i },
      { key: 'pitching', label: 'Pitching change', emoji: '🔄', match: /pitching change|relieved|in to pitch|pitches to/i },
      { key: 'sac', label: 'Sacrifice', emoji: '🙇', match: /sacrifice/i },
      { key: 'wild', label: 'Wild pitch', emoji: '🌪️', match: /wild pitch|passed ball/i },
      { key: 'review', label: 'Replay review', emoji: '📺', match: /review|challenge/i },
    ],
    soccer: [
      { key: 'goal', label: 'Goal', emoji: '⚽', match: /^goal!|\bgoal!/i },
      { key: 'yellow', label: 'Yellow card', emoji: '🟨', match: /yellow card/i },
      { key: 'red', label: 'Red card', emoji: '🟥', match: /red card/i },
      { key: 'corner', label: 'Corner kick', emoji: '🚩', match: /corner/i },
      { key: 'save', label: 'Keeper save', emoji: '🧤', match: /saved/i },
      { key: 'offside', label: 'Offside', emoji: '🚫', match: /offside/i },
      { key: 'foul', label: 'Foul', emoji: '🚨', match: /foul/i },
      { key: 'sub', label: 'Substitution', emoji: '🔄', match: /substitution/i },
      { key: 'header', label: 'Header', emoji: '🤕', match: /header/i },
      { key: 'miss', label: 'Shot just wide', emoji: '↗️', match: /attempt missed|misses|wide|too high/i },
      { key: 'blocked', label: 'Blocked shot', emoji: '🧱', match: /attempt blocked|blocked/i },
      { key: 'freekick', label: 'Free kick', emoji: '🦶', match: /free kick/i },
      { key: 'penalty', label: 'Penalty kick', emoji: '🎯', match: /penalty/i },
      { key: 'post', label: 'Hits the post', emoji: '🥅', match: /post|crossbar|bar\b/i },
      { key: 'var', label: 'VAR check', emoji: '📺', match: /\bVAR\b|video assistant/i },
      { key: 'delay', label: 'Injury stoppage', emoji: '🩹', match: /delay|injury/i },
      { key: 'half', label: 'Halftime', emoji: '⏸️', match: /first half ends|half time|halftime/i },
    ],
  };

  const BINGO_SIZE = 4;

  function squareMatches(square, text) {
    const t = String(text || '');
    if (!square.match.test(t)) return false;
    if (square.also && !square.also.test(t)) return false;
    if (square.not && square.not.test(t)) return false;
    return true;
  }

  // A 4x4 card of squares for this sport, the same every time for the same
  // seed (player id + game id).
  function bingoCard(sportKey, seed) {
    const pool = SQUARES[family(sportKey)];
    if (!pool) return null;
    const picked = shuffle(pool, seeded(`${sportKey}|${seed}`)).slice(0, BINGO_SIZE * BINGO_SIZE);
    return picked.map((s) => ({ key: s.key, label: s.label, emoji: s.emoji }));
  }

  // Which squares on a card the plays so far have filled in.
  function markedSquares(card, sportKey, plays) {
    const pool = SQUARES[family(sportKey)] || [];
    const byKey = Object.fromEntries(pool.map((s) => [s.key, s]));
    const marked = new Set();
    (plays || []).forEach((p) => {
      const text = `${p.type || ''} ${p.text || ''}`;
      (card || []).forEach((sq) => {
        const def = byKey[sq.key];
        if (def && !marked.has(sq.key) && squareMatches(def, text)) marked.add(sq.key);
      });
    });
    return marked;
  }

  // Completed rows, columns and the two diagonals.
  function bingoLines(card, marked) {
    const n = BINGO_SIZE;
    const at = (r, c) => card[r * n + c] && marked.has(card[r * n + c].key);
    const lines = [];
    for (let r = 0; r < n; r += 1) if ([...Array(n).keys()].every((c) => at(r, c))) lines.push({ kind: 'row', index: r });
    for (let c = 0; c < n; c += 1) if ([...Array(n).keys()].every((r) => at(r, c))) lines.push({ kind: 'col', index: c });
    if ([...Array(n).keys()].every((i) => at(i, i))) lines.push({ kind: 'diag', index: 0 });
    if ([...Array(n).keys()].every((i) => at(i, n - 1 - i))) lines.push({ kind: 'diag', index: 1 });
    return lines;
  }

  // ---- Call the next play (football) and Who scores next (everyone) -------
  // What kind of football play a line describes, or null for things that
  // aren't a snap (timeouts, end of quarter, penalties before the snap).
  function playKind(text, type) {
    const t = `${type || ''} ${text || ''}`;
    if (/timeout|end of (the )?(quarter|half|game)|end quarter|end half|two-minute|official|injury/i.test(t)) return null;
    if (/punt|field goal|extra point|\bPAT\b|kickoff|kicks off|on-side|onside/i.test(t)) return 'kick';
    if (/pass|sacked|\bsack\b|incomplete|intercept|scramble/i.test(t)) return 'pass';
    if (/rush|run for|left end|right end|up the middle|left tackle|right tackle|left guard|right guard|kneel|for (no gain|\d+ y)/i.test(t)) return 'run';
    if (/penalty|false start|offside|delay of game/i.test(t)) return null;
    return null;
  }

  const CALL_OPTIONS = [
    { key: 'run', label: 'Run', emoji: '🏃' },
    { key: 'pass', label: 'Pass', emoji: '🎯' },
    { key: 'kick', label: 'Kick', emoji: '🦶' },
  ];
  const CALL_POINTS = { play: 10, score: 25 };

  // Plays that happened after `afterId`, oldest first. Plays come newest
  // first, so they're the ones in front of it.
  function playsAfter(plays, afterId) {
    const list = plays || [];
    if (!afterId) return list.slice().reverse();
    const i = list.findIndex((p) => String(p.id) === String(afterId));
    if (i < 0) return [];
    return list.slice(0, i).reverse();
  }

  // A call: { kind: 'play', guess: 'run'|'pass'|'kick', afterId } or
  // { kind: 'score', guess: teamId, afterId, away, home } where away/home
  // are the scores when the call was made. Returns null (still waiting) or
  // { right, actual, points }.
  function resolveCall(call, plays, game) {
    if (!call) return null;
    const after = playsAfter(plays, call.afterId);
    if (call.kind === 'play') {
      for (const p of after) {
        const kind = playKind(p.text, p.type);
        if (!kind) continue;
        const right = kind === call.guess;
        return { right, actual: kind, points: right ? CALL_POINTS.play : 0, playId: p.id || null };
      }
      return null;
    }
    if (call.kind === 'score') {
      for (const p of after) {
        if (p.awayScore === null || p.homeScore === null || p.awayScore === undefined || p.homeScore === undefined) continue;
        const awayUp = p.awayScore > call.away;
        const homeUp = p.homeScore > call.home;
        if (!awayUp && !homeUp) continue;
        const scorer = awayUp ? game && game.away && String(game.away.id) : game && game.home && String(game.home.id);
        const right = String(call.guess) === String(scorer);
        return { right, actual: scorer, points: right ? CALL_POINTS.score : 0, playId: p.id || null };
      }
      // No play-by-play scores (some sports): compare the scoreboard.
      if (game && game.away && game.home && (!after.length || after.every((p) => p.awayScore === null || p.awayScore === undefined))) {
        const a = Number(game.away.score);
        const h = Number(game.home.score);
        if (a > call.away || h > call.home) {
          const scorer = a > call.away ? String(game.away.id) : String(game.home.id);
          const right = String(call.guess) === scorer;
          return { right, actual: scorer, points: right ? CALL_POINTS.score : 0, playId: null };
        }
      }
      return null;
    }
    return null;
  }

  // ---- Score guess ---------------------------------------------------------
  // How far a guess was from the final: total goals/points off on both
  // sides. Null when either is missing.
  function guessError(guess, final) {
    if (!guess || !final) return null;
    const ga = Number(guess.away);
    const gh = Number(guess.home);
    const fa = Number(final.away);
    const fh = Number(final.home);
    if ([ga, gh, fa, fh].some((n) => !Number.isFinite(n))) return null;
    return Math.abs(ga - fa) + Math.abs(gh - fh);
  }

  // XP for a guess: 50 for exact, then less the further off, plus 10 for
  // picking the right winner (or a draw).
  function guessPoints(guess, final) {
    const err = guessError(guess, final);
    if (err === null) return 0;
    const sign = (a, h) => Math.sign(Number(a) - Number(h));
    const winner = sign(guess.away, guess.home) === sign(final.away, final.home) ? 10 : 0;
    const close = err === 0 ? 50 : Math.max(0, 30 - err * 2);
    return close + winner;
  }

  // The closest guesses for one game. entries: [{ id, guess }]. Returns the
  // ids that tied for closest.
  function closestGuesses(entries, final) {
    let best = null;
    let ids = [];
    (entries || []).forEach((e) => {
      const err = guessError(e.guess, final);
      if (err === null) return;
      if (best === null || err < best) { best = err; ids = [e.id]; } else if (err === best) ids.push(e.id);
    });
    return { error: best, ids };
  }

  // ---- XP, levels, streaks and Scrappy's outfits ---------------------------
  // Level n needs 100 * n * (n - 1) / 2 XP in all: 0, 100, 300, 600, 1000...
  function levelFor(xp) {
    const total = Math.max(0, Number(xp) || 0);
    let level = 1;
    while (100 * (level * (level + 1)) / 2 <= total) level += 1;
    const floor = 100 * (level * (level - 1)) / 2;
    const next = 100 * (level * (level + 1)) / 2;
    return { level, xp: total, floor, next, progress: (total - floor) / (next - floor) };
  }

  const OUTFITS = [
    { key: 'cap', level: 1, emoji: '🧢', name: 'Backwards cap', desc: "Scrappy's classic" },
    { key: 'finger', level: 2, emoji: '☝️', name: 'Foam finger', desc: 'We are number one!' },
    { key: 'scarf', level: 3, emoji: '🧣', name: 'Team scarf', desc: 'Cozy for cold night games' },
    { key: 'shades', level: 4, emoji: '🕶️', name: 'Cool shades', desc: 'For sunny day games' },
    { key: 'whistle', level: 5, emoji: '📯', name: 'Ref whistle', desc: 'Scrappy makes the calls' },
    { key: 'headset', level: 6, emoji: '🎧', name: 'Coach headset', desc: 'Calling plays like a pro' },
    { key: 'medal', level: 7, emoji: '🥇', name: 'Gold medal', desc: 'A true champion' },
    { key: 'crown', level: 8, emoji: '👑', name: 'Crown', desc: 'King of the couch' },
    { key: 'trophy', level: 10, emoji: '🏆', name: 'Big trophy', desc: 'Hall of Famer' },
    { key: 'rocket', level: 12, emoji: '🚀', name: 'Rocket pack', desc: 'Out of this world' },
  ];

  function unlockedOutfits(xp) {
    const { level } = levelFor(xp);
    return OUTFITS.filter((o) => o.level <= level);
  }

  // Days in a row with something done, by local date "YYYY-MM-DD".
  function updateStreak(streak, today) {
    const s = streak && streak.last ? streak : { last: null, days: 0, best: 0 };
    if (s.last === today) return s;
    const prev = new Date(`${today}T12:00:00Z`);
    prev.setUTCDate(prev.getUTCDate() - 1);
    const yesterday = prev.toISOString().slice(0, 10);
    const days = s.last === yesterday ? s.days + 1 : 1;
    return { last: today, days, best: Math.max(s.best || 0, days) };
  }

  // XP for keeping a streak: 10 a day, plus a 50 bonus every 7th day.
  function streakBonus(days) {
    return 10 + (days > 0 && days % 7 === 0 ? 50 : 0);
  }

  // Adds an XP award to a player's record. Each award has a unique `key`
  // (like "bingo:cfb:401:row0") so the same thing never pays twice.
  // record: { total, log: [{ key, points, reason, at, game }], streak }
  function addXp(record, award, now) {
    const r = record && typeof record === 'object' ? record : { total: 0, log: [] };
    const log = Array.isArray(r.log) ? r.log : [];
    if (!award || !award.key || !(award.points > 0) || log.some((l) => l.key === award.key)) return { record: r, added: false };
    const entry = { key: String(award.key), points: Math.round(award.points), reason: award.reason || '', at: now || Date.now(), game: award.game || null };
    const nextLog = [...log, entry].slice(-200);
    return { record: { ...r, total: (Number(r.total) || 0) + entry.points, log: nextLog }, added: true, entry };
  }

  // XP earned since a time (this week), and in one game.
  function xpSince(record, since) {
    return ((record && record.log) || []).filter((l) => l.at >= since).reduce((s, l) => s + l.points, 0);
  }
  function xpForGame(record, gameKey) {
    return ((record && record.log) || []).filter((l) => l.game === gameKey).reduce((s, l) => s + l.points, 0);
  }

  // Monday 00:00 local time of the week `now` falls in.
  function weekStart(now) {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return d.getTime();
  }

  // ---- Player trading cards ------------------------------------------------
  // Pulls the numbers out of a stat line ("24/31, 312 YDS, 3 TD, 1 INT").
  function statNumbers(line) {
    const out = {};
    String(line || '').replace(/(-?\d+(?:\.\d+)?)\s*([A-Za-z]+)/g, (m, n, k) => {
      out[k.toUpperCase()] = (out[k.toUpperCase()] || 0) + Number(n);
      return m;
    });
    return out;
  }

  // Common, rare, epic or legendary, from how big the game was.
  function cardRarity(sportKey, line) {
    const n = statNumbers(line);
    const fam = family(sportKey);
    let score = 0;
    if (fam === 'football') {
      score = (n.YDS || 0) / 100 + (n.TD || 0) * 1.2 + (n.SACK || n.SACKS || 0) * 1.5 + (n.INT && !/\d+\/\d+/.test(line) ? n.INT * 2 : 0);
    } else if (fam === 'basketball') {
      score = (n.PTS || 0) / 10 + (n.REB || 0) / 6 + (n.AST || 0) / 5;
    } else if (fam === 'hockey' || fam === 'soccer') {
      score = (n.G || n.GOALS || 0) * 2 + (n.A || n.AST || n.ASSISTS || 0) + (n.SV || n.SAVES || 0) / 15;
    } else if (fam === 'baseball') {
      score = (n.H || 0) * 0.8 + (n.HR || 0) * 2 + (n.RBI || 0) * 0.6 + (n.K || 0) / 3;
    }
    if (score >= 6) return 'legendary';
    if (score >= 4) return 'epic';
    if (score >= 2.5) return 'rare';
    return 'common';
  }

  const RARITY = {
    common: { label: 'Common', xp: 5 },
    rare: { label: 'Rare', xp: 15 },
    epic: { label: 'Epic', xp: 30 },
    legendary: { label: 'Legendary', xp: 60 },
  };

  // Cards from a game's leaders (the top passer, rusher, scorer...). A card
  // is per player per game, so a big game is its own collectible.
  function cardsFromGame(detail, sportKey) {
    const out = [];
    const teams = (detail && detail.teams) || [];
    ((detail && detail.leaders) || []).forEach((group) => {
      const team = teams.find((t) => t.name === group.team) || {};
      (group.categories || []).forEach((cat) => {
        if (!cat.athlete || !cat.value) return;
        const id = cat.athleteId || cat.athlete;
        if (out.some((c) => c.athleteKey === `${id}`)) return;
        out.push({
          athleteKey: String(id),
          id: `${sportKey}:${detail.id}:${id}`,
          sport: sportKey,
          gameId: String(detail.id),
          athleteId: cat.athleteId || null,
          name: cat.athlete,
          headshot: cat.headshot || null,
          position: cat.position || null,
          stat: cat.name || null,
          line: cat.value,
          team: team.name || group.team || null,
          teamId: team.id || null,
          teamLogo: team.logo || null,
          color: team.color || null,
          opponent: (teams.find((t) => t !== team) || {}).name || null,
          date: detail.date || null,
          rarity: cardRarity(sportKey, cat.value),
        });
      });
    });
    return out.map(({ athleteKey, ...card }) => card);
  }

  // ---- Read it out loud ----------------------------------------------------
  // A short sentence for a game, for the browser to say.
  function spokenScore(game) {
    if (!game || !game.home || !game.away) return '';
    const name = (t) => t.nickname || t.shortName || t.name || 'the other team';
    const a = game.away;
    const h = game.home;
    const state = game.status && game.status.state;
    if (state === 'pre') return `${name(a)} play at ${name(h)} later.`;
    const as = Number(a.score);
    const hs = Number(h.score);
    if (state === 'post') {
      if (as === hs) return `${name(a)} and ${name(h)} tied, ${as} to ${hs}.`;
      const [w, l, ws, ls] = as > hs ? [a, h, as, hs] : [h, a, hs, as];
      return `Final: the ${name(w)} beat the ${name(l)}, ${ws} to ${ls}.`;
    }
    if (as === hs) return `${name(a)} and ${name(h)} are tied at ${as}.`;
    const [lead, trail, ls, ts] = as > hs ? [a, h, as, hs] : [h, a, hs, as];
    return `The ${name(lead)} lead the ${name(trail)}, ${ls} to ${ts}.`;
  }

  return {
    family, seeded, SQUARES, BINGO_SIZE, squareMatches, bingoCard, markedSquares, bingoLines,
    playKind, CALL_OPTIONS, CALL_POINTS, playsAfter, resolveCall,
    guessError, guessPoints, closestGuesses,
    levelFor, OUTFITS, unlockedOutfits, updateStreak, streakBonus, addXp, xpSince, xpForGame, weekStart,
    statNumbers, cardRarity, RARITY, cardsFromGame, spokenScore,
  };
});

// Pure logic behind the kids' features (kid mode explanations, score
// celebrations, pick'em, stickers, trivia, countdown). No DOM, no fetch,
// no storage, so it runs the same in the browser (as the global KidsCore)
// and in Node tests (require('../public/js/kids-core.js')).

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.KidsCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  // Which kind of game a sport key is, for words and point values.
  const FAMILY = {
    cfb: 'football', nfl: 'football',
    nba: 'basketball', mcbb: 'basketball',
    mlb: 'baseball',
    nhl: 'hockey',
    ufc: 'fighting', nascar: 'racing',
  };
  function family(sportKey) {
    return FAMILY[sportKey] || 'other';
  }

  // ---- "What just happened?" -------------------------------------------
  // Turns a play-by-play line into one short sentence a kid can follow.
  // Order matters: the first rule that matches wins, so the bigger event
  // (a touchdown) beats the smaller words in the same line (a pass).
  const RULES = {
    football: [
      [/touchdown|\bTD\b/i, "That's a touchdown, worth 6 points! The team carried or caught the ball in the end zone."],
      [/two-point|2-pt|two point/i, "That's a two-point try! After a touchdown, a team can run or pass from close to the end zone for 2 more points."],
      [/extra point|\bPAT\b|kick\)/i, 'That was the extra point kick after a touchdown. If it goes through the posts, it is worth 1 point.'],
      [/field goal/i, /no good|missed|blocked/i, "The kicker tried a field goal but it didn't go in, so no points this time."],
      [/field goal/i, 'Field goal! The kicker booted it through the posts for 3 points.'],
      [/safety/i, 'Safety! The defense tackled the other team in their own end zone. That is worth 2 points for the defense.'],
      [/intercept/i, 'Interception! A defender caught a pass that was meant for the other team, so now their team gets the ball.'],
      [/fumble/i, 'Fumble! Someone dropped the ball while running with it. Whoever grabs it gets to keep it.'],
      [/sacked|\bsack\b/i, 'Sack! The defense tackled the quarterback before he could throw the ball.'],
      [/punt/i, "Punt! The team couldn't get a first down, so they kicked the ball far away to the other team."],
      [/kickoff|kicks off|kicked off/i, 'Kickoff! One team kicks the ball to the other team to start play.'],
      [/penalty|flag/i, 'A referee threw a flag. Someone broke a rule, so their team gets moved back.'],
      [/1ST down|first down/i, 'First down! The team moved the ball 10 yards, so they get 4 new tries to keep going.'],
      [/incomplete/i, 'Incomplete pass. Nobody caught the ball, so the team tries again from the same spot.'],
      [/pass .*complete|pass to|caught/i, 'A pass! The quarterback threw the ball and a teammate caught it.'],
      [/run for|rush|left end|right end|up the middle/i, 'A run! A player carried the ball forward.'],
    ],
    basketball: [
      [/three point|3-pt|three-point/i, /miss/i, 'They tried a long three-point shot but missed.'],
      [/three point|3-pt|three-point/i, 'Swish! A shot from way behind the big arc is worth 3 points.'],
      [/free throw/i, /miss/i, 'They missed a free throw. Those are free shots from the line after a foul.'],
      [/free throw/i, 'Free throw! After a foul, a player gets a free shot from the line. Each one is worth 1 point.'],
      [/dunk/i, 'Slam dunk! The player jumped up and stuffed the ball right through the hoop for 2 points.'],
      [/block/i, 'Blocked! A defender swatted the shot away.'],
      [/steal/i, 'Steal! A defender took the ball away from the other team.'],
      [/rebound/i, 'Rebound! A player grabbed the ball after a missed shot.'],
      [/miss/i, "The shot didn't go in."],
      [/makes|made|layup|jumper|jump shot|hook/i, 'Bucket! A regular shot inside the arc is worth 2 points.'],
      [/foul/i, 'Foul! A player bumped or grabbed someone, which is against the rules.'],
      [/turnover|traveling|out of bounds/i, 'Turnover! The team lost the ball to the other team.'],
      [/timeout/i, 'Timeout! The coach stopped the game to talk to the players.'],
    ],
    hockey: [
      [/goal/i, /on goal|saved by/i, 'A shot on goal, but the goalie stopped it!'],
      [/goal/i, 'GOAL! The puck went into the net. Every goal is worth 1 point.'],
      [/save/i, 'Save! The goalie stopped the puck from going in the net.'],
      [/penalty|minutes for|tripping|hooking|slashing|roughing/i, 'Penalty! A player broke a rule and has to sit in the penalty box, so their team plays with one fewer player for a bit.'],
      [/shot/i, 'A shot! A player fired the puck at the net.'],
      [/faceoff/i, 'Faceoff! The referee drops the puck between two players to start play.'],
      [/hit\b|hits/i, 'A big hit! Bumping into players is allowed in hockey.'],
    ],
    baseball: [
      [/homer|home run/i, "Home run! The batter hit the ball out of the park and gets to run all the way around the bases. Everyone on base scores too!"],
      [/struck out|strikes out|strikeout/i, 'Strikeout! The batter got three strikes, so they are out.'],
      [/walk/i, 'A walk! The pitcher threw four balls, so the batter gets to go to first base for free.'],
      [/tripled/i, 'A triple! The batter hit the ball and ran all the way to third base.'],
      [/doubled/i, 'A double! The batter hit the ball and made it to second base.'],
      [/singled/i, 'A single! The batter hit the ball and made it to first base.'],
      [/scored|scores/i, 'A run scored! A runner made it all the way home, worth 1 point.'],
      [/double play/i, 'Double play! The defense got two outs on one play.'],
      [/flied out|fly out|popped out|lined out/i, 'Caught! A fielder caught the ball in the air, so the batter is out.'],
      [/grounded out|ground out/i, 'The batter hit the ball on the ground and the fielders threw it to first base in time for an out.'],
      [/stole/i, 'Stolen base! A runner sneaked to the next base while the pitcher was pitching.'],
    ],
  };

  function explainPlay(text, sportKey) {
    if (!text) return null;
    const rules = RULES[family(sportKey)];
    if (!rules) return null;
    for (const rule of rules) {
      const [match, second, third] = rule;
      if (!match.test(text)) continue;
      if (third !== undefined) {
        if (second.test(text)) return third;
        continue;
      }
      return second;
    }
    return null;
  }

  // ---- Score celebrations ------------------------------------------------
  // What to shout when a team's score goes up by `points`.
  function celebrationLabel(sportKey, points) {
    const fam = family(sportKey);
    if (fam === 'football') {
      if (points >= 6) return 'TOUCHDOWN!';
      if (points === 3) return 'FIELD GOAL!';
      if (points === 2) return 'TWO POINTS!';
      return 'SCORE!';
    }
    if (fam === 'hockey') return points > 1 ? `${points} GOALS!` : 'GOAL!';
    if (fam === 'baseball') return points > 1 ? `${points} RUNS SCORE!` : 'RUN SCORES!';
    if (fam === 'basketball') return points === 3 ? 'THREE!' : 'BUCKET!';
    return 'SCORE!';
  }

  // Basketball scores every few seconds, so confetti on every bucket would
  // never stop. There we only celebrate a win.
  function celebratesEveryScore(sportKey) {
    return family(sportKey) !== 'basketball';
  }

  // Compares a fresh list of games with the scores seen last time.
  // `prev` maps gameId -> { [teamId]: score, state }. Returns the new map
  // and the events to celebrate for followed teams. A game seen for the
  // first time never celebrates, so loading a page mid-game stays quiet.
  function scoreChanges(prev, games, followedIds, sportKey) {
    const next = {};
    const events = [];
    (games || []).forEach((g) => {
      if (!g || !g.id) return;
      const teams = [g.away, g.home].filter((t) => t && t.id);
      const state = g.status && g.status.state;
      const entry = { state };
      teams.forEach((t) => { entry[String(t.id)] = toNumber(t.score); });
      next[String(g.id)] = entry;
      const before = prev && prev[String(g.id)];
      if (!before) return;
      teams.forEach((t) => {
        const id = String(t.id);
        if (!followedIds.has(id)) return;
        const opponent = teams.find((o) => o !== t) || null;
        const was = before[id];
        const now = entry[id];
        if (celebratesEveryScore(sportKey) && was !== null && was !== undefined && now !== null && now > was) {
          const points = now - was;
          events.push({ kind: 'score', gameId: String(g.id), team: t, opponent, points, label: celebrationLabel(sportKey, points) });
        }
        if (before.state !== 'post' && state === 'post' && t.winner) {
          events.push({ kind: 'win', gameId: String(g.id), team: t, opponent, points: 0, label: 'THEY WON!' });
        }
      });
    });
    return { next, events };
  }

  function toNumber(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  // ---- Countdown -----------------------------------------------------------
  function countdownParts(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    return {
      days: Math.floor(total / 86400),
      hours: Math.floor((total % 86400) / 3600),
      minutes: Math.floor((total % 3600) / 60),
      seconds: total % 60,
      done: total === 0,
    };
  }

  // The live game, else the soonest game that hasn't started.
  function nextGame(schedule, now) {
    const games = (schedule || []).filter((g) => g && g.status);
    const live = games.find((g) => g.status.state === 'in');
    if (live) return live;
    const t = now || Date.now();
    return games
      .filter((g) => g.status.state === 'pre' && g.date && new Date(g.date).getTime() > t - 6 * 3600 * 1000)
      .sort((a, b) => new Date(a.date) - new Date(b.date))[0] || null;
  }

  // ---- Pick'em -------------------------------------------------------------
  // A pick: { sport, gameId, teamId, week, date, away, home, ranks, result }
  // where result is null until the game ends, then { winnerId } (null
  // winnerId for a tie). Week is a label like "cfb-2026-2-10" that groups
  // picks for the "perfect week" badge.
  function pickOutcome(pick) {
    if (!pick || !pick.result) return 'pending';
    if (!pick.result.winnerId) return 'tie';
    return String(pick.result.winnerId) === String(pick.teamId) ? 'right' : 'wrong';
  }

  function playerStats(picks) {
    const list = Object.values(picks || {});
    const stats = { right: 0, wrong: 0, pending: 0, total: list.length };
    list.forEach((p) => {
      const o = pickOutcome(p);
      if (o === 'right') stats.right += 1;
      else if (o === 'wrong') stats.wrong += 1;
      else if (o === 'pending') stats.pending += 1;
    });
    return stats;
  }

  const BADGES = [
    { key: 'first', emoji: '🌟', name: 'First Win', desc: 'Got your first pick right' },
    { key: 'streak3', emoji: '🔥', name: 'On Fire', desc: '3 right picks in a row' },
    { key: 'ten', emoji: '🏅', name: 'Ten Right', desc: '10 right picks' },
    { key: 'twentyfive', emoji: '🏆', name: 'Pick Master', desc: '25 right picks' },
    { key: 'perfect', emoji: '💯', name: 'Perfect Week', desc: 'Every pick right in a week (at least 3 picks)' },
    { key: 'upset', emoji: '😲', name: 'Upset Spotter', desc: 'Picked a lower-ranked team to beat a ranked team, and they did' },
  ];

  function badgesFor(picks) {
    const resolved = Object.values(picks || {})
      .filter((p) => pickOutcome(p) === 'right' || pickOutcome(p) === 'wrong')
      .sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0));
    const earned = new Set();
    const rightCount = resolved.filter((p) => pickOutcome(p) === 'right').length;
    if (rightCount >= 1) earned.add('first');
    if (rightCount >= 10) earned.add('ten');
    if (rightCount >= 25) earned.add('twentyfive');

    let streak = 0;
    resolved.forEach((p) => {
      streak = pickOutcome(p) === 'right' ? streak + 1 : 0;
      if (streak >= 3) earned.add('streak3');
    });

    const weeks = {};
    Object.values(picks || {}).forEach((p) => {
      if (!p.week) return;
      (weeks[p.week] = weeks[p.week] || []).push(pickOutcome(p));
    });
    Object.values(weeks).forEach((outcomes) => {
      if (outcomes.length >= 3 && outcomes.every((o) => o === 'right')) earned.add('perfect');
    });

    resolved.forEach((p) => {
      if (pickOutcome(p) !== 'right' || !p.ranks) return;
      const mine = p.ranks[String(p.teamId)] || null;
      const otherId = [p.away && p.away.id, p.home && p.home.id].map(String).find((id) => id !== String(p.teamId));
      const theirs = otherId ? p.ranks[otherId] || null : null;
      // Unranked beats ranked, or a worse rank (bigger number) beats a better one.
      if (theirs && (!mine || mine > theirs)) earned.add('upset');
    });

    return BADGES.filter((b) => earned.has(b.key));
  }

  // Players sorted for the family leaderboard: most right picks, then
  // fewest wrong, then name.
  function leaderboard(players, picksByPlayer) {
    return (players || [])
      .map((p) => ({ player: p, stats: playerStats(picksByPlayer && picksByPlayer[p.id]), badges: badgesFor(picksByPlayer && picksByPlayer[p.id]) }))
      .sort((a, b) => b.stats.right - a.stats.right || a.stats.wrong - b.stats.wrong || String(a.player.name).localeCompare(String(b.player.name)));
  }

  // The result of a finished game as stored on a pick, or null if it
  // isn't over yet. Works with scoreboard games (away/home) and game
  // summaries (teams[]).
  function gameResult(game) {
    if (!game || !game.status || !(game.status.completed || game.status.state === 'post')) return null;
    const teams = game.teams || [game.away, game.home].filter(Boolean);
    const winner = teams.find((t) => t && t.winner);
    if (winner) return { winnerId: String(winner.id) };
    const scored = teams.filter((t) => t && t.score !== null && t.score !== undefined);
    if (scored.length === 2) {
      const [a, b] = scored.map((t) => Number(t.score));
      if (a === b) return { winnerId: null };
      return { winnerId: String(a > b ? scored[0].id : scored[1].id) };
    }
    return null;
  }

  // ---- Trivia --------------------------------------------------------------
  // Rules questions anyone can answer by watching. { q, answer, wrong[] }
  const FACTS = {
    football: [
      { q: 'How many points is a touchdown worth?', answer: '6', wrong: ['3', '1', '10'] },
      { q: 'How many points is a field goal worth?', answer: '3', wrong: ['6', '1', '2'] },
      { q: 'How many tries (downs) does a team get to go 10 yards?', answer: '4', wrong: ['2', '3', '6'] },
      { q: 'How many players does each team have on the field?', answer: '11', wrong: ['9', '5', '15'] },
      { q: 'What is a safety worth?', answer: '2 points', wrong: ['1 point', '6 points', '3 points'] },
      { q: 'What is the area at each end of the field called?', answer: 'End zone', wrong: ['Goal box', 'Home plate', 'Paint'] },
      { q: 'How long is a football field between the goal lines?', answer: '100 yards', wrong: ['50 yards', '200 yards', '75 yards'] },
      { q: 'Who usually throws the ball?', answer: 'Quarterback', wrong: ['Kicker', 'Goalie', 'Pitcher'] },
      { q: 'What do you call it when a defender catches the other team\'s pass?', answer: 'Interception', wrong: ['Touchback', 'Punt', 'Rebound'] },
      { q: 'How many quarters are in a football game?', answer: '4', wrong: ['2', '3', '9'] },
    ],
    basketball: [
      { q: 'How many points is a shot from behind the arc?', answer: '3', wrong: ['2', '1', '4'] },
      { q: 'How many points is a free throw?', answer: '1', wrong: ['2', '3', '0'] },
      { q: 'How many players does each team have on the court?', answer: '5', wrong: ['6', '11', '9'] },
      { q: 'How tall is the hoop?', answer: '10 feet', wrong: ['8 feet', '12 feet', '6 feet'] },
      { q: 'What is it called when a player jumps and slams the ball through the hoop?', answer: 'Dunk', wrong: ['Layup', 'Punt', 'Bunt'] },
      { q: 'What do you call grabbing the ball after a missed shot?', answer: 'Rebound', wrong: ['Steal', 'Assist', 'Save'] },
    ],
    hockey: [
      { q: 'What do hockey players hit instead of a ball?', answer: 'A puck', wrong: ['A birdie', 'A disc', 'A rock'] },
      { q: 'How many periods are in a hockey game?', answer: '3', wrong: ['2', '4', '9'] },
      { q: 'Where does a player go after a penalty?', answer: 'Penalty box', wrong: ['Dugout', 'End zone', 'Locker room'] },
      { q: 'How many points is a goal?', answer: '1', wrong: ['2', '3', '6'] },
      { q: 'What do you call three goals by one player in a game?', answer: 'Hat trick', wrong: ['Triple play', 'Grand slam', 'Three-peat'] },
    ],
    baseball: [
      { q: 'How many strikes make an out?', answer: '3', wrong: ['2', '4', '5'] },
      { q: 'How many balls make a walk?', answer: '4', wrong: ['3', '2', '5'] },
      { q: 'How many innings are in a regular game?', answer: '9', wrong: ['7', '4', '12'] },
      { q: 'How many bases are there, counting home plate?', answer: '4', wrong: ['3', '5', '6'] },
      { q: 'What is a home run with the bases loaded called?', answer: 'Grand slam', wrong: ['Hat trick', 'Touchdown', 'Slam dunk'] },
      { q: 'Who throws the ball to the batter?', answer: 'Pitcher', wrong: ['Catcher', 'Quarterback', 'Umpire'] },
    ],
  };

  function shuffle(list, rng) {
    const r = rng || Math.random;
    const a = list.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // Up to `count` distinct values from `pool` that differ from `answer`.
  function pickWrong(pool, answer, count, rng) {
    const seen = new Set([String(answer).toLowerCase()]);
    const out = [];
    shuffle(pool, rng).forEach((v) => {
      if (!v || out.length >= count) return;
      const k = String(v).toLowerCase();
      if (seen.has(k)) return;
      seen.add(k);
      out.push(v);
    });
    return out;
  }

  function makeQuestion(q, answer, wrong, extra, rng) {
    if (!answer || wrong.length < 2) return null;
    const choices = shuffle([answer, ...wrong.slice(0, 3)], rng);
    return Object.assign({ q, answer, choices }, extra || {});
  }

  // Builds a quiz. `teams` are followed teams with info from
  // /api/team/:id (name, nickname, location, logo, color, venue, sport).
  // `pool` is other teams to borrow wrong answers from (same fields).
  // Questions: { q, answer, choices[], kind?, image?, swatches? }.
  function buildQuiz({ teams, pool, sports, count, rng }) {
    const r = rng || Math.random;
    const all = [...(teams || []), ...(pool || [])];
    const questions = [];
    (teams || []).forEach((t) => {
      const others = all.filter((o) => String(o.id) !== String(t.id) || o.sport !== t.sport);
      const sameSport = others.filter((o) => o.sport === t.sport);
      const otherPool = sameSport.length >= 3 ? sameSport : others;
      if (t.nickname && t.location) {
        const q = makeQuestion(`What is ${t.location}'s team called?`, t.nickname,
          pickWrong(otherPool.map((o) => o.nickname), t.nickname, 3, r), { kind: 'nickname', teamId: t.id }, r);
        if (q) questions.push(q);
      }
      if (t.logo) {
        const q = makeQuestion('Which team has this logo?', t.name,
          pickWrong(otherPool.map((o) => o.name), t.name, 3, r), { kind: 'logo', image: t.logo, teamId: t.id }, r);
        if (q) questions.push(q);
      }
      if (t.venue) {
        const q = makeQuestion(`Where does ${t.name} play home games?`, t.venue,
          pickWrong(otherPool.map((o) => o.venue), t.venue, 3, r), { kind: 'venue', teamId: t.id }, r);
        if (q) questions.push(q);
      }
      if (t.color && /^#[0-9a-f]{6}$/i.test(t.color)) {
        const wrong = pickWrong(otherPool.map((o) => o.color).filter((c) => c && /^#[0-9a-f]{6}$/i.test(c) && colorDistance(c, t.color) > 80), t.color, 3, r);
        const q = makeQuestion(`Which color is ${t.name}'s main color?`, t.color, wrong, { kind: 'color', swatches: true, teamId: t.id }, r);
        if (q) questions.push(q);
      }
    });
    const families = [...new Set((sports || []).map(family))].filter((f) => FACTS[f]);
    if (!families.length) families.push('football');
    families.forEach((f) => {
      FACTS[f].forEach((fact) => {
        const q = makeQuestion(fact.q, fact.answer, fact.wrong, { kind: 'fact' }, r);
        if (q) questions.push(q);
      });
    });
    // Team questions are the fun ones, so they get a head start.
    const teamQs = shuffle(questions.filter((q) => q.kind !== 'fact'), r);
    const factQs = shuffle(questions.filter((q) => q.kind === 'fact'), r);
    const n = count || 10;
    const takeTeam = Math.min(teamQs.length, Math.ceil(n * 0.6));
    return shuffle([...teamQs.slice(0, takeTeam), ...factQs.slice(0, n - takeTeam)], r).slice(0, n);
  }

  function colorDistance(a, b) {
    const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    const [x, y] = [rgb(a), rgb(b)];
    return Math.sqrt(x.reduce((s, v, i) => s + (v - y[i]) ** 2, 0));
  }

  // ---- Stickers ------------------------------------------------------------
  // One sticker per player, team and game; reason is 'watched' or 'picked'.
  function stickerKey(s) {
    return `${s.sport}:${s.gameId}:${s.teamId}:${s.reason}`;
  }

  // Groups stickers into one album slot per team, newest team first.
  function albumByTeam(stickers) {
    const byTeam = new Map();
    (stickers || []).forEach((s) => {
      const k = `${s.sport}:${s.teamId}`;
      if (!byTeam.has(k)) byTeam.set(k, { sport: s.sport, teamId: s.teamId, name: s.name, logo: s.logo, color: s.color, stickers: [], latest: 0 });
      const slot = byTeam.get(k);
      slot.stickers.push(s);
      slot.latest = Math.max(slot.latest, s.at || 0);
      if (s.logo) slot.logo = s.logo;
      if (s.color) slot.color = s.color;
    });
    return [...byTeam.values()].sort((a, b) => b.latest - a.latest);
  }

  return {
    family, explainPlay, celebrationLabel, celebratesEveryScore, scoreChanges,
    countdownParts, nextGame,
    pickOutcome, playerStats, badgesFor, leaderboard, gameResult, BADGES,
    buildQuiz, shuffle, FACTS,
    stickerKey, albumByTeam,
  };
});

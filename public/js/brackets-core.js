// Pure logic behind the playoff hub and the family bracket challenge: which
// round a postseason game belongs to, laying games out as a bracket, the
// projected College Football Playoff field, and challenge scoring. No DOM,
// no fetch, so it runs in the browser (as the global BracketsCore) and on
// the server (require('../public/js/brackets-core.js')), which scores
// league standings with the same rules the page shows.

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BracketsCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  // Later rounds are worth more, so a family member who calls the title
  // game can still catch up. Every bowl game is worth 1.
  const ROUNDS = {
    cfb: [
      { key: 'first', label: 'First Round', points: 1, slots: 4 },
      { key: 'qf', label: 'Quarterfinals', points: 2, slots: 4 },
      { key: 'sf', label: 'Semifinals', points: 4, slots: 2 },
      { key: 'final', label: 'National Championship', points: 8, slots: 1 },
    ],
    mcbb: [
      { key: 'first4', label: 'First Four', points: 1, slots: 4 },
      { key: 'r64', label: 'Round of 64', points: 1, slots: 8 },
      { key: 'r32', label: 'Round of 32', points: 2, slots: 4 },
      { key: 's16', label: 'Sweet 16', points: 4, slots: 2 },
      { key: 'e8', label: 'Elite Eight', points: 8, slots: 1 },
      { key: 'f4', label: 'Final Four', points: 16, slots: 2 },
      { key: 'final', label: 'National Championship', points: 32, slots: 1 },
    ],
  };
  const BOWL_POINTS = 1;
  const CFP_SIZE = 12;

  function roundInfo(sportKey, key) {
    return (ROUNDS[sportKey] || []).find((r) => r.key === key) || null;
  }

  // ---- Which game is which -------------------------------------------------
  // ESPN names postseason games in the competition note ("headline"):
  //   "CFP Quarterfinal at the Rose Bowl Presented by Prudential"
  //   "Allstate Sugar Bowl - CFP Semifinal"
  //   "Men's Basketball Championship - South Region - 1st Round"
  // Returns { kind: 'cfp' | 'bowl' | 'mm', round, region, name } or null
  // for a game that isn't part of the postseason (an NIT game, say).
  function classify(game, sportKey) {
    const h = String((game && game.headline) || '');
    if (sportKey === 'cfb') {
      const cfp = /\bCFP\b|College Football Playoff|National Championship/i.test(h);
      let round = null;
      if (cfp) {
        if (/national championship|championship game/i.test(h)) round = 'final';
        else if (/semi/i.test(h)) round = 'sf';
        else if (/quarter/i.test(h)) round = 'qf';
        else if (/first round|1st round|opening round/i.test(h)) round = 'first';
      }
      if (round) return { kind: 'cfp', round, region: null, name: bowlName(h) };
      // Anything else needs "Bowl" in its name, so a stray regular-season
      // game never shows up as a bowl.
      if (!/bowl/i.test(h)) return null;
      return { kind: 'bowl', round: null, region: null, name: bowlName(h) };
    }
    if (sportKey === 'mcbb') {
      if (!/Men's Basketball Championship|NCAA (Men's )?Tournament|March Madness/i.test(h)) return null;
      let round = null;
      if (/first four/i.test(h)) round = 'first4';
      else if (/1st round|first round|round of 64/i.test(h)) round = 'r64';
      else if (/2nd round|second round|round of 32/i.test(h)) round = 'r32';
      else if (/sweet 16|sweet sixteen|regional semifinal/i.test(h)) round = 's16';
      else if (/elite 8|elite eight|regional final/i.test(h)) round = 'e8';
      else if (/final four|national semifinal/i.test(h)) round = 'f4';
      else if (/national championship|championship game/i.test(h)) round = 'final';
      if (!round) return null;
      const m = h.match(/-\s*([A-Za-z .']+?)\s+Region/i);
      return { kind: 'mm', round, region: m ? m[1].trim() : null, name: null };
    }
    return null;
  }

  // "Allstate Sugar Bowl - CFP Semifinal" -> "Allstate Sugar Bowl";
  // "CFP Quarterfinal at the Rose Bowl Presented by Prudential" -> "Rose Bowl".
  function bowlName(headline) {
    const h = String(headline || '').trim();
    if (!h) return null;
    const at = h.match(/\bat the (.+?)(?:\s+presented by.*)?$/i);
    if (at) return at[1].trim();
    // A bare playoff label ("College Football Playoff First Round Game")
    // names no bowl.
    const parts = h.split(/\s+-\s+/).filter((p) => !/\bCFP\b|College Football Playoff/i.test(p));
    if (!parts.length) return null;
    const name = parts[0].replace(/\s+presented by.*$/i, '').trim();
    return name || null;
  }

  // ---- Laying out a bracket ------------------------------------------------
  function teamIds(game) {
    return [game && game.away, game && game.home].filter((t) => t && t.id).map((t) => String(t.id));
  }

  // Orders each round so a game sits next to the game it feeds into. The
  // anchor round keeps its own order (seed order, else dates); rounds
  // before it follow the round after them, rounds after it follow the
  // round before. Games with no shared team yet keep their order at the end.
  function followRound(target, ref) {
    const position = (g) => {
      const ids = teamIds(g);
      const idx = ref.games.findIndex((x) => teamIds(x).some((id) => ids.includes(id)));
      return idx === -1 ? Infinity : idx;
    };
    target.games = target.games
      .map((g, n) => ({ g, n, p: position(g) }))
      .sort((a, b) => a.p - b.p || a.n - b.n)
      .map((x) => x.g);
  }

  function alignRounds(rounds, anchor) {
    const a = anchor === undefined ? rounds.length - 1 : anchor;
    for (let i = a - 1; i >= 0; i--) followRound(rounds[i], rounds[i + 1]);
    for (let i = a + 1; i < rounds.length; i++) followRound(rounds[i], rounds[i - 1]);
    return rounds;
  }

  // Sorts games by their best seed in a fixed bracket order, so the
  // bracket reads top to bottom the way it's printed.
  function seedSort(games, order, seedOf) {
    const rank = (g) => {
      const seeds = [g.away, g.home].map((t) => (t ? seedOf(t) : null)).filter((n) => n > 0);
      const idx = seeds.length ? order.indexOf(Math.min(...seeds)) : -1;
      return idx === -1 ? Infinity : idx;
    };
    return games.map((g, n) => ({ g, n, r: rank(g) })).sort((x, y) => x.r - y.r || x.n - y.n).map((x) => x.g);
  }

  function byDate(a, b) {
    return new Date(a.date || 0) - new Date(b.date || 0);
  }

  // Pads a round with empty "TBD" slots until ESPN lists the game.
  function withSlots(games, slots) {
    const out = games.slice();
    while (out.length < slots) out.push({ id: null, placeholder: true, away: null, home: null });
    return out;
  }

  // CFP: quarterfinals hosted by seeds 1 and 4 (top half), then 2 and 3.
  // March Madness regions: first-round games in printed order (1 v 16,
  // 8 v 9, 5 v 12, ...).
  const SEED_ORDER = { qf: [1, 4, 2, 3], r64: [1, 8, 5, 4, 6, 3, 7, 2] };

  function makeRounds(sportKey, keys, games) {
    const rounds = keys.map((key) => {
      const info = roundInfo(sportKey, key);
      return { key, label: info.label, points: info.points, slots: info.slots, games: games.filter((g) => g.round === key).sort(byDate) };
    });
    const anchor = rounds.findIndex((r) => SEED_ORDER[r.key]);
    if (anchor !== -1) {
      const seedOf = (t) => Number(t.seed) || (sportKey === 'mcbb' ? Number(t.curatedRank) : 0);
      rounds[anchor].games = seedSort(rounds[anchor].games, SEED_ORDER[rounds[anchor].key], seedOf);
    }
    alignRounds(rounds, anchor === -1 ? undefined : anchor);
    rounds.forEach((r) => { r.games = withSlots(r.games, r.slots); });
    return rounds;
  }

  const REGION_ORDER = ['east', 'west', 'south', 'midwest'];

  // Turns a postseason scoreboard into the hub's layout.
  //   cfb:  { cfp: { rounds } | null, bowls: [game] }
  //   mcbb: { regions: [{ name, rounds }], firstFour: [game], finals: rounds }
  // Every game gets .round, .region and .bowl added.
  function buildBracket(games, sportKey) {
    const tagged = [];
    (games || []).forEach((g) => {
      const c = classify(g, sportKey);
      if (!c) return;
      tagged.push(Object.assign({}, g, { kind: c.kind, round: c.round, region: c.region, bowl: c.name }));
    });
    if (sportKey === 'cfb') {
      const cfpGames = tagged.filter((g) => g.kind === 'cfp');
      return {
        cfp: cfpGames.length ? { rounds: makeRounds('cfb', ['first', 'qf', 'sf', 'final'], cfpGames) } : null,
        bowls: tagged.filter((g) => g.kind === 'bowl').sort(byDate),
      };
    }
    if (sportKey === 'mcbb') {
      const names = [...new Set(tagged.filter((g) => g.region && g.round !== 'first4').map((g) => g.region))];
      names.sort((a, b) => {
        const ia = REGION_ORDER.indexOf(a.toLowerCase());
        const ib = REGION_ORDER.indexOf(b.toLowerCase());
        return (ia === -1 ? 9 : ia) - (ib === -1 ? 9 : ib) || a.localeCompare(b);
      });
      return {
        regions: names.map((name) => ({ name, rounds: makeRounds('mcbb', ['r64', 'r32', 's16', 'e8'], tagged.filter((g) => g.region === name)) })),
        firstFour: tagged.filter((g) => g.round === 'first4').sort(byDate),
        finals: tagged.some((g) => g.round === 'f4' || g.round === 'final') || names.length ? makeRounds('mcbb', ['f4', 'final'], tagged) : [],
      };
    }
    return {};
  }

  // Every real game in a bracket layout, with its point value:
  // Map `${sport}:${gameId}` -> { game, points, round }.
  function gameIndex(bracket, sportKey) {
    const index = new Map();
    const add = (g, points) => {
      if (!g || !g.id || g.placeholder || g.projected) return;
      index.set(`${sportKey}:${g.id}`, { game: g, points, round: g.round || null });
    };
    const addRounds = (rounds) => (rounds || []).forEach((r) => r.games.forEach((g) => add(g, r.points)));
    if (bracket.cfp) addRounds(bracket.cfp.rounds);
    (bracket.bowls || []).forEach((g) => add(g, BOWL_POINTS));
    (bracket.regions || []).forEach((reg) => addRounds(reg.rounds));
    (bracket.firstFour || []).forEach((g) => add(g, roundInfo('mcbb', 'first4').points));
    addRounds(bracket.finals);
    return index;
  }

  // ---- Projected playoff field ----------------------------------------------
  // Before the real games exist: the top 12 of the CFP rankings (or the AP
  // poll until those come out), seeded straight down. The real field also
  // saves spots for the top conference champions, which a poll can't know,
  // so the page labels this "if the season ended today".
  function projectCfp(polls) {
    const list = polls || [];
    const poll = list.find((p) => /playoff/i.test(`${p.name} ${p.shortName} ${p.type}`))
      || list.find((p) => /\bAP\b/.test(`${p.name} ${p.shortName}`) || p.type === 'ap')
      || list[0];
    if (!poll) return null;
    const seeds = (poll.ranks || [])
      .filter((r) => r.team && r.rank)
      .sort((a, b) => a.rank - b.rank)
      .slice(0, CFP_SIZE)
      .map((r, i) => Object.assign({}, r.team, { seed: i + 1, record: r.recordSummary || null }));
    if (seeds.length < CFP_SIZE) return null;
    const s = (n) => seeds[n - 1];
    const winner = (a, b) => ({ id: null, name: `Winner ${a}/${b}`, placeholder: true });
    const game = (away, home, round) => ({ id: null, projected: true, round, away, home, status: { state: 'pre' } });
    // Top half: 1 vs the 8/9 winner, 4 vs the 5/12 winner. Bottom half:
    // 2 vs 7/10, 3 vs 6/11. Seeds 1-4 skip the first round.
    const rounds = [
      { key: 'first', games: [game(s(9), s(8), 'first'), game(s(12), s(5), 'first'), game(s(10), s(7), 'first'), game(s(11), s(6), 'first')] },
      { key: 'qf', games: [game(winner(8, 9), s(1), 'qf'), game(winner(5, 12), s(4), 'qf'), game(winner(7, 10), s(2), 'qf'), game(winner(6, 11), s(3), 'qf')] },
      { key: 'sf', games: [game(null, null, 'sf'), game(null, null, 'sf')].map((g) => Object.assign(g, { placeholder: true })) },
      { key: 'final', games: [Object.assign(game(null, null, 'final'), { placeholder: true })] },
    ].map((r) => Object.assign(r, { label: roundInfo('cfb', r.key).label, points: roundInfo('cfb', r.key).points }));
    return { poll: poll.name || poll.shortName || 'Rankings', seeds, rounds };
  }

  // ---- What if ----------------------------------------------------------------
  // Plays out the projected field from the visitor's picks: picks is
  // { 'first-0': teamId, 'qf-2': teamId, ... }. Each pick moves that team
  // into its next game; a pick whose team is no longer in that game (an
  // earlier pick changed) is ignored. Returns { rounds, champion }, with
  // every game carrying its `slot` key.
  function whatIfCfp(projected, picks) {
    if (!projected || !projected.rounds || projected.rounds.length < 4) return null;
    picks = picks || {};
    const copyTeam = (t) => (t ? Object.assign({}, t) : null);
    const rounds = projected.rounds.map((r) => Object.assign({}, r, {
      games: r.games.map((g, i) => Object.assign({}, g, { slot: `${r.key}-${i}`, away: copyTeam(g.away), home: copyTeam(g.home), placeholder: false })),
    }));
    const isTeam = (t) => !!(t && t.id && !t.placeholder);
    const picked = (g) => {
      const id = picks[g.slot];
      if (id === undefined || id === null) return null;
      return [g.away, g.home].find((t) => isTeam(t) && String(t.id) === String(id)) || null;
    };
    const tbd = (label) => ({ id: null, name: label, placeholder: true });
    const [first, qf, sf, final] = rounds;
    // First round winner i meets the bye seed in quarterfinal i (away side).
    first.games.forEach((g, i) => {
      const w = picked(g);
      qf.games[i].away = w ? copyTeam(w) : qf.games[i].away;
    });
    qf.games.forEach((g, i) => {
      const w = picked(g);
      const side = i % 2 === 0 ? 'away' : 'home';
      sf.games[Math.floor(i / 2)][side] = w ? copyTeam(w) : tbd('Quarterfinal winner');
    });
    sf.games.forEach((g, i) => {
      const w = picked(g);
      final.games[0][i === 0 ? 'away' : 'home'] = w ? copyTeam(w) : tbd('Semifinal winner');
    });
    rounds.forEach((r) => r.games.forEach((g) => {
      g.placeholder = !(isTeam(g.away) && isTeam(g.home));
      const w = g.placeholder ? null : picked(g);
      g.pickedId = w ? String(w.id) : null;
    }));
    const champ = picked(final.games[0]);
    return { rounds, champion: champ && !final.games[0].placeholder ? champ : null };
  }

  // ---- Challenge scoring ---------------------------------------------------
  // A bracket pick: { sport, gameId, teamId, pickedAt? }. pickedAt is set by
  // the server when the pick is saved to an account; with `strict`, a pick
  // only counts when it was saved before the game started.
  function winnerOf(game) {
    if (!game || !game.status || !(game.status.completed || game.status.state === 'post')) return undefined;
    const teams = [game.away, game.home].filter(Boolean);
    const w = teams.find((t) => t.winner);
    if (w) return String(w.id);
    if (teams.length === 2 && teams.every((t) => t.score !== null && t.score !== undefined)) {
      const [a, b] = teams.map((t) => Number(t.score));
      if (a !== b) return String(a > b ? teams[0].id : teams[1].id);
    }
    return null;
  }

  function countsInTime(pick, game) {
    const start = Date.parse(game && game.date);
    return !!pick.pickedAt && Number.isFinite(start) && Number(pick.pickedAt) < start;
  }

  function scorePicks(picks, index, { strict } = {}) {
    const out = { points: 0, right: 0, wrong: 0, pending: 0, possible: 0 };
    Object.entries(picks || {}).forEach(([key, pick]) => {
      const entry = index.get(key);
      if (!entry || !pick) return;
      if (strict && !countsInTime(pick, entry.game)) return;
      const w = winnerOf(entry.game);
      if (w === undefined) { out.pending += 1; out.possible += entry.points; return; }
      if (w && w === String(pick.teamId)) { out.right += 1; out.points += entry.points; out.possible += entry.points; } else out.wrong += 1;
    });
    return out;
  }

  // players: [{ id, name, emoji, ... }]; picksByPlayer: { [playerId]: picks }.
  function standings(players, picksByPlayer, index, opts) {
    return (players || [])
      .map((p) => ({ player: p, score: scorePicks(picksByPlayer && picksByPlayer[p.id], index, opts) }))
      .sort((a, b) => b.score.points - a.score.points || b.score.right - a.score.right
        || b.score.possible - a.score.possible || String(a.player.name).localeCompare(String(b.player.name)));
  }

  // The season a postseason belongs to by default: CFB bowls run Dec-Jan
  // and belong to the season that started in the fall; March Madness is
  // named by the spring it's played in, so after April it looks ahead.
  function defaultSeason(sportKey, now) {
    const d = now ? new Date(now) : new Date();
    const y = d.getFullYear();
    const m = d.getMonth(); // 0 = January
    if (sportKey === 'mcbb') return m >= 4 ? y + 1 : y;
    return m < 7 ? y - 1 : y;
  }

  return {
    ROUNDS, BOWL_POINTS, CFP_SIZE,
    classify, bowlName, roundInfo, alignRounds, buildBracket, gameIndex,
    projectCfp, whatIfCfp, winnerOf, scorePicks, standings, defaultSeason,
  };
});

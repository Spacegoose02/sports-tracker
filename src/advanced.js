// Advanced college football stats from CollegeFootballData.com (needs the
// same free CFBD_API_KEY as the recruiting tabs):
//   - team pages: SP+ rating and rank (overall, offense, defense), and
//     offense/defense EPA per play, success rate and explosiveness, with
//     each number's national rank;
//   - game pages: each team's EPA per play, success rate, explosiveness and
//     havoc for that game.
// CFBD uses ESPN's game ids, and team names that match ESPN's `location`
// ("Virginia Tech", "Ole Miss").

const cache = require('./cache');
const recruiting = require('./recruiting');

const num = (v) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

// The season a date falls in: CFB seasons are named for the fall they
// start in, and bowls in January still count for the year before.
function seasonFor(now = new Date()) {
  return now.getMonth() < 2 ? now.getFullYear() - 1 : now.getFullYear();
}

// Ranks a value among every team (1 = best). `higherIsBetter` false for
// defense, where allowing less is good.
function rankAmong(values, value, higherIsBetter = true) {
  if (value === null) return null;
  const list = values.filter((v) => v !== null);
  return 1 + list.filter((v) => (higherIsBetter ? v > value : v < value)).length;
}

const pickSide = (s) => ({
  epa: num(s && s.ppa),
  successRate: num(s && s.successRate),
  explosiveness: num(s && s.explosiveness),
  rushEpa: num(s && s.rushingPlays && s.rushingPlays.ppa),
  passEpa: num(s && s.passingPlays && s.passingPlays.ppa),
  havoc: num(s && s.havoc && s.havoc.total),
});

// All teams' season advanced stats and SP+ ratings, cached for 6 hours
// (CFBD updates them once a week or so, and the free tier has a limit).
async function seasonTables(year, deps) {
  return cache.getOrFetch(`cfbd:advanced:${year}`, async () => {
    const [adv, sp] = await Promise.all([
      deps.cfbd(`/stats/season/advanced?year=${year}&excludeGarbageTime=true`).catch(() => []),
      deps.cfbd(`/ratings/sp?year=${year}`).catch(() => []),
    ]);
    return { adv: Array.isArray(adv) ? adv : [], sp: Array.isArray(sp) ? sp : [] };
  }, 6 * 60 * 60 * 1000);
}

const sameTeam = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();

async function teamAdvanced({ teamName, year }, deps = { cfbd: recruiting.cfbd, hasCfbd: recruiting.hasCfbd }) {
  if (!deps.hasCfbd()) return { available: false, reason: 'no-key' };
  const season = year || seasonFor();
  const { adv, sp } = await seasonTables(season, deps);
  const row = adv.find((r) => sameTeam(r.team, teamName));
  const rating = sp.find((r) => sameTeam(r.team, teamName));
  if (!row && !rating) return { available: false, reason: 'not-found', season };

  const sides = adv.map((r) => ({ off: pickSide(r.offense), def: pickSide(r.defense) }));
  const stat = (side, key, higherIsBetter) => {
    const value = row ? pickSide(row[side === 'off' ? 'offense' : 'defense'])[key] : null;
    return { value, rank: rankAmong(sides.map((s) => s[side][key]), value, higherIsBetter), of: sides.length };
  };
  return {
    available: true,
    season,
    team: (row && row.team) || (rating && rating.team),
    sp: rating ? {
      rating: num(rating.rating),
      rank: num(rating.ranking),
      offense: num(rating.offense && rating.offense.rating),
      offenseRank: num(rating.offense && rating.offense.ranking),
      defense: num(rating.defense && rating.defense.rating),
      defenseRank: num(rating.defense && rating.defense.ranking),
      specialTeams: num(rating.specialTeams && rating.specialTeams.rating),
    } : null,
    offense: row ? {
      epa: stat('off', 'epa', true),
      successRate: stat('off', 'successRate', true),
      explosiveness: stat('off', 'explosiveness', true),
      rushEpa: stat('off', 'rushEpa', true),
      passEpa: stat('off', 'passEpa', true),
    } : null,
    defense: row ? {
      epa: stat('def', 'epa', false),
      successRate: stat('def', 'successRate', false),
      explosiveness: stat('def', 'explosiveness', false),
      havoc: stat('def', 'havoc', true),
    } : null,
  };
}

// One game's advanced box score: EPA per play, success rate,
// explosiveness and havoc for each team.
async function gameAdvanced(gameId, deps = { cfbd: recruiting.cfbd, hasCfbd: recruiting.hasCfbd }) {
  if (!deps.hasCfbd()) return { available: false, reason: 'no-key' };
  return cache.getOrFetch(`cfbd:game:${gameId}`, async () => {
    let json;
    try {
      json = await deps.cfbd(`/game/box/advanced?id=${encodeURIComponent(gameId)}`);
    } catch (err) {
      return { available: false, reason: 'not-found' };
    }
    const teams = (json && json.teams) || {};
    const byTeam = new Map();
    const put = (team, key, value) => {
      if (!team) return;
      const t = byTeam.get(team) || { team };
      t[key] = num(value);
      byTeam.set(team, t);
    };
    ((teams.ppa) || []).forEach((r) => {
      put(r.team, 'epa', r.overall && r.overall.total);
      put(r.team, 'passEpa', r.passing && r.passing.total);
      put(r.team, 'rushEpa', r.rushing && r.rushing.total);
      put(r.team, 'plays', r.plays);
    });
    ((teams.cumulativePpa) || []).forEach((r) => put(r.team, 'totalEpa', r.overall && r.overall.total));
    ((teams.successRates) || []).forEach((r) => put(r.team, 'successRate', r.overall && r.overall.total));
    ((teams.explosiveness) || []).forEach((r) => put(r.team, 'explosiveness', r.overall && r.overall.total));
    ((teams.havoc) || []).forEach((r) => put(r.team, 'havoc', r.total));
    ((teams.scoringOpportunities) || []).forEach((r) => put(r.team, 'pointsPerOpportunity', r.pointsPerOpportunity));
    const list = [...byTeam.values()];
    return list.length ? { available: true, teams: list } : { available: false, reason: 'not-found' };
  }, 60 * 1000);
}

module.exports = { teamAdvanced, gameAdvanced, rankAmong, seasonFor };

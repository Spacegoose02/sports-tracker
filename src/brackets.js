// Postseason data for the playoff hub (/brackets.html): the College
// Football Playoff and bowls, and the men's NCAA basketball tournament.
// Games come from ESPN's scoreboard; brackets-core.js sorts them into
// rounds, the same code the page and the family bracket challenge use.

const espn = require('./espn');
const cache = require('./cache');
const BracketsCore = require('../public/js/brackets-core.js');

const SPORTS = ['cfb', 'mcbb'];

async function cfbPostseason(season) {
  // ESPN files the whole CFB postseason (bowls and every playoff round)
  // under postseason week 1.
  const sb = await espn.getScoreboard({ sport: 'cfb', year: season, week: 1, seasontype: 3 });
  const bracket = BracketsCore.buildBracket(sb.games, 'cfb');
  // ESPN lists playoff games weeks ahead with "TBD" teams. Until the field
  // is set, the hub shows a projection from the current rankings.
  const cfpSet = !!bracket.cfp && bracket.cfp.rounds.some((r) => r.games.some((g) => realTeam(g.away) && realTeam(g.home)));
  let projected = null;
  if (!cfpSet) {
    try {
      const rankings = await espn.getRankings({ sport: 'cfb' });
      if (!rankings.season || Number(rankings.season) === Number(season)) projected = BracketsCore.projectCfp(rankings.polls);
    } catch (err) {
      projected = null;
    }
  }
  return { ...bracket, cfpSet, projected };
}

function realTeam(t) {
  return !!(t && t.id && Number(t.id) > 0 && !/^TBD\b/i.test(t.name || ''));
}

async function mcbbTournament(season) {
  // The tournament runs from the First Four (mid-March) to the title game
  // (early April). Division I scoreboard for that window, then only the
  // games ESPN labels as the NCAA tournament (no NIT and friends).
  const sb = await espn.getScoreboard({ sport: 'mcbb', dates: `${season}0314-${season}0410` });
  return BracketsCore.buildBracket(sb.games, 'mcbb');
}

function hasGames(sport, data) {
  if (sport === 'cfb') return !!(data.cfp || (data.bowls && data.bowls.length));
  return !!((data.regions && data.regions.length) || (data.firstFour && data.firstFour.length));
}

// { sport, season, empty, ...layout } for one sport and season. Finished
// seasons never change, so they are cached for a day; the current one
// follows the normal short cache so live scores move.
async function getPostseason({ sport, season } = {}) {
  if (!SPORTS.includes(sport)) throw new Error(`No playoff hub for ${sport}`);
  const current = BracketsCore.defaultSeason(sport);
  const year = Number(season) || current;
  const load = async () => {
    const data = sport === 'cfb' ? await cfbPostseason(year) : await mcbbTournament(year);
    return { sport, season: year, empty: !hasGames(sport, data), ...data };
  };
  if (year < current) return cache.getOrFetch(`brackets:${sport}:${year}`, load, 24 * 60 * 60 * 1000);
  return load();
}

module.exports = { getPostseason, SPORTS };

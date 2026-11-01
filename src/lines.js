// Betting lines for the Lines page: each game's spread, total and
// moneylines (parsed in espn.js parseOdds), plus how the game did against
// them once it's final. Results are informational only; this app takes no
// bets and links to no sportsbook.

// How a finished game did against its closing line. Null until the game is
// final and has both scores, or when there was no line to grade.
function gradeGame(game) {
  if (!game || !game.odds || !game.status || !game.status.completed) return null;
  if (!game.home || !game.away) return null;
  const home = Number(game.home.score);
  const away = Number(game.away.score);
  if (!Number.isFinite(home) || !Number.isFinite(away) || game.home.score === null || game.away.score === null) return null;

  const result = { ats: null, total: null };
  const { homeSpread, overUnder } = game.odds;
  if (homeSpread !== null && homeSpread !== undefined) {
    // Home margin plus the home spread: above zero the home side covered.
    const cover = (home - away) + homeSpread;
    const fav = game.odds.favorite || (homeSpread < 0 ? 'home' : homeSpread > 0 ? 'away' : null);
    let winner = null;
    if (cover > 0) winner = 'home';
    else if (cover < 0) winner = 'away';
    result.ats = {
      winner, // 'home' | 'away' | null (push)
      push: cover === 0,
      margin: Math.abs(cover),
      favoriteCovered: fav && winner ? fav === winner : null,
    };
  }
  if (overUnder !== null && overUnder !== undefined) {
    const points = home + away;
    result.total = {
      points,
      result: points > overUnder ? 'over' : points < overUnder ? 'under' : 'push',
    };
  }
  return result.ats || result.total ? result : null;
}

// Games with a line first (by kickoff), then the ones without, each
// carrying its graded result.
function buildLines(games) {
  const withLines = [];
  let withoutLines = 0;
  (games || []).forEach((game) => {
    if (!game || !game.odds) {
      withoutLines += 1;
      return;
    }
    withLines.push({ ...game, result: gradeGame(game) });
  });
  withLines.sort((a, b) => (a.date ? Date.parse(a.date) : 0) - (b.date ? Date.parse(b.date) : 0));

  // Week summary: favorites against the spread and overs/unders.
  const summary = { favorites: { won: 0, lost: 0, push: 0 }, totals: { over: 0, under: 0, push: 0 } };
  withLines.forEach((g) => {
    if (!g.result) return;
    const { ats, total } = g.result;
    if (ats) {
      if (ats.push) summary.favorites.push += 1;
      else if (ats.favoriteCovered === true) summary.favorites.won += 1;
      else if (ats.favoriteCovered === false) summary.favorites.lost += 1;
    }
    if (total) summary.totals[total.result] += 1;
  });

  return { games: withLines, withoutLines, summary };
}

module.exports = { gradeGame, buildLines };

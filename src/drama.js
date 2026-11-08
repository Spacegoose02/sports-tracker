// How gripping a live game is, shared by the home page ("Live now" order)
// and the game alerts (close-game and upset alerts). Mirrors gameDrama in
// public/js/shared.js, which tags cards on the Scores page.

const REG_PERIODS = { cfb: 4, nfl: 4, nba: 4, wnba: 4, mcbb: 2, nhl: 3, mlb: 9, epl: 2, mls: 2, ucl: 2 };
const CLOSE_MARGIN = { cfb: 8, nfl: 8, nba: 6, wnba: 6, mcbb: 6, nhl: 1, mlb: 2, epl: 1, mls: 1, ucl: 1 };

function rankOf(team) {
  const r = team && Number(team.curatedRank);
  return r && r <= 25 ? r : null;
}

// The facts behind the drama score, or null when the game isn't live with
// two scores.
function liveFacts(game, sport) {
  if (!game || !game.home || !game.away || !game.status || game.status.state !== 'in') return null;
  const h = Number(game.home.score);
  const a = Number(game.away.score);
  if (Number.isNaN(h) || Number.isNaN(a) || game.home.score === null || game.away.score === null) return null;
  const regulation = REG_PERIODS[sport] || 4;
  const close = CLOSE_MARGIN[sport] || 8;
  const period = Number(game.status.period) || 1;
  const overtime = period > regulation;
  const margin = Math.abs(h - a);
  const hr = rankOf(game.home);
  const ar = rankOf(game.away);
  // A ranked team losing to an unranked team, or to one ranked at least
  // five spots lower.
  const trailing = h < a ? { me: hr, them: ar, team: game.home } : a < h ? { me: ar, them: hr, team: game.away } : null;
  const upset = !!(trailing && trailing.me && (!trailing.them || trailing.them - trailing.me >= 5));
  return {
    margin, close, period, regulation, overtime, hr, ar, upset,
    upsetVictim: upset ? trailing.team : null,
    lateness: overtime ? 1.1 : Math.min(1, period / regulation),
    // The last period of regulation (4th quarter, 2nd half, 3rd period,
    // 9th inning... baseball counts from the 7th) or overtime.
    final: overtime || period >= (sport === 'mlb' ? 7 : regulation),
  };
}

// 0 to ~130: close score, late in the game, a ranked team in trouble.
function liveDrama(game, sport) {
  const f = liveFacts({ ...game, status: { ...(game && game.status), state: 'in' } }, sport);
  if (!f) return 0;
  const closeness = Math.max(0, 1 - f.margin / (f.close * 2));
  return Math.round(closeness * 60 + f.lateness * 30 + (f.upset ? 25 : 0) + (f.hr && f.ar ? 10 : 0) + (f.overtime ? 10 : 0));
}

// A one-score game in the final period: worth a "close game" alert.
function isCloseFinish(game, sport) {
  const f = liveFacts(game, sport);
  return !!(f && f.final && f.margin <= f.close);
}

// A ranked team losing in the second half: worth an "upset brewing" alert.
function isUpsetBrewing(game, sport) {
  const f = liveFacts(game, sport);
  return !!(f && f.upset && f.lateness >= 0.5) ? f.upsetVictim : null;
}

module.exports = { REG_PERIODS, CLOSE_MARGIN, rankOf, liveFacts, liveDrama, isCloseFinish, isUpsetBrewing };

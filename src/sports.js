// The sports this app can show, all served by ESPN's public site API.
// ESPN uses the same endpoint shapes for every league; only the path
// segment changes (football/nfl, basketball/nba, ...), so adding a sport is
// one entry here.
//
//   schedule: 'week' sports (football) page through numbered weeks;
//             'day' sports page through calendar dates.
//   groups:   optional division filter ESPN accepts on the scoreboard and
//             standings (college only), shown as a toggle in the UI.
//   rankings: whether ESPN publishes polls for this league.
//   field:    whether the live football field diagram applies.
//   notable:  whether the admin "Notable Games" picks apply (CFB only, the
//             picks table has no sport column).
//   format:   'game' (two teams), 'card' (UFC: an event made of fights) or
//             'race' (NASCAR: one race with a running order). Card and race
//             sports list events instead of games, have no teams to follow
//             and no standings.
//   leaders:  season stat leaders page (default on for team sports).
//   fantasy:  weekly fantasy football scores built from box scores.
//   kind:     the game family (football, soccer, golf...), for words, kid
//             explanations and drawings that are the same across leagues.

const SPORTS = {
  cfb: {
    key: 'cfb',
    label: 'College Football',
    shortLabel: 'CFB',
    path: 'football/college-football',
    schedule: 'week',
    maxWeek: 15,
    seasonTypes: [{ value: 2, label: 'Regular Season' }, { value: 3, label: 'Postseason / Bowls' }],
    groups: [{ key: 'fbs', label: 'FBS', value: 80 }, { key: 'fcs', label: 'FCS', value: 81 }],
    rankings: true,
    field: true,
    notable: true,
    periodPrefix: 'Q',
  },
  nfl: {
    key: 'nfl',
    label: 'NFL',
    shortLabel: 'NFL',
    path: 'football/nfl',
    schedule: 'week',
    maxWeek: 18,
    seasonTypes: [{ value: 2, label: 'Regular Season' }, { value: 3, label: 'Playoffs' }],
    groups: null,
    rankings: false,
    field: true,
    notable: false,
    fantasy: true,
    periodPrefix: 'Q',
  },
  nba: {
    key: 'nba',
    label: 'NBA',
    shortLabel: 'NBA',
    path: 'basketball/nba',
    schedule: 'day',
    groups: null,
    rankings: false,
    field: false,
    notable: false,
    periodPrefix: 'Q',
  },
  mcbb: {
    key: 'mcbb',
    label: "Men's College Basketball",
    shortLabel: 'CBB',
    path: 'basketball/mens-college-basketball',
    schedule: 'day',
    // 50 = all Division I. Without it ESPN only returns featured games.
    groups: [{ key: 'd1', label: 'Division I', value: 50 }],
    rankings: true,
    field: false,
    notable: false,
    periodPrefix: 'H',
  },
  mlb: {
    key: 'mlb',
    label: 'MLB',
    shortLabel: 'MLB',
    path: 'baseball/mlb',
    schedule: 'day',
    groups: null,
    rankings: false,
    field: false,
    notable: false,
    periodPrefix: 'Inn ',
  },
  nhl: {
    key: 'nhl',
    label: 'NHL',
    shortLabel: 'NHL',
    path: 'hockey/nhl',
    schedule: 'day',
    groups: null,
    rankings: false,
    field: false,
    notable: false,
    periodPrefix: 'P',
  },
  wnba: {
    key: 'wnba',
    label: 'WNBA',
    shortLabel: 'WNBA',
    path: 'basketball/wnba',
    schedule: 'day',
    groups: null,
    rankings: false,
    field: false,
    notable: false,
    periodPrefix: 'Q',
  },
  // Soccer: draws are normal, standings are by points, and the clock is
  // minutes ("67'"). Every league is the same shape under soccer/<slug>.
  epl: {
    key: 'epl',
    label: 'Premier League',
    shortLabel: 'EPL',
    path: 'soccer/eng.1',
    schedule: 'day',
    groups: null,
    rankings: false,
    field: false,
    notable: false,
    leaders: false,
    kind: 'soccer',
    periodPrefix: 'H',
  },
  mls: {
    key: 'mls',
    label: 'MLS',
    shortLabel: 'MLS',
    path: 'soccer/usa.1',
    schedule: 'day',
    groups: null,
    rankings: false,
    field: false,
    notable: false,
    leaders: false,
    kind: 'soccer',
    periodPrefix: 'H',
  },
  ucl: {
    key: 'ucl',
    label: 'Champions League',
    shortLabel: 'UCL',
    path: 'soccer/uefa.champions',
    schedule: 'day',
    groups: null,
    rankings: false,
    field: false,
    notable: false,
    leaders: false,
    kind: 'soccer',
    periodPrefix: 'H',
  },
  ufc: {
    key: 'ufc',
    label: 'UFC',
    shortLabel: 'UFC',
    path: 'mma/ufc',
    schedule: 'event',
    format: 'card',
    groups: null,
    rankings: false,
    standings: false,
    teams: false,
    field: false,
    notable: false,
    periodPrefix: 'R',
  },
  nascar: {
    key: 'nascar',
    label: 'NASCAR Cup Series',
    shortLabel: 'NASCAR',
    path: 'racing/nascar-premier',
    schedule: 'event',
    format: 'race',
    groups: null,
    rankings: false,
    standings: false,
    teams: false,
    field: false,
    notable: false,
    periodPrefix: 'Lap ',
  },
  f1: {
    key: 'f1',
    label: 'Formula 1',
    shortLabel: 'F1',
    path: 'racing/f1',
    schedule: 'event',
    format: 'race',
    groups: null,
    rankings: false,
    standings: false,
    teams: false,
    field: false,
    notable: false,
    periodPrefix: 'Lap ',
  },
  // Golf: a tournament is one event with a leaderboard (to-par scores), so
  // it reuses the race layout with a score beside each name.
  golf: {
    key: 'golf',
    label: 'PGA Tour',
    shortLabel: 'Golf',
    path: 'golf/pga',
    schedule: 'event',
    format: 'race',
    groups: null,
    rankings: false,
    standings: false,
    teams: false,
    field: false,
    notable: false,
    kind: 'golf',
    periodPrefix: 'Rd ',
  },
};

const KINDS = {
  cfb: 'football', nfl: 'football',
  nba: 'basketball', mcbb: 'basketball', wnba: 'basketball',
  mlb: 'baseball', nhl: 'hockey',
  ufc: 'fighting', nascar: 'racing', f1: 'racing',
};

// Team sports get these defaults unless they say otherwise.
for (const sport of Object.values(SPORTS)) {
  if (sport.format === undefined) sport.format = 'game';
  if (sport.standings === undefined) sport.standings = true;
  if (sport.teams === undefined) sport.teams = true;
  if (sport.leaders === undefined) sport.leaders = sport.format === 'game';
  if (sport.fantasy === undefined) sport.fantasy = false;
  if (sport.kind === undefined) sport.kind = KINDS[sport.key] || 'other';
}

const DEFAULT_SPORT = 'cfb';

function getSport(key) {
  return Object.prototype.hasOwnProperty.call(SPORTS, key) ? SPORTS[key] : null;
}

// Resolves a ?sport= value to a sport config, falling back to college
// football so every existing URL keeps working unchanged.
function resolveSport(key) {
  return getSport(key || DEFAULT_SPORT);
}

// The config the browser needs (no ESPN paths).
function publicSportList() {
  return Object.values(SPORTS).map(({ path, ...rest }) => rest);
}

module.exports = { SPORTS, DEFAULT_SPORT, getSport, resolveSport, publicSportList };

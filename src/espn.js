// Thin client around ESPN's public (unofficial, undocumented but widely
// used) college football APIs. No API key required.
//
// Reference endpoints:
//   Scoreboard (a week's games):
//     https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard
//   Team schedule (full season for one team):
//     https://site.api.espn.com/apis/site/v2/sports/football/college-football/teams/{id}/schedule
//   Game summary (box score / live drive-by-drive stats):
//     https://site.api.espn.com/apis/site/v2/sports/football/college-football/summary

const fetch = require('node-fetch');
const cache = require('./cache');

const BASE = 'https://site.api.espn.com/apis/site/v2/sports/football/college-football';
const CORE_BASE = 'https://sports.core.api.espn.com/v2/sports/football/leagues/college-football';

async function fetchJson(url) {
  const res = await fetch(url, { timeout: 10000 });
  if (!res.ok) {
    throw new Error(`ESPN request failed: ${res.status} ${res.statusText} for ${url}`);
  }
  return res.json();
}

// ESPN represents a competitor's score differently across endpoints: the
// scoreboard endpoint tends to give a plain string ("24"), but the
// per-team schedule endpoint has been observed giving an object
// ({ value: 24, displayValue: "24" }) or omitting it on some entries
// entirely. This normalizes all of those shapes, and falls back to
// summing quarter-by-quarter linescores if the top-level score is
// missing but linescores are present.
function parseScore(rawScore, linescores) {
  let value = null;
  if (rawScore !== undefined && rawScore !== null) {
    if (typeof rawScore === 'number') {
      value = rawScore;
    } else if (typeof rawScore === 'string' && rawScore !== '') {
      value = Number(rawScore);
    } else if (typeof rawScore === 'object') {
      if (rawScore.value !== undefined) value = Number(rawScore.value);
      else if (rawScore.displayValue !== undefined) value = Number(rawScore.displayValue);
    }
  }
  if ((value === null || Number.isNaN(value)) && Array.isArray(linescores) && linescores.length) {
    const sum = linescores.reduce((acc, l) => {
      const n = typeof l === 'object' ? Number(l.value !== undefined ? l.value : l.displayValue) : Number(l);
      return acc + (Number.isNaN(n) ? 0 : n);
    }, 0);
    if (sum > 0) value = sum;
  }
  return value === null || Number.isNaN(value) ? null : value;
}

// Betting odds, when ESPN includes them (mainly pregame/in-progress; often
// absent for older or lower-profile games). `oddsArr` is whatever raw array
// ESPN gave us (competition.odds on the scoreboard, or pickcenter on the
// summary endpoint) — both use roughly the same shape, so one parser covers
// both. Only the first (primary) provider is used.
function parseOdds(oddsArr) {
  if (!Array.isArray(oddsArr) || !oddsArr.length) return null;
  const o = oddsArr[0];
  const rawOverUnder = o.overUnder !== undefined ? o.overUnder : o.total;
  const overUnder = rawOverUnder !== undefined && rawOverUnder !== null ? Number(rawOverUnder) : null;
  const rawSpread = o.spread;
  const spread = rawSpread !== undefined && rawSpread !== null ? Number(rawSpread) : null;
  if (overUnder === null && spread === null && !o.details) return null;
  return {
    provider: (o.provider && o.provider.name) || null,
    details: o.details || null,
    spread: Number.isNaN(spread) ? null : spread,
    overUnder: Number.isNaN(overUnder) ? null : overUnder,
  };
}

function parseCuratedRank(c) {
  const raw = c.curatedRank;
  if (!raw) return null;
  const current = typeof raw === 'object' ? raw.current : raw;
  const n = Number(current);
  return !Number.isNaN(n) && n > 0 && n < 99 ? n : null;
}

function normalizeCompetitor(c) {
  const team = c.team || {};
  const linescores = (c.linescores || []).map((l) => (typeof l === 'object' ? (l.value !== undefined ? l.value : l.displayValue) : l));
  return {
    id: team.id,
    uid: team.uid,
    name: team.displayName || team.name,
    shortName: team.shortDisplayName || team.abbreviation,
    abbreviation: team.abbreviation,
    logo: team.logo || (team.logos && team.logos[0] && team.logos[0].href) || null,
    color: team.color ? `#${team.color}` : null,
    score: parseScore(c.score, c.linescores),
    homeAway: c.homeAway,
    winner: !!c.winner,
    curatedRank: parseCuratedRank(c),
    records: (c.records || []).map((r) => ({ name: r.name, summary: r.summary })),
    linescores,
  };
}

// ESPN's live "situation" object, normalized once and reused by both the
// scoreboard (normalizeGame, below) and the game-summary endpoint
// (getGameSummary). `yardLine` is a 0-100 number measured from the
// possessing team's OWN goal line (0 = pinned on their own goal, 100 =
// standing in the opponent's end zone) — this matches how ESPN computes
// `isRedZone` (true once yardLine crosses into the opponent's 20, i.e.
// yardLine >= 80) and is the convention this app's field-position diagram
// on the game page assumes. ESPN doesn't publish a formal schema for this
// endpoint, so if a live game ever shows the ball on the wrong side of the
// field, this is the first place to check.
function parseSituation(raw) {
  if (!raw) return null;
  const yardLine = raw.yardLine !== undefined && raw.yardLine !== null ? Number(raw.yardLine) : null;
  const distance = raw.distance !== undefined && raw.distance !== null ? Number(raw.distance) : null;
  return {
    down: raw.shortDownDistanceText || raw.downDistanceText || null,
    distance: Number.isNaN(distance) ? null : distance,
    yardLine: Number.isNaN(yardLine) ? null : yardLine,
    possessionText: raw.possessionText || null,
    isRedZone: !!raw.isRedZone,
    homeTimeouts: raw.homeTimeouts !== undefined ? raw.homeTimeouts : null,
    awayTimeouts: raw.awayTimeouts !== undefined ? raw.awayTimeouts : null,
    possession: raw.possession || null,
    lastPlay: raw.lastPlay && raw.lastPlay.text,
  };
}

function normalizeGame(event) {
  const comp = event.competitions && event.competitions[0];
  const status = event.status || (comp && comp.status) || {};
  const competitors = (comp && comp.competitors) || [];
  const home = competitors.find((c) => c.homeAway === 'home');
  const away = competitors.find((c) => c.homeAway === 'away');
  const broadcasts = (comp && comp.broadcasts) || [];

  return {
    id: event.id,
    date: event.date,
    name: event.name,
    shortName: event.shortName,
    week: event.week && event.week.number,
    venue: comp && comp.venue && comp.venue.fullName,
    neutralSite: !!(comp && comp.neutralSite),
    conferenceCompetition: !!(comp && comp.conferenceCompetition),
    broadcast: broadcasts[0] && broadcasts[0].names && broadcasts[0].names[0],
    status: {
      state: status.type && status.type.state, // 'pre' | 'in' | 'post'
      detail: status.type && status.type.detail,
      shortDetail: status.type && status.type.shortDetail,
      completed: !!(status.type && status.type.completed),
      period: status.period,
      clock: status.displayClock,
    },
    home: home ? normalizeCompetitor(home) : null,
    away: away ? normalizeCompetitor(away) : null,
    // Best-effort: ESPN only attaches odds to some games (mainly current/
    // upcoming FBS matchups with a real sportsbook line). Null just means
    // "no line available," not an error.
    odds: parseOdds(comp && comp.odds),
    situation: parseSituation(comp && comp.situation),
  };
}

// ESPN's `winner` flag on a competitor isn't always present (some feeds,
// notably the per-team schedule endpoint, omit it even for finished
// games). If the game is completed and both scores parsed successfully,
// infer the winner from the scores so the UI can always show a clear W/L.
function fillInWinner(game) {
  if (!game.status || !game.status.completed) return game;
  if (!game.home || !game.away) return game;
  if (game.home.score === null || game.away.score === null) return game;
  if (game.home.winner || game.away.winner) return game; // already known
  if (game.home.score === game.away.score) return game; // tie, leave as-is
  game.home.winner = game.home.score > game.away.score;
  game.away.winner = game.away.score > game.home.score;
  return game;
}

// Get the scoreboard for a given week/season. If week/season/seasontype are
// omitted, ESPN returns whatever week is "current" on their end.
async function getScoreboard({ year, week, seasontype = 2, groups = 80 } = {}) {
  const params = new URLSearchParams();
  if (year) params.set('year', year);
  if (week) params.set('week', week);
  if (seasontype) params.set('seasontype', seasontype);
  if (groups) params.set('groups', groups); // 80 = FBS
  params.set('limit', 400);

  const key = `espn:scoreboard:${params.toString()}`;
  return cache.getOrFetch(key, async () => {
    const json = await fetchJson(`${BASE}/scoreboard?${params.toString()}`);
    const events = json.events || [];
    return {
      season: json.season && json.season.year,
      week: json.week && json.week.number,
      seasonType: json.season && json.season.type,
      games: events.map((e) => fillInWinner(normalizeGame(e))),
    };
  });
}

// Full-season schedule for one team (used for the pinned favorite team and
// for the "jump to my team's next game" convenience).
async function getTeamSchedule(teamId, season) {
  const params = new URLSearchParams();
  if (season) params.set('season', season);
  const key = `espn:teamschedule:${teamId}:${season || 'current'}`;
  return cache.getOrFetch(key, async () => {
    const json = await fetchJson(`${BASE}/teams/${teamId}/schedule?${params.toString()}`);
    const events = json.events || [];
    return {
      teamId,
      season: json.season && json.season.year,
      games: events.map((event) => {
        // Team schedule events have a slightly different shape than the
        // scoreboard endpoint (competitions live at the top level under
        // "competitions" too, but competitors reference team refs) - ESPN
        // is not perfectly consistent, so normalizeGame() defensively reads
        // through optional chaining-equivalent guards above, and
        // fillInWinner() covers the case where this feed omits the
        // `winner` flag on completed games even when scores are present.
        return fillInWinner(normalizeGame(event));
      }),
    };
  });
}

// Team header info: current record, rank, logo, colors.
async function getTeamInfo(teamId) {
  const key = `espn:teaminfo:${teamId}`;
  return cache.getOrFetch(key, async () => {
    const json = await fetchJson(`${BASE}/teams/${teamId}`);
    const team = json.team || {};
    return {
      id: team.id,
      name: team.displayName,
      shortName: team.shortDisplayName,
      abbreviation: team.abbreviation,
      logo: team.logos && team.logos[0] && team.logos[0].href,
      color: team.color ? `#${team.color}` : null,
      record: team.record && team.record.items && team.record.items[0] && team.record.items[0].summary,
      rank: team.rank || null,
      standingSummary: team.standingSummary,
    };
  }, 5 * 60 * 1000); // team info changes rarely, cache 5 min
}

// Live/finished game detail: score by quarter, leaders, box score stats.
// Cached for a very short time (or not at all) so "live" stays live.
async function getGameSummary(eventId) {
  const key = `espn:summary:${eventId}`;
  return cache.getOrFetch(key, async () => {
    const json = await fetchJson(`${BASE}/summary?event=${encodeURIComponent(eventId)}`);
    const header = json.header || {};
    const comp = header.competitions && header.competitions[0];
    const competitors = (comp && comp.competitors) || [];

    return {
      id: header.id,
      date: (comp && comp.date) || header.date || null,
      venue: (comp && comp.venue && comp.venue.fullName) || null,
      broadcast: (comp && comp.broadcasts && comp.broadcasts[0] && comp.broadcasts[0].names && comp.broadcasts[0].names[0]) || null,
      status: comp && comp.status && {
        state: comp.status.type && comp.status.type.state,
        detail: comp.status.type && comp.status.type.detail,
        shortDetail: comp.status.type && comp.status.type.shortDetail,
        completed: !!(comp.status.type && comp.status.type.completed),
        period: comp.status.period,
        clock: comp.status.displayClock,
      },
      situation: parseSituation(json.situation),
      teams: competitors.map((c) => ({
        id: c.team && c.team.id,
        name: c.team && c.team.displayName,
        shortName: c.team && (c.team.shortDisplayName || c.team.abbreviation),
        abbreviation: c.team && c.team.abbreviation,
        logo: (c.team && (c.team.logo || (c.team.logos && c.team.logos[0] && c.team.logos[0].href))) || null,
        color: c.team && c.team.color ? `#${c.team.color}` : null,
        record: c.records && c.records[0] && c.records[0].summary,
        rank: c.curatedRank ? parseCuratedRank(c) : null,
        homeAway: c.homeAway,
        winner: !!c.winner,
        score: parseScore(c.score, c.linescores),
        linescores: (c.linescores || []).map((l) => (typeof l === 'object' ? (l.value !== undefined ? l.value : l.displayValue) : l)),
      })),
      leaders: (json.leaders || []).map((teamLeaders) => ({
        team: teamLeaders.team && teamLeaders.team.displayName,
        categories: (teamLeaders.leaders || []).map((cat) => ({
          name: cat.displayName,
          athlete: cat.leaders && cat.leaders[0] && cat.leaders[0].athlete && cat.leaders[0].athlete.displayName,
          value: cat.leaders && cat.leaders[0] && cat.leaders[0].displayValue,
        })),
      })),
      boxscore: json.boxscore
        ? {
          teams: (json.boxscore.teams || []).map((t) => ({
            team: t.team && t.team.displayName,
            stats: (t.statistics || []).map((s) => ({ name: s.label || s.name, value: s.displayValue })),
          })),
        }
        : null,
      drives: json.drives && json.drives.current
        ? {
          description: json.drives.current.description,
          plays: (json.drives.current.plays || []).slice(-5).map((p) => p.text),
        }
        : null,
      // Full play-by-play works out to at least ~50-150+ plays a game, so
      // this reads through every drive (previous, in chronological order
      // per ESPN, plus the current one) rather than just the last few
      // plays `drives` above uses for the compact "latest drive" summary.
      // Returned newest-first so the game page can show it as a live feed.
      odds: parseOdds(json.pickcenter) || parseOdds(comp && comp.odds),
      playByPlay: buildPlayByPlay(json.drives),
    };
  }, 10 * 1000); // 10s cache for in-game data
}

function buildPlayByPlay(drivesJson) {
  if (!drivesJson) return [];
  const drives = [...(drivesJson.previous || []), ...(drivesJson.current ? [drivesJson.current] : [])];
  const plays = [];
  for (const drive of drives) {
    const driveDesc = drive.description || (drive.team && drive.team.displayName) || null;
    for (const p of drive.plays || []) {
      if (!p.text) continue;
      plays.push({
        text: p.text,
        period: p.period && p.period.number,
        clock: p.clock && p.clock.displayValue,
        drive: driveDesc,
        scoringPlay: !!p.scoringPlay,
      });
    }
  }
  return plays.reverse(); // newest first
}

// Top 25 rankings (AP, Coaches, etc.), including "others receiving votes".
// ESPN's rankings JSON shape has drifted a bit over the years, so this
// reads several possible field names defensively rather than assuming one.
async function getRankings({ year, week, seasontype = 2 } = {}) {
  const params = new URLSearchParams();
  if (year) params.set('year', year);
  if (week) params.set('week', week);
  if (seasontype) params.set('seasontype', seasontype);
  // No group/division filter: ESPN's rankings endpoint returns every poll
  // it has for the week in one response (AP Top 25, AFCA Coaches, FCS
  // Coaches Poll, AFCA Division II/III Coaches, etc.) — the poll picker in
  // the UI is what narrows it down, so there's no need to ask ESPN to
  // pre-filter by division.

  const key = `espn:rankings:${params.toString()}`;
  return cache.getOrFetch(key, async () => {
    const json = await fetchJson(`${BASE}/rankings?${params.toString()}`);
    const pollsRaw = json.rankings || (json.sports && json.sports[0] && json.sports[0].leagues && json.sports[0].leagues[0] && json.sports[0].leagues[0].rankings) || [];

    const polls = pollsRaw.map((poll) => {
      const ranks = (poll.ranks || []).map((r) => ({
        rank: r.current,
        previousRank: r.previous || null,
        trend: r.trend || null,
        points: r.points || null,
        firstPlaceVotes: r.firstPlaceVotes || 0,
        recordSummary: r.recordSummary || (r.team && r.team.record) || null,
        team: r.team
          ? {
            id: r.team.id,
            name: r.team.displayName || r.team.name,
            shortName: r.team.shortDisplayName || r.team.abbreviation,
            abbreviation: r.team.abbreviation,
            logo: r.team.logos && r.team.logos[0] && r.team.logos[0].href,
          }
          : null,
      }));

      // "Others receiving votes" shows up under a few different possible
      // keys depending on ESPN's API version; try each.
      const othersRaw = poll.others || poll.receivingVotes || poll.otherReceivingVotes || [];
      const others = othersRaw.map((o) => ({
        points: o.points || o.receivingVotesCount || null,
        recordSummary: o.recordSummary || null,
        team: o.team
          ? {
            id: o.team.id,
            name: o.team.displayName || o.team.name,
            shortName: o.team.shortDisplayName || o.team.abbreviation,
            abbreviation: o.team.abbreviation,
            logo: o.team.logos && o.team.logos[0] && o.team.logos[0].href,
          }
          : null,
      }));

      const droppedOut = (poll.droppedOut || []).map((d) => ({
        team: d.team ? { id: d.team.id, name: d.team.displayName || d.team.name } : null,
      }));

      return {
        id: poll.id,
        name: poll.name,
        shortName: poll.shortName,
        headline: poll.headline,
        occurrence: poll.occurrence && poll.occurrence.value,
        ranks,
        others,
        droppedOut,
      };
    });

    return { season: year, week, polls };
  }, 60 * 1000); // rankings update ~weekly, but cache short so a same-day fix shows up fast
}

// Conference standings, grouped by conference. group=80 is FBS.
async function getStandings({ year, group = 80 } = {}) {
  const params = new URLSearchParams();
  params.set('season', year || new Date().getFullYear());
  params.set('group', group);

  const key = `espn:standings:${params.toString()}`;
  return cache.getOrFetch(key, async () => {
    // This endpoint lives at a slightly different path than the others.
    const url = `https://site.api.espn.com/apis/v2/sports/football/college-football/standings?${params.toString()}`;
    const json = await fetchJson(url);
    const children = json.children || [];

    const conferences = children.map((conf) => {
      const standings = (conf.standings && conf.standings.entries) || [];
      const entries = standings.map((entry) => {
        const team = entry.team || {};
        const statByName = {};
        (entry.stats || []).forEach((s) => {
          statByName[s.name || s.shortDisplayName] = s.displayValue;
        });
        return {
          team: {
            id: team.id,
            name: team.displayName || team.name,
            shortName: team.shortDisplayName || team.abbreviation,
            abbreviation: team.abbreviation,
            logo: team.logos && team.logos[0] && team.logos[0].href,
          },
          overall: statByName.overall || statByName['overall record'] || null,
          conference: statByName.vsConf || statByName.conferenceRecord || statByName['vs. Conf.'] || null,
          streak: statByName.streak || null,
          rank: statByName.rank || null,
        };
      });
      return {
        name: conf.name || (conf.abbreviation),
        abbreviation: conf.abbreviation,
        entries,
      };
    });

    return { season: year, conferences };
  }, 5 * 60 * 1000); // standings change slowly, cache 5 min
}

// Season-level team statistics (passing/rushing/defense totals, etc.)
async function getTeamStatistics(teamId, season) {
  const params = new URLSearchParams();
  if (season) params.set('season', season);
  const key = `espn:teamstats:${teamId}:${season || 'current'}`;
  return cache.getOrFetch(key, async () => {
    const json = await fetchJson(`${BASE}/teams/${teamId}/statistics?${params.toString()}`);
    const splits = (json.results && json.results.stats && json.results.stats.categories) || (json.splits && json.splits.categories) || [];
    return {
      teamId,
      categories: splits.map((cat) => ({
        name: cat.displayName || cat.name,
        stats: (cat.stats || []).map((s) => ({ name: s.displayName || s.name, value: s.displayValue })),
      })),
    };
  }, 5 * 60 * 1000);
}

module.exports = {
  getScoreboard,
  getTeamSchedule,
  getTeamInfo,
  getGameSummary,
  getRankings,
  getStandings,
  getTeamStatistics,
};

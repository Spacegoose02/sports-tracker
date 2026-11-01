// Followed teams' schedules as an iCalendar (.ics) feed, plus the "my
// teams" summary other apps (Den Duty) read. Phones and calendar apps
// subscribe to the feed URL and refresh it on their own, so new games and
// kickoff time changes show up without re-exporting.

const ds = require('./datasource');
const { getSport } = require('./sports');

// Typical game length per sport, for the calendar entry's end time.
const DURATION_MIN = { cfb: 210, nfl: 195, nba: 150, mcbb: 135, mlb: 180, nhl: 165 };

// Loads each followed team's season schedule. Teams in sports without
// teams (UFC, NASCAR) and unknown sports are skipped; one team failing
// doesn't break the rest.
async function loadSchedules(follows) {
  const usable = follows.filter((f) => {
    const sport = getSport(f.sport);
    return sport && sport.teams !== false && /^[A-Za-z0-9_-]{1,40}$/.test(String(f.id));
  });
  return Promise.all(usable.map(async (f) => {
    const schedule = await ds.getTeamSchedule(String(f.id), undefined, f.sport).catch(() => null);
    return { follow: f, games: schedule ? schedule.games || [] : [] };
  }));
}

// ---- iCalendar --------------------------------------------------------

function icsEscape(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

// RFC 5545 lines are at most 75 octets; longer ones continue on the next
// line after a single space. Splits on characters, not bytes mid-UTF-8.
function foldLine(line) {
  const out = [];
  let current = '';
  let bytes = 0;
  for (const ch of line) {
    const size = Buffer.byteLength(ch);
    if (bytes + size > (out.length ? 74 : 75)) {
      out.push(current);
      current = '';
      bytes = 0;
    }
    current += ch;
    bytes += size;
  }
  out.push(current);
  return out.join('\r\n ');
}

function icsDateTime(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function icsDate(date) {
  return date.toISOString().slice(0, 10).replace(/-/g, '');
}

function teamName(team) {
  return (team && (team.name || team.shortName || team.abbreviation)) || 'TBD';
}

function gameSummary(game) {
  const away = game.away || {};
  const home = game.home || {};
  const sep = game.neutralSite ? 'vs' : 'at';
  let summary = `${teamName(away)} ${sep} ${teamName(home)}`;
  if (game.status && game.status.completed && away.score !== null && away.score !== undefined && home.score !== null && home.score !== undefined) {
    summary = `${teamName(away)} ${away.score}, ${teamName(home)} ${home.score} (Final)`;
  }
  return summary;
}

function buildIcs(schedules, { name = 'My teams', baseUrl = '', now = new Date() } = {}) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//CFB Tracker//Followed teams//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsEscape(name)}`,
    'REFRESH-INTERVAL;VALUE=DURATION:PT6H',
    'X-PUBLISHED-TTL:PT6H',
  ];
  const seen = new Set();
  schedules.forEach(({ follow, games }) => {
    const sport = getSport(follow.sport);
    games.forEach((game) => {
      if (!game || !game.id || !game.date) return;
      const uid = `${follow.sport}-${game.id}`;
      if (seen.has(uid)) return; // two followed teams playing each other
      seen.add(uid);
      const start = new Date(game.date);
      if (Number.isNaN(start.getTime())) return;
      const description = [
        sport ? sport.label : null,
        game.broadcast ? `TV: ${game.broadcast}` : null,
        game.status && game.status.state === 'post' && game.status.detail ? game.status.detail : null,
        baseUrl ? `${baseUrl}/game.html?id=${encodeURIComponent(game.id)}&source=espn&sport=${encodeURIComponent(follow.sport)}` : null,
      ].filter(Boolean).join('\n');
      lines.push('BEGIN:VEVENT');
      lines.push(`UID:${uid}@cfb-tracker`);
      lines.push(`DTSTAMP:${icsDateTime(now)}`);
      if (game.timeValid === false) {
        // Kickoff TBA: an all-day entry on the scheduled (US) day.
        const day = new Date(start.getTime() - 5 * 60 * 60 * 1000);
        const next = new Date(day.getTime() + 24 * 60 * 60 * 1000);
        lines.push(`DTSTART;VALUE=DATE:${icsDate(day)}`);
        lines.push(`DTEND;VALUE=DATE:${icsDate(next)}`);
      } else {
        const end = new Date(start.getTime() + (DURATION_MIN[follow.sport] || 180) * 60 * 1000);
        lines.push(`DTSTART:${icsDateTime(start)}`);
        lines.push(`DTEND:${icsDateTime(end)}`);
      }
      lines.push(`SUMMARY:${icsEscape(gameSummary(game))}`);
      if (game.venue) lines.push(`LOCATION:${icsEscape(game.venue)}`);
      if (description) lines.push(`DESCRIPTION:${icsEscape(description)}`);
      if (game.status && game.status.state === 'post') lines.push('STATUS:CONFIRMED');
      lines.push('END:VEVENT');
    });
  });
  lines.push('END:VCALENDAR');
  return `${lines.map(foldLine).join('\r\n')}\r\n`;
}

// ---- "My teams" summary (Den Duty) -------------------------------------

function slimGame(game) {
  if (!game) return null;
  return {
    id: game.id,
    date: game.date,
    timeValid: game.timeValid !== false,
    name: game.name,
    shortName: game.shortName,
    venue: game.venue || null,
    broadcast: game.broadcast || null,
    status: game.status,
    home: game.home,
    away: game.away,
  };
}

// Each followed team with its header info, live game, next game, last
// result and the next few games.
async function myTeamsSummary(follows, { baseUrl = '', upcoming = 3, now = Date.now() } = {}) {
  const schedules = await loadSchedules(follows);
  return Promise.all(schedules.map(async ({ follow, games }) => {
    const sport = getSport(follow.sport);
    const info = await ds.getTeamInfo(String(follow.id), follow.sport).catch(() => null);
    const sorted = games.filter((g) => g && g.date).sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
    const live = sorted.find((g) => g.status && g.status.state === 'in') || null;
    const ahead = sorted.filter((g) => g.status && g.status.state === 'pre' && Date.parse(g.date) >= now - 6 * 60 * 60 * 1000);
    const past = sorted.filter((g) => g.status && g.status.state === 'post');
    return {
      sport: follow.sport,
      sportLabel: sport ? sport.label : follow.sport,
      id: String(follow.id),
      name: (info && info.name) || follow.name || null,
      abbreviation: (info && info.abbreviation) || follow.abbreviation || null,
      logo: (info && info.logo) || follow.logo || null,
      color: (info && info.color) || null,
      record: (info && info.record) || null,
      rank: (info && info.rank) || null,
      standingSummary: (info && info.standingSummary) || null,
      url: `${baseUrl}/team.html?id=${encodeURIComponent(follow.id)}&source=espn&sport=${encodeURIComponent(follow.sport)}`,
      liveGame: slimGame(live),
      nextGame: slimGame(ahead[0]),
      lastGame: slimGame(past[past.length - 1]),
      upcoming: ahead.slice(0, upcoming).map(slimGame),
    };
  }));
}

module.exports = { loadSchedules, buildIcs, myTeamsSummary, foldLine, icsEscape };

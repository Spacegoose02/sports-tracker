// The slower-changing half of the game page: head-to-head history between
// the two teams and the kickoff weather forecast. Served from its own
// route (/api/game/:id/matchup) with long caches, so the game page's live
// polling of /api/game/:id stays one cheap ESPN call.
//
// Head-to-head: ESPN has no "series history" endpoint for football, so this
// reads the home team's schedule for the last HISTORY_SEASONS seasons and
// keeps the games against the opponent. Basketball, baseball and hockey
// summaries already carry this season's series (summary.seasonSeries).
//
// Weather: ESPN's summary sometimes includes it (summary.gameInfo.weather);
// otherwise, for an outdoor football or baseball game in the next two weeks,
// it's looked up from Open-Meteo (free, no key) by the venue's city.

const fetch = require('node-fetch');
const cache = require('./cache');
const espn = require('./espn');

const HISTORY_SEASONS = 12;
const HOUR = 60 * 60 * 1000;
const FORECAST_DAYS = 15;
const OUTDOOR_SPORTS = new Set(['cfb', 'nfl', 'mlb']);
const FOOTBALL = new Set(['cfb', 'nfl']);

// Stadiums with a fixed or retractable roof. Retractable roofs are often
// open, but the forecast is still shown with an "if the roof is open" note.
const ROOFED = [
  { test: /Superdome|Ford Field|U\.?S\.? Bank Stadium|Caesars Superdome|Allegiant Stadium|Lucas Oil Stadium|SoFi Stadium|Alamodome|Carrier Dome|JMA Wireless Dome|Kibbie Dome|ASUN Arena|Tropicana Field|Rogers Centre|Dome/i, roof: 'fixed' },
  { test: /AT&T Stadium|NRG Stadium|Mercedes-Benz Stadium|State Farm Stadium|Globe Life Field|Minute Maid Park|Daikin Park|Chase Field|T-Mobile Park|American Family Field|loanDepot park|LoanDepot Park/i, roof: 'retractable' },
];

function roofFor(venueName, indoorFlag) {
  if (indoorFlag === true) return 'fixed';
  const hit = venueName && ROOFED.find((r) => r.test.test(venueName));
  return hit ? hit.roof : null;
}

// Season a game belongs to: January/February games (bowls, NFL playoffs)
// count toward the previous year's season.
function seasonOf(dateIso) {
  const d = new Date(dateIso);
  if (Number.isNaN(d.getTime())) return new Date().getUTCFullYear();
  return d.getUTCMonth() < 2 ? d.getUTCFullYear() - 1 : d.getUTCFullYear();
}

function side(team) {
  return team ? {
    id: team.id ? String(team.id) : null,
    name: team.shortName || team.name,
    abbreviation: team.abbreviation,
    score: team.score,
    winner: !!team.winner,
  } : null;
}

// Pure: turns a list of finished meetings into a record and summary line.
function summarizeSeries(meetings, teamA, teamB, firstSeason) {
  const wins = { [teamA.id]: 0, [teamB.id]: 0 };
  let ties = 0;
  for (const g of meetings) {
    const winner = [g.home, g.away].find((s) => s && s.winner);
    if (winner && wins[winner.id] !== undefined) wins[winner.id] += 1;
    else ties += 1;
  }
  // Streak, newest first.
  let streak = null;
  for (const g of meetings) {
    const winner = [g.home, g.away].find((s) => s && s.winner);
    if (!winner) break;
    if (!streak) streak = { teamId: winner.id, count: 1 };
    else if (streak.teamId === winner.id) streak.count += 1;
    else break;
  }
  const nameOf = (id) => (String(id) === String(teamA.id) ? teamA.name : teamB.name);
  const a = wins[teamA.id];
  const b = wins[teamB.id];
  const tieText = ties ? `-${ties}` : '';
  let summary;
  if (!meetings.length) summary = `No meetings since ${firstSeason}`;
  else if (a === b) summary = `Series tied ${a}-${b}${tieText} since ${firstSeason}`;
  else summary = `${nameOf(a > b ? teamA.id : teamB.id)} leads ${Math.max(a, b)}-${Math.min(a, b)}${tieText} since ${firstSeason}`;
  return {
    wins,
    ties,
    summary,
    streak: streak && streak.count > 1 ? { ...streak, text: `${nameOf(streak.teamId)} has won ${streak.count} straight` } : null,
  };
}

async function headToHead(summary, sport) {
  const home = (summary.teams || []).find((t) => t.homeAway === 'home');
  const away = (summary.teams || []).find((t) => t.homeAway === 'away');
  if (!home || !away || !home.id || !away.id) return null;
  const season = seasonOf(summary.date);
  const firstSeason = season - HISTORY_SEASONS + 1;
  const key = `matchup:h2h:${sport}:${home.id}:${away.id}:${season}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  {
    const seasons = Array.from({ length: HISTORY_SEASONS }, (_, i) => season - i);
    const results = await Promise.allSettled(seasons.map((s) => espn.getTeamSchedule(home.id, s, sport)));
    const seen = new Set([String(summary.id)]);
    const meetings = [];
    for (const r of results) {
      if (r.status !== 'fulfilled') continue;
      for (const g of r.value.games || []) {
        if (!g || seen.has(String(g.id)) || !g.status || !g.status.completed) continue;
        const ids = [g.home && String(g.home.id), g.away && String(g.away.id)];
        if (!ids.includes(String(home.id)) || !ids.includes(String(away.id))) continue;
        seen.add(String(g.id));
        meetings.push({
          id: String(g.id),
          date: g.date,
          season: seasonOf(g.date),
          neutralSite: !!g.neutralSite,
          venue: g.venue || null,
          home: side(g.home),
          away: side(g.away),
        });
      }
    }
    meetings.sort((x, y) => new Date(y.date) - new Date(x.date));
    const failed = results.filter((r) => r.status === 'rejected').length;
    if (failed === results.length) throw new Error('Could not load the home team schedule');
    const value = {
      sinceSeason: firstSeason,
      complete: failed === 0,
      meetings,
      ...summarizeSeries(meetings, { id: String(home.id), name: home.shortName || home.name }, { id: String(away.id), name: away.shortName || away.name }, firstSeason),
    };
    // A partial history (some seasons failed) is retried sooner.
    cache.set(key, value, failed ? 10 * 60 * 1000 : 6 * HOUR);
    return value;
  }
}

const STATE_NAMES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware',
  DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
  KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
  MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey',
  NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon',
  PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah',
  VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};

// WMO weather codes used by Open-Meteo.
function weatherText(code) {
  const c = Number(code);
  if (c === 0) return 'Clear';
  if (c === 1) return 'Mostly clear';
  if (c === 2) return 'Partly cloudy';
  if (c === 3) return 'Overcast';
  if (c === 45 || c === 48) return 'Fog';
  if (c >= 51 && c <= 57) return 'Drizzle';
  if (c >= 61 && c <= 67) return 'Rain';
  if (c >= 71 && c <= 77) return 'Snow';
  if (c >= 80 && c <= 82) return 'Rain showers';
  if (c === 85 || c === 86) return 'Snow showers';
  if (c >= 95) return 'Thunderstorms';
  return null;
}

async function getJson(url) {
  const res = await fetch(url, { timeout: 8000 });
  if (!res.ok) throw new Error(`Weather request failed: ${res.status}`);
  return res.json();
}

async function geocode(city, state, country) {
  const key = `matchup:geo:${city}:${state || ''}:${country || ''}`;
  return cache.getOrFetch(key, async () => {
    const params = new URLSearchParams({ name: city, count: '10', language: 'en', format: 'json' });
    const isUs = !country || /^(USA|US|United States)/i.test(country);
    if (isUs) params.set('countryCode', 'US');
    const json = await getJson(`https://geocoding-api.open-meteo.com/v1/search?${params}`);
    const results = json.results || [];
    const stateName = state && (STATE_NAMES[String(state).toUpperCase()] || state);
    const hit = (stateName && results.find((r) => r.admin1 && r.admin1.toLowerCase() === String(stateName).toLowerCase())) || results[0];
    return hit ? { lat: hit.latitude, lon: hit.longitude } : null;
  }, 7 * 24 * HOUR);
}

// Pure: picks the forecast hour closest to kickoff.
function pickHour(hourly, kickoffIso) {
  if (!hourly || !Array.isArray(hourly.time) || !hourly.time.length) return null;
  const target = new Date(kickoffIso).getTime();
  let best = 0;
  let bestDiff = Infinity;
  hourly.time.forEach((t, i) => {
    const diff = Math.abs(new Date(`${t}Z`).getTime() - target);
    if (diff < bestDiff) { bestDiff = diff; best = i; }
  });
  if (bestDiff > 2 * HOUR) return null;
  const at = (k) => (hourly[k] ? hourly[k][best] : null);
  return {
    temperatureF: at('temperature_2m') !== null ? Math.round(at('temperature_2m')) : null,
    conditions: weatherText(at('weather_code')),
    precipitationChance: at('precipitation_probability'),
    windMph: at('wind_speed_10m') !== null ? Math.round(at('wind_speed_10m')) : null,
    source: 'Open-Meteo forecast',
  };
}

async function kickoffWeather(summary, sport) {
  const info = summary.gameInfo || {};
  const venue = info.venue || summary.venue || null;
  const roof = roofFor(venue, info.indoor);
  if (roof === 'fixed') return { indoor: true, venue };
  if (info.weather) return { ...info.weather, roof, venue };
  if (!OUTDOOR_SPORTS.has(sport)) return null;
  if (!summary.status || summary.status.state === 'post' || !summary.date || !info.city) return null;
  const kickoff = new Date(summary.date).getTime();
  const now = Date.now();
  if (kickoff - now > FORECAST_DAYS * 24 * HOUR) return { tooEarly: true, venue };
  const key = `matchup:wx:${summary.id}`;
  return cache.getOrFetch(key, async () => {
    const place = await geocode(info.city, info.state, info.country);
    if (!place) return null;
    const day = new Date(Math.max(kickoff, now)).toISOString().slice(0, 10);
    const params = new URLSearchParams({
      latitude: String(place.lat),
      longitude: String(place.lon),
      hourly: 'temperature_2m,precipitation_probability,wind_speed_10m,weather_code',
      temperature_unit: 'fahrenheit',
      wind_speed_unit: 'mph',
      timezone: 'UTC',
      start_date: day,
      end_date: new Date(new Date(day).getTime() + 24 * HOUR).toISOString().slice(0, 10),
    });
    const json = await getJson(`https://api.open-meteo.com/v1/forecast?${params}`);
    const hour = pickHour(json.hourly, summary.date);
    return hour ? { ...hour, roof, venue, place: [info.city, info.state].filter(Boolean).join(', ') } : null;
  }, 30 * 60 * 1000);
}

async function getMatchup(summary, sport) {
  const [h2h, weather] = await Promise.allSettled([
    FOOTBALL.has(sport) ? headToHead(summary, sport) : Promise.resolve(null),
    kickoffWeather(summary, sport),
  ]);
  return {
    headToHead: h2h.status === 'fulfilled' ? h2h.value : null,
    seasonSeries: summary.seasonSeries || null,
    weather: weather.status === 'fulfilled' ? weather.value : null,
  };
}

module.exports = { getMatchup, headToHead, kickoffWeather, summarizeSeries, pickHour, roofFor, seasonOf, weatherText };

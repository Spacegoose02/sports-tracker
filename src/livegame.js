// Live game extras for the game page: a drive tracker (football), a
// momentum series and the biggest win-probability swings. Built from the
// same ESPN summary JSON as src/gamedetail.js, so it costs no extra calls.
// ESPN doesn't document the summary, so every reader is defensive and
// returns [] or null when a field is missing.

const MOMENTUM_BUCKETS = 24;
const MAX_SWINGS = 3;

const num = (v) => {
  const n = Number(v);
  return v !== null && v !== undefined && v !== '' && Number.isFinite(n) ? n : null;
};
const idOf = (t) => (t && t.id !== undefined && t.id !== null ? String(t.id) : null);

// Every play in game order, from either shape: football groups plays into
// drives, other sports send one flat `plays` list.
function chronologicalPlays(json) {
  const drives = json.drives
    ? [...(json.drives.previous || []), ...(json.drives.current ? [json.drives.current] : [])]
    : null;
  if (drives) {
    const seen = new Set();
    const out = [];
    for (const d of drives) {
      for (const p of d.plays || []) {
        // ESPN repeats the current drive inside `previous` once it ends.
        const key = p.id || `${p.sequenceNumber}|${p.text}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ ...p, _teamId: idOf(p.start && p.start.team) || idOf(d.team) });
      }
    }
    return out;
  }
  return (Array.isArray(json.plays) ? json.plays : []).map((p) => ({ ...p, _teamId: idOf(p.team) }));
}

// "Own 25", "Opp 30" from yards to the end zone, which ESPN measures from
// the offense's point of view on every play.
function fieldSpot(yardsToEndzone) {
  const y = num(yardsToEndzone);
  if (y === null) return null;
  if (y === 50) return 'Midfield';
  return y > 50 ? `Own ${100 - y}` : `Opp ${y}`;
}

function driveResultKind(result) {
  const r = String(result || '').toLowerCase();
  if (/touchdown|^td$/.test(r)) return 'td';
  if (/field goal|^fg$/.test(r) && !/missed|blocked|no good/.test(r)) return 'fg';
  if (/punt/.test(r)) return 'punt';
  if (/interception|fumble|downs|^int$|turnover|blocked|missed|safety/.test(r)) return 'turnover';
  if (/end of (half|game|quarter)|half|end of/.test(r)) return 'end';
  return r ? 'other' : null;
}

// One row per drive for the drive tracker, oldest first. Field position is
// 0 (own goal line) to 100 (opponent's goal line) for the offense.
function parseDriveChart(json) {
  if (!json.drives) return [];
  const list = [...(json.drives.previous || [])];
  const cur = json.drives.current;
  if (cur && !list.some((d) => d && cur.id && d.id === cur.id)) list.push(cur);
  const currentId = cur && cur.id ? String(cur.id) : null;
  return list.filter(Boolean).map((d, i) => {
    const plays = (d.plays || []).filter((p) => p && p.text);
    const first = plays[0];
    const last = plays[plays.length - 1];
    const startYte = num(first && first.start && first.start.yardsToEndzone);
    const endYte = num(last && last.end && last.end.yardsToEndzone);
    const result = d.displayResult || d.result || d.shortDisplayResult || null;
    const isScore = !!d.isScore;
    let kind = driveResultKind(result);
    if (isScore && (!kind || kind === 'other')) kind = 'td';
    const live = currentId !== null && String(d.id) === currentId && !result;
    return {
      id: d.id ? String(d.id) : String(i),
      teamId: idOf(d.team),
      team: d.team ? (d.team.abbreviation || d.team.shortDisplayName || d.team.displayName || null) : null,
      period: num(d.start && d.start.period && d.start.period.number) ?? num(first && first.period && first.period.number),
      clock: (d.start && d.start.clock && d.start.clock.displayValue) || (first && first.clock && first.clock.displayValue) || null,
      result: live ? null : result,
      kind: live ? 'live' : kind,
      isScore,
      live,
      plays: num(d.offensivePlays) ?? plays.length,
      yards: num(d.yards),
      time: (d.timeElapsed && d.timeElapsed.displayValue) || null,
      description: d.description || null,
      start: startYte !== null ? 100 - startYte : null,
      end: endYte !== null ? 100 - endYte : null,
      startText: (d.start && d.start.text) || fieldSpot(startYte),
      endText: (d.end && d.end.text) || fieldSpot(endYte),
    };
  });
}

// Momentum: the game split into equal slices of plays, each bar the net
// swing toward the home (+) or away (-) team. Win probability when ESPN
// has it, otherwise points scored in the slice.
function parseMomentum(json, plays) {
  const wp = (Array.isArray(json.winprobability) ? json.winprobability : [])
    .map((p) => num(p && p.homeWinPercentage))
    .filter((p) => p !== null);
  const buckets = (series, n) => {
    const size = Math.max(1, Math.ceil((series.length - 1) / n));
    const out = [];
    for (let s = 0; s < series.length - 1; s += size) {
      const e = Math.min(series.length - 1, s + size);
      out.push({ from: s, to: e, value: series[e] - series[s] });
    }
    return out;
  };
  if (wp.length > 2) {
    return {
      basis: 'winProbability',
      bars: buckets(wp, MOMENTUM_BUCKETS).map((b) => ({ value: Math.round(b.value * 1000) / 1000 })),
    };
  }
  // Running margin (home minus away) after each play that has a score.
  const margins = [0];
  for (const p of plays) {
    const h = num(p.homeScore);
    const a = num(p.awayScore);
    if (h !== null && a !== null) margins.push(h - a);
  }
  if (margins.length < 3 || margins.every((m) => m === 0)) return null;
  return {
    basis: 'points',
    bars: buckets(margins, MOMENTUM_BUCKETS).map((b) => ({ value: b.value })),
  };
}

// The plays that moved win probability the most, matched to their text
// by play id. `delta` is from the home team's side (+ helps home).
function parseSwings(json, plays) {
  const wp = Array.isArray(json.winprobability) ? json.winprobability : [];
  if (wp.length < 2) return [];
  const byId = new Map(plays.filter((p) => p.id).map((p) => [String(p.id), p]));
  const swings = [];
  for (let i = 1; i < wp.length; i += 1) {
    const prev = num(wp[i - 1] && wp[i - 1].homeWinPercentage);
    const cur = num(wp[i] && wp[i].homeWinPercentage);
    const play = wp[i] && wp[i].playId ? byId.get(String(wp[i].playId)) : null;
    if (prev === null || cur === null || !play) continue;
    swings.push({
      delta: Math.round((cur - prev) * 1000) / 1000,
      text: play.text,
      period: num(play.period && play.period.number),
      clock: (play.clock && play.clock.displayValue) || null,
      teamId: play._teamId || null,
    });
  }
  return swings
    .filter((s) => Math.abs(s.delta) >= 0.05)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, MAX_SWINGS);
}

function parseLiveExtras(json) {
  json = json || {};
  const plays = chronologicalPlays(json);
  return {
    driveChart: parseDriveChart(json),
    momentum: parseMomentum(json, plays),
    wpSwings: parseSwings(json, plays),
  };
}

module.exports = { parseLiveExtras, parseDriveChart, parseMomentum, parseSwings, chronologicalPlays, driveResultKind, fieldSpot };

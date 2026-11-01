/*
 * Sports Tracker card for Home Assistant.
 *
 *   type: custom:sports-tracker-card
 *   entity: sensor.sports_tracker_virginia_tech_hokies
 *   visual: true        # field / court / diamond / rink / track / octagon
 *   linescore: true     # score by quarter, period or inning
 *   last_play: true
 *   celebrate: true     # confetti when your team scores
 *
 * Draws a sensor from the Sports Tracker integration. Plain JavaScript, no
 * build step: Home Assistant loads this file as-is.
 */

const CARD_VERSION = '1.0.0';

const esc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const color = (c, fallback) => (/^#[0-9a-fA-F]{6}$/.test(c || '') ? c : fallback);
const url = (u) => (/^https?:\/\//i.test(u || '') ? u : null);
const num = (v) => (typeof v === 'number' && !Number.isNaN(v) ? v : null);

// Light team colors (white, yellow) need dark text on top of them.
function inkOn(hex) {
  const c = color(hex, '#444444');
  const r = parseInt(c.slice(1, 3), 16);
  const g = parseInt(c.slice(3, 5), 16);
  const b = parseInt(c.slice(5, 7), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) > 170 ? '#111111' : '#ffffff';
}

// Two teams with near-identical colors get the opponent drawn in a
// neutral color instead, so the field ends and score bar stay readable.
function distinct(a, b) {
  const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [x, y] = [rgb(a), rgb(b)];
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]) > 90 ? b : '#5f6b7a';
}

const START_WORD = {
  cfb: 'Kickoff', nfl: 'Kickoff', nba: 'Tip-off', mcbb: 'Tip-off',
  mlb: 'First pitch', nhl: 'Puck drop', ufc: 'First fight', nascar: 'Green flag',
};

function relative(dateStr, lang) {
  const t = Date.parse(dateStr);
  if (Number.isNaN(t)) return '';
  const diff = t - Date.now();
  const rtf = new Intl.RelativeTimeFormat(lang || undefined, { numeric: 'auto' });
  const abs = Math.abs(diff);
  if (abs < 60 * 60 * 1000) return rtf.format(Math.round(diff / 60000), 'minute');
  if (abs < 36 * 60 * 60 * 1000) return rtf.format(Math.round(diff / 3600000), 'hour');
  return rtf.format(Math.round(diff / 86400000), 'day');
}

function dayAndTime(dateStr, lang) {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return { day: '', time: '' };
  const sameWeek = Math.abs(d - Date.now()) < 6 * 86400000;
  return {
    day: d.toLocaleDateString(lang || undefined, sameWeek ? { weekday: 'long' } : { weekday: 'short', month: 'short', day: 'numeric' }),
    time: d.toLocaleTimeString(lang || undefined, { hour: 'numeric', minute: '2-digit' }),
  };
}

// ---- Visuals -------------------------------------------------------------

// Football: 100-yard field plus end zones. 1 yard = 2 units, so the field
// runs x=20..220. The followed team defends the left goal.
function footballSvg(card, prev) {
  const team = card.team || {};
  const opp = card.opponent || {};
  const tc = color(team.color, '#1f6feb');
  const oc = distinct(tc, color(opp.color, '#d1242f'));
  const f = card.field || {};
  const live = card.state === 'IN';
  const X = (yd) => 20 + yd * 2;
  let lines = '';
  for (let yd = 5; yd < 100; yd += 5) {
    lines += `<line x1="${X(yd)}" y1="4" x2="${X(yd)}" y2="96" stroke="#fff" stroke-opacity="${yd % 10 ? 0.25 : 0.55}" stroke-width="${yd % 10 ? 0.5 : 0.8}"/>`;
    if (yd % 10 === 0) {
      const label = yd <= 50 ? yd : 100 - yd;
      lines += `<text x="${X(yd)}" y="16" class="yd">${label}</text><text x="${X(yd)}" y="91" class="yd">${label}</text>`;
    }
  }
  for (let yd = 1; yd < 100; yd += 1) {
    if (yd % 5) lines += `<line x1="${X(yd)}" y1="38" x2="${X(yd)}" y2="40" stroke="#fff" stroke-opacity=".35" stroke-width=".4"/><line x1="${X(yd)}" y1="60" x2="${X(yd)}" y2="62" stroke="#fff" stroke-opacity=".35" stroke-width=".4"/>`;
  }
  const ezText = (x, t, c, rot) => `<text x="${x}" y="50" class="ez" fill="${inkOn(c)}" transform="rotate(${rot} ${x} 50)">${esc(t || '')}</text>`;
  let marks = '';
  const ball = live ? num(f.ball) : null;
  if (ball !== null) {
    const bx = X(Math.max(0, Math.min(100, ball)));
    const fromX = prev && num(prev.ballX) !== null ? prev.ballX - bx : 0;
    const fd = num(f.firstDown);
    const rz = f.isRedZone
      ? (f.possession === 'team'
        ? `<rect x="${X(80)}" y="4" width="40" height="92" class="redzone"/>`
        : `<rect x="${X(0)}" y="4" width="40" height="92" class="redzone"/>`)
      : '';
    const dir = f.possession === 'opponent' ? -1 : 1;
    const holder = f.possession === 'opponent' ? oc : tc;
    marks = `${rz}
      ${fd !== null ? `<line x1="${X(fd)}" y1="4" x2="${X(fd)}" y2="96" class="firstdown"/>` : ''}
      <line x1="${bx}" y1="4" x2="${bx}" y2="96" class="scrimmage"/>
      <g class="ball" style="--from:${fromX}px">
        <g transform="translate(${bx} 50)">
          <polygon points="${dir * 9},-6 ${dir * 15},0 ${dir * 9},6" fill="${holder}" stroke="#fff" stroke-width=".8"/>
          <ellipse rx="6.5" ry="4" fill="#8b4513" stroke="#3b1d08" stroke-width=".6"/>
          <line x1="-2.5" y1="0" x2="2.5" y2="0" stroke="#fff" stroke-width=".7"/>
          <line x1="-1.2" y1="-1" x2="-1.2" y2="1" stroke="#fff" stroke-width=".5"/>
          <line x1="0" y1="-1" x2="0" y2="1" stroke="#fff" stroke-width=".5"/>
          <line x1="1.2" y1="-1" x2="1.2" y2="1" stroke="#fff" stroke-width=".5"/>
        </g>
      </g>`;
  }
  const svg = `<svg viewBox="0 0 240 100" class="visual" role="img" aria-label="Football field">
    <rect x="0" y="0" width="240" height="100" rx="4" fill="#2e7d32"/>
    ${Array.from({ length: 10 }, (_, i) => `<rect x="${X(i * 10)}" y="4" width="20" height="92" fill="#000" fill-opacity="${i % 2 ? 0.06 : 0}"/>`).join('')}
    <rect x="0" y="4" width="20" height="92" fill="${tc}"/>
    <rect x="220" y="4" width="20" height="92" fill="${oc}"/>
    ${ezText(10, team.abbreviation || team.shortName, tc, -90)}
    ${ezText(230, opp.abbreviation || opp.shortName, oc, 90)}
    <rect x="0" y="4" width="240" height="92" fill="none" stroke="#fff" stroke-width="1"/>
    <line x1="20" y1="4" x2="20" y2="96" stroke="#fff" stroke-width="1"/>
    <line x1="220" y1="4" x2="220" y2="96" stroke="#fff" stroke-width="1"/>
    ${lines}
    ${marks}
  </svg>`;
  let caption = '';
  if (live && f.possession) {
    const who = f.possession === 'team' ? team : opp;
    const spot = f.possessionText ? ` at ${esc(f.possessionText)}` : '';
    caption = `<div class="caption"><span class="dot" style="background:${f.possession === 'team' ? tc : oc}"></span><b>${esc(who.abbreviation || who.shortName || '')}</b> ball${f.downDistance ? ` &middot; ${esc(f.downDistance)}` : ''}${spot}${f.isRedZone ? ' <span class="rz">RED ZONE</span>' : ''}</div>`;
  }
  const timeouts = live && (num(f.teamTimeouts) !== null || num(f.opponentTimeouts) !== null)
    ? `<div class="timeouts"><span>${'<i></i>'.repeat(Math.max(0, Math.min(3, f.teamTimeouts || 0)))}</span><small>timeouts</small><span>${'<i></i>'.repeat(Math.max(0, Math.min(3, f.opponentTimeouts || 0)))}</span></div>`
    : '';
  return { html: svg + caption + timeouts, state: { ballX: ball !== null ? X(Math.max(0, Math.min(100, ball))) : null } };
}

function baseballSvg(card) {
  const b = card.bases || {};
  const live = card.state === 'IN';
  const base = (x, y, on) => `<rect x="${x - 7}" y="${y - 7}" width="14" height="14" transform="rotate(45 ${x} ${y})" class="base ${on ? 'on' : ''}"/>`;
  const dots = (n, max, cls) => Array.from({ length: max }, (_, i) => `<i class="${i < n ? cls : ''}"></i>`).join('');
  const svg = `<svg viewBox="0 0 240 130" class="visual" role="img" aria-label="Baseball diamond">
    <rect width="240" height="130" rx="4" fill="#2e7d32"/>
    <path d="M120 122 L30 40 A110 110 0 0 1 210 40 Z" fill="#388e3c"/>
    <polygon points="120,118 165,73 120,28 75,73" fill="#b5835a"/>
    <polygon points="120,106 153,73 120,40 87,73" fill="#43a047"/>
    <circle cx="120" cy="74" r="6" fill="#b5835a"/>
    <line x1="120" y1="118" x2="30" y2="28" stroke="#fff" stroke-opacity=".6"/>
    <line x1="120" y1="118" x2="210" y2="28" stroke="#fff" stroke-opacity=".6"/>
    ${base(165, 73, live && b.onFirst)}${base(120, 28, live && b.onSecond)}${base(75, 73, live && b.onThird)}
    <polygon points="114,114 126,114 126,119 120,124 114,119" fill="#fff"/>
  </svg>`;
  const count = live && b
    ? `<div class="count"><span>B ${dots(b.balls || 0, 3, 'ball')}</span><span>S ${dots(b.strikes || 0, 2, 'strike')}</span><span>O ${dots(b.outs || 0, 2, 'out')}</span></div>`
    : '';
  return { html: svg + count, state: {} };
}

function basketballSvg(card) {
  const tc = color((card.team || {}).color, '#1f6feb');
  const oc = distinct(tc, color((card.opponent || {}).color, '#d1242f'));
  const live = card.state === 'IN';
  const half = (x0, dir, c) => {
    const hoop = x0 + dir * 12;
    const keyX = dir > 0 ? x0 : x0 - 48;
    return `<rect x="${keyX}" y="38" width="48" height="34" fill="${c}" fill-opacity=".85" stroke="#fff" stroke-width=".8"/>
      <circle cx="${x0 + dir * 48}" cy="55" r="12" fill="none" stroke="#fff" stroke-width=".8"/>
      <path d="M${x0} 9 L${x0 + dir * 30} 9 A50 50 0 0 ${dir > 0 ? 1 : 0} ${x0 + dir * 30} 101 L${x0} 101" fill="none" stroke="#fff" stroke-width=".8"/>
      <line x1="${x0 + dir * 8}" y1="47" x2="${x0 + dir * 8}" y2="63" stroke="#fff" stroke-width="1.5"/>
      <circle cx="${hoop}" cy="55" r="3" fill="none" stroke="#ff7043" stroke-width="1.2"/>`;
  };
  const svg = `<svg viewBox="0 0 240 110" class="visual" role="img" aria-label="Basketball court">
    <rect width="240" height="110" rx="4" fill="#d7a26a"/>
    ${Array.from({ length: 12 }, (_, i) => `<line x1="0" y1="${5 + i * 9}" x2="240" y2="${5 + i * 9}" stroke="#a86b32" stroke-opacity=".25"/>`).join('')}
    <rect x="4" y="5" width="232" height="100" fill="none" stroke="#fff" stroke-width="1"/>
    <line x1="120" y1="5" x2="120" y2="105" stroke="#fff" stroke-width="1"/>
    <circle cx="120" cy="55" r="12" fill="${tc}" fill-opacity=".5" stroke="#fff" stroke-width=".8"/>
    ${half(4, 1, tc)}${half(236, -1, oc)}
    ${live ? '<g class="bounce"><circle cx="120" cy="55" r="5" fill="#e65100" stroke="#3e2723" stroke-width=".6"/><path d="M115 55 H125 M120 50 V60" stroke="#3e2723" stroke-width=".5"/></g>' : ''}
  </svg>`;
  return { html: svg, state: {} };
}

function hockeySvg(card) {
  const tc = color((card.team || {}).color, '#1f6feb');
  const oc = distinct(tc, color((card.opponent || {}).color, '#d1242f'));
  const live = card.state === 'IN';
  const faceoff = (x, y) => `<circle cx="${x}" cy="${y}" r="13" fill="none" stroke="#d32f2f" stroke-width=".7"/><circle cx="${x}" cy="${y}" r="1.5" fill="#d32f2f"/>`;
  const svg = `<svg viewBox="0 0 240 110" class="visual" role="img" aria-label="Hockey rink">
    <rect x="3" y="3" width="234" height="104" rx="30" fill="#eef6fb" stroke="#90a4ae" stroke-width="2"/>
    <line x1="18" y1="7" x2="18" y2="103" stroke="#d32f2f" stroke-width=".8"/>
    <line x1="222" y1="7" x2="222" y2="103" stroke="#d32f2f" stroke-width=".8"/>
    <line x1="82" y1="4" x2="82" y2="106" stroke="${tc}" stroke-width="3"/>
    <line x1="158" y1="4" x2="158" y2="106" stroke="${oc}" stroke-width="3"/>
    <line x1="120" y1="4" x2="120" y2="106" stroke="#d32f2f" stroke-width="3" stroke-dasharray="6 2"/>
    <circle cx="120" cy="55" r="14" fill="none" stroke="#1565c0" stroke-width=".8"/>
    ${faceoff(45, 30)}${faceoff(45, 80)}${faceoff(195, 30)}${faceoff(195, 80)}
    <path d="M18 49 A6 6 0 0 1 18 61 Z" fill="#81d4fa"/><path d="M222 49 A6 6 0 0 0 222 61 Z" fill="#81d4fa"/>
    <rect x="12" y="51" width="6" height="8" fill="none" stroke="${tc}" stroke-width="1.2"/>
    <rect x="222" y="51" width="6" height="8" fill="none" stroke="${oc}" stroke-width="1.2"/>
    ${live ? '<g class="puck"><ellipse cx="120" cy="55" rx="3.2" ry="2.4" fill="#111"/></g>' : ''}
  </svg>`;
  return { html: svg, state: {} };
}

// NASCAR: a closed path per track shape, cars riding it with animateMotion.
const TRACKS = {
  // Drawn counterclockwise (cars turn left), except road courses.
  oval: 'M70 135 H230 A52 52 0 0 0 230 31 H70 A52 52 0 0 0 70 135 Z',
  trioval: 'M75 130 Q150 152 225 130 A51 51 0 0 0 225 28 H75 A51 51 0 0 0 75 130 Z',
  triangle: 'M60 134 H240 Q264 134 250 114 L166 26 Q150 10 134 26 L50 114 Q36 134 60 134 Z',
  paperclip: 'M60 125 H240 A42 42 0 0 0 240 41 H60 A42 42 0 0 0 60 125 Z',
  short: 'M100 135 H200 A52 52 0 0 0 200 31 H100 A52 52 0 0 0 100 135 Z',
  road: 'M40 120 L40 70 Q40 40 70 40 L120 40 Q140 40 145 60 Q150 80 170 80 L210 80 Q230 80 235 60 L240 40 Q262 40 262 70 L262 110 Q262 132 238 132 L170 132 Q150 132 140 120 Q130 108 110 112 L60 130 Q40 136 40 120 Z',
};
function trackShape(venue) {
  const v = String(venue || '').toLowerCase();
  if (/pocono/.test(v)) return 'triangle';
  if (/martinsville/.test(v)) return 'paperclip';
  if (/glen|sonoma|americas|cota|road america|roval|street|mexico|autódromo|autodromo|road course|circuit/.test(v)) return 'road';
  if (/bristol|richmond|dover|wilkesboro|iowa|new hampshire|loudon|phoenix|gateway|world wide|nashville|darlington|bowman/.test(v)) return 'short';
  if (/daytona|talladega|atlanta|kansas|las vegas|texas|charlotte|homestead|michigan|fontana|auto club/.test(v)) return 'trioval';
  return 'oval';
}
const CAR_COLORS = ['#ffd600', '#e53935', '#1e88e5', '#43a047', '#fb8c00', '#8e24aa', '#00acc1', '#f06292', '#c0ca33', '#ffffff'];

function nascarSvg(card) {
  const race = card.race || {};
  const live = card.state === 'IN';
  const done = card.state === 'POST';
  const shape = trackShape((card.event || {}).venue);
  const d = TRACKS[shape];
  const leaders = (race.leaders || []).slice(0, 10);
  const lap = num(race.lap);
  const total = num(race.totalLaps);
  const dur = 8;
  // Keep cars where they were across re-renders: start the animation at
  // the phase the wall clock says it should be at.
  const phase = (Date.now() / 1000) % dur;
  const cars = live
    ? leaders.slice().reverse().map((r, idx) => {
      const i = leaders.length - 1 - idx;
      const c = CAR_COLORS[i % CAR_COLORS.length];
      const begin = -(phase + (leaders.length - i) * 0.32);
      return `<g><circle r="7" fill="${c}" stroke="#111" stroke-width="1"/><text class="carnum" fill="${inkOn(c)}">${esc(r.number || r.place || '')}</text>
        <animateMotion dur="${dur}s" begin="${begin.toFixed(2)}s" repeatCount="indefinite" rotate="0"><mpath href="#track"/></animateMotion></g>`;
    }).join('')
    : '';
  const center = live
    ? `<text x="150" y="76" class="lap">${lap !== null ? `LAP ${lap}` : 'RACING'}</text>${total ? `<text x="150" y="94" class="laps">of ${total}</text>` : ''}`
    : done && leaders[0]
      ? `<text x="150" y="76" class="lap">🏁 #${esc(leaders[0].number || '')}</text><text x="150" y="94" class="laps">${esc(leaders[0].shortName || leaders[0].name || '')} wins!</text>`
      : `<text x="150" y="84" class="laps">${esc((card.event || {}).venue || '')}</text>`;
  const progress = live && lap !== null && total
    ? `<div class="bar"><div style="width:${Math.min(100, (lap / total) * 100).toFixed(1)}%"></div></div>`
    : '';
  const svg = `<svg viewBox="0 0 300 160" class="visual track" role="img" aria-label="Race track">
    <rect width="300" height="160" rx="6" fill="#33691e"/>
    <path id="track" d="${d}" fill="none" stroke="#424242" stroke-width="20" stroke-linejoin="round"/>
    <path d="${d}" fill="none" stroke="#fff" stroke-opacity=".5" stroke-width="1" stroke-dasharray="4 6"/>
    <path d="${d}" fill="none" stroke="#e0e0e0" stroke-width="22" stroke-opacity=".15"/>
    ${center}
    ${cars}
  </svg>`;
  const board = leaders.length
    ? `<ol class="leaders">${leaders.slice(0, 5).map((r, i) => `<li><span class="pos" style="background:${CAR_COLORS[i]};color:${inkOn(CAR_COLORS[i])}">${esc(r.place || i + 1)}</span><span class="carno">#${esc(r.number || '')}</span> ${esc(r.name || '')}</li>`).join('')}</ol>`
    : '';
  return { html: svg + progress + board, state: {} };
}

function ufcSvg(card) {
  const c = (card.card || {}).current;
  if (!c) return { html: '', state: {} };
  const [a, b] = c.fighters || [];
  const live = c.state === 'IN';
  const round = num(c.round);
  const rounds = Math.max(3, round || 0) > 3 ? 5 : 3;
  const pts = Array.from({ length: 8 }, (_, i) => {
    const ang = (Math.PI / 8) + (i * Math.PI) / 4;
    return `${(150 + 58 * Math.cos(ang)).toFixed(1)},${(72 + 58 * Math.sin(ang)).toFixed(1)}`;
  }).join(' ');
  const fname = (f) => String((f && (f.shortName || f.name)) || 'TBA');
  // Long names are squeezed to fit beside the cage.
  const label = (f, x, cls) => {
    const n = fname(f);
    return `<text x="${x}" y="70" class="fighter ${cls}"${n.length > 14 ? ' textLength="86" lengthAdjust="spacingAndGlyphs"' : ''}>${esc(n)}</text>`;
  };
  const svg = `<svg viewBox="0 0 300 160" class="visual" role="img" aria-label="Octagon">
    <rect width="300" height="160" rx="6" fill="#111"/>
    <polygon points="${pts}" fill="#1c1c1c" stroke="#9e9e9e" stroke-width="3"/>
    <circle cx="150" cy="72" r="22" fill="#b71c1c" fill-opacity=".85"/>
    <text x="150" y="77" class="ufc">UFC</text>
    ${label(a, 48, 'red')}${label(b, 252, 'blue')}
    <text x="48" y="86" class="frec">${esc((a && a.record) || '')}</text>
    <text x="252" y="86" class="frec">${esc((b && b.record) || '')}</text>
    ${live ? `<text x="150" y="152" class="round">ROUND ${round || ''}${c.clock ? ` · ${esc(c.clock)}` : ''}</text>` : ''}
    ${live ? Array.from({ length: rounds }, (_, i) => `<circle cx="${150 - (rounds - 1) * 7 + i * 14}" cy="138" r="4" fill="${i < (round || 0) ? '#ffd600' : '#555'}"/>`).join('') : ''}
  </svg>`;
  const bouts = ((card.card || {}).bouts || []).slice(0, 6).map((bout) => {
    const [x, y] = bout.fighters || [];
    const fn = (f) => (f ? `<span class="${f.winner ? 'won' : ''}">${esc(f.shortName || f.name || '')}</span>` : '<span>TBA</span>');
    const tag = bout.state === 'IN' ? '<em class="live">LIVE</em>' : bout.result ? `<em>${esc(bout.result)}</em>` : `<em>${esc(bout.weightClass || '')}</em>`;
    return `<li>${fn(x)} <small>vs</small> ${fn(y)} ${tag}</li>`;
  }).join('');
  return { html: svg + (bouts ? `<ul class="bouts">${bouts}</ul>` : ''), state: {} };
}

const VISUALS = {
  cfb: footballSvg, nfl: footballSvg,
  nba: basketballSvg, mcbb: basketballSvg,
  mlb: baseballSvg, nhl: hockeySvg,
  nascar: nascarSvg, ufc: ufcSvg,
};

// ---- Card ----------------------------------------------------------------

const STYLE = `
  :host { display: block; }
  ha-card { position: relative; overflow: hidden; padding: 16px; color: var(--primary-text-color); }
  .bg { position: absolute; top: -20px; width: 55%; opacity: .07; pointer-events: none; }
  .bg.l { left: -12%; } .bg.r { right: -12%; }
  .top { position: relative; display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 8px; }
  .side { display: flex; flex-direction: column; align-items: center; text-align: center; min-width: 0; }
  .side img { width: 64px; height: 64px; object-fit: contain; }
  .side .ph { width: 64px; height: 64px; border-radius: 50%; display: grid; place-items: center; font-weight: 700; }
  .side .nm { font-size: 1.15em; margin-top: 4px; line-height: 1.2; overflow-wrap: anywhere; }
  .side .rk { font-size: .75em; color: var(--secondary-text-color); margin-right: 3px; }
  .side .rec { font-size: .8em; color: var(--secondary-text-color); }
  .side.lost { opacity: .55; }
  .mid { text-align: center; }
  .score { font-size: 2.6em; font-weight: 300; letter-spacing: .02em; white-space: nowrap; }
  .score b { font-weight: 600; }
  .when .d { font-size: 1.2em; } .when .t { color: var(--secondary-text-color); margin-top: 4px; }
  .status { margin-top: 4px; font-size: 1.05em; }
  .live { color: #e53935; font-weight: 700; font-style: normal; font-size: .75em; letter-spacing: .08em; }
  .live::before { content: ''; display: inline-block; width: 8px; height: 8px; margin-right: 4px; border-radius: 50%; background: #e53935; animation: blink 1.2s infinite; }
  .title { text-align: center; font-weight: 600; font-size: 1.1em; position: relative; }
  .sub { text-align: center; color: var(--secondary-text-color); position: relative; }
  hr { border: 0; border-top: 1px solid var(--divider-color, rgba(255,255,255,.2)); margin: 12px 0; }
  .info { display: flex; justify-content: space-between; gap: 8px; font-size: .9em; position: relative; }
  .info .big { font-weight: 600; font-size: 1.05em; }
  .info .muted { color: var(--secondary-text-color); }
  .info .right { text-align: right; align-self: flex-end; }
  .visual { width: 100%; display: block; margin-top: 12px; border-radius: 6px; }
  .yd { fill: #fff; fill-opacity: .7; font: 600 7px sans-serif; text-anchor: middle; }
  .ez { font: 700 9px sans-serif; text-anchor: middle; dominant-baseline: middle; letter-spacing: 1px; }
  .firstdown { stroke: #ffd600; stroke-width: 1.4; }
  .scrimmage { stroke: #42a5f5; stroke-width: 1.2; }
  .redzone { fill: #e53935; animation: pulse 1.6s ease-in-out infinite; }
  .ball { animation: slide 1.4s ease-out both; }
  .caption { margin-top: 8px; text-align: center; }
  .caption .dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 6px; vertical-align: middle; }
  .rz { color: #e53935; font-weight: 700; font-size: .8em; margin-left: 4px; }
  .timeouts { display: flex; justify-content: space-between; align-items: center; margin-top: 6px; font-size: .75em; color: var(--secondary-text-color); }
  .timeouts i { display: inline-block; width: 14px; height: 4px; border-radius: 2px; background: #ffd600; margin-right: 3px; }
  .base { fill: #fff; fill-opacity: .35; stroke: #fff; stroke-width: 1; }
  .base.on { fill: #ffd600; fill-opacity: 1; animation: glow 1.4s ease-in-out infinite; }
  .count { display: flex; justify-content: center; gap: 18px; margin-top: 8px; font-weight: 600; }
  .count i { display: inline-block; width: 11px; height: 11px; border-radius: 50%; border: 1.5px solid var(--secondary-text-color); margin-left: 3px; vertical-align: -1px; }
  .count i.ball { background: #43a047; border-color: #43a047; } .count i.strike { background: #fb8c00; border-color: #fb8c00; } .count i.out { background: #e53935; border-color: #e53935; }
  .bounce { animation: bounce .7s ease-in infinite alternate; transform-origin: 120px 55px; }
  .puck { animation: puck 5s ease-in-out infinite; }
  .carnum { font: 700 7px sans-serif; text-anchor: middle; dominant-baseline: central; }
  .lap { fill: #fff; font: 800 18px sans-serif; text-anchor: middle; }
  .laps { fill: #fff; fill-opacity: .8; font: 600 11px sans-serif; text-anchor: middle; }
  .bar { height: 6px; border-radius: 3px; background: var(--divider-color, rgba(255,255,255,.2)); margin-top: 8px; overflow: hidden; }
  .bar div { height: 100%; background: linear-gradient(90deg, #ffd600, #e53935); }
  .leaders { list-style: none; padding: 0; margin: 10px 0 0; font-size: .92em; }
  .leaders li { display: flex; align-items: center; gap: 8px; padding: 2px 0; }
  .leaders .pos { display: inline-grid; place-items: center; width: 20px; height: 20px; border-radius: 4px; font-weight: 700; font-size: .85em; }
  .leaders .carno { color: var(--secondary-text-color); min-width: 30px; }
  .ufc { fill: #fff; font: 900 14px sans-serif; text-anchor: middle; }
  .fighter { font: 700 11px sans-serif; text-anchor: middle; } .fighter.red { fill: #ef5350; } .fighter.blue { fill: #42a5f5; }
  .frec { fill: #bdbdbd; font: 10px sans-serif; text-anchor: middle; }
  .round { fill: #ffd600; font: 700 12px sans-serif; text-anchor: middle; }
  .bouts { list-style: none; padding: 0; margin: 10px 0 0; font-size: .88em; }
  .bouts li { padding: 3px 0; border-bottom: 1px solid var(--divider-color, rgba(255,255,255,.1)); }
  .bouts em { float: right; font-style: normal; color: var(--secondary-text-color); font-size: .9em; }
  .bouts .won { font-weight: 700; }
  .stat { margin-top: 12px; position: relative; }
  .stat .lbl { text-align: center; font-size: .85em; }
  .stat .row { display: grid; grid-template-columns: auto 1fr auto; gap: 10px; align-items: center; margin-top: 4px; font-size: .9em; }
  .stat .track { display: flex; height: 8px; border-radius: 4px; overflow: hidden; background: var(--divider-color, rgba(255,255,255,.2)); }
  .lines { width: 100%; border-collapse: collapse; margin-top: 12px; font-size: .85em; position: relative; }
  .lines th, .lines td { text-align: center; padding: 2px 4px; }
  .lines th { color: var(--secondary-text-color); font-weight: 500; }
  .lines td:first-child, .lines th:first-child { text-align: left; }
  .lines td:last-child { font-weight: 700; }
  .play { margin-top: 10px; font-size: .88em; color: var(--secondary-text-color); position: relative; }
  .play b { color: var(--primary-text-color); }
  .party { position: absolute; inset: 0; pointer-events: none; overflow: hidden; z-index: 5; }
  .party .msg { position: absolute; left: 50%; top: 40%; transform: translate(-50%, -50%); font: 900 2.2em sans-serif; white-space: nowrap; color: #fff; -webkit-text-stroke: 1.5px var(--team); text-shadow: 0 0 12px var(--team), 0 3px 10px rgba(0,0,0,.8); animation: pop 3.2s ease-out forwards; }
  .party i { position: absolute; top: -12px; width: 8px; height: 12px; border-radius: 2px; animation: fall 3s ease-in forwards; }
  .err { color: var(--error-color, #e53935); }
  @keyframes slide { from { transform: translateX(var(--from)); } to { transform: translateX(0); } }
  @keyframes pulse { 0%, 100% { fill-opacity: .12; } 50% { fill-opacity: .32; } }
  @keyframes glow { 0%, 100% { filter: none; } 50% { filter: drop-shadow(0 0 4px #ffd600); } }
  @keyframes blink { 50% { opacity: .2; } }
  @keyframes bounce { from { transform: translateY(-14px); } to { transform: translateY(6px) scale(1.05, .9); } }
  @keyframes puck { 0%, 100% { transform: translate(0, 0); } 25% { transform: translate(-60px, -25px); } 50% { transform: translate(40px, 20px); } 75% { transform: translate(70px, -15px); } }
  @keyframes pop { 0% { transform: translate(-50%, -50%) scale(.2); opacity: 0; } 15% { transform: translate(-50%, -50%) scale(1.15); opacity: 1; } 25% { transform: translate(-50%, -50%) scale(1); } 80% { opacity: 1; } 100% { opacity: 0; } }
  @keyframes fall { to { transform: translateY(520px) rotate(720deg); opacity: .2; } }
  @media (prefers-reduced-motion: reduce) { .ball, .bounce, .puck, .redzone, .base.on, .party i { animation: none; } }
`;

const CELEBRATE = {
  cfb: (p) => (p >= 6 ? 'TOUCHDOWN!' : p === 3 ? 'FIELD GOAL!' : p === 2 ? 'SAFETY!' : null),
  nfl: (p) => (p >= 6 ? 'TOUCHDOWN!' : p === 3 ? 'FIELD GOAL!' : p === 2 ? 'SAFETY!' : null),
  nhl: () => 'GOAL!',
  mlb: (p) => (p > 1 ? `${p} RUNS SCORE!` : 'RUN SCORES!'),
  nba: (p) => (p === 3 ? 'FROM DOWNTOWN!' : null),
  mcbb: (p) => (p === 3 ? 'FROM DOWNTOWN!' : null),
};

class SportsTrackerCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._prev = {};
  }

  static getStubConfig(hass) {
    const entity = Object.keys((hass && hass.states) || {}).find((id) => id.startsWith('sensor.') && hass.states[id].attributes && hass.states[id].attributes.kind && hass.states[id].attributes.sport);
    return { entity: entity || '' };
  }

  // The visual editor (Home Assistant 2024.11+ builds it from this schema).
  static getConfigForm() {
    return {
      schema: [
        { name: 'entity', required: true, selector: { entity: { domain: 'sensor', integration: 'sports_tracker' } } },
        { name: 'visual', selector: { boolean: {} } },
        { name: 'linescore', selector: { boolean: {} } },
        { name: 'last_play', selector: { boolean: {} } },
        { name: 'celebrate', selector: { boolean: {} } },
      ],
      computeLabel: (s) => ({
        entity: 'Team or event', visual: 'Show field, court or track', linescore: 'Show score by period',
        last_play: 'Show last play', celebrate: 'Celebrate when my team scores',
      }[s.name]),
    };
  }

  setConfig(config) {
    if (!config || !config.entity) throw new Error('Pick a Sports Tracker sensor (entity).');
    this._config = { visual: true, linescore: true, last_play: true, celebrate: true, ...config };
    this._stateObj = undefined;
    if (this._hass) this.hass = this._hass;
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._config) return;
    const st = hass.states[this._config.entity];
    if (st === this._stateObj) return; // nothing changed for this entity
    this._stateObj = st;
    this._render(st);
  }

  getCardSize() { return 6; }

  getGridOptions() { return { columns: 12, min_columns: 6, rows: 'auto' }; }

  _render(st) {
    const lang = this._hass && this._hass.language;
    if (!st) {
      this.shadowRoot.innerHTML = `<style>${STYLE}</style><ha-card><div class="err">Entity not found: ${esc(this._config.entity)}</div></ha-card>`;
      return;
    }
    const a = st.attributes || {};
    const card = {
      kind: a.kind, sport: a.sport, league: a.league, sportLabel: a.sport_label,
      state: st.state, team: a.team, opponent: a.opponent, event: a.event || {}, field: a.field,
      bases: a.bases, stat: a.stat, race: a.race, card: a.card, odds: a.odds, nextGame: a.next_game, lastPlay: a.last_play,
    };
    if (st.state === 'unavailable' || st.state === 'unknown' || !card.kind) {
      this.shadowRoot.innerHTML = `<style>${STYLE}</style><ha-card><div class="title">${esc(a.friendly_name || this._config.entity)}</div><div class="sub">Waiting for the Sports Tracker…</div></ha-card>`;
      return;
    }
    const body = card.kind === 'game' ? this._game(card, lang) : this._event(card, lang);
    const visual = this._config.visual && VISUALS[card.sport] ? VISUALS[card.sport](card, this._prev) : { html: '', state: {} };
    const party = this._party(card);
    this.shadowRoot.innerHTML = `<style>${STYLE}</style><ha-card>${body.top}${visual.html}${body.bottom}${party}</ha-card>`;
    this._prev = { ...visual.state, eventId: card.event.id, teamScore: card.team && card.team.score };
  }

  _side(t, lostish) {
    if (!t) return '<div class="side"></div>';
    const logo = url(t.logo);
    const c = color(t.color, '#555555');
    const img = logo
      ? `<img src="${esc(logo)}" alt="" loading="lazy">`
      : `<div class="ph" style="background:${c};color:${inkOn(c)}">${esc((t.abbreviation || t.shortName || '?').slice(0, 4))}</div>`;
    const rank = t.rank ? `<span class="rk">#${esc(t.rank)}</span>` : '';
    return `<div class="side ${lostish ? 'lost' : ''}">${img}<div class="nm">${rank}${esc(t.shortName || t.name || '')}</div>${t.record ? `<div class="rec">${esc(t.record)}</div>` : ''}</div>`;
  }

  _game(card, lang) {
    const { team, opponent, event } = card;
    const live = card.state === 'IN';
    const post = card.state === 'POST';
    const bg = [team, opponent].map((t, i) => (t && url(t.logo) ? `<img class="bg ${i ? 'r' : 'l'}" src="${esc(url(t.logo))}" alt="">` : '')).join('');
    let mid;
    if (card.state === 'PRE' || card.state === 'NOT_FOUND' || !opponent) {
      const when = event.date ? dayAndTime(event.date, lang) : { day: card.state === 'NOT_FOUND' ? 'No games scheduled' : '', time: '' };
      mid = `<div class="when"><div class="d">${esc(when.day)}</div><div class="t">${esc(when.time)}</div></div>`;
    } else {
      const ts = team && team.score != null ? team.score : '-';
      const os = opponent && opponent.score != null ? opponent.score : '-';
      const status = live
        ? `<div class="status">${esc(event.clock && card.sport !== 'mlb' ? `${event.clock} - ` : '')}${esc(card.sport === 'mlb' ? (event.shortDetail || '') : (event.periodLabel || event.shortDetail || ''))}</div><em class="live">LIVE</em>`
        : `<div class="status">${esc(event.shortDetail || 'Final')}</div>`;
      mid = `<div class="score">${team && team.winner ? `<b>${esc(ts)}</b>` : esc(ts)}&nbsp;&nbsp;${opponent && opponent.winner ? `<b>${esc(os)}</b>` : esc(os)}</div>${status}`;
    }
    const top = `${bg}<div class="top">${this._side(team, post && opponent && opponent.winner)}<div class="mid">${mid}</div>${this._side(opponent, post && team && team.winner)}</div>`;

    let info = '';
    if (card.state === 'PRE' && event.date) {
      const word = START_WORD[card.sport] || 'Starts';
      const odds = card.odds && card.odds.details ? ` · ${esc(card.odds.details)}${card.odds.overUnder != null ? ` O/U ${esc(card.odds.overUnder)}` : ''}` : '';
      info = `<hr><div class="info"><div><div class="big">${esc(word)} ${esc(relative(event.date, lang))}</div><div>${esc(event.venue || '')}</div><div class="muted">${odds.replace(/^ · /, '')}</div></div><div class="right">${esc(event.broadcast || '')}</div></div>`;
    } else if (event.venue || event.broadcast) {
      info = `<hr><div class="info"><div>${esc(event.venue || '')}</div><div class="right">${esc(event.broadcast || '')}</div></div>`;
    }
    if (post && card.nextGame && card.nextGame.date) {
      const { day, time } = dayAndTime(card.nextGame.date, lang);
      info += `<div class="info" style="margin-top:6px"><div class="muted">Next: ${card.nextGame.homeAway === 'away' ? '@ ' : 'vs '}${esc(card.nextGame.opponent || 'TBA')}</div><div class="right muted">${esc(day)} ${esc(time)}</div></div>`;
    }

    let stat = '';
    const s = card.stat;
    if (s && (live || post)) {
      const tv = parseFloat(s.team);
      const ov = parseFloat(s.opponent);
      const tot = (tv || 0) + (ov || 0);
      const tc = color(team.color, '#1f6feb');
      const oc = distinct(tc, color(opponent.color, '#d1242f'));
      const pct = tot > 0 ? (tv / tot) * 100 : 50;
      stat = `<div class="stat"><div class="lbl">${esc(s.label)}</div><div class="row"><span>${esc(s.team)}</span><div class="track"><div style="width:${pct.toFixed(1)}%;background:${tc}"></div><div style="flex:1;background:${oc}"></div></div><span>${esc(s.opponent)}</span></div></div>`;
    }

    let lines = '';
    const ls = (t) => (t && Array.isArray(t.linescores) ? t.linescores : []);
    const periods = Math.max(ls(team).length, ls(opponent).length);
    if (this._config.linescore && (live || post) && periods > 0 && periods <= 15) {
      const label = (i) => (card.sport === 'mlb' ? i + 1 : i < (card.sport === 'mcbb' ? 2 : card.sport === 'nhl' ? 3 : 4) ? i + 1 : 'OT');
      const row = (t) => `<tr><td>${esc((t && (t.abbreviation || t.shortName)) || '')}</td>${Array.from({ length: periods }, (_, i) => `<td>${esc(ls(t)[i] != null ? ls(t)[i] : '')}</td>`).join('')}<td>${esc(t && t.score != null ? t.score : '')}</td></tr>`;
      lines = `<table class="lines"><tr><th></th>${Array.from({ length: periods }, (_, i) => `<th>${label(i)}</th>`).join('')}<th>T</th></tr>${row(team)}${row(opponent)}</table>`;
    }

    const play = this._config.last_play && live && card.lastPlay ? `<div class="play"><b>Last play:</b> ${esc(card.lastPlay)}</div>` : '';
    return { top, bottom: info + stat + lines + play };
  }

  _event(card, lang) {
    const ev = card.event || {};
    const live = card.state === 'IN';
    let status;
    if (card.state === 'PRE' && ev.date) {
      const { day, time } = dayAndTime(ev.date, lang);
      status = `${esc(START_WORD[card.sport] || 'Starts')} ${esc(relative(ev.date, lang))} · ${esc(day)} ${esc(time)}`;
    } else if (live) {
      status = `<em class="live">LIVE</em> ${esc(ev.shortDetail || '')}`;
    } else {
      status = esc(ev.shortDetail || ev.detail || (card.state === 'NOT_FOUND' ? 'Nothing scheduled' : ''));
    }
    const top = `<div class="title">${esc(ev.name || card.sportLabel || '')}</div><div class="sub">${status}</div>`;
    const bottom = ev.venue || ev.broadcast
      ? `<hr><div class="info"><div>${esc(ev.venue || '')}</div><div class="right">${esc(ev.broadcast || '')}</div></div>`
      : '';
    return { top, bottom };
  }

  // Confetti in team colors when the followed team scores.
  _party(card) {
    if (!this._config.celebrate || card.kind !== 'game' || card.state !== 'IN') return '';
    const prev = this._prev;
    const score = card.team && card.team.score;
    if (!prev || prev.eventId !== card.event.id || typeof prev.teamScore !== 'number' || typeof score !== 'number') return '';
    const pts = score - prev.teamScore;
    if (pts <= 0) return '';
    const word = (CELEBRATE[card.sport] || (() => null))(pts);
    if (!word) return '';
    const tc = color(card.team.color, '#ffd600');
    const colors = [tc, '#ffffff', '#ffd600', tc];
    const bits = Array.from({ length: 36 }, (_, i) => `<i style="left:${(i * 2.8 + (i % 3)).toFixed(1)}%;background:${colors[i % colors.length]};animation-delay:${((i % 9) * 0.08).toFixed(2)}s"></i>`).join('');
    return `<div class="party">${bits}<div class="msg" style="--team:${tc}">${esc(word)}</div></div>`;
  }
}

if (!customElements.get('sports-tracker-card')) {
  customElements.define('sports-tracker-card', SportsTrackerCard);
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: 'sports-tracker-card',
    name: 'Sports Tracker',
    description: 'Live scorecard with a football field, NASCAR track, baseball diamond, court, rink or octagon.',
    preview: true,
    documentationURL: 'https://github.com/Spacegoose02/sports-tracker/blob/main/docs/home-assistant.md',
  });
  console.info(`%c SPORTS-TRACKER-CARD %c ${CARD_VERSION} `, 'background:#e53935;color:#fff;font-weight:700', 'background:#222;color:#fff');
}

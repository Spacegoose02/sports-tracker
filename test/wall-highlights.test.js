const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { loadShared } = require('./helpers');
const hl = require('../src/highlights');
const gd = require('../src/gamedetail');

// ---- Highlights --------------------------------------------------------

test('ESPN highlight clips keep the MP4, web link and thumbnail', () => {
  const clips = hl.parseEspnHighlights({
    videos: [
      {
        id: 101,
        headline: 'Hokies score on a 60-yard run',
        description: 'A long run.',
        duration: 45,
        thumbnail: 'https://a.espncdn.com/thumb.jpg',
        links: {
          web: { href: 'https://www.espn.com/video/clip?id=101' },
          source: { href: 'https://media.video-cdn.espn.com/clip.mp4', HD: { href: 'https://media.video-cdn.espn.com/clip-hd.mp4' } },
        },
      },
      { id: 102, headline: 'HLS only', links: { source: { href: 'https://x.espn.com/a.m3u8' }, web: { href: 'https://www.espn.com/v/102' } } },
      { id: 103, headline: 'Nowhere to watch', links: {} },
      { id: 104, headline: 'Bad link', links: { web: { href: 'javascript:alert(1)' } } },
      { id: 101, headline: 'Duplicate', links: { web: { href: 'https://www.espn.com/v/101' } } },
    ],
  });
  assert.strictEqual(clips.length, 2);
  assert.strictEqual(clips[0].videoUrl, 'https://media.video-cdn.espn.com/clip-hd.mp4');
  assert.strictEqual(clips[0].url, 'https://www.espn.com/video/clip?id=101');
  assert.strictEqual(clips[0].duration, 45);
  assert.strictEqual(clips[0].source, 'ESPN');
  assert.strictEqual(clips[1].videoUrl, null);
  assert.deepStrictEqual(hl.parseEspnHighlights({}), []);
  assert.deepStrictEqual(gd.parseGameExtras({}).highlights, []);
});

test('YouTube uploads match only when both teams are named, after kickoff', () => {
  const teams = [
    { name: 'Virginia Tech Hokies', shortName: 'Virginia Tech', location: 'Virginia Tech', nickname: 'Hokies', abbreviation: 'VT' },
    { name: 'Clemson Tigers', shortName: 'Clemson', location: 'Clemson', nickname: 'Tigers', abbreviation: 'CLEM' },
  ];
  const v = (id, title, publishedAt) => ({ id, title, publishedAt, url: `https://www.youtube.com/watch?v=${id}`, embedUrl: `https://www.youtube-nocookie.com/embed/${id}?autoplay=1`, channel: 'ACC Digital Network' });
  const videos = [
    v('aaaaaaa', 'Virginia Tech vs. Clemson Full Game Highlights', '2026-10-31T23:00:00Z'),
    v('bbbbbbb', 'Hokies press conference after Clemson', '2026-10-31T22:00:00Z'),
    v('ccccccc', 'Clemson vs. Florida State Highlights', '2026-10-31T23:00:00Z'),
    v('ddddddd', 'Virginia Tech vs Clemson 2025 highlights', '2025-10-31T23:00:00Z'),
    v('eeeeeee', 'VTech recap', '2026-10-31T23:00:00Z'),
  ];
  const clips = hl.matchYouTube(videos, teams, '2026-10-31T19:30:00Z');
  assert.deepStrictEqual(clips.map((c) => c.id), ['yt:aaaaaaa', 'yt:bbbbbbb']);
  assert.match(clips[0].embedUrl, /youtube-nocookie/);
  assert.deepStrictEqual(hl.matchYouTube(videos, [teams[0]], '2026-10-31T19:30:00Z'), []);
});

function loadScript(file, CFB, extra) {
  const code = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', file), 'utf8');
  const name = file === 'wall.js' ? 'Wall' : 'CFBGame';
  const sandbox = { CFB, console, URLSearchParams, ...(extra || {}) };
  vm.createContext(sandbox);
  vm.runInContext(`${code}\nthis.${name} = ${name};`, sandbox);
  return sandbox[name];
}

test('highlights section escapes titles and picks the right player', () => {
  const CFB = loadShared();
  const CFBGame = loadScript('game-sections.js', CFB);
  assert.strictEqual(CFBGame.highlightsHtml({ clips: [] }), '');
  const html = CFBGame.highlightsHtml({
    clips: [
      { title: '<b>Big</b> play', duration: 75, videoUrl: 'https://cdn.example/a.mp4', source: 'ESPN' },
      { title: 'Recap', url: 'https://www.espn.com/v/1', source: 'ESPN' },
    ],
  });
  assert.match(html, /&lt;b&gt;Big/);
  assert.match(html, /1:15/);
  assert.match(html, /data-hl="0"/);
  assert.match(html, /<a class="hl-card" href="https:\/\/www.espn.com\/v\/1"/);
  assert.match(CFBGame.highlightPlayerHtml({ title: 'x', videoUrl: 'https://cdn.example/a.mp4' }), /<video[^>]+src="https:\/\/cdn.example\/a.mp4"/);
  assert.match(CFBGame.highlightPlayerHtml({ title: 'x', embedUrl: 'https://www.youtube-nocookie.com/embed/abc' }), /<iframe/);
  assert.doesNotMatch(CFBGame.highlightPlayerHtml({ title: 'x', videoUrl: 'javascript:alert(1)' }), /javascript/);
});

// ---- TV wall -------------------------------------------------------------

const NOW = Date.parse('2026-10-31T22:00:00Z');
function game(id, state, opts) {
  const o = opts || {};
  return {
    id,
    sport: o.sport || 'cfb',
    date: o.date || '2026-10-31T19:30:00Z',
    status: { state, shortDetail: o.detail || '' },
    away: { id: o.awayId || `a${id}`, abbreviation: 'AWY', shortName: 'Away', score: o.as === undefined ? 0 : o.as, curatedRank: o.rank || null },
    home: { id: o.homeId || `h${id}`, abbreviation: 'HOM', shortName: 'Home', score: o.hs === undefined ? 0 : o.hs },
    situation: o.situation || null,
  };
}

test('wall rotation puts live followed games first and drops stale ones', () => {
  const Wall = loadScript('wall.js', loadShared());
  const games = [
    game('1', 'post', { date: '2026-10-31T16:00:00Z' }),
    game('2', 'in', { as: 35, hs: 3 }),
    game('3', 'in', { as: 21, hs: 20 }),
    game('4', 'in', { as: 0, hs: 30, homeId: '259' }),
    game('5', 'pre', { date: '2026-11-01T00:00:00Z' }),
    game('6', 'pre', { date: '2026-11-05T00:00:00Z' }),
    game('7', 'pre', { date: '2026-11-05T00:00:00Z', awayId: '259' }),
    game('8', 'post', { date: '2026-10-29T00:00:00Z' }),
  ];
  const followed = { cfb: new Set(['259']) };
  const order = Wall.pickGames(games, followed, { now: NOW }).map((g) => g.id);
  assert.deepStrictEqual(order, ['4', '3', '2', '7', '5', '1']);
  const mine = Wall.pickGames(games, followed, { now: NOW, mineOnly: true });
  assert.deepStrictEqual(mine.map((g) => g.id), ['4', '7']);
  assert.ok(mine.every((g) => g.mine));
});

test('wall field puts the ball on the right side for either team', () => {
  const Wall = loadScript('wall.js', loadShared());
  const away = Wall.fieldData(game('1', 'in', { awayId: 'A', homeId: 'H', situation: { possession: 'A', possessionText: 'HOM 20', distance: 5, yardLine: 80, isRedZone: true } }));
  assert.deepStrictEqual(JSON.parse(JSON.stringify(away)), { possession: 'away', ball: 80, firstDown: 85, redZone: true });
  const home = Wall.fieldData(game('1', 'in', { awayId: 'A', homeId: 'H', situation: { possession: 'H', possessionText: 'HOM 25', distance: 10, yardLine: 25 } }));
  assert.deepStrictEqual(JSON.parse(JSON.stringify(home)), { possession: 'home', ball: 75, firstDown: 65, redZone: false });
  assert.strictEqual(Wall.fieldData(game('1', 'post', { situation: { possession: 'A' } })), null);
  const svg = Wall.fieldSvg(game('1', 'in', { awayId: 'A', homeId: 'H', situation: { possession: 'A', possessionText: 'AWY 30', distance: 10 } }));
  assert.match(svg, /class="firstdown"/);
  assert.match(svg, /translate\(80 50\)/);
});

test('wall stage escapes team names and shows the linescore after the game', () => {
  const Wall = loadScript('wall.js', loadShared());
  const g = game('1', 'post', { as: 24, hs: 17, detail: 'Final' });
  g.away.shortName = '<script>x</script>';
  g.away.winner = true;
  g.away.linescores = [7, 7, 3, 7];
  g.home.linescores = [0, 10, 0, 7];
  const html = Wall.stageHtml(g, { key: 'cfb', shortLabel: 'CFB', periodPrefix: 'Q', field: true });
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /wall-lines/);
  assert.match(html, /<th>Q4<\/th>/);
  const ot = Wall.linescoreHtml({ away: { abbreviation: 'A', score: 3, linescores: [1, 0, 1, 1] }, home: { abbreviation: 'B', score: 2, linescores: [0, 1, 1, 0] } }, { key: 'nhl', periodPrefix: 'P' });
  assert.match(ot, /<th>P3<\/th><th>OT<\/th>/);
});

test('wall page loads its own stylesheet and script', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'wall.html'), 'utf8');
  assert.match(html, /\/css\/wall\.css/);
  assert.match(html, /\/js\/wall\.js/);
  const game = fs.readFileSync(path.join(__dirname, '..', 'public', 'game.html'), 'utf8');
  assert.match(game, /\/css\/highlights\.css/);
  assert.match(game, /id="gameHighlights"/);
});

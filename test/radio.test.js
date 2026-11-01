const test = require('node:test');
const assert = require('node:assert');
require('./helpers');
const { buildRadioInfo, parseEspnBroadcasts, corePath } = require('../src/radio');

test('parseEspnBroadcasts keeps radio and satellite, drops TV, de-duplicates', () => {
  const list = parseEspnBroadcasts([
    { type: { shortName: 'TV' }, market: { type: 'National' }, media: { shortName: 'ESPN' } },
    { type: { shortName: 'Radio' }, market: { type: 'Home' }, media: { shortName: 'WBNS-FM' }, lang: 'en' },
    { type: { shortName: 'Radio' }, market: { type: 'Home' }, media: { shortName: 'WBNS-FM' } },
    { type: { shortName: 'Radio' }, market: { type: 'Away' }, media: { shortName: 'KVET' } },
    { type: { shortName: 'Radio' }, market: { type: 'National' }, station: { name: 'SiriusXM', channel: 84 } },
    { type: { shortName: 'Radio' }, market: { type: 'Home' }, media: { shortName: 'KLAX' }, lang: 'es' },
    { market: 'national', names: ['ABC'] },
  ]);
  assert.deepStrictEqual(list.map((s) => [s.kind, s.name, s.market]), [
    ['radio', 'WBNS-FM', 'home'],
    ['radio', 'KVET', 'away'],
    ['satellite', 'SiriusXM', 'national'],
    ['radio', 'KLAX', 'home'],
  ]);
  assert.strictEqual(list[2].channel, '84');
  assert.strictEqual(list[3].lang, 'es');
});

test('buildRadioInfo groups stations by team and adds checked flagships', () => {
  const info = buildRadioInfo({
    teams: [
      { id: '194', name: 'Ohio State Buckeyes', homeAway: 'home' },
      { id: '99999', name: 'Some Team', homeAway: 'away' },
    ],
    broadcasts: [[
      { type: { shortName: 'Radio' }, market: { type: 'Home' }, media: { shortName: 'WBNS-FM' } },
      { type: { shortName: 'Radio' }, market: { type: 'Home' }, media: { shortName: 'WOSU' } },
      { type: { shortName: 'Radio' }, market: { type: 'National' }, media: { shortName: 'Sports USA' } },
    ]],
  });
  assert.strictEqual(info.national.length, 1);
  assert.strictEqual(info.national[0].name, 'Sports USA');
  const [osu, other] = info.teams;
  assert.match(osu.flagship.station, /WBNS/);
  // WBNS-FM is the flagship already, so only the extra station is listed.
  assert.deepStrictEqual(osu.stations.map((x) => x.name), ['WOSU']);
  assert.strictEqual(other.flagship, null);
  assert.match(other.tuneIn, /^https:\/\/tunein\.com\/search\/\?query=Some%20Team%20radio$/);
  assert.match(info.siriusxm, /siriusxm\.com\/sports\/college-football/);
});

test('flagships only apply to college football', () => {
  const info = buildRadioInfo({ sport: 'nfl', teams: [{ id: '194', name: 'X', homeAway: 'home' }] });
  assert.strictEqual(info.teams[0].flagship, null);
  assert.strictEqual(info.siriusxm, null);
});

test('radio endpoint rejects unknown sports', async () => {
  const { startApp } = require('./helpers');
  const app = await startApp({ NODE_ENV: 'test' });
  try {
    const res = await fetch(`${app.url}/api/game/401858502/radio?sport=curling`);
    assert.strictEqual(res.status, 400);
  } finally {
    await app.close();
  }
});

test('corePath inserts leagues/ for the core API', () => {
  assert.strictEqual(corePath('football/college-football'), 'football/leagues/college-football');
  assert.strictEqual(corePath('basketball/nba'), 'basketball/leagues/nba');
});

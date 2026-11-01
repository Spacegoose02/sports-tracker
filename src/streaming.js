// Where to stream a game, worked out from the TV networks ESPN lists for it.
// ESPN doesn't say which apps carry a network, so this is a hand-kept map
// from network to the streaming services that carry it live. Prices and
// plan names change often, so it names the service and links to it rather
// than quoting a price. Live TV services (YouTube TV, Hulu + Live TV, Fubo,
// Sling, DirecTV Stream) carry most cable networks; they're listed as one
// "live TV" entry instead of under every network.

const SERVICES = {
  espnApp: { name: 'ESPN app', url: 'https://www.espn.com/watch/', note: 'ESPN Unlimited, or sign in with a TV provider' },
  espnPlus: { name: 'ESPN+', url: 'https://plus.espn.com/', note: 'ESPN+ or ESPN Unlimited plan' },
  foxOne: { name: 'Fox One', url: 'https://www.foxone.com/', note: 'Fox One subscription, or the Fox Sports app with a TV provider' },
  paramount: { name: 'Paramount+', url: 'https://www.paramountplus.com/', note: 'CBS games on any Paramount+ plan with live CBS' },
  peacock: { name: 'Peacock', url: 'https://www.peacocktv.com/', note: 'Peacock Premium' },
  prime: { name: 'Prime Video', url: 'https://www.amazon.com/primevideo', note: 'Amazon Prime or Prime Video' },
  netflix: { name: 'Netflix', url: 'https://www.netflix.com/', note: 'Any Netflix plan' },
  apple: { name: 'Apple TV', url: 'https://tv.apple.com/', note: 'Apple TV subscription' },
  cw: { name: 'The CW app', url: 'https://www.cwtv.com/', note: 'Free, no sign-in needed' },
  hboMax: { name: 'HBO Max', url: 'https://www.hbomax.com/', note: 'TNT Sports games on HBO Max' },
  nflPlus: { name: 'NFL+', url: 'https://www.nfl.com/plus/', note: 'Phones and tablets; NFL+ Premium for replays' },
  youtube: { name: 'YouTube', url: 'https://www.youtube.com/', note: 'Free on YouTube' },
  mlbTv: { name: 'MLB.TV', url: 'https://www.mlb.com/live-stream-games', note: 'Out-of-market games' },
  nbaLp: { name: 'NBA League Pass', url: 'https://www.nba.com/watch/league-pass-stream', note: 'Out-of-market games' },
  nhlEspnPlus: { name: 'ESPN+', url: 'https://plus.espn.com/', note: 'Out-of-market NHL games' },
  liveTv: { name: 'Live TV streaming', url: null, note: 'YouTube TV, Hulu + Live TV, Fubo, Sling or DirecTV Stream, depending on the channel' },
};

// Matched against the network name, first match wins per rule; a network
// can match several rules. Rules are tested in order and the results are
// de-duplicated.
const RULES = [
  { test: /^ESPN\+$|ESPN\+|SEC Network\+|SECN\+|ACC Network Extra|ACCNX|Big 12 Now/i, services: ['espnPlus'] },
  { test: /^(ESPN|ESPN2|ESPNU|ESPNEWS|ESPN Deportes|ABC|SEC Network|SECN|ACC Network|ACCN|LHN|Longhorn Network)$/i, services: ['espnApp', 'liveTv'] },
  { test: /^(FOX|FS1|FS2|BTN|Big Ten Network|Fox Deportes)$/i, services: ['foxOne', 'liveTv'] },
  { test: /^(CBS|CBSSN|CBS Sports Network)$/i, services: ['paramount', 'liveTv'] },
  { test: /^(NBC|USA|USA Net|USA Network|NBCSN|Peacock|Telemundo|Universo)$/i, services: ['peacock'] },
  { test: /^(NBC|USA|USA Net|USA Network|Telemundo|Universo)$/i, services: ['liveTv'] },
  { test: /Prime Video|Amazon/i, services: ['prime'] },
  { test: /Netflix/i, services: ['netflix'] },
  { test: /Apple/i, services: ['apple'] },
  { test: /^(The CW|CW|CW Network)$/i, services: ['cw'] },
  { test: /^(TNT|TBS|truTV|TNT Sports)$/i, services: ['hboMax', 'liveTv'] },
  { test: /^(NFL Network|NFLN|NFL RedZone)$/i, services: ['nflPlus', 'liveTv'] },
  { test: /YouTube/i, services: ['youtube'] },
  { test: /^(MLB Network|MLBN|MLB\.TV)$/i, services: ['mlbTv', 'liveTv'] },
  { test: /^(NBA TV|NBA League Pass)$/i, services: ['nbaLp', 'liveTv'] },
  { test: /^(NHL Network|NHLN)$/i, services: ['liveTv'] },
  { test: /^(Mountain West Network|MW Network)$/i, services: ['youtube'] },
];

// Returns [{ name, url, note, networks: [...] }] in the order networks are
// listed, so the national broadcast's services come first.
function servicesFor(networks) {
  const byKey = new Map();
  for (const network of networks || []) {
    const n = String(network || '').trim();
    if (!n) continue;
    for (const rule of RULES) {
      if (!rule.test.test(n)) continue;
      for (const key of rule.services) {
        if (!byKey.has(key)) byKey.set(key, { ...SERVICES[key], networks: [] });
        const entry = byKey.get(key);
        if (!entry.networks.includes(n)) entry.networks.push(n);
      }
    }
  }
  // Keep "live TV" last: it's the catch-all.
  const list = [...byKey.entries()];
  list.sort((a, b) => (a[0] === 'liveTv') - (b[0] === 'liveTv'));
  return list.map(([, v]) => v);
}

module.exports = { servicesFor, SERVICES };

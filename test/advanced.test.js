const test = require('node:test');
const assert = require('node:assert');
const advanced = require('../src/advanced');

const ADV = [
  { team: 'Virginia Tech', offense: { ppa: 0.25, successRate: 0.46, explosiveness: 1.2, rushingPlays: { ppa: 0.2 }, passingPlays: { ppa: 0.3 } }, defense: { ppa: 0.1, successRate: 0.38, explosiveness: 1.1, havoc: { total: 0.19 } } },
  { team: 'Florida State', offense: { ppa: 0.1, successRate: 0.4, explosiveness: 1.3 }, defense: { ppa: 0.2, successRate: 0.42, explosiveness: 1.2, havoc: { total: 0.15 } } },
  { team: 'Miami', offense: { ppa: 0.35, successRate: 0.5, explosiveness: 1.1 }, defense: { ppa: 0.05, successRate: 0.36, explosiveness: 1.0, havoc: { total: 0.22 } } },
];
const SP = [{ team: 'Virginia Tech', rating: 12.3, ranking: 22, offense: { rating: 33.1, ranking: 30 }, defense: { rating: 20.8, ranking: 18 } }];

function deps(calls = []) {
  return {
    hasCfbd: () => true,
    cfbd: async (p) => {
      calls.push(p);
      if (p.startsWith('/stats/season/advanced')) return ADV;
      if (p.startsWith('/ratings/sp')) return SP;
      if (p.startsWith('/game/box/advanced')) {
        return { teams: {
          ppa: [{ team: 'Virginia Tech', plays: 70, overall: { total: 0.31 }, passing: { total: 0.4 }, rushing: { total: 0.2 } }, { team: 'Florida State', overall: { total: 0.02 } }],
          successRates: [{ team: 'Virginia Tech', overall: { total: 0.5 } }, { team: 'Florida State', overall: { total: 0.38 } }],
          havoc: [{ team: 'Virginia Tech', total: 0.2 }, { team: 'Florida State', total: 0.12 }],
        } };
      }
      return [];
    },
  };
}

test('team advanced stats with national ranks (defense ranks lower-is-better)', async () => {
  const data = await advanced.teamAdvanced({ teamName: 'virginia tech', year: 2031 }, deps());
  assert.strictEqual(data.available, true);
  assert.deepStrictEqual(data.sp, { rating: 12.3, rank: 22, offense: 33.1, offenseRank: 30, defense: 20.8, defenseRank: 18, specialTeams: null });
  assert.deepStrictEqual(data.offense.epa, { value: 0.25, rank: 2, of: 3 });
  assert.deepStrictEqual(data.defense.epa, { value: 0.1, rank: 2, of: 3 });
  assert.strictEqual(data.defense.havoc.rank, 2);
  assert.strictEqual((await advanced.teamAdvanced({ teamName: 'Nowhere State', year: 2031 }, deps())).available, false);
});

test('game advanced box score, and no key means not available', async () => {
  const data = await advanced.gameAdvanced('401999', deps());
  assert.deepStrictEqual(data.teams.map((t) => [t.team, t.epa, t.successRate, t.havoc]), [['Virginia Tech', 0.31, 0.5, 0.2], ['Florida State', 0.02, 0.38, 0.12]]);
  assert.deepStrictEqual(await advanced.teamAdvanced({ teamName: 'Miami' }, { hasCfbd: () => false }), { available: false, reason: 'no-key' });
  assert.strictEqual(advanced.seasonFor(new Date('2027-01-05T12:00:00')), 2026);
  assert.strictEqual(advanced.seasonFor(new Date('2026-09-05T12:00:00')), 2026);
});

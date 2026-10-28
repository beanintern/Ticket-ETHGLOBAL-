// Checks how Easy mode reads bets back from a Derive account's option positions (src/lib/bets.ts):
// pairing bought and sold options into bets, keeping what this browser knows about them, showing
// a just-bought bet until the account catches up, and dropping records of bets sold elsewhere.
//
//   npm run check:bets
import { createServer } from 'vite';

const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
const { betsFromHeld, CONFIRM_GRACE_MS } = await vite.ssrLoadModule('/src/lib/bets.ts');
const EXP = Date.UTC(2026, 10, 27, 8);
const expiryOf = (_a, y) => Date.UTC(+y.slice(0, 4), +y.slice(4, 6) - 1, +y.slice(6, 8), 8);
const spotAt = () => 2400;
const NOW = Date.UTC(2026, 9, 28, 12);
const opt = (strike, type, amount, avg = 0, sub = 1, asset = 'ETH') => ({
  subaccountId: sub, instrument: `${asset}-20261127-${String(strike).replace('.', '_')}-${type}`, asset, expiryYmd: '20261127', strike, type, amount, averagePrice: avg, markPrice: 0, unrealizedPnl: 0, openedAt: NOW - 3600e3,
});
const local = (dir, lo, hi, shares, entry, openedAt = NOW - 3600e3, id = `pos_${dir}_${lo}_${hi}`, venue = 'derive-mainnet') => ({
  id, asset: 'ETH', name: 'x', legs: [], openedAt, openSpot: 2390, venue, bet: { dir, level: (lo + hi) / 2, lo, hi, expiry: EXP, shares, entry },
});
const run = (held, loc = [], heldAt = NOW) => betsFromHeld(held, heldAt, 'derive-mainnet', loc, NOW, expiryOf, spotAt);
const show = (r) => r.bets.map((b) => `${b.bet.dir} ${b.bet.lo}/${b.bet.hi} ×${+b.bet.shares.toFixed(4)} @${+b.bet.entry.toFixed(4)}${b.subaccountId ? ` sub${b.subaccountId}` : ''}`).sort().join(', ') || '(none)';

const cases = [
  ['an above bet: +call lo, −call hi; price paid from this browser', run([opt(2400, 'C', 0.5, 60), opt(2500, 'C', -0.5, 30)], [local('above', 2400, 2500, 50, 0.32)]), 'above 2400/2500 ×50 @0.32 sub1', 0, []],
  ['a below bet on another device: price from the account (fees not known)', run([opt(2300, 'P', 1, 40), opt(2200, 'P', -1, 20)]), 'below 2200/2300 ×100 @0.2 sub1', 0, []],
  ['two overlapping call spreads stay two bets', run([opt(2400, 'C', 1), opt(2450, 'C', 1), opt(2500, 'C', -1), opt(2550, 'C', -1)]), 'above 2400/2500 ×100 @0 sub1, above 2450/2550 ×100 @0 sub1', 0, []],
  ['a lone bought option is not a bet', run([opt(2400, 'C', 2), opt(2500, 'C', -0.5)]), 'above 2400/2500 ×50 @0 sub1', 1.5, []],
  ['a sold put above a bought put pays the wrong way: not a bet', run([opt(2300, 'P', 1), opt(2400, 'P', -1)]), '(none)', 2, []],
  ['subaccounts are never mixed', run([opt(2400, 'C', 1, 0, 1), opt(2500, 'C', -1, 0, 2)]), '(none)', 2, []],
  ['bets in two subaccounts, each sold from its own', run([opt(2400, 'C', 1, 0, 1), opt(2500, 'C', -1, 0, 1), opt(2.5, 'C', 10, 0, 3, 'SOL'), opt(3, 'C', -10, 0, 3, 'SOL')]), 'above 2.5/3 ×5 @0 sub3, above 2400/2500 ×100 @0 sub1', 0, []],
  ['partly sold elsewhere: the account says how many', run([opt(2400, 'C', 0.2), opt(2500, 'C', -0.2)], [local('above', 2400, 2500, 50, 0.32)]), 'above 2400/2500 ×20 @0.32 sub1', 0, []],
  ['just bought, not in the account yet: shown meanwhile', run([], [local('above', 2400, 2500, 50, 0.32, NOW - CONFIRM_GRACE_MS / 2)]), 'above 2400/2500 ×50 @0.32', 0, []],
  ['sold elsewhere: the record is dropped', run([], [local('above', 2400, 2500, 50, 0.32)]), '(none)', 0, ['pos_above_2400_2500']],
  ['bought an hour ago, but the account was last read before that (Derive stalled): kept', run([], [local('above', 2400, 2500, 50, 0.32)], NOW - 2 * 3600e3), 'above 2400/2500 ×50 @0.32', 0, []],
  ['a bet on the other network is left alone', run([], [local('above', 2400, 2500, 50, 0.32, NOW - 3600e3, 'pos_t', 'derive-testnet')]), '(none)', 0, []],
];
let failed = 0;
for (const [name, r, want, other, stale] of cases) {
  const got = show(r);
  const ok = got === want && Math.abs(r.otherLegs - other) < 1e-9 && r.stale.join() === stale.join();
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n     got  ${got} · other ${r.otherLegs} · stale ${r.stale}\n     want ${want} · other ${other} · stale ${stale}`}`);
}
console.log(`\n${cases.length - failed}/${cases.length} cases passed`);
await vite.close();
process.exit(failed ? 1 : 0);

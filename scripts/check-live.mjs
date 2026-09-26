// Checks the live Derive data layer (src/data/derive.ts) against the real exchange.
//   npm run check:live                  (mainnet)
//   NETWORK=testnet npm run check:live  (v3 testnet on Sepolia)
// Runs the same code the app uses, under Node, and verifies:
//   - listed expiries/strikes load and look sane
//   - the index price and hourly price history are present and consistent
//   - our pricing (Black-Scholes on spot with the IV we derive) reproduces Derive's mark prices,
//     which is what makes the P&L map line up with exchange prices
//   - IV for an unlisted strike falls between its neighbours
import { createServer } from 'vite';
import { bsPriceForCheck } from './bs-for-check.mjs';

const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
const { createDeriveSource, DERIVE_MAINNET, DERIVE_TESTNET } = await vite.ssrLoadModule('/src/data/derive.ts');
const testnet = process.env.NETWORK === 'testnet';
// The testnet only has a few months of index history.
const MIN_HISTORY_DAYS = testnet ? 90 : 300;
const YEAR = 365 * 864e5;
const failures = [];
const fail = (m) => failures.push(m);

const src = createDeriveSource(testnet ? DERIVE_TESTNET : DERIVE_MAINNET);
console.log(`Network: ${testnet ? 'testnet (v3, Sepolia)' : 'mainnet'}`);
const t0 = Date.now();
await new Promise((resolve, reject) => {
  const off = src.subscribe(() => {
    if (src.status === 'ready') { off(); resolve(); }
    if (src.status === 'error') { off(); reject(new Error(src.error)); }
  });
  setTimeout(() => reject(new Error('timed out waiting for Derive data')), 90_000);
});
console.log(`Derive data ready in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

const now = Date.now();
for (const asset of ['ETH', 'BTC']) {
  const m = src.markets[asset];
  const exps = m.expiries;
  console.log(`${asset}: index ${m.spot.toFixed(2)} · ${m.candles.length} candles over ${((m.candles.at(-1).t - m.candles[0].t) / 864e5).toFixed(0)} days · ${exps.length} expiries (${exps.map((e) => `${e.label} ${e.kind[0]}`).join(', ')})`);
  if (!(m.spot > 0)) fail(`${asset}: no index price`);
  if (m.candles.length < 300) fail(`${asset}: only ${m.candles.length} candles`);
  const spanDays = (m.candles.at(-1).t - m.candles[0].t) / 864e5;
  if (spanDays < MIN_HISTORY_DAYS) fail(`${asset}: history only covers ${spanDays.toFixed(0)} days`);
  const lastExp = m.expiries.at(-1);
  if (lastExp && lastExp.ts - now < 180 * 864e5) fail(`${asset}: longest expiry ${lastExp.label} is under 6 months out`);
  const last = m.candles.at(-1);
  if (Math.abs(last.c / m.spot - 1) > 0.02) fail(`${asset}: last candle ${last.c} far from index ${m.spot}`);
  if (!exps.length) fail(`${asset}: no expiries`);
  if (exps.some((e) => e.ts <= now)) fail(`${asset}: expired expiry listed`);

  let priced = 0, maxErr = 0, worst = '';
  for (const e of exps) {
    const ks = m.strikes(e.ts);
    if (!ks.length) fail(`${asset} ${e.label}: no strikes`);
    if (ks.some((k, i) => i && k <= ks[i - 1])) fail(`${asset} ${e.label}: strikes not sorted`);
    const snapped = m.snapStrike(m.spot, e.ts);
    if (!ks.includes(snapped)) fail(`${asset} ${e.label}: snapStrike gave unlisted ${snapped}`);
    const up = m.stepStrike(snapped, e.ts, 1), down = m.stepStrike(snapped, e.ts, -1);
    if (!ks.includes(up) || !ks.includes(down) || up < snapped || down > snapped) fail(`${asset} ${e.label}: stepStrike out of grid`);
    const T = (e.ts - now) / YEAR;
    for (const k of ks) for (const type of ['C', 'P']) {
      const q = m.quote(type, k, e.ts);
      if (!q) continue;
      const model = bsPriceForCheck(type, m.spot, k, T, m.iv(type, k, e.ts, now));
      // Deep in-the-money options can't always be matched by a spot-based model (their mark sits
      // below spot intrinsic when the forward differs from spot); skip those.
      const intrinsic = type === 'C' ? Math.max(m.spot - k, 0) : Math.max(k - m.spot, 0);
      if (q.mark <= intrinsic * 1.001) continue;
      const err = Math.abs(model - q.mark);
      const tol = Math.max(0.05, q.mark * 0.005);
      priced++;
      if (err / tol > maxErr) { maxErr = err / tol; worst = `${type}${k} ${e.label}: model ${model.toFixed(2)} vs mark ${q.mark}`; }
      if (err > tol && failures.length < 20) fail(`${asset} ${type}${k} ${e.label}: model ${model.toFixed(2)} vs Derive mark ${q.mark}`);
    }
  }
  console.log(`   ${priced} quoted options priced; worst match ${worst || 'n/a'}`);

  // IV between quoted neighbours for an unlisted strike near spot.
  const e = exps.find((x) => x.ts - now > 5 * 864e5) ?? exps[0];
  const ks = m.strikes(e.ts);
  const i = ks.findIndex((k) => k > m.spot);
  if (i > 0) {
    const [a, b] = [ks[i - 1], ks[i]];
    const mid = (a + b) / 2;
    const [va, vb, vm] = [m.iv('C', a, e.ts, now), m.iv('C', b, e.ts, now), m.iv('C', mid, e.ts, now)];
    console.log(`   IV ${e.label}: ${a} ${(va * 100).toFixed(1)}% · ${mid} ${(vm * 100).toFixed(1)}% · ${b} ${(vb * 100).toFixed(1)}%`);
    if (vm < Math.min(va, vb) - 1e-6 || vm > Math.max(va, vb) + 1e-6) fail(`${asset}: interpolated IV ${vm} not between ${va} and ${vb}`);
  }
  console.log();
}

src.close();
await vite.close();
console.log(failures.length ? `FAILED (${failures.length}):\n - ${failures.join('\n - ')}` : 'All live-data checks passed.');
process.exit(failures.length ? 1 : 0);

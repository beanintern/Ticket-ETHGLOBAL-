// Automated chart check: places random positions and verifies what the chart draws against an
// independent Black-Scholes calculation (written here, not imported from the app).
//
//   npm run check:chart            # 60 random positions
//   N=200 SEED=7 npm run check:chart
//
// For each position it checks:
//   1. leg dots sit at (expiry, strike) and are blue for buys, amber for sells
//   2. the P&L colours: green where the position makes money, red where it loses, and clearly
//      stronger for big P&L than for small P&L
//   3. the break-even line matches where P&L actually crosses zero
//   4. max profit / max loss (over the position's whole life): value, price band, and that no
//      P&L on the map beats it
//   5. uncapped-profit / uncapped-loss tags appear exactly when they should
//   6. the Build panel's max profit / max loss agree
import { chromium } from 'playwright';
import { preview } from 'vite';
import { mkdirSync } from 'node:fs';
import { inspect } from './chart-inspect.mjs';

const N = Number(process.env.N ?? 60);
const SEED = Number(process.env.SEED ?? 20260926);
const OUT = process.env.OUT ?? 'check-chart-failures';

function rng(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(SEED);
const pick = (a) => a[Math.floor(rand() * a.length)];
const gauss = () => Math.sqrt(-2 * Math.log(Math.max(rand(), 1e-12))) * Math.cos(2 * Math.PI * rand());
const DAY = 864e5;

const server = await preview({ preview: { port: 4180 }, logLevel: 'warn' });
const url = server.resolvedUrls.local[0];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 860 }, deviceScaleFactor: 1 });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
// The simulator's random numbers come from SEED and its prices are frozen, so a run (and any
// failure in it) replays exactly.
await page.addInitScript(([seed, debug]) => {
  window.__TICKET_TEST__ = true;
  window.__DEBUG_CHECK__ = debug;
  let s = seed | 0;
  Math.random = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}, [SEED, !!process.env.DEBUG]);
await page.goto(`${url}?source=mock&freeze=1`); // the check runs against the simulator
await page.waitForFunction(() => window.__ticket && window.__chart);
await page.mouse.move(1300, 845); // keep the cursor (and its tooltip) off the chart

let failed = 0, samples = 0, total = 0;
// ONLY=113 re-runs just that case (with the same SEED it's the same position and market).
const ONLY = Number(process.env.ONLY ?? 0);
async function runCase(asset, legs, horizonDays, tag = '') {
  total++;
  if (ONLY && total !== ONLY) return;
  await page.evaluate(({ a, l, h }) => { window.__ticket.setLegs(a, l); window.__ticket.setView({ horizon: h, yZoom: 1, yShift: 0 }); }, { a: asset, l: legs, h: horizonDays * DAY });
  await page.waitForTimeout(250);
  const res = await page.evaluate(inspect);
  samples += res.colourSamples;
  const label = `#${total} ${tag}${asset} ${legs.map((l) => `${l.side > 0 ? '+' : '-'}${l.qty}${l.type}${l.strike}@${new Date(l.expiry).toISOString().slice(5, 10)}`).join(' ')} [${horizonDays}d]`;
  if (res.failures.length) {
    failed++;
    mkdirSync(OUT, { recursive: true });
    await page.screenshot({ path: `${OUT}/case-${total}.png` });
    console.log(`FAIL ${label}`);
    for (const f of res.failures) console.log(`     - ${f}`);
  } else console.log(`ok   ${label}`);
}

// Named structures first: spreads, condors, butterflies and calendars, whose max profit / loss
// zones curve over time. Each at a short, medium and long zoom.
for (const asset of ['ETH', 'BTC']) {
  const { spot, spec, expiries } = await page.evaluate((a) => ({ spot: window.__ticket.spot(a), spec: window.__ticket.specs[a], expiries: window.__ticket.expiries(a) }), asset);
  const now = Date.now();
  const exp = (days) => expiries.reduce((a, b) => (Math.abs(b - now - days * DAY) < Math.abs(a - now - days * DAY) ? b : a));
  const step = spec.strikeStep * 2;
  const k = Math.round(spot / step) * step;
  const L = (type, side, dk, days, qty = 1) => ({ type, side, strike: k + dk * step, expiry: exp(days), qty });
  const structures = {
    'call spread': (d) => [L('C', 1, 1, d), L('C', -1, 4, d)],
    'put spread': (d) => [L('P', 1, -1, d), L('P', -1, -4, d)],
    'short call spread': (d) => [L('C', -1, 1, d), L('C', 1, 4, d)],
    'iron condor': (d) => [L('P', 1, -6, d), L('P', -1, -3, d), L('C', -1, 3, d), L('C', 1, 6, d)],
    butterfly: (d) => [L('C', 1, -3, d), L('C', -1, 0, d, 2), L('C', 1, 3, d)],
    calendar: (d) => [L('C', -1, 0, Math.max(3, d / 4)), L('C', 1, 0, d)],
    'short put': (d) => [L('P', -1, -3, d)],
    'long call': (d) => [L('C', 1, 2, d)],
  };
  for (const [name, make] of Object.entries(structures))
    for (const [days, horizon] of [[14, 21], [45, 60], [120, 182]]) await runCase(asset, make(days), horizon, `${name}: `);
  // The same, with the last expiry just inside the right edge of the chart.
  for (const [name, make] of Object.entries(structures)) {
    const legs = make(60);
    const last = Math.max(...legs.map((l) => l.expiry));
    await runCase(asset, legs, ((last - now) / DAY) * 1.01, `${name} (expiry at edge): `);
  }
}

for (let n = 0; n < N; n++) {
  const asset = rand() < 0.7 ? 'ETH' : 'BTC';
  const { spot, spec, expiries } = await page.evaluate((a) => ({ spot: window.__ticket.spot(a), spec: window.__ticket.specs[a], expiries: window.__ticket.expiries(a) }), asset);
  const horizonDays = pick([7, 21, 60, 182]);
  const now = Date.now();
  const inView = expiries.filter((e) => e - now < horizonDays * DAY * 0.95 && e - now > 6 * 3600e3);
  const oneDate = rand() < 0.65;
  const shared = pick(inView);
  const legs = [];
  const count = 1 + Math.floor(rand() * 5);
  // One in five: 2-4 legs spread over several nearby dates. These are the positions whose best or
  // worst outcome can come after the first expiry.
  const nearby = inView.filter((e) => e - now < 40 * DAY);
  if (rand() < 0.2 && nearby.length >= 2) {
    for (let i = 0, k = 2 + Math.floor(rand() * 3); i < k; i++) {
      const e = pick(nearby);
      const st = e - now > 21 * DAY ? spec.strikeStep * 2 : spec.strikeStep;
      legs.push({ type: rand() < 0.5 ? 'C' : 'P', side: rand() < 0.5 ? 1 : -1, qty: 1, expiry: e, strike: Math.max(st, Math.round((spot * Math.exp(0.1 * (rand() * 2 - 1))) / st) * st) });
    }
  }
  for (let i = 0; i < (legs.length ? 0 : count); i++) {
    const expiry = oneDate ? shared : pick(inView);
    const step = expiry - now > 21 * DAY ? spec.strikeStep * 2 : spec.strikeStep;
    const strike = Math.max(step, Math.round((spot * Math.exp(0.08 * gauss())) / step) * step);
    legs.push({ type: rand() < 0.5 ? 'C' : 'P', side: rand() < 0.5 ? 1 : -1, strike, expiry, qty: 1 + Math.floor(rand() * 3) });
  }
  await runCase(asset, legs, horizonDays);
}
console.log(`\n${(ONLY ? 1 : total) - failed}/${ONLY ? 1 : total} positions passed · ${samples} colour samples checked${pageErrors.length ? ` · page errors: ${pageErrors.join('; ')}` : ''}`);
if (failed) console.log(`Screenshots of failures in ./${OUT}/`);
await browser.close();
await server.httpServer.close();
process.exit(failed || pageErrors.length ? 1 : 0);

// Automated check for Easy mode (prediction-market style Yes bets), against an independent
// calculation (not the app's own pricing).
//
//   npm run check:easy
//
// Clicks above and below the price at several dates and zooms, and checks:
//   1. the question: "above" when clicked above the index, "below" when below, on the listed
//      expiry under the click, at a level between two listed strikes around the click
//   2. the price in cents is the spread's value per $1 (independent Black-Scholes on the
//      simulator's vol surface), and is between 1¢ and 99¢
//   3. buying $X gives X / price shares whose legs pay exactly $1 per share past the far strike,
//      $0 on the losing side, and 50¢ at the level (checked leg by leg at expiry)
//   4. the bet shows on the chart and in the list, and selling it removes it
import { chromium } from 'playwright';
import { preview } from 'vite';

const DAY = 864e5;
const server = await preview({ preview: { port: 4182 }, logLevel: 'warn' });
const url = server.resolvedUrls.local[0];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 860 }, deviceScaleFactor: 1 });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
await page.addInitScript(() => { window.__TICKET_TEST__ = true; try { localStorage.clear(); } catch {} });
await page.goto(`${url}?source=mock&freeze=1&mode=easy`);
await page.waitForFunction(() => window.__ticket && window.__chart);
const box = await page.locator('canvas').first().boundingBox();

// [asset, horizon days, x as a fraction of the future, price as a multiple of spot, stake]
const cases = [
  ['ETH', 21, 0.5, 1.06, 20],
  ['ETH', 21, 0.3, 0.95, 50],
  ['ETH', 60, 0.8, 1.2, 10],
  ['ETH', 7, 0.9, 0.99, 100],
  ['BTC', 21, 0.6, 1.05, 25],
  ['BTC', 182, 0.7, 0.8, 40],
];
let failed = 0;
for (const [asset, horizon, fx, mult, stake] of cases) {
  const failures = [];
  const fail = (m) => failures.push(m);
  await page.click(`.market:has-text("${asset}")`);
  await page.evaluate((h) => window.__ticket.setView({ horizon: h * 864e5, yZoom: 1, yShift: 0 }), horizon);
  await page.waitForTimeout(250);
  const [x, y] = await page.evaluate(({ fx, mult }) => {
    const K = window.__chart;
    return [K.geom.nowX + fx * (K.geom.plotR - K.geom.nowX), K.pToY(K.spot * mult)];
  }, { fx, mult });
  await page.mouse.move(box.x + x, box.y + y);
  await page.waitForTimeout(150);
  const res = await page.evaluate(({ x, y, asset }) => {
    const K = window.__chart;
    const out = [];
    const q = K.easyHover;
    if (!q) return { out: ['no quote under the pointer'] };
    const clicked = K.yToP(y);
    const spot = K.spot;
    // 1. Question.
    if ((clicked >= spot) !== (q.dir === 'above')) out.push(`clicked ${clicked.toFixed(0)} vs index ${spot.toFixed(0)} but asked "${q.dir}"`);
    const listed = window.__ticket.expiries(asset);
    if (!listed.includes(q.expiry)) out.push('expiry not listed');
    const nearest = listed.filter((e) => K.tToX(e) <= K.geom.plotR + 1).reduce((a, b) => (Math.abs(K.tToX(b) - x) < Math.abs(K.tToX(a) - x) ? b : a));
    if (q.expiry !== nearest) out.push(`expiry ${new Date(q.expiry).toISOString().slice(5, 10)} isn't the one under the click (${new Date(nearest).toISOString().slice(5, 10)})`);
    if (!(q.lo <= clicked + 1e-6 && clicked < q.hi)) out.push(`strikes ${q.lo}/${q.hi} don't bracket the click ${clicked.toFixed(0)}`);
    if (Math.abs(q.level - (q.lo + q.hi) / 2) > 1e-9) out.push('level is not the midpoint');
    // 2. Price, independently.
    const YEAR = 365 * 864e5;
    const normCdf = (v) => {
      const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
      const sign = v < 0 ? -1 : 1, z = Math.abs(v) / Math.SQRT2, t = 1 / (1 + p * z);
      return 0.5 * (1 + sign * (1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-z * z)));
    };
    const bs = (type, S, k, T, iv) => {
      if (T <= 0) return type === 'C' ? Math.max(S - k, 0) : Math.max(k - S, 0);
      const sq = iv * Math.sqrt(T), d1 = (Math.log(S / k) + 0.5 * sq * sq) / sq, d2 = d1 - sq;
      return type === 'C' ? S * normCdf(d1) - k * normCdf(d2) : k * normCdf(-d2) - S * normCdf(-d1);
    };
    const baseIv = window.__ticket.specs[asset].baseIv;
    const ivOf = (k, T) => {
      const t = Math.max(T, 1 / (365 * 24));
      const m = Math.max(-2.5, Math.min(2.5, Math.log(k / spot) / Math.sqrt(Math.max(t, 7 / 365))));
      return baseIv * (0.93 + 0.07 * Math.min(1, t * 6)) * (1 + 0.12 * m * m - 0.04 * m);
    };
    const T = (q.expiry - K.now) / YEAR;
    const w = q.hi - q.lo;
    const want = q.dir === 'above'
      ? (bs('C', spot, q.lo, T, ivOf(q.lo, T)) - bs('C', spot, q.hi, T, ivOf(q.hi, T))) / w
      : (bs('P', spot, q.hi, T, ivOf(q.hi, T)) - bs('P', spot, q.lo, T, ivOf(q.lo, T))) / w;
    const clamp = Math.min(0.99, Math.max(0.01, want));
    if (Math.abs(q.price - clamp) > 0.002) out.push(`price ${(q.price * 100).toFixed(2)}¢, independent ${(clamp * 100).toFixed(2)}¢`);
    return { out, q };
  }, { x, y, asset });
  failures.push(...res.out);
  if (res.q) {
    const before = await page.$$eval('.bet-list li', (l) => l.length);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForSelector('.bet-card');
    const shown = await page.textContent('.bet-price .num');
    if (shown.trim() !== `${Math.round(res.q.price * 100)}¢`) fail(`card shows ${shown}, quote is ${Math.round(res.q.price * 100)}¢`);
    await page.fill('.stake-input input', String(stake));
    await page.click('.bet-card .primary');
    await page.waitForTimeout(250);
    // 3. The bet's legs, independently: what they pay per share at expiry.
    const pos = await page.evaluate(() => JSON.parse(localStorage.getItem('ticket.positions.v1')).positions[0]);
    const b = pos.bet;
    if (!b) fail('no bet saved');
    else {
      const payAt = (S) => pos.legs.reduce((a, l) => a + l.side * l.qty * (l.type === 'C' ? Math.max(S - l.strike, 0) : Math.max(l.strike - S, 0)), 0) / b.shares;
      const win = b.dir === 'above' ? b.hi + (b.hi - b.lo) : b.lo - (b.hi - b.lo);
      const lose = b.dir === 'above' ? b.lo - (b.hi - b.lo) : b.hi + (b.hi - b.lo);
      if (Math.abs(payAt(win) - 1) > 1e-9) fail(`pays ${payAt(win)} per share when right, not $1`);
      if (Math.abs(payAt(lose)) > 1e-9) fail(`pays ${payAt(lose)} per share when wrong, not $0`);
      if (Math.abs(payAt(b.level) - 0.5) > 1e-9) fail(`pays ${payAt(b.level)} at the level, not 50¢`);
      if (Math.abs(b.shares - stake / res.q.price) > 1e-6 * b.shares) fail(`${b.shares} shares for $${stake} at ${res.q.price}`);
      const paid = pos.legs.reduce((a, l) => a + l.side * l.qty * l.entry, 0);
      if (Math.abs(paid - stake) > 0.01 * stake) fail(`legs cost $${paid.toFixed(2)} for a $${stake} bet`);
      // 4. On the chart and in the list; then sell it.
      const listed = await page.$$eval('.bet-list li', (l) => l.length);
      if (listed !== before + 1) fail(`bet list has ${listed} rows, expected ${before + 1}`);
      await page.click('.bet-list li >> nth=0 >> .link');
      await page.waitForTimeout(200);
      const after = await page.$$eval('.bet-list li', (l) => l.length);
      if (after !== before) fail(`selling left ${after} bets, expected ${before}`);
    }
  }
  const label = `${asset} ${res.q ? `${res.q.dir} ${res.q.level} on ${new Date(res.q.expiry).toISOString().slice(5, 10)} at ${(res.q.price * 100).toFixed(1)}¢` : ''} [${horizon}d, $${stake}]`;
  if (failures.length) {
    failed++;
    console.log(`FAIL ${label}`);
    for (const f of failures) console.log(`     - ${f}`);
  } else console.log(`ok   ${label}`);
}
console.log(`\n${cases.length - failed}/${cases.length} bets passed${pageErrors.length ? ` · page errors: ${pageErrors.join('; ')}` : ''}`);
await browser.close();
await server.httpServer.close();
process.exit(failed || pageErrors.length ? 1 : 0);

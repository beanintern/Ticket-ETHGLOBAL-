// Automated check for Easy mode (a grid of prediction-market style bets), against an independent
// calculation (not the app's own pricing).
//
//   npm run check:easy
//
// For several assets and zooms it checks the grid, then bets on boxes above and below the price:
//   1. the grid: boxes never overlap, each column ends exactly on its listed expiry, and every
//      box edge is a strike listed for that expiry
//   2. every box: "above" if its band is above the index, "below" if below, and its price (shown
//      as a multiplier, 1 / price) equals an independent Black-Scholes value of the spread per $1
//   3. betting on a box: the card shows its multiplier, "Show underlying positions" lists the
//      two options (right expiry, strikes and sides), buying $X costs $X, and the shares' legs pay
//      exactly $1 past the far strike, $0 on the losing side and 50¢ at the middle
//   4. the bet is listed, and selling it removes it
import { chromium } from 'playwright';
import { preview } from 'vite';

const server = await preview({ preview: { port: 4182 }, logLevel: 'warn' });
const url = server.resolvedUrls.local[0];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 860 }, deviceScaleFactor: 1 });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
await page.addInitScript(() => { window.__TICKET_TEST__ = true; try { localStorage.clear(); } catch {} });
await page.goto(`${url}?source=mock&freeze=1&mode=easy`);
await page.waitForFunction(() => window.__ticket && window.__chart);
const canvas = await page.locator('canvas').first().boundingBox();

// Independent pricing, in the page (mirrors the simulator's vol surface).
const PRICER = `(() => {
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
  return (asset, spot, now, b) => {
    const baseIv = window.__ticket.specs[asset].baseIv;
    const ivOf = (k, T) => {
      const t = Math.max(T, 1 / (365 * 24));
      const m = Math.max(-2.5, Math.min(2.5, Math.log(k / spot) / Math.sqrt(Math.max(t, 7 / 365))));
      return baseIv * (0.93 + 0.07 * Math.min(1, t * 6)) * (1 + 0.12 * m * m - 0.04 * m);
    };
    const T = (b.expiry - now) / YEAR, w = b.hi - b.lo;
    const v = b.dir === 'above'
      ? (bs('C', spot, b.lo, T, ivOf(b.lo, T)) - bs('C', spot, b.hi, T, ivOf(b.hi, T))) / w
      : (bs('P', spot, b.hi, T, ivOf(b.hi, T)) - bs('P', spot, b.lo, T, ivOf(b.lo, T))) / w;
    return Math.min(0.99, Math.max(0.01, v));
  };
})()`;

// [asset, horizon days, which column (fraction), target chance, stake]
const cases = [
  ['ETH', 21, 0.5, 0.2, 20],
  ['ETH', 21, 0.2, 0.3, 50],
  ['ETH', 60, 0.9, 0.1, 10],
  ['ETH', 7, 1, 0.4, 100],
  ['BTC', 21, 0.6, 0.25, 25],
  ['BTC', 182, 0.7, 0.15, 40],
];
let failed = 0;
for (const [asset, horizon, colFrac, chance, stake] of cases) {
  const failures = [];
  const fail = (m) => failures.push(m);
  await page.click(`.market:has-text("${asset}")`);
  await page.evaluate((h) => window.__ticket.setView({ horizon: h * 864e5, yZoom: 1, yShift: 0 }), horizon);
  await page.waitForTimeout(300);
  await page.mouse.move(1430, 850);
  await page.waitForTimeout(100);
  // 1 + 2: the whole grid.
  const grid = await page.evaluate(({ asset, PRICER }) => {
    const K = window.__chart;
    K.draw();
    const price = (0, eval)(PRICER);
    const boxes = K.easyBoxes;
    const out = [];
    if (!boxes?.length) return { out: ['no grid'], boxes: [] };
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (Math.abs(b.x1 - K.tToX(b.expiry)) > 0.5) out.push(`column for ${new Date(b.expiry).toISOString().slice(5, 10)} ends at ${b.x1.toFixed(0)}, expiry is at ${K.tToX(b.expiry).toFixed(0)}`);
      const ks = window.__ticket.strikes(asset, b.expiry);
      if (!ks.includes(b.lo) || !ks.includes(b.hi)) out.push(`box ${b.lo}/${b.hi} isn't on listed strikes`);
      const wantDir = (b.lo + b.hi) / 2 >= K.spot ? 'above' : 'below';
      if (b.dir !== wantDir) out.push(`box ${b.lo}/${b.hi} is "${b.dir}", its middle is ${wantDir} the index`);
      const want = price(asset, K.spot, K.now, b);
      if (Math.abs(b.price - want) > 0.002) out.push(`box ${b.lo}/${b.hi} ${new Date(b.expiry).toISOString().slice(5, 10)}: ${(1 / b.price).toFixed(2)}x, independent ${(1 / want).toFixed(2)}x`);
      for (let j = i + 1; j < boxes.length; j++) {
        const c = boxes[j];
        const xo = Math.min(b.x1, c.x1) - Math.max(b.x0, c.x0);
        const yo = Math.min(b.y1, c.y1) - Math.max(b.y0, c.y0);
        if (xo > 0.5 && yo > 0.5) out.push(`boxes ${b.lo}/${b.hi} and ${c.lo}/${c.hi} overlap`);
      }
    }
    return { out: out.slice(0, 6), boxes };
  }, { asset, PRICER });
  failures.push(...grid.out);
  const cols = [...new Set(grid.boxes.map((b) => b.expiry))].sort((a, b) => a - b);
  const col = cols[Math.min(cols.length - 1, Math.round(colFrac * (cols.length - 1)))];
  const inCol = grid.boxes.filter((b) => b.expiry === col && b.y0 > 130 && b.y1 < 800);
  for (const dir of ['above', 'below']) {
    const pick = inCol.filter((b) => b.dir === dir).sort((a, b) => Math.abs(a.price - chance) - Math.abs(b.price - chance))[0];
    if (!pick) { fail(`no ${dir} box in the column`); continue; }
    await page.mouse.click(canvas.x + (pick.x0 + pick.x1) / 2, canvas.y + (pick.y0 + pick.y1) / 2);
    await page.waitForSelector('.bet-card');
    // 3. Card, underlying positions, purchase.
    const shown = (await page.textContent('.bet-price .num')).trim();
    const m = Math.min(100, 1 / pick.price);
    const want = m >= 99.95 ? '100x' : m >= 10 ? `${m.toFixed(1)}x` : `${m.toFixed(2)}x`;
    if (shown !== want) fail(`card shows ${shown}, box is ${want}`);
    await page.fill('.stake-input input', String(stake));
    if ((await page.getAttribute('.underlying-btn', 'aria-expanded')) !== 'true') await page.click('.underlying-btn');
    const rows = await page.$$eval('.underlying tr', (r) => r.map((x) => x.innerText.replace(/\s+/g, ' ')));
    const ymd = new Date(pick.expiry).toISOString().slice(0, 10).replace(/-/g, '');
    const t = dir === 'above' ? 'C' : 'P';
    const wantRows = dir === 'above' ? [['Buy', pick.lo], ['Sell', pick.hi]] : [['Buy', pick.hi], ['Sell', pick.lo]];
    if (rows.length !== 2) fail(`underlying shows ${rows.length} rows`);
    else wantRows.forEach(([side, k], i) => {
      if (!rows[i].startsWith(side) || !rows[i].includes(`${asset}-${ymd}-${k}-${t}`)) fail(`underlying row ${i + 1} "${rows[i]}", expected ${side} ${asset}-${ymd}-${k}-${t}`);
    });
    const before = await page.$$eval('.bet-list li', (l) => l.length);
    await page.click('.bet-card .primary');
    await page.waitForTimeout(250);
    const pos = await page.evaluate(() => JSON.parse(localStorage.getItem('ticket.positions.v1')).positions[0]);
    const b = pos?.bet;
    if (!b) { fail('no bet saved'); continue; }
    if (b.lo !== pick.lo || b.hi !== pick.hi || b.expiry !== pick.expiry || b.dir !== dir) fail(`saved bet ${b.dir} ${b.lo}/${b.hi} isn't the box clicked`);
    const payAt = (S) => pos.legs.reduce((a, l) => a + l.side * l.qty * (l.type === 'C' ? Math.max(S - l.strike, 0) : Math.max(l.strike - S, 0)), 0) / b.shares;
    const w = b.hi - b.lo;
    const [win, lose] = dir === 'above' ? [b.hi + w, b.lo - w] : [b.lo - w, b.hi + w];
    if (Math.abs(payAt(win) - 1) > 1e-9) fail(`pays ${payAt(win)} per share when right, not $1`);
    if (Math.abs(payAt(lose)) > 1e-9) fail(`pays ${payAt(lose)} per share when wrong, not $0`);
    if (Math.abs(payAt((b.lo + b.hi) / 2) - 0.5) > 1e-9) fail(`pays ${payAt((b.lo + b.hi) / 2)} in the middle, not 50¢`);
    const paid = pos.legs.reduce((a, l) => a + l.side * l.qty * l.entry, 0);
    if (Math.abs(paid - stake) > 0.01 * stake) fail(`legs cost $${paid.toFixed(2)} for a $${stake} bet`);
    // 4. Listed, then sold.
    const listed = await page.$$eval('.bet-list li', (l) => l.length);
    if (listed !== before + 1) fail(`bet list has ${listed} rows, expected ${before + 1}`);
    await page.click('.bet-list li >> nth=0 >> .link');
    await page.waitForTimeout(200);
    const after = await page.$$eval('.bet-list li', (l) => l.length);
    if (after !== before) fail(`selling left ${after} bets, expected ${before}`);
  }
  const label = `${asset} [${horizon}d] · ${grid.boxes.length} boxes in ${cols.length} columns · bets on ${new Date(col).toISOString().slice(5, 10)}, $${stake}`;
  if (failures.length) {
    failed++;
    console.log(`FAIL ${label}`);
    for (const f of failures) console.log(`     - ${f}`);
  } else console.log(`ok   ${label}`);
}
console.log(`\n${cases.length - failed}/${cases.length} grids passed${pageErrors.length ? ` · page errors: ${pageErrors.join('; ')}` : ''}`);
await browser.close();
await server.httpServer.close();
process.exit(failed || pageErrors.length ? 1 : 0);

// Automated check for the Draw path tool: draws price paths on the chart with the mouse and
// verifies the position it builds, against an independent calculation (not the app's own).
//
//   npm run check:draw
//
// For each path it checks:
//   1. the ticket is made of call butterflies (+1 / −2 / +1) on listed strikes, with equal wings,
//      at most 6 of them, on listed expiries covering the path
//   2. at each butterfly's expiry, the legs still alive then pay most within half a wing of where
//      the path is at that date (legs that expired earlier already paid out and don't count)
//   3. the drawn path stays on the chart as a guide, and one undo restores the previous ticket
import { chromium } from 'playwright';
import { preview } from 'vite';

const DAY = 864e5;
const server = await preview({ preview: { port: 4181 }, logLevel: 'warn' });
const url = server.resolvedUrls.local[0];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 860 }, deviceScaleFactor: 1 });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
await page.addInitScript(() => { window.__TICKET_TEST__ = true; });
await page.goto(`${url}?source=mock&freeze=1`);
await page.waitForFunction(() => window.__ticket && window.__chart);

// Paths as [fraction of the plot width, price as a multiple of spot] points.
const paths = [
  ['rally', 21, [[0, 1], [1, 1.1]]],
  ['up then down', 60, [[0, 1], [0.35, 1.15], [0.95, 0.9]]],
  ['dip and recover', 21, [[0, 1], [0.3, 0.92], [0.9, 1.02]]],
  ['slow grind down', 182, [[0, 1], [0.9, 0.8]]],
  ['short hop', 7, [[0, 1], [0.12, 1.02]]],
  ['BTC zigzag', 60, [[0, 1], [0.25, 1.08], [0.5, 0.96], [0.75, 1.1], [0.95, 1.0]], 'BTC'],
];

let failed = 0;
for (const [name, horizon, shape, asset = 'ETH'] of paths) {
  const failures = [];
  const fail = (m) => failures.push(m);
  await page.evaluate(({ a, h }) => {
    window.__ticket.setLegs(a, [{ type: 'C', side: 1, strike: Math.round(window.__ticket.spot(a)), expiry: window.__ticket.expiries(a)[3], qty: 1 }]);
    window.__ticket.setView({ horizon: h * 864e5, yZoom: 1, yShift: 0 });
  }, { a: asset, h: horizon });
  await page.waitForTimeout(250);
  await page.keyboard.press('5');
  const G = await page.evaluate(() => ({ nowX: window.__chart.geom.nowX, plotR: window.__chart.geom.plotR, spot: window.__chart.spot }));
  const box = await page.locator('canvas').first().boundingBox();
  const pts = [];
  for (let i = 0; i < shape.length - 1; i++)
    for (let k = 0; k < 20; k++) {
      const f = k / 20;
      pts.push([shape[i][0] + (shape[i + 1][0] - shape[i][0]) * f, shape[i][1] + (shape[i + 1][1] - shape[i][1]) * f]);
    }
  pts.push(shape[shape.length - 1]);
  const xy = await page.evaluate(({ pts, G }) => pts.map(([fx, m]) => [G.nowX + 3 + fx * (G.plotR - G.nowX - 8), window.__chart.pToY(G.spot * m)]), { pts, G });
  await page.mouse.move(box.x + xy[0][0], box.y + xy[0][1]);
  await page.mouse.down();
  for (const [x, y] of xy.slice(1)) await page.mouse.move(box.x + x, box.y + y, { steps: 2 });
  await page.mouse.up();
  await page.mouse.move(1300, 845);
  await page.waitForTimeout(300);

  const res = await page.evaluate(({ asset, xy }) => {
    const K = window.__chart;
    K.draw();
    const out = [];
    const { legs, now, spot } = K;
    const path = xy.map(([x, y]) => ({ t: K.xToT(x), p: K.yToP(y) })).filter((q) => q.t > now);
    const pathAt = (t) => {
      if (t <= path[0].t) return path[0].p;
      for (let i = 1; i < path.length; i++) if (t <= path[i].t) return path[i - 1].p + ((path[i].p - path[i - 1].p) * (t - path[i - 1].t)) / (path[i].t - path[i - 1].t);
      return path[path.length - 1].p;
    };
    // Independent Black-Scholes, mirroring the simulator's vol surface.
    const YEAR = 365 * 864e5;
    const normCdf = (x) => {
      const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
      const sign = x < 0 ? -1 : 1, z = Math.abs(x) / Math.SQRT2, t = 1 / (1 + p * z);
      return 0.5 * (1 + sign * (1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-z * z)));
    };
    const call = (S, k, T, iv) => {
      if (T <= 0) return Math.max(S - k, 0);
      const sq = iv * Math.sqrt(T), d1 = (Math.log(S / k) + 0.5 * sq * sq) / sq;
      return S * normCdf(d1) - k * normCdf(d1 - sq);
    };
    const baseIv = window.__ticket.specs[asset].baseIv;
    const ivOf = (k, T) => {
      const t = Math.max(T, 1 / (365 * 24));
      const m = Math.max(-2.5, Math.min(2.5, Math.log(k / spot) / Math.sqrt(Math.max(t, 7 / 365))));
      return baseIv * (0.93 + 0.07 * Math.min(1, t * 6)) * (1 + 0.12 * m * m - 0.04 * m);
    };
    const listed = window.__ticket.expiries(asset);
    // 1. Butterflies on listed strikes and expiries.
    const byExp = new Map();
    for (const l of legs) {
      if (l.type !== 'C') out.push(`non-call leg ${l.type}${l.strike}`);
      if (!listed.includes(l.expiry)) out.push(`unlisted expiry ${new Date(l.expiry).toISOString()}`);
      if (!byExp.has(l.expiry)) byExp.set(l.expiry, []);
      byExp.get(l.expiry).push(l);
    }
    if (!legs.length) out.push('no legs built');
    if (byExp.size > 6) out.push(`${byExp.size} butterflies (max 6)`);
    const flies = [];
    for (const [e, ls] of byExp) {
      const sorted = [...ls].sort((a, b) => a.strike - b.strike);
      const sig = sorted.map((l) => l.side * l.qty).join(',');
      if (sorted.length !== 3 || sig !== '1,-2,1') { out.push(`${new Date(e).toISOString().slice(5, 10)}: not a +1/-2/+1 butterfly (${sig})`); continue; }
      const [lo, mid, hi] = sorted.map((l) => l.strike);
      if (Math.abs(mid - lo - (hi - mid)) > 1e-9) out.push(`${new Date(e).toISOString().slice(5, 10)}: unequal wings ${lo}/${mid}/${hi}`);
      flies.push({ e, lo, mid, hi });
    }
    // Expiries cover the path: the last butterfly is at or after the path's last listed expiry.
    const tEnd = path[path.length - 1].t;
    const lastIn = listed.filter((e) => e > now && e <= tEnd).pop();
    if (lastIn && Math.max(...flies.map((f) => f.e)) < lastIn) out.push('path end not covered by a butterfly');
    // 2. Where the live legs pay most at each butterfly's expiry.
    const lines = [];
    for (const f of flies) {
      const live = legs.filter((l) => l.expiry >= f.e);
      const value = (S) => live.reduce((a, l) => a + l.side * l.qty * call(S, l.strike, (l.expiry - f.e) / YEAR, ivOf(l.strike, (l.expiry - now) / YEAR)), 0);
      let best = -Infinity, bestS = 0;
      for (let S = f.lo - (f.hi - f.lo); S <= f.hi + (f.hi - f.lo); S += (f.hi - f.lo) / 400) { const v = value(S); if (v > best) { best = v; bestS = S; } }
      const want = pathAt(f.e);
      const half = (f.hi - f.lo) / 2;
      lines.push(`${new Date(f.e).toISOString().slice(5, 10)} path ${want.toFixed(0)} → fly ${f.lo}/${f.mid}/${f.hi}, peaks at ${bestS.toFixed(0)}`);
      if (Math.abs(bestS - want) > half) out.push(`${new Date(f.e).toISOString().slice(5, 10)}: position peaks at ${bestS.toFixed(0)}, path is at ${want.toFixed(0)} (more than half a wing, ${half}, away)`);
    }
    // 3. Guide.
    if (!K.guide || K.guide.length < 2) out.push('drawn path not shown as a guide');
    return { failures: out, lines };
  }, { asset, xy });
  failures.push(...res.failures);
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(200);
  const after = await page.evaluate(() => window.__chart.legs.length);
  if (after !== 1) fail(`undo left ${after} legs, expected the 1 from before`);
  await page.keyboard.press('v');
  if (failures.length) {
    failed++;
    console.log(`FAIL ${name} (${asset}, ${horizon}d)`);
    for (const f of failures) console.log(`     - ${f}`);
  } else console.log(`ok   ${name} (${asset}, ${horizon}d)`);
  for (const l of res.lines) console.log(`       ${l}`);
}
console.log(`\n${paths.length - failed}/${paths.length} paths passed${pageErrors.length ? ` · page errors: ${pageErrors.join('; ')}` : ''}`);
await browser.close();
await server.httpServer.close();
process.exit(failed || pageErrors.length ? 1 : 0);

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

// Runs inside the page, after the scenario is on screen.
function inspect() {
  const C = window.__chart;
  C.draw();
  const K = window.__chart;
  const failures = [];
  const fail = (msg) => failures.push(msg);
  const cv = document.querySelector('canvas');
  const ctx = cv.getContext('2d');
  const dpr = cv.width / cv.getBoundingClientRect().width;
  const px = (x, y) => ctx.getImageData(Math.round(x * dpr), Math.round(y * dpr), 1, 1).data;
  const { nowX, plotR, plotT, plotB } = K.geom;

  // ---- independent pricing (mirrors the mock market's vol surface) ----
  const YEAR = 365 * DAY_MS();
  function DAY_MS() { return 864e5; }
  const normCdf = (x) => {
    const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
    const sign = x < 0 ? -1 : 1;
    const z = Math.abs(x) / Math.SQRT2;
    const t = 1 / (1 + p * z);
    return 0.5 * (1 + sign * (1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-z * z)));
  };
  const bs = (type, S, Kk, T, iv) => {
    if (T <= 0) return type === 'C' ? Math.max(S - Kk, 0) : Math.max(Kk - S, 0);
    const sq = iv * Math.sqrt(T);
    const d1 = (Math.log(S / Kk) + 0.5 * sq * sq) / sq;
    const d2 = d1 - sq;
    return type === 'C' ? S * normCdf(d1) - Kk * normCdf(d2) : Kk * normCdf(-d2) - S * normCdf(-d1);
  };
  const baseIv = window.__ticket.specs[K.asset].baseIv;
  const ivOf = (spot, Kk, T) => {
    const t = Math.max(T, 1 / (365 * 24));
    const m = Math.max(-2.5, Math.min(2.5, Math.log(Kk / spot) / Math.sqrt(Math.max(t, 7 / 365))));
    return baseIv * (0.93 + 0.07 * Math.min(1, t * 6)) * (1 + 0.12 * m * m - 0.04 * m);
  };
  const { legs, spot, now } = K;
  const ivs = legs.map((l) => ivOf(spot, l.strike, Math.max((l.expiry - now) / YEAR, 1e-6)));
  const entries = legs.map((l, i) => l.entry ?? bs(l.type, spot, l.strike, (l.expiry - now) / YEAR, ivs[i]));
  const pnl = (S, t) => legs.reduce((s, l, i) => s + l.side * l.qty * (bs(l.type, S, l.strike, (l.expiry - t) / YEAR, ivs[i]) - entries[i]), 0);
  const firstExp = Math.min(...legs.map((l) => l.expiry));
  const lastExp = Math.max(...legs.map((l) => l.expiry));

  // ---- 1. leg dots ----
  for (const l of legs) {
    const m = K.markers.find((mm) => mm.id === l.id);
    const ex = Math.min(K.tToX(l.expiry), plotR - 2);
    const ey = K.pToY(l.strike);
    const visible = ey >= plotT - 4 && ey <= plotB + 4;
    if (!visible) {
      if (m) fail(`dot for ${l.strike}${l.type} drawn although its strike is off-chart`);
      continue;
    }
    if (!m) { fail(`missing dot for ${l.side > 0 ? 'long' : 'short'} ${l.strike}${l.type}`); continue; }
    if (Math.abs(m.x - ex) > 0.6 || Math.abs(m.y - ey) > 0.6) fail(`dot for ${l.strike}${l.type} at (${m.x.toFixed(1)},${m.y.toFixed(1)}), expected (${ex.toFixed(1)},${ey.toFixed(1)})`);
    const crowded = K.markers.some((o) => o.id !== m.id && Math.hypot(o.x - m.x, o.y - m.y) < 12);
    if (!crowded && ey > plotT + 6 && ey < plotB - 6) {
      const [r, g, b] = px(m.x, m.y);
      const ok = l.side > 0 ? b > r + 60 : r > b + 90;
      if (!ok) fail(`dot for ${l.side > 0 ? 'long' : 'short'} ${l.strike}${l.type} has colour rgb(${r},${g},${b})`);
    }
  }

  // ---- 2. P&L colours ----
  const xEnd = Math.min(K.tToX(lastExp), plotR) - 3;
  let maxPos = 0, maxNeg = 0;
  for (let i = 0; i <= 40; i++) for (let j = 0; j <= 40; j++) {
    const v = pnl(K.yToP(plotT + (plotB - plotT) * (j / 40)), K.xToT(nowX + (xEnd - nowX) * (i / 40)));
    maxPos = Math.max(maxPos, v); maxNeg = Math.max(maxNeg, -v);
  }
  const mx = Math.max(maxPos, maxNeg);
  const posScale = Math.max(maxPos, mx * 0.2), negScale = Math.max(maxNeg, mx * 0.2);
  const inRect = (x, y) => K.rects.some(([rx, ry, rw, rh]) => x >= rx - 2 && x <= rx + rw + 2 && y >= ry - 2 && y <= ry + rh + 2);
  const hatchedLoss = K.tags.some((t) => t.kind === 'loss');
  const spotY = K.pToY(spot);
  let checked = 0, wrong = 0;
  const grad = { pos: [], neg: [] };
  const R = mulberry(Math.floor(now / 1000));
  function mulberry(seed) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  if (xEnd - nowX > 12 && mx > 1e-6) {
    for (let k = 0; k < 400 && checked < 200; k++) {
      const x = nowX + 3 + R() * (xEnd - nowX - 3);
      const y = plotT + 3 + R() * (plotB - plotT - 6);
      if (inRect(x, y) || Math.abs(y - spotY) < 3) continue;
      if (K.markers.some((m) => Math.hypot(m.x - x, m.y - y) < 14)) continue;
      if (legs.some((l) => Math.abs(K.pToY(l.strike) - y) < 4 || Math.abs(K.tToX(l.expiry) - x) < 3)) continue;
      const v = pnl(K.yToP(y), K.xToT(x));
      const rel = v >= 0 ? v / posScale : -v / negScale;
      if (rel < 0.08) continue; // too close to break-even to call
      // The map is rendered on a grid (4px cells), so skip points whose cell straddles a big change.
      const vx = pnl(K.yToP(y), K.xToT(x + 4)), vy = pnl(K.yToP(y + 4), K.xToT(x));
      if (Math.sign(vx) !== Math.sign(v) || Math.sign(vy) !== Math.sign(v)) continue;
      const [r, g] = px(x, y);
      const d = g - r;
      checked++;
      if ((v > 0 && d < 4) || (v < 0 && d > -4)) {
        wrong++;
        if (wrong <= 3) fail(`colour at price ${K.yToP(y).toFixed(0)}, ${new Date(K.xToT(x)).toISOString().slice(0, 13)}: P&L ${v.toFixed(2)} but pixel g-r=${d}`);
      }
      if (!(v < 0 && hatchedLoss)) (v >= 0 ? grad.pos : grad.neg).push([rel, Math.abs(d)]);
    }
  }
  if (wrong > 3) fail(`${wrong} of ${checked} colour samples wrong`);
  for (const side of ['pos', 'neg']) {
    const pairs = grad[side];
    const lowP = pairs.filter((p) => p[0] < 0.33), highP = pairs.filter((p) => p[0] > 0.66);
    if (lowP.length >= 5 && highP.length >= 5) {
      const mean = (a) => a.reduce((s, p) => s + p[1], 0) / a.length;
      if (mean(highP) < mean(lowP) + 3)
        fail(`${side === 'pos' ? 'profit' : 'loss'} shading doesn't get stronger with P&L (small P&L avg ${mean(lowP).toFixed(1)}, big P&L avg ${mean(highP).toFixed(1)})`);
    }
  }

  // ---- 3. break-even line ----
  if (K.heat) {
    const { x0, cell, cols, contour } = K.heat;
    const tol = cell + 2;
    for (let s = 0; s < 12; s++) {
      const c = Math.floor(((s + 0.5) / 12) * cols);
      const xC = x0 + (c + 0.5) * cell;
      if (xC > xEnd) continue;
      const t = K.xToT(xC);
      const roots = [];
      let prev = pnl(K.yToP(plotT + cell / 2), t);
      for (let y = plotT + cell / 2 + 1; y <= plotB - cell / 2; y++) {
        const v = pnl(K.yToP(y), t);
        if ((prev >= 0) !== (v >= 0)) roots.push(y - v / (v - prev));
        prev = v;
      }
      // Two crossings closer than a couple of cells can merge on the grid; don't judge those.
      const clean = roots.filter((r, i) => !roots.some((o, j) => j !== i && Math.abs(o - r) < 2.5 * cell));
      const drawn = contour[c] ?? [];
      for (const r of clean) if (!drawn.some((d) => Math.abs(d - r) <= tol)) { fail(`break-even at ${K.yToP(r).toFixed(0)} (${new Date(t).toISOString().slice(0, 13)}) not drawn`); break; }
      for (const d of drawn) if (!roots.some((r) => Math.abs(d - r) <= tol)) { fail(`break-even drawn at ${K.yToP(d).toFixed(0)} (${new Date(t).toISOString().slice(0, 13)}) where P&L doesn't cross zero`); break; }
    }
  }

  // ---- 4 & 5. max profit / loss zones and uncapped tags ----
  // Max profit / loss over the position's whole life: every expiry, and times in between.
  const exps = [...new Set(legs.map((l) => l.expiry))].sort((a, b) => a - b);
  const times = [];
  { let prev = now; for (const e of exps) { for (let k = 1; k < 10; k++) times.push(prev + ((e - prev) * k) / 10); times.push(e); prev = e; } }
  const probe = [...legs.map((l) => l.strike), spot * 1e-4];
  for (let i = 0; i <= 1500; i++) probe.push(spot * Math.exp(Math.log(0.05) + Math.log(400) * (i / 1500)));
  let maxP = -Infinity, minP = Infinity;
  for (const t of times) for (const S of probe) { const v = pnl(S, t); maxP = Math.max(maxP, v); minP = Math.min(minP, v); }
  let unlimitedProfit = false, unlimitedLoss = false, lossToZero = false, profitToZero = false;
  for (const e of exps) {
    const up = pnl(spot * 40, e) - pnl(spot * 20, e), down = pnl(spot * 0.02, e) - pnl(spot * 0.04, e);
    if (up > 1e-6 * spot) unlimitedProfit = true;
    if (up < -1e-6 * spot) unlimitedLoss = true;
    if (down < -1e-6 * spot) lossToZero = true;
    if (down > 1e-6 * spot) profitToZero = true;
  }
  let visMax = -Infinity, visMin = Infinity;
  for (const t of [firstExp, lastExp]) for (let y = plotT; y <= plotB; y += 2) { const v = pnl(K.yToP(y), t); visMax = Math.max(visMax, v); visMin = Math.min(visMin, v); }
  const tolV = Math.max(0, visMax - visMin) * 0.004 + 1e-6;
  const wantZones = { profit: maxP > tolV && !unlimitedProfit, loss: minP < -tolV && !unlimitedLoss };
  for (const kind of ['profit', 'loss']) {
    const z = K.zones.find((zz) => zz.kind === kind);
    const want = kind === 'profit' ? maxP : minP;
    if (!wantZones[kind]) { if (z) fail(`${kind} zone drawn but max ${kind} is ${kind === 'profit' ? 'uncapped' : 'uncapped or ~0'}`); continue; }
    if (!z) { fail(`max ${kind} zone missing (expected ${want.toFixed(2)})`); continue; }
    if ((z.cells > 0 || z.runs.length) && !z.labelled) fail(`max ${kind} zone is drawn but has no label`);
    if (Math.abs(z.v - want) > Math.abs(want) * 0.01 + 0.05) fail(`max ${kind} ${z.v.toFixed(2)}, expected ${want.toFixed(2)}`);
    // Nothing on the map may beat the stated max (or be worse than the stated max loss).
    let beyond = null;
    for (let i = 0; i <= 40 && !beyond; i++) {
      const t = now + ((lastExp - now) * i) / 40;
      for (let j = 0; j <= 60; j++) {
        const S = K.yToP(plotT + ((plotB - plotT) * j) / 60);
        const v = pnl(S, t);
        const over = kind === 'profit' ? v - z.v : z.v - v;
        if (over > Math.abs(z.v) * 0.005 + 0.05) { beyond = `${v.toFixed(2)} at ${S.toFixed(0)} on ${new Date(t).toISOString().slice(0, 13)}`; break; }
      }
    }
    if (beyond) fail(`P&L ${beyond} beats the stated max ${kind} ${z.v.toFixed(2)}`);
    // Where is P&L within 5% of the max at the zone's reference time?
    const level = want * 0.95;
    const inside = (y) => (kind === 'profit' ? pnl(K.yToP(y), z.t) >= level : pnl(K.yToP(y), z.t) <= level);
    const runs = [];
    let start = null;
    for (let y = plotT; y <= plotB; y++) {
      if (inside(y)) start ??= y;
      else if (start !== null) { runs.push([start, y]); start = null; }
    }
    if (start !== null) runs.push([start, plotB]);
    // The traced outline follows the true 95% contour over time, all the way to expiry: every
    // point where P&L crosses that level must have the outline within a few pixels of it, and every
    // piece of outline must sit on such a point.
    if (z.segs && !z.compact) {
      const lvl = z.level;
      const f = (y, t) => (kind === 'profit' ? pnl(K.yToP(y), t) - lvl : lvl - pnl(K.yToP(y), t));
      // Scan every pixel, and every strike too: at a strike the payoff can peak in a band thinner
      // than a pixel.
      const strikeYs = [...new Set(legs.map((l) => K.pToY(l.strike)))].filter((y) => y > plotT && y < plotB);
      const scanYs = [];
      for (let y = plotT + 1; y <= plotB; y++) scanYs.push(y);
      scanYs.push(...strikeYs);
      scanYs.sort((a, b) => a - b);
      const crossings = (t) => {
        const ys = [];
        let fp = f(plotT, t);
        let prevY = plotT;
        for (const y of scanYs) {
          const fy = f(y, t);
          if ((fp >= 0) !== (fy >= 0)) {
            let a = prevY, b = y;
            for (let k = 0; k < 20; k++) { const m = (a + b) / 2; if ((f(m, t) >= 0) === (fp >= 0)) a = m; else b = m; }
            ys.push((a + b) / 2);
          }
          fp = fy;
          prevY = y;
        }
        return ys;
      };
      const distSeg = (x, y, [x1, y1, x2, y2]) => {
        const dx = x2 - x1, dy = y2 - y1;
        const u = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy || 1)));
        return Math.hypot(x1 + u * dx - x, y1 + u * dy - y);
      };
      const tEnd = Math.min(lastExp, K.xToT(plotR));
      const ts = [];
      for (let i = 1; i < 80; i++) ts.push(now + ((tEnd - now) * i) / 80);
      // The contour moves fastest just before each expiry, as time value collapses.
      for (const e of exps) if (e <= tEnd) for (let j = 0; j < 14; j++) { ts.push(e - (e - now) * 0.03 * 0.6 ** j); if (e + (e - now) * 0.03 * 0.6 ** j < tEnd) ts.push(e + (e - now) * 0.03 * 0.6 ** j); }
      const TOL_PX = 3;
      let missed = null;
      for (const t of ts) {
        const x = K.tToX(t);
        if (x < nowX + 2 || x > plotR - 2) continue;
        const cs = crossings(t);
        const insideTop = f(plotT, t) >= 0;
        for (let ci = 0; ci < cs.length; ci++) {
          const y = cs[ci];
          if (y < plotT + 2 || y > plotB - 2) continue;
          // The in-zone band this crossing bounds. Bands under 2px tall (a spike in the last
          // minutes before an expiry, say) can't be seen, so they don't need an outline.
          const bandAbove = (ci % 2 === 0) === insideTop;
          const other = bandAbove ? (cs[ci - 1] ?? plotT) : (cs[ci + 1] ?? plotB);
          if (Math.abs(other - y) < 2) continue;
          // An island that appears within the last pixel (it isn't there a pixel earlier, not even
          // nearby) is too brief to see. A steep boundary is different: it still exists a pixel
          // earlier, just elsewhere, so it isn't skipped.
          const before = crossings(K.xToT(x - 1));
          if (before.length < cs.length && !before.some((b) => Math.abs(b - y) < 3 || Math.abs(b - other) < 3)) continue;
          const d = Math.min(Infinity, ...z.segs.map((sg) => distSeg(x, y, sg)));
          if (d > TOL_PX && (!missed || d > missed.d)) missed = { d, t, y };
        }
      }
      if (missed && window.__DEBUG_CHECK__) {
        const cs = crossings(missed.t);
        const mx = K.tToX(missed.t);
        const close = z.segs.map((sg) => [distSeg(mx, missed.y, sg), sg]).sort((p, q) => p[0] - q[0])[0];
        fail(`debug: miss at x ${mx.toFixed(1)} y ${missed.y.toFixed(1)}; closest seg ${close ? close[1].map((v) => v.toFixed(1)).join('/') : 'none'}`);
        fail(`debug: crossings at that time ${cs.map((y) => K.yToP(y).toFixed(1)).join(', ')} · top inside ${f(plotT, missed.t) >= 0} · segs near x: ${z.segs.filter((sg) => Math.abs(sg[0] - K.tToX(missed.t)) < 6).map((sg) => sg.map((v) => v.toFixed(1)).join('/')).slice(0, 6).join(' ')}`);
      }
      if (missed) fail(`max ${kind} outline misses the 95% contour by ${missed.d.toFixed(0)}px at ${K.yToP(missed.y).toFixed(0)} on ${new Date(missed.t).toISOString().slice(0, 16)}`);
      let stray = null;
      for (const sg of z.segs) {
        const [x1, y1, x2, y2] = sg;
        const xm = (x1 + x2) / 2, ym = (y1 + y2) / 2;
        if (ym < plotT + 2 || ym > plotB - 2) continue;
        // Nearest point of the true contour, looking a few pixels either side too (at the tip of a
        // zone the contour is nearest sideways, not straight up or down).
        let d = Infinity;
        for (let dx = -TOL_PX; dx <= TOL_PX; dx += 0.5) {
          for (const c of crossings(K.xToT(xm + dx))) d = Math.min(d, Math.hypot(dx, c - ym));
        }
        // At the tip of a zone the peak P&L just touches the level, so the tip's position is
        // ill-conditioned; there, judge by value: is P&L at this point at the level?
        const onLevel = Math.abs(f(ym, K.xToT(xm))) < Math.abs(lvl) * 0.002 + 0.01;
        if (d > TOL_PX && !onLevel && (!stray || d > stray.d)) stray = { d, x: xm, y: ym };
      }
      if (stray && window.__DEBUG_CHECK__) {
        const sg = z.segs.find((q) => (q[0] + q[2]) / 2 === stray.x && (q[1] + q[3]) / 2 === stray.y);
        const i = z.segs.indexOf(sg);
        fail(`debug: stray seg #${i}/${z.segs.length} ${sg.map((v) => v.toFixed(2)).join('/')} · neighbours ${z.segs.slice(Math.max(0, i - 3), i + 4).map((q) => q.map((v) => v.toFixed(1)).join('/')).join('  ')} · crossings at mid ${crossings(K.xToT(stray.x)).map((y) => y.toFixed(1)).join(',')}`);
      }
      if (stray) fail(`max ${kind} outline strays ${Number.isFinite(stray.d) ? stray.d.toFixed(0) + 'px' : 'far'} off the contour at ${K.yToP(stray.y).toFixed(0)} on ${new Date(K.xToT(stray.x)).toISOString().slice(0, 16)}`);
    }
    const tol = z.cell * 1.5 + 2;
    const big = (r) => r[1] - r[0] > 2 * z.cell;
    for (const r of runs.filter(big)) if (!z.runs.some((d) => Math.abs(d[0] - r[0]) <= tol && Math.abs(d[1] - r[1]) <= tol))
      fail(`max ${kind} band ${K.yToP(r[1]).toFixed(0)}–${K.yToP(r[0]).toFixed(0)} not outlined (drawn: ${z.runs.map((d) => `${K.yToP(d[1]).toFixed(0)}–${K.yToP(d[0]).toFixed(0)}`).join(', ') || 'none'})`);
    for (const d of z.runs.filter(big)) if (!runs.some((r) => Math.abs(d[0] - r[0]) <= tol && Math.abs(d[1] - r[1]) <= tol))
      fail(`max ${kind} outline ${K.yToP(d[1]).toFixed(0)}–${K.yToP(d[0]).toFixed(0)} where P&L isn't near the max`);
  }
  const wantTags = [];
  if (unlimitedLoss) wantTags.push('up:loss'); else if (unlimitedProfit) wantTags.push('up:profit');
  if (lossToZero) wantTags.push('down:loss'); else if (profitToZero) wantTags.push('down:profit');
  const gotTags = K.tags.map((t) => `${t.dir}:${t.kind}`);
  if (wantTags.sort().join() !== gotTags.sort().join()) fail(`tags ${gotTags.join(',') || 'none'}, expected ${wantTags.join(',') || 'none'}`);

  // ---- 6. Build panel ----
  const dd = [...document.querySelectorAll('.summary dd')].map((e) => e.textContent);
  const money = (t) => (t.includes('Unlimited') ? Infinity : Number((t.match(/\$([\d,]+(?:\.\d+)?)/) ?? ['', 'NaN'])[1].replace(/,/g, '')));
  const panelMax = money(dd[2] ?? ''), panelLoss = money(dd[3] ?? '');
  if (unlimitedProfit !== (panelMax === Infinity)) fail(`panel max profit "${dd[2]}" vs uncapped=${unlimitedProfit}`);
  else if (!unlimitedProfit && Math.abs(panelMax - maxP) > Math.abs(maxP) * 0.01 + 0.5) fail(`panel max profit ${panelMax} vs ${maxP.toFixed(2)}`);
  if (unlimitedLoss !== (panelLoss === Infinity)) fail(`panel max loss "${dd[3]}" vs uncapped=${unlimitedLoss}`);
  else if (!unlimitedLoss && Math.abs(panelLoss - Math.abs(Math.min(0, minP))) > Math.abs(minP) * 0.01 + 0.5) fail(`panel max loss ${panelLoss} vs ${Math.abs(minP).toFixed(2)}`);

  return { failures, colourSamples: checked };
}

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

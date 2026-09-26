import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import type { OptType } from '../lib/bs';
import { bsPrice } from '../lib/bs';
import { compactUsd, price as fmtPrice, signedUsd } from '../lib/format';
import {
  DAY,
  HOUR,
  YEAR,
  impliedVol,
  snapStrike,
  type Candle,
  type Expiry,
  type MarketSpec,
} from '../lib/market';
import type { Leg, Model, Side } from '../lib/strategy';

export type Tool = 'pointer' | 'buyC' | 'sellC' | 'buyP' | 'sellP';

export const TOOL_LEG: Record<Exclude<Tool, 'pointer'>, { type: OptType; side: Side; label: string }> = {
  buyC: { type: 'C', side: 1, label: 'Buy Call' },
  sellC: { type: 'C', side: -1, label: 'Sell Call' },
  buyP: { type: 'P', side: 1, label: 'Buy Put' },
  sellP: { type: 'P', side: -1, label: 'Sell Put' },
};

export interface ChartView {
  horizon: number;
  yZoom: number;
  yShift: number;
}

interface Props {
  spec: MarketSpec;
  candles: Candle[];
  spot: number;
  now: number;
  expiries: Expiry[];
  /** Legs the user can drag / remove. */
  editableLegs: Leg[];
  /** Legs shown for context (open positions); included in the P&L map. */
  staticLegs: Leg[];
  model: Model;
  tool: Tool;
  selectedLegId: string | null;
  view: ChartView;
  onViewChange: (v: ChartView) => void;
  onAdd: (type: OptType, side: Side, strike: number, expiry: number) => void;
  onMove: (id: string, strike: number, expiry: number) => void;
  onSelect: (id: string | null) => void;
  onRemove: (id: string) => void;
}

const C = {
  bg: '#0c0f14',
  future: '#0f131a',
  grid: 'rgba(148,163,190,0.07)',
  gridStrong: 'rgba(148,163,190,0.16)',
  text: '#e3e7ee',
  muted: '#8390a3',
  dim: '#566174',
  candleUp: '#a9b4c7',
  candleDown: '#566174',
  long: '#6fa8ff',
  short: '#f0a94b',
  profit: [46, 201, 139] as const,
  loss: [239, 90, 85] as const,
  spot: '#e3e7ee',
  panel: '#161b24',
  line: '#2c3441',
};

const AXIS_W = 70;
const PROFILE_W = 92;
const TIME_H = 26;
const TOP_H = 28;
const PAST_FRAC = 0.3;
const CELL = 4;
const MONO = '"Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace';
const SANS = 'Geist, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';

interface Geom {
  w: number;
  h: number;
  plotR: number;
  plotT: number;
  plotB: number;
  nowX: number;
  lo: number;
  hi: number;
  tToX: (t: number) => number;
  xToT: (x: number) => number;
  pToY: (p: number) => number;
  yToP: (y: number) => number;
}

interface Marker {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface DragState {
  kind: 'leg' | 'axis';
  id?: string;
  startX: number;
  startY: number;
  startShift?: number;
  moved: boolean;
  strike?: number;
  expiry?: number;
}

function niceStep(range: number, target: number): number {
  const raw = range / target;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const n = raw / pow;
  return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * pow;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtTime(t: number, withHour: boolean): string {
  const d = new Date(t);
  const date = `${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
  if (!withHour) return date;
  return `${date} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

export function Chart(props: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sizeRef = useRef({ w: 0, h: 0, dpr: 1 });
  const propsRef = useRef(props);
  propsRef.current = props;
  const hoverRef = useRef<{ x: number; y: number } | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const markersRef = useRef<Marker[]>([]);
  const geomRef = useRef<Geom | null>(null);
  const heatRef = useRef<{ key: string; canvas: HTMLCanvasElement; maxAbs: number; contour: number[] } | null>(null);

  const computeGeom = useCallback((): Geom => {
    const { w, h } = sizeRef.current;
    const { spot, now, view, candles, spec } = propsRef.current;
    const plotR = w - AXIS_W - PROFILE_W;
    const plotT = TOP_H;
    const plotB = h - TIME_H;
    const nowX = plotR * PAST_FRAC;
    const pxPerMs = (plotR - nowX) / view.horizon;
    const tToX = (t: number) => nowX + (t - now) * pxPerMs;
    const xToT = (x: number) => now + (x - nowX) / pxPerMs;

    // Auto range: a ~2.2σ cone at the horizon, widened to fit visible history.
    const sd = spec.baseIv * Math.sqrt(view.horizon / YEAR);
    let lo = spot * Math.exp(-1.6 * sd);
    let hi = spot * Math.exp(1.6 * sd);
    const tMin = xToT(0);
    for (let i = candles.length - 1; i >= 0 && candles[i].t >= tMin; i--) {
      lo = Math.min(lo, candles[i].l);
      hi = Math.max(hi, candles[i].h);
    }
    const pad = (hi - lo) * 0.06;
    lo -= pad;
    hi += pad;
    const mid = (lo + hi) / 2 + (hi - lo) * view.yShift;
    const half = ((hi - lo) / 2) * view.yZoom;
    lo = Math.max(0, mid - half);
    hi = mid + half;
    const pToY = (p: number) => plotB - ((p - lo) / (hi - lo)) * (plotB - plotT);
    const yToP = (y: number) => lo + ((plotB - y) / (plotB - plotT)) * (hi - lo);
    return { w, h, plotR, plotT, plotB, nowX, lo, hi, tToX, xToT, pToY, yToP };
  }, []);

  /** Nearest listed expiry (by pixels) and strike for a point in the future region. */
  const snapAt = useCallback((g: Geom, x: number, y: number) => {
    const { expiries, now, spec } = propsRef.current;
    if (x < g.nowX + 2 || x > g.plotR || y < g.plotT || y > g.plotB) return null;
    let best: Expiry | null = null;
    let bestD = Infinity;
    for (const e of expiries) {
      const ex = g.tToX(e.ts);
      if (ex > g.plotR + 1) continue;
      const d = Math.abs(ex - x);
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
    if (!best) return null;
    return { expiry: best.ts, strike: snapStrike(spec, g.yToP(y), best.ts, now) };
  }, []);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const { w, h, dpr } = sizeRef.current;
    if (!canvas || w < 50 || h < 50) return;
    const ctx = canvas.getContext('2d')!;
    const p = propsRef.current;
    const { spec, candles, spot, now, expiries, model, editableLegs, staticLegs, tool, selectedLegId, view } = p;
    const g = computeGeom();
    geomRef.current = g;
    const { plotR, plotT, plotB, nowX, tToX, xToT, pToY, yToP } = g;
    const hover = hoverRef.current;
    const drag = dragRef.current;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = C.future;
    ctx.fillRect(nowX, plotT, plotR - nowX, plotB - plotT);

    // Legs as they'd be after an in-progress drag.
    const dragLeg = drag?.kind === 'leg' && drag.moved ? drag : null;
    const legs = model.legs;
    const legsForPnl = dragLeg
      ? legs.map((l) => (l.id === dragLeg.id ? { ...l, strike: dragLeg.strike!, expiry: dragLeg.expiry! } : l))
      : legs;
    const pnlFn = (S: number, t: number) => {
      let s = 0;
      for (let i = 0; i < legsForPnl.length; i++) {
        const l = legsForPnl[i];
        const iv = l === legs[i] ? model.ivs[i] : impliedVol(spec, spot, l.strike, Math.max((l.expiry - now) / YEAR, 1e-6));
        s += l.side * l.qty * (bsPrice(l.type, S, l.strike, (l.expiry - t) / YEAR, iv) - model.entries[i]);
      }
      return s;
    };

    // ---- P&L heat map over (time, price) ----
    // Only paint up to the last expiry: after that everything has settled.
    const lastExp = legsForPnl.length ? Math.max(...legsForPnl.map((l) => l.expiry)) : now;
    const heatR = Math.min(plotR, tToX(lastExp));
    const cols = Math.max(0, Math.ceil((heatR - nowX) / CELL));
    const rows = Math.ceil((plotB - plotT) / CELL);
    let maxAbs = 0;
    if (legsForPnl.length && cols > 0 && rows > 0) {
      const key = [
        legsForPnl.map((l) => `${l.type}${l.side}${l.strike}@${l.expiry}x${l.qty}`).join('|'),
        model.entries.map((e) => e.toFixed(4)).join(','),
        spot.toFixed(4),
        Math.floor(now / 30000),
        w,
        h,
        g.lo.toFixed(3),
        g.hi.toFixed(3),
        view.horizon,
      ].join('#');
      if (!heatRef.current || heatRef.current.key !== key) {
        const vals = new Float32Array(cols * rows);
        let mx = 0;
        for (let c = 0; c < cols; c++) {
          const t = xToT(nowX + (c + 0.5) * CELL);
          for (let r = 0; r < rows; r++) {
            const v = pnlFn(yToP(plotT + (r + 0.5) * CELL), t);
            vals[r * cols + c] = v;
            mx = Math.max(mx, Math.abs(v));
          }
        }
        const off = heatRef.current?.canvas ?? document.createElement('canvas');
        off.width = cols;
        off.height = rows;
        const octx = off.getContext('2d')!;
        const img = octx.createImageData(cols, rows);
        const contour: number[] = [];
        if (mx > 1e-9) {
          for (let i = 0; i < vals.length; i++) {
            const v = vals[i];
            const a = Math.pow(Math.abs(v) / mx, 0.75);
            const rgb = v >= 0 ? C.profit : C.loss;
            img.data[i * 4] = rgb[0];
            img.data[i * 4 + 1] = rgb[1];
            img.data[i * 4 + 2] = rgb[2];
            img.data[i * 4 + 3] = Math.round(255 * (0.05 + 0.5 * a));
          }
          // Break-even contour: where P&L changes sign between vertically adjacent cells.
          for (let c = 0; c < cols; c++) {
            for (let r = 0; r < rows - 1; r++) {
              const a = vals[r * cols + c];
              const b = vals[(r + 1) * cols + c];
              if ((a >= 0) !== (b >= 0)) {
                const f = a / (a - b);
                contour.push(nowX + c * CELL, plotT + (r + 0.5 + f) * CELL);
              }
            }
          }
        }
        octx.putImageData(img, 0, 0);
        heatRef.current = { key, canvas: off, maxAbs: mx, contour };
      }
      const heat = heatRef.current;
      maxAbs = heat.maxAbs;
      if (maxAbs > 1e-9) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(nowX, plotT, heatR - nowX, plotB - plotT);
        ctx.clip();
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(heat.canvas, nowX, plotT, cols * CELL, rows * CELL);
        ctx.fillStyle = 'rgba(227,231,238,0.55)';
        for (let i = 0; i < heat.contour.length; i += 2) ctx.fillRect(heat.contour[i], heat.contour[i + 1] - 0.6, CELL, 1.2);
        ctx.restore();
      }
    }

    // ---- Price grid + axis ----
    const pStep = niceStep(g.hi - g.lo, Math.max(3, (plotB - plotT) / 60));
    ctx.font = `11px ${MONO}`;
    ctx.textBaseline = 'middle';
    const spotY = pToY(spot);
    for (let v = Math.ceil(g.lo / pStep) * pStep; v <= g.hi; v += pStep) {
      const y = Math.round(pToY(v)) + 0.5;
      if (Math.abs(y - spotY) < 14) continue;
      ctx.strokeStyle = C.grid;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(plotR, y);
      ctx.stroke();
      ctx.fillStyle = C.muted;
      ctx.textAlign = 'left';
      ctx.fillText(fmtPrice(v, pStep < 1 ? 2 : 0), plotR + PROFILE_W + 8, y);
    }

    // ---- Time grid + axis ----
    const pxPerDay = (plotR - nowX) / (view.horizon / DAY);
    const tSteps = [HOUR, 2 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 7 * DAY, 14 * DAY, 30 * DAY];
    const tStep = tSteps.find((s) => (s / DAY) * pxPerDay >= 80) ?? 30 * DAY;
    const tStart = Math.ceil(xToT(0) / tStep) * tStep;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let t = tStart; tToX(t) < plotR; t += tStep) {
      const x = Math.round(tToX(t)) + 0.5;
      ctx.strokeStyle = C.grid;
      ctx.beginPath();
      ctx.moveTo(x, plotT);
      ctx.lineTo(x, plotB);
      ctx.stroke();
      if (Math.abs(x - nowX) > 40) {
        ctx.fillStyle = C.dim;
        ctx.fillText(fmtTime(t, tStep < DAY), x, plotB + TIME_H / 2);
      }
    }

    // ---- Expiry columns ----
    const snap = hover && tool !== 'pointer' && !drag ? snapAt(g, hover.x, hover.y) : null;
    const activeExpiry = dragLeg?.expiry ?? snap?.expiry;
    const legExpiries = new Set(legs.map((l) => l.expiry));
    const visible = expiries.filter((e) => tToX(e.ts) <= plotR);
    const placed: [number, number][] = [];
    const prio = { monthly: 0, weekly: 1, daily: 2 } as const;
    const ordered = [...visible].sort(
      (a, b) =>
        Number(b.ts === activeExpiry) - Number(a.ts === activeExpiry) ||
        Number(legExpiries.has(b.ts)) - Number(legExpiries.has(a.ts)) ||
        prio[a.kind] - prio[b.kind],
    );
    ctx.font = `600 10px ${MONO}`;
    for (const e of ordered) {
      const x = Math.round(tToX(e.ts)) + 0.5;
      const active = e.ts === activeExpiry;
      const used = legExpiries.has(e.ts);
      ctx.strokeStyle = active ? 'rgba(111,168,255,0.7)' : used ? C.gridStrong : 'rgba(148,163,190,0.10)';
      ctx.setLineDash(active || used ? [] : [3, 4]);
      ctx.beginPath();
      ctx.moveTo(x, plotT);
      ctx.lineTo(x, plotB);
      ctx.stroke();
      ctx.setLineDash([]);
      const label = e.label;
      const lw = ctx.measureText(label).width + 12;
      const lx = Math.min(plotR - lw / 2, Math.max(nowX + lw / 2, x));
      if (!active && placed.some(([a, b]) => lx + lw / 2 > a && lx - lw / 2 < b)) continue;
      placed.push([lx - lw / 2 - 3, lx + lw / 2 + 3]);
      roundRect(ctx, lx - lw / 2, 6, lw, 17, 4);
      ctx.fillStyle = active ? C.long : used ? C.line : C.panel;
      ctx.fill();
      ctx.fillStyle = active ? '#0c0f14' : e.kind === 'daily' ? C.muted : C.text;
      ctx.textAlign = 'center';
      ctx.fillText(label, lx, 15);
    }

    // ---- Candles (past) ----
    const pxPerHour = pxPerDay / 24;
    const bucketH = [1, 2, 4, 6, 12, 24, 48].find((b) => b * pxPerHour >= 5) ?? 48;
    const bucket = bucketH * HOUR;
    const tLeft = xToT(0) - bucket;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, plotT, nowX + 4, plotB - plotT);
    ctx.clip();
    let i0 = candles.length - 1;
    while (i0 > 0 && candles[i0 - 1].t >= tLeft) i0--;
    let bStart = Math.floor(candles[i0].t / bucket) * bucket;
    let agg: Candle | null = null;
    const bodyW = Math.max(1, bucketH * pxPerHour * 0.62);
    const flush = (cd: Candle) => {
      const x = tToX(cd.t + bucket / 2);
      const up = cd.c >= cd.o;
      ctx.strokeStyle = up ? C.candleUp : C.candleDown;
      ctx.fillStyle = up ? C.bg : C.candleDown;
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, pToY(cd.h));
      ctx.lineTo(Math.round(x) + 0.5, pToY(cd.l));
      ctx.stroke();
      const y1 = pToY(Math.max(cd.o, cd.c));
      const y2 = pToY(Math.min(cd.o, cd.c));
      const bh = Math.max(1, y2 - y1);
      ctx.fillRect(x - bodyW / 2, y1, bodyW, bh);
      if (up && bodyW > 2) ctx.strokeRect(x - bodyW / 2 + 0.5, y1 + 0.5, bodyW - 1, Math.max(0, bh - 1));
    };
    for (let i = i0; i < candles.length; i++) {
      const cd = candles[i];
      const b = Math.floor(cd.t / bucket) * bucket;
      if (!agg || b !== bStart) {
        if (agg) flush(agg);
        bStart = b;
        agg = { t: b, o: cd.o, h: cd.h, l: cd.l, c: cd.c };
      } else {
        agg.h = Math.max(agg.h, cd.h);
        agg.l = Math.min(agg.l, cd.l);
        agg.c = cd.c;
      }
    }
    if (agg) flush(agg);
    ctx.restore();

    // ---- Now line + spot ----
    ctx.strokeStyle = 'rgba(227,231,238,0.35)';
    ctx.beginPath();
    ctx.moveTo(Math.round(nowX) + 0.5, plotT);
    ctx.lineTo(Math.round(nowX) + 0.5, plotB);
    ctx.stroke();
    const sy = Math.round(pToY(spot)) + 0.5;
    ctx.setLineDash([2, 3]);
    ctx.strokeStyle = 'rgba(227,231,238,0.45)';
    ctx.beginPath();
    ctx.moveTo(0, sy);
    ctx.lineTo(plotR + PROFILE_W, sy);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = C.spot;
    ctx.beginPath();
    ctx.arc(nowX, sy, 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(227,231,238,0.15)';
    ctx.beginPath();
    ctx.arc(nowX, sy, 3.5 + 4 * ((now / 1000) % 1), 0, Math.PI * 2);
    ctx.fill();
    ctx.font = `600 10px ${MONO}`;
    ctx.fillStyle = C.muted;
    ctx.textAlign = 'center';
    ctx.fillText('NOW', nowX, plotB + TIME_H / 2);

    // ---- Payoff caps at the first expiry ----
    // A capped structure (spread, condor) plateaus at max profit / max loss. The heat map alone
    // just shows a flat colour there, so bracket the plateau and label it.
    if (legsForPnl.length && maxAbs > 1e-9) {
      const firstExp = Math.min(...legsForPnl.map((l) => l.expiry));
      const ex = Math.round(Math.min(tToX(firstExp), plotR - 2));
      let maxP = -Infinity;
      let minP = Infinity;
      for (let i = 0; i <= 600; i++) {
        const v = pnlFn(spot * Math.exp(Math.log(0.05) + Math.log(400) * (i / 600)), firstExp);
        maxP = Math.max(maxP, v);
        minP = Math.min(minP, v);
      }
      const tail = pnlFn(spot * 40, firstExp) - pnlFn(spot * 20, firstExp);
      const unlimitedProfit = tail > 1e-6 * spot;
      const unlimitedLoss = tail < -1e-6 * spot;
      const tol = (maxP - minP) * 0.004 + 1e-6;
      const samples: [number, number][] = [];
      for (let y = plotT; y <= plotB; y += 2) samples.push([y, pnlFn(yToP(y), firstExp)]);
      const runs = (pred: (v: number) => boolean) => {
        const out: [number, number][] = [];
        let start: number | null = null;
        for (const [y, v] of samples) {
          if (pred(v)) start ??= y;
          else if (start !== null) {
            out.push([start, y - 2]);
            start = null;
          }
        }
        if (start !== null) out.push([start, samples[samples.length - 1][0]]);
        return out;
      };
      const strikeLabel = (y: number) => {
        const p = yToP(y);
        const k = legsForPnl.reduce((a, l) => (Math.abs(l.strike - p) < Math.abs(a - p) ? l.strike : a), legsForPnl[0].strike);
        return fmtPrice(Math.abs(k - p) / p < 0.03 ? k : p, 0);
      };
      const drawCap = ([y0, y1]: [number, number], v: number, kind: 'profit' | 'loss') => {
        const rgb = kind === 'profit' ? C.profit : C.loss;
        const col = `rgb(${rgb.join(',')})`;
        const atTop = y0 <= plotT + 2;
        const atBottom = y1 >= plotB - 2;
        let where: string;
        if (atTop && atBottom) where = 'across this range';
        else if (y1 - y0 < 8) where = `at ${strikeLabel((y0 + y1) / 2)}`;
        else if (atTop) where = `above ${strikeLabel(y1)}`;
        else if (atBottom) where = `below ${strikeLabel(y0)}`;
        else where = `${strikeLabel(y1)} – ${strikeLabel(y0)}`;

        // Bracket just right of the expiry line.
        const bx = ex + 5;
        ctx.strokeStyle = col;
        ctx.lineWidth = 2;
        ctx.beginPath();
        if (!atTop) ctx.moveTo(bx + 5, y0), ctx.lineTo(bx, y0);
        else ctx.moveTo(bx, y0);
        ctx.lineTo(bx, y1);
        if (!atBottom) ctx.lineTo(bx + 5, y1);
        ctx.stroke();
        ctx.lineWidth = 1;
        // Faint cap line across the heat map at the plateau edge.
        ctx.setLineDash([6, 4]);
        ctx.strokeStyle = `rgba(${rgb.join(',')},0.55)`;
        ctx.beginPath();
        if (!atTop) ctx.moveTo(nowX, y0 + 0.5), ctx.lineTo(ex, y0 + 0.5);
        if (!atBottom) ctx.moveTo(nowX, y1 + 0.5), ctx.lineTo(ex, y1 + 0.5);
        ctx.stroke();
        ctx.setLineDash([]);

        const title = `${kind === 'profit' ? 'MAX PROFIT' : 'MAX LOSS'} ${signedUsd(v)}`;
        const sub = kind === 'profit' ? `capped ${where}` : `limited ${where}`;
        ctx.font = `600 11px ${MONO}`;
        const tw = ctx.measureText(title).width;
        ctx.font = `11px ${SANS}`;
        const w2 = Math.max(tw, ctx.measureText(sub).width) + 18;
        const right = ex + 14 + w2 < plotR;
        const lx = right ? ex + 14 : ex - 14 - w2;
        const ly = Math.max(plotT + 4, Math.min(plotB - 40, (y0 + y1) / 2 - 18));
        roundRect(ctx, lx, ly, w2, 36, 5);
        ctx.fillStyle = 'rgba(12,15,20,0.88)';
        ctx.fill();
        ctx.strokeStyle = `rgba(${rgb.join(',')},0.5)`;
        ctx.stroke();
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.font = `600 11px ${MONO}`;
        ctx.fillStyle = col;
        ctx.fillText(title, lx + 9, ly + 12);
        ctx.font = `11px ${SANS}`;
        ctx.fillStyle = C.muted;
        ctx.fillText(sub, lx + 9, ly + 26);
      };
      if (maxP > tol && !unlimitedProfit) for (const r of runs((v) => v >= maxP - tol)) drawCap(r, maxP, 'profit');
      if (minP < -tol && !unlimitedLoss) for (const r of runs((v) => v <= minP + tol)) drawCap(r, minP, 'loss');
    }

    // ---- Leg markers ----
    const markers: Marker[] = [];
    const editableIds = new Set(editableLegs.map((l) => l.id));
    const staticIds = new Set(staticLegs.map((l) => l.id));
    ctx.font = `600 11px ${MONO}`;
    ctx.textBaseline = 'middle';
    const drawLeg = (l: Leg, ghost = false) => {
      const isStatic = staticIds.has(l.id) && !editableIds.has(l.id);
      const dimmed = isStatic && editableLegs.length > 0;
      const x = Math.min(tToX(l.expiry), plotR - 2);
      const y = pToY(l.strike);
      if (y < plotT - 4 || y > plotB + 4) return;
      const col = l.side > 0 ? C.long : C.short;
      ctx.globalAlpha = ghost ? 0.85 : dimmed ? 0.5 : 1;
      ctx.strokeStyle = col;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(nowX, y);
      ctx.lineTo(x, y);
      ctx.stroke();
      ctx.setLineDash([]);
      const label = `${l.side > 0 ? '+' : '−'}${l.qty} ${fmtPrice(l.strike, 0)} ${l.type}`;
      const tw = ctx.measureText(label).width;
      const pw = tw + 26;
      const ph = 20;
      const px = x - 10 - pw;
      const py = y - ph / 2;
      roundRect(ctx, px, py, pw, ph, 5);
      ctx.fillStyle = ghost ? 'rgba(12,15,20,0.85)' : '#0c0f14';
      ctx.fill();
      ctx.lineWidth = l.id === selectedLegId ? 2 : 1;
      ctx.strokeStyle = l.id === selectedLegId ? C.text : col;
      if (ghost) ctx.setLineDash([3, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineWidth = 1;
      // Direction glyph: calls pay above the strike, puts below.
      ctx.fillStyle = col;
      ctx.beginPath();
      const gx = px + 9;
      if (l.type === 'C') {
        ctx.moveTo(gx - 4, y + 3);
        ctx.lineTo(gx + 4, y + 3);
        ctx.lineTo(gx, y - 4);
      } else {
        ctx.moveTo(gx - 4, y - 3);
        ctx.lineTo(gx + 4, y - 3);
        ctx.lineTo(gx, y + 4);
      }
      ctx.fill();
      ctx.fillStyle = C.text;
      ctx.textAlign = 'left';
      ctx.fillText(label, px + 18, y + 0.5);
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fillStyle = col;
      ctx.fill();
      ctx.strokeStyle = '#0c0f14';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.lineWidth = 1;
      ctx.globalAlpha = 1;
      if (!isStatic && !ghost) markers.push({ id: l.id, x: px, y: py, w: pw + 16, h: ph });
    };
    for (const l of staticLegs) if (!editableIds.has(l.id)) drawLeg(l);
    for (const l of editableLegs) {
      if (dragLeg && l.id === dragLeg.id) drawLeg({ ...l, strike: dragLeg.strike!, expiry: dragLeg.expiry! }, true);
      else drawLeg(l);
    }
    markersRef.current = markers;

    // ---- Ghost for the active tool ----
    const overMarker = hover && markers.some((m) => hover.x >= m.x && hover.x <= m.x + m.w && hover.y >= m.y && hover.y <= m.y + m.h);
    let ghostInfo: string[] | null = null;
    if (snap && tool !== 'pointer' && !overMarker) {
      const tl = TOOL_LEG[tool];
      const ghost: Leg = { id: '__ghost', asset: spec.asset, type: tl.type, side: tl.side, strike: snap.strike, expiry: snap.expiry, qty: 1 };
      drawLeg(ghost, true);
      const T = (snap.expiry - now) / YEAR;
      const iv = impliedVol(spec, spot, snap.strike, T);
      const prem = bsPrice(tl.type, spot, snap.strike, T, iv);
      ghostInfo = [
        `${tl.label} ${fmtPrice(snap.strike, 0)} · ${fmtTime(snap.expiry, false)}`,
        `${tl.side > 0 ? 'Pay' : 'Receive'} ${compactUsd(prem)} · IV ${(iv * 100).toFixed(1)}%`,
      ];
    }

    // ---- Profile gutter: P&L across price at one moment ----
    const gx0 = plotR;
    ctx.fillStyle = '#0e1218';
    ctx.fillRect(gx0, plotT, PROFILE_W, plotB - plotT);
    ctx.strokeStyle = C.line;
    ctx.beginPath();
    ctx.moveTo(gx0 + 0.5, plotT);
    ctx.lineTo(gx0 + 0.5, plotB);
    ctx.moveTo(gx0 + PROFILE_W + 0.5, 0);
    ctx.lineTo(gx0 + PROFILE_W + 0.5, h);
    ctx.stroke();
    if (legsForPnl.length) {
      const firstExp = Math.min(...legsForPnl.map((l) => l.expiry));
      const hoverT = hover && hover.x > nowX && hover.x < plotR ? xToT(hover.x) : null;
      const tProf = hoverT ?? firstExp;
      const pts: [number, number][] = [];
      let pm = 1e-9;
      for (let y = plotT; y <= plotB; y += 2) {
        const v = pnlFn(yToP(y), tProf);
        pts.push([y, v]);
        pm = Math.max(pm, Math.abs(v));
      }
      const zx = gx0 + PROFILE_W / 2;
      const half = PROFILE_W / 2 - 6;
      for (const [y, v] of pts) {
        const rgb = v >= 0 ? C.profit : C.loss;
        ctx.fillStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.75)`;
        const len = (v / pm) * half;
        ctx.fillRect(len >= 0 ? zx : zx + len, y, Math.abs(len), 2);
      }
      ctx.strokeStyle = 'rgba(227,231,238,0.25)';
      ctx.beginPath();
      ctx.moveTo(zx + 0.5, plotT);
      ctx.lineTo(zx + 0.5, plotB);
      ctx.stroke();
      ctx.fillStyle = 'rgba(14,18,24,0.9)';
      ctx.fillRect(gx0 + 1, plotT, PROFILE_W - 1, 30);
      ctx.font = `600 9px ${MONO}`;
      ctx.fillStyle = C.muted;
      ctx.textAlign = 'center';
      ctx.fillText(hoverT ? 'P&L AT' : 'AT EXPIRY', zx, plotT + 10);
      ctx.fillStyle = C.text;
      ctx.fillText(fmtTime(tProf, !!hoverT && tStep < DAY), zx, plotT + 22);
      if (hoverT) {
        const x = Math.round(hover!.x) + 0.5;
        ctx.strokeStyle = 'rgba(227,231,238,0.2)';
        ctx.beginPath();
        ctx.moveTo(x, plotT);
        ctx.lineTo(x, plotB);
        ctx.stroke();
      }
    } else {
      ctx.font = `600 9px ${MONO}`;
      ctx.fillStyle = C.dim;
      ctx.textAlign = 'center';
      ctx.fillText('P&L', gx0 + PROFILE_W / 2, plotT + 10);
    }

    // Spot tag on the axis.
    ctx.font = `600 11px ${MONO}`;
    const sLabel = fmtPrice(spot, spec.priceDecimals);
    roundRect(ctx, plotR + PROFILE_W + 2, sy - 9, AXIS_W - 4, 18, 3);
    ctx.fillStyle = C.text;
    ctx.fill();
    ctx.fillStyle = C.bg;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(sLabel, plotR + PROFILE_W + 7, sy + 0.5);

    // ---- Crosshair + tooltip ----
    if (hover && hover.x < plotR && hover.y > plotT && hover.y < plotB && !drag) {
      const hy = Math.round(hover.y) + 0.5;
      ctx.strokeStyle = 'rgba(227,231,238,0.22)';
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(0, hy);
      ctx.lineTo(plotR + PROFILE_W, hy);
      if (hover.x <= nowX) {
        ctx.moveTo(Math.round(hover.x) + 0.5, plotT);
        ctx.lineTo(Math.round(hover.x) + 0.5, plotB);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      const hp = yToP(hover.y);
      roundRect(ctx, plotR + PROFILE_W + 2, hy - 9, AXIS_W - 4, 18, 3);
      ctx.fillStyle = C.line;
      ctx.fill();
      ctx.fillStyle = C.text;
      ctx.font = `11px ${MONO}`;
      ctx.fillText(fmtPrice(hp, hp < 100 ? 2 : 0), plotR + PROFILE_W + 7, hy + 0.5);

      const lines: { text: string; color?: string; bold?: boolean }[] = [];
      const ht = xToT(hover.x);
      if (hover.x > nowX) {
        if (ghostInfo) {
          lines.push({ text: ghostInfo[0], bold: true, color: TOOL_LEG[tool as Exclude<Tool, 'pointer'>].side > 0 ? C.long : C.short });
          lines.push({ text: ghostInfo[1] });
        }
        lines.push({ text: `${fmtTime(ht, true)} UTC · ${fmtPrice(hp, hp < 100 ? 2 : 0)}`, color: C.muted });
        if (legsForPnl.length) {
          const v = pnlFn(hp, ht);
          lines.push({ text: `Position P&L ${signedUsd(v)}`, bold: true, color: v >= 0 ? `rgb(${C.profit.join(',')})` : `rgb(${C.loss.join(',')})` });
        }
      } else {
        lines.push({ text: `${fmtTime(ht, true)} UTC`, color: C.muted });
      }
      ctx.font = `12px ${SANS}`;
      const lw = Math.max(...lines.map((l) => ctx.measureText(l.text).width)) + 20;
      const lh = lines.length * 17 + 12;
      let tx = hover.x + 16;
      let ty = hover.y + 16;
      if (tx + lw > plotR - 4) tx = hover.x - 16 - lw;
      if (ty + lh > plotB - 4) ty = hover.y - 16 - lh;
      roundRect(ctx, tx, ty, lw, lh, 6);
      ctx.fillStyle = 'rgba(17,21,28,0.94)';
      ctx.fill();
      ctx.strokeStyle = C.line;
      ctx.stroke();
      lines.forEach((l, i) => {
        ctx.font = `${l.bold ? 600 : 400} 12px ${SANS}`;
        ctx.fillStyle = l.color ?? C.text;
        ctx.textAlign = 'left';
        ctx.fillText(l.text, tx + 10, ty + 14 + i * 17);
      });
    }

    // Borders.
    ctx.strokeStyle = C.line;
    ctx.beginPath();
    ctx.moveTo(0, plotB + 0.5);
    ctx.lineTo(w, plotB + 0.5);
    ctx.moveTo(0, plotT - 0.5);
    ctx.lineTo(plotR + PROFILE_W, plotT - 0.5);
    ctx.stroke();

    // Cursor.
    let cursor = 'default';
    if (drag) cursor = drag.kind === 'axis' ? 'ns-resize' : 'grabbing';
    else if (overMarker) cursor = 'grab';
    else if (hover && hover.x > plotR + PROFILE_W) cursor = 'ns-resize';
    else if (snap && tool !== 'pointer') cursor = 'crosshair';
    canvas.style.cursor = cursor;
  }, [computeGeom, snapAt]);

  // Size canvas to container.
  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const ro = new ResizeObserver(() => {
      const r = wrap.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      sizeRef.current = { w: r.width, h: r.height, dpr };
      canvas.width = Math.round(r.width * dpr);
      canvas.height = Math.round(r.height * dpr);
      canvas.style.width = `${r.width}px`;
      canvas.style.height = `${r.height}px`;
      draw();
    });
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [draw]);

  useEffect(() => {
    draw();
  });

  // Pulse the spot dot.
  useEffect(() => {
    let raf = 0;
    let last = 0;
    const loop = (ts: number) => {
      if (ts - last > 60) {
        last = ts;
        draw();
      }
      raf = requestAnimationFrame(loop);
    };
    if (!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [draw]);

  // Wheel: scroll zooms time; shift/axis scroll zooms price.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const { view, onViewChange } = propsRef.current;
      const g = geomRef.current;
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const f = Math.exp(Math.sign(e.deltaY || e.deltaX) * 0.12);
      if (e.shiftKey || (g && x > g.plotR)) {
        onViewChange({ ...view, yZoom: Math.min(4, Math.max(0.15, view.yZoom * f)) });
      } else {
        onViewChange({ ...view, horizon: Math.min(150 * DAY, Math.max(1.5 * DAY, view.horizon * f)) });
      }
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, []);

  const pos = (e: React.PointerEvent) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const hitMarker = (x: number, y: number) =>
    [...markersRef.current].reverse().find((m) => x >= m.x && x <= m.x + m.w && y >= m.y && y <= m.y + m.h);

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const { x, y } = pos(e);
    hoverRef.current = { x, y };
    const g = geomRef.current ?? computeGeom();
    const p = propsRef.current;
    if (x > g.plotR + PROFILE_W) {
      dragRef.current = { kind: 'axis', startX: x, startY: y, startShift: p.view.yShift, moved: false };
      (e.target as Element).setPointerCapture(e.pointerId);
      return;
    }
    const m = hitMarker(x, y);
    if (m) {
      const leg = p.editableLegs.find((l) => l.id === m.id)!;
      dragRef.current = { kind: 'leg', id: m.id, startX: x, startY: y, moved: false, strike: leg.strike, expiry: leg.expiry };
      (e.target as Element).setPointerCapture(e.pointerId);
      draw();
      return;
    }
    if (p.tool === 'pointer') {
      p.onSelect(null);
      return;
    }
    const s = snapAt(g, x, y);
    if (s) {
      const tl = TOOL_LEG[p.tool];
      p.onAdd(tl.type, tl.side, s.strike, s.expiry);
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const { x, y } = pos(e);
    hoverRef.current = { x, y };
    const d = dragRef.current;
    const g = geomRef.current;
    if (d && g) {
      if (Math.abs(x - d.startX) + Math.abs(y - d.startY) > 4) d.moved = true;
      if (d.kind === 'axis') {
        const p = propsRef.current;
        p.onViewChange({ ...p.view, yShift: d.startShift! + ((y - d.startY) / (g.plotB - g.plotT)) * p.view.yZoom });
      } else if (d.moved) {
        const s = snapAt(g, Math.max(g.nowX + 3, Math.min(g.plotR, x)), Math.max(g.plotT + 1, Math.min(g.plotB - 1, y)));
        if (s) {
          d.strike = s.strike;
          d.expiry = s.expiry;
        }
      }
    }
    draw();
  };

  const onPointerUp = () => {
    const d = dragRef.current;
    dragRef.current = null;
    if (d?.kind === 'leg') {
      const p = propsRef.current;
      if (d.moved) p.onMove(d.id!, d.strike!, d.expiry!);
      else p.onSelect(d.id!);
    }
    draw();
  };

  const onContextMenu = (e: React.MouseEvent) => {
    const r = canvasRef.current!.getBoundingClientRect();
    const m = hitMarker(e.clientX - r.left, e.clientY - r.top);
    if (m) {
      e.preventDefault();
      propsRef.current.onRemove(m.id);
    }
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    const g = geomRef.current;
    const r = canvasRef.current!.getBoundingClientRect();
    if (g && e.clientX - r.left > g.plotR + PROFILE_W) {
      const p = propsRef.current;
      p.onViewChange({ ...p.view, yZoom: 1, yShift: 0 });
    }
  };

  return (
    <div ref={wrapRef} className="chart-canvas-wrap">
      <canvas
        ref={canvasRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={() => {
          if (!dragRef.current) {
            hoverRef.current = null;
            draw();
          }
        }}
        onContextMenu={onContextMenu}
        onDoubleClick={onDoubleClick}
        aria-label="Price chart. Click a future expiry column to place an option at that strike."
        role="img"
      />
    </div>
  );
}

import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import type { OptType } from '../lib/bs';
import { bsPrice } from '../lib/bs';
import { compactUsd, price as fmtPrice, signedUsd } from '../lib/format';
import {
  DAY,
  HOUR,
  YEAR,
  type Candle,
  type Expiry,
  type MarketSpec,
} from '../lib/market';
import type { Market } from '../data/types';
import { betQuestion, fmtMultiplier, multiplier, type BetQuote } from '../lib/binary';
import type { PathPoint } from '../lib/pathfit';
import { buildModel, lifetimeExtremes, type Leg, type Model, type Side } from '../lib/strategy';

export type Tool = 'pointer' | 'draw' | LegTool;
export type LegTool = 'buyC' | 'sellC' | 'buyP' | 'sellP';
const isLegTool = (t: Tool): t is LegTool => t !== 'pointer' && t !== 'draw';

export const TOOL_LEG: Record<LegTool, { type: OptType; side: Side; label: string }> = {
  buyC: { type: 'C', side: 1, label: 'Buy Call' },
  sellC: { type: 'C', side: -1, label: 'Sell Call' },
  buyP: { type: 'P', side: 1, label: 'Buy Put' },
  sellP: { type: 'P', side: -1, label: 'Sell Put' },
};

export interface ChartView {
  /** Future time visible to the right of "now" at the default pan position. */
  horizon: number;
  yZoom: number;
  yShift: number;
  /** Where the "now" line sits, as a fraction of the plot width (panning moves it). Unset = default. */
  nowFrac?: number;
}

interface Props {
  spec: MarketSpec;
  market: Market;
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
  /** Moves several legs at once (the group handle), as one undo step. */
  onMoveGroup: (moves: { id: string; strike: number; expiry: number }[]) => void;
  onSelect: (id: string | null) => void;
  onRemove: (id: string) => void;
  /** A price path drawn with the Draw tool (on release). */
  onDraw: (path: PathPoint[]) => void;
  /** The last drawn path, shown dashed while its fitted position is on the chart. */
  guide: PathPoint[] | null;
  /** Easy mode: click above/below the price to pick a Yes bet; the idle map is a probability cone. */
  easy?: EasyLayer | null;
}

export interface EasyLayer {
  /** The bet for one box: a listed expiry and a band of listed strikes. */
  quote: (expiry: number, lo: number, hi: number) => BetQuote | null;
  onPick: (expiry: number, lo: number, hi: number) => void;
  /** The bet being set up (its box is filled in). */
  pending: BetQuote | null;
  /** Placed bets, drawn as outlined boxes with their price now. */
  bets: { id: string; expiry: number; lo: number; hi: number; dir: 'above' | 'below'; label: string; up: boolean }[];
}

/** One box of the easy-mode grid: from the previous expiry to this one, between two strikes. */
interface EasyBox {
  expiry: number;
  lo: number;
  hi: number;
  x0: number;
  x1: number;
  q: BetQuote;
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
/** Below this width (phones) the axis, P&L strip and history get narrower so the plot keeps its room. */
const NARROW_W = 600;
const TOUCH_SLACK = 10;
/** How long a finger must rest before a press counts as a long-press. */
const LONG_PRESS_MS = 450;
/** The max profit / max loss outline covers P&L within this fraction of the max. */
export const ZONE_FRAC = 0.05;
const TIME_H = 26;
const TOP_H = 28;
const PAST_FRAC = 0.3;
/** Furthest out you can zoom: past Derive's longest listed expiry (about a year). */
const MAX_HORIZON = 430 * DAY;
const CELL = 4;
/** Coarser P&L map while the view is moving, refined once it settles. */
const CELL_MOVING = 8;
const MONO = '"Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace';
const SANS = 'Geist, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';

interface Geom {
  baseFrac: number;
  axisW: number;
  profileW: number;
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
  label: string;
  color: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A max profit / loss zone, traced: outline segments, closing edges, and where to caption it. */
interface ZoneTrace {
  segs: number[][];
  startRuns: [number, number][];
  endRuns: [number, number][] | null;
  tRef: number;
  atExpiry: [number, number][];
}

/** Marker id of the handle that moves every editable leg together. */
const GROUP_ID = '__group';

type LegPos = { id: string; strike: number; expiry: number };

interface DragState {
  kind: 'leg' | 'axis' | 'pan' | 'group' | 'draw';
  /** Draw tool: the path so far, as (time, price). */
  path?: PathPoint[];
  /** Group drag: the legs as they were when grabbed, where each would land now, and where each is drawn. */
  groupFrom?: LegPos[];
  groupTo?: LegPos[];
  groupLive?: LegPos[];
  startFrac?: number;
  touch?: boolean;
  id?: string;
  startX: number;
  startY: number;
  startShift?: number;
  moved: boolean;
  /** Where the leg will land on drop: the nearest listed strike and expiry. */
  strike?: number;
  expiry?: number;
  /** Where the leg is drawn and priced during the drag: follows the pointer without snapping. */
  liveStrike?: number;
  liveExpiry?: number;
  /** Pointer offset from the dot's centre when grabbed, so the dot doesn't hop to the cursor. */
  grabDX?: number;
  grabDY?: number;
}

/** After a drop, legs glide from where they were released to their snapped strikes and expiries. */
interface Settle {
  moves: { id: string; from: { strike: number; expiry: number }; to: { strike: number; expiry: number } }[];
  t0: number;
}

const SETTLE_MS = 180;

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
  const settleRef = useRef<Settle | null>(null);
  const markersRef = useRef<Marker[]>([]);
  const geomRef = useRef<Geom | null>(null);
  const lastMoveRef = useRef(0);
  const zoomRef = useRef<{ horizon: number; yZoom: number; raf: number; cur: ChartView; sent: ChartView[] } | null>(null);
  /** Easy mode's grid of boxes, rebuilt when the view or prices change. */
  const easyGridRef = useRef<{ key: string; boxes: EasyBox[] } | null>(null);
  /** Traced max profit / loss outlines, reused until the map (legs, view, prices) changes. */
  const zoneCacheRef = useRef<Map<string, ZoneTrace>>(new Map());
  const heatRef = useRef<{
    key: string;
    canvas: HTMLCanvasElement;
    maxAbs: number;
    contour: number[][];
    x0: number;
    vals: Float32Array;
    cols: number;
    rows: number;
    cell: number;
  } | null>(null);

  const computeGeom = useCallback((): Geom => {
    const { w, h } = sizeRef.current;
    const { spot, now, view, candles, spec } = propsRef.current;
    const narrow = w < NARROW_W;
    const axisW = narrow ? 52 : AXIS_W;
    const profileW = narrow ? 40 : PROFILE_W;
    const plotR = w - axisW - profileW;
    const plotT = TOP_H;
    const plotB = h - TIME_H;
    const baseFrac = narrow ? 0.2 : PAST_FRAC;
    const nowX = plotR * (view.nowFrac ?? baseFrac);
    // Scale comes from the default layout, so panning slides the chart without rescaling it.
    const pxPerMs = (plotR * (1 - baseFrac)) / view.horizon;
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
    return { baseFrac, axisW, profileW, w, h, plotR, plotT, plotB, nowX, lo, hi, tToX, xToT, pToY, yToP };
  }, []);

  /** Nearest listed expiry (by pixels) and strike for a point in the future region. */
  const snapAt = useCallback((g: Geom, x: number, y: number) => {
    const { expiries, market } = propsRef.current;
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
    return { expiry: best.ts, strike: market.snapStrike(g.yToP(y), best.ts) };
  }, []);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const { w, h, dpr } = sizeRef.current;
    if (!canvas || w < 50 || h < 50) return;
    const ctx = canvas.getContext('2d')!;
    ctx.save();
    try {
    const p = propsRef.current;
    const { spec, market, candles, spot, now, expiries, model, editableLegs, staticLegs, tool, selectedLegId, view } = p;
    const g = computeGeom();
    geomRef.current = g;
    // What this frame drew, for the automated chart check (scripts/check-chart.mjs).
    const dbg = {
      zones: [] as {
        kind: string;
        v: number;
        level: number;
        runs: [number, number][];
        t: number;
        cell: number;
        cells?: number;
        width?: number;
        compact?: boolean;
        /** The traced outline (not its closing edges), as [x1, y1, x2, y2] segments. */
        segs?: number[][];
        labelled?: boolean;
      }[],
      tags: [] as { dir: string; kind: string }[],
      rects: [] as [number, number, number, number][],
      firstExp: 0,
    };
    const { plotR, plotT, plotB, nowX, tToX, xToT, pToY, yToP } = g;
    const PW = g.profileW;
    const AW = g.axisW;
    const narrow = PW < PROFILE_W;
    const hover = hoverRef.current;
    const drag = dragRef.current;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = C.future;
    ctx.fillRect(nowX, plotT, plotR - nowX, plotB - plotT);

    // A leg being dragged is drawn and priced where the pointer is (continuously, so the map
    // morphs smoothly); after the drop it glides to its snapped strike and expiry.
    const dragLeg = drag?.kind === 'leg' && drag.moved ? drag : null;
    const dragGroup = drag?.kind === 'group' && drag.moved && drag.groupLive ? drag : null;
    // Legs drawn and priced somewhere other than their current strike/expiry this frame.
    let override: Map<string, { strike: number; expiry: number }> | null = null;
    if (dragLeg) override = new Map([[dragLeg.id!, { strike: dragLeg.liveStrike!, expiry: dragLeg.liveExpiry! }]]);
    if (dragGroup) override = new Map(dragGroup.groupLive!.map((l) => [l.id, l]));
    const settle = settleRef.current;
    if (!override && settle) {
      const k = Math.min(1, (performance.now() - settle.t0) / SETTLE_MS);
      if (k >= 1) settleRef.current = null;
      else {
        const e = 1 - (1 - k) ** 3;
        override = new Map(
          settle.moves.map((m) => [
            m.id,
            { strike: m.from.strike + (m.to.strike - m.from.strike) * e, expiry: m.from.expiry + (m.to.expiry - m.from.expiry) * e },
          ]),
        );
      }
    }
    const legs = model.legs;
    const legsForPnl = override
      ? legs.map((l) => {
          const o = override!.get(l.id);
          return o ? { ...l, strike: o.strike, expiry: o.expiry } : l;
        })
      : legs;
    // Re-price the dragged leg at its new strike/expiry, so the map shows the trade as it
    // would be if you dropped it here (new premium, not the old one).
    const liveModel = override ? buildModel(legsForPnl, market, now) : model;
    const pnlFn = liveModel.pnl;

    // ---- P&L heat map over (time, price) ----
    // Only paint up to the last expiry: after that everything has settled.
    const lastExp = legsForPnl.length ? Math.max(...legsForPnl.map((l) => l.expiry)) : now;
    // Up to the last expiry the map shows live P&L; after it, the settled result carries on to the
    // right edge (drawn lighter), so a zoomed-out view never looks empty.
    const expR = Math.min(plotR, tToX(lastExp));
    const heatR = plotR;
    const cell = performance.now() - lastMoveRef.current < 200 ? CELL_MOVING : CELL;
    // Heat starts at whichever is later: now, or the left edge (when panned into the future).
    const hx0 = Math.max(nowX, 0);
    const cols = Math.max(0, Math.ceil((heatR - hx0) / cell));
    const rows = Math.ceil((plotB - plotT) / cell);
    let maxAbs = 0;
    if (legsForPnl.length && cols > 0 && rows > 0) {
      const key = [
        legsForPnl.map((l) => `${l.type}${l.side}${l.strike}@${l.expiry}x${l.qty}`).join('|'),
        liveModel.entries.map((e) => e.toFixed(4)).join(','),
        spot.toFixed(4),
        Math.floor(now / 30000),
        w,
        h,
        g.lo.toFixed(3),
        g.hi.toFixed(3),
        view.horizon,
        hx0.toFixed(1),
        cell,
      ].join('#');
      if (!heatRef.current || heatRef.current.key !== key) {
        const vals = new Float32Array(cols * rows);
        let mx = 0;
        for (let c = 0; c < cols; c++) {
          const t = xToT(hx0 + (c + 0.5) * cell);
          for (let r = 0; r < rows; r++) {
            const raw = pnlFn(yToP(plotT + (r + 0.5) * cell), t);
            const v = Number.isFinite(raw) ? raw : 0;
            vals[r * cols + c] = v;
            mx = Math.max(mx, Math.abs(v));
          }
        }
        const off = heatRef.current?.canvas ?? document.createElement('canvas');
        off.width = cols;
        off.height = rows;
        const octx = off.getContext('2d')!;
        const img = octx.createImageData(cols, rows);
        const contour: number[][] = [];
        if (mx > 1e-9) {
          // Profit and loss each get their own scale (with a floor at 20% of the larger side), so a
          // small loss next to a big uncapped profit is still clearly red instead of near-black.
          let maxPos = 0;
          let maxNeg = 0;
          for (let i = 0; i < vals.length; i++) {
            if (vals[i] > maxPos) maxPos = vals[i];
            else if (-vals[i] > maxNeg) maxNeg = -vals[i];
          }
          const posScale = Math.max(maxPos, mx * 0.2);
          const negScale = Math.max(maxNeg, mx * 0.2);
          for (let i = 0; i < vals.length; i++) {
            const v = vals[i];
            const a = Math.pow(Math.abs(v) / (v >= 0 ? posScale : negScale), 0.75);
            const rgb = v >= 0 ? C.profit : C.loss;
            img.data[i * 4] = rgb[0];
            img.data[i * 4 + 1] = rgb[1];
            img.data[i * 4 + 2] = rgb[2];
            img.data[i * 4 + 3] = Math.round(255 * (0.05 + 0.5 * a));
          }
          // Break-even: per column, the interpolated y of every sign change down the column.
          for (let c = 0; c < cols; c++) {
            const ys: number[] = [];
            for (let r = 0; r < rows - 1; r++) {
              const a = vals[r * cols + c];
              const b = vals[(r + 1) * cols + c];
              if ((a >= 0) !== (b >= 0)) ys.push(plotT + (r + 0.5 + a / (a - b)) * cell);
            }
            contour.push(ys);
          }
        }
        octx.putImageData(img, 0, 0);
        heatRef.current = { key, canvas: off, maxAbs: mx, contour, x0: hx0, vals, cols, rows, cell };
      }
      const heat = heatRef.current;
      maxAbs = heat.maxAbs;
      if (maxAbs > 1e-9) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(hx0, plotT, heatR - hx0, plotB - plotT);
        ctx.clip();
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(heat.canvas, hx0, plotT, cols * cell, rows * cell);
        // After the last expiry everything has settled: dim it with a crisp edge and say so.
        if (expR < plotR - 1) {
          ctx.fillStyle = 'rgba(12,15,20,0.62)';
          ctx.fillRect(expR, plotT, plotR - expR, plotB - plotT);
          if (plotR - expR > 90) {
            ctx.font = `600 9px ${MONO}`;
            ctx.fillStyle = C.dim;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillText('SETTLED · AFTER LAST EXPIRY', expR + 8, plotB - 10);
            dbg.rects.push([expR + 4, plotB - 18, 190, 16]);
          }
        }
        // Break-even as one continuous line: join each crossing to the nearest crossing in the
        // next column (a line can't jump more than a few cells between neighbouring columns).
        ctx.strokeStyle = 'rgba(227,231,238,0.6)';
        ctx.lineWidth = 1.25;
        ctx.lineJoin = 'round';
        ctx.beginPath();
        const cx = (c: number) => heat.x0 + (c + 0.5) * cell;
        for (let c = 0; c < heat.contour.length - 1; c++) {
          const next = heat.contour[c + 1];
          for (const y of heat.contour[c]) {
            let best: number | null = null;
            for (const y2 of next) if (best === null || Math.abs(y2 - y) < Math.abs(best - y)) best = y2;
            if (best !== null && Math.abs(best - y) < cell * 6) {
              ctx.moveTo(cx(c), y);
              ctx.lineTo(cx(c + 1), best);
            }
          }
        }
        // Extend the first column's crossings back to the now line so the curve starts there.
        for (const y of heat.contour[0] ?? []) {
          ctx.moveTo(heat.x0, y);
          ctx.lineTo(cx(0), y);
        }
        ctx.stroke();
        ctx.lineWidth = 1;
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
      ctx.fillText(fmtPrice(v, pStep < 1 ? 2 : 0), plotR + PW + 8, y);
    }

    // ---- Time grid + axis ----
    const pxPerDay = tToX(now + DAY) - tToX(now);
    const tSteps = [HOUR, 2 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 7 * DAY, 14 * DAY, 30 * DAY, 61 * DAY, 91 * DAY];
    const tStep = tSteps.find((s) => (s / DAY) * pxPerDay >= 80) ?? 91 * DAY;
    // Up to two weeks apart, ticks are evenly spaced; beyond that they sit on month starts
    // (every 1, 2 or 3 months), labelled "Nov", with the year on January.
    const ticks: [number, string][] = [];
    if (tStep < 30 * DAY) {
      for (let t = Math.ceil(xToT(0) / tStep) * tStep; tToX(t) < plotR; t += tStep) ticks.push([t, fmtTime(t, tStep < DAY)]);
    } else {
      const every = tStep >= 91 * DAY ? 3 : tStep >= 61 * DAY ? 2 : 1;
      const d0 = new Date(xToT(0));
      for (let i = 1; ; i++) {
        const t = Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth() + i, 1);
        if (tToX(t) >= plotR) break;
        const mo = new Date(t).getUTCMonth();
        if (mo % every === 0) ticks.push([t, mo === 0 ? `${MON[mo]} ${new Date(t).getUTCFullYear()}` : MON[mo]]);
      }
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const [t, label] of ticks) {
      const x = Math.round(tToX(t)) + 0.5;
      ctx.strokeStyle = C.grid;
      ctx.beginPath();
      ctx.moveTo(x, plotT);
      ctx.lineTo(x, plotB);
      ctx.stroke();
      if (Math.abs(x - nowX) > 40) {
        ctx.fillStyle = C.dim;
        ctx.fillText(label, x, plotB + TIME_H / 2);
      }
    }

    // ---- Expiry columns ----
    const snap = hover && isLegTool(tool) && !drag ? snapAt(g, hover.x, hover.y) : null;
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
    ctx.lineTo(plotR + PW, sy);
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
    ctx.fillText('NOW', Math.max(nowX, 16), plotB + TIME_H / 2);

    // ---- Max profit / max loss ----
    // Measured over the position's whole life (every expiry and in between), the same as the
    // Build panel, so nothing on the map can beat the stated max.
    if (legsForPnl.length && maxAbs > 1e-9) {
      const firstExp = Math.min(...legsForPnl.map((l) => l.expiry));
      const lastExp = Math.max(...legsForPnl.map((l) => l.expiry));
      dbg.firstExp = firstExp;
      const ex = Math.round(Math.min(tToX(firstExp), plotR - 2));
      const mixedExpiry = lastExp - firstExp > 60_000;
      const ext = lifetimeExtremes(pnlFn, legsForPnl, spot, now);
      const { maxP, minP, unlimitedProfit, unlimitedLoss } = ext;
      const samples: [number, number][] = [];
      for (const t of [firstExp, lastExp]) for (let y = plotT; y <= plotB; y += 2) samples.push([y, pnlFn(yToP(y), t)]);
      // "Flat" is judged against what's on screen: using the far-off-screen range (up to 20x spot)
      // made the tolerance so wide that a small capped loss next to uncapped profit never counted.
      let visMax = -Infinity;
      let visMin = Infinity;
      for (const [, v] of samples) {
        visMax = Math.max(visMax, v);
        visMin = Math.min(visMin, v);
      }
      const tol = Math.max(0, visMax - visMin) * 0.004 + 1e-6;
      const strikeLabel = (y: number) => {
        const p = yToP(y);
        const k = legsForPnl.reduce((a, l) => (Math.abs(l.strike - p) < Math.abs(a - p) ? l.strike : a), legsForPnl[0].strike);
        return fmtPrice(Math.abs(k - p) / p < 0.03 ? k : p, 0);
      };
      const nearest = (rs: [number, number][]) =>
        rs.reduce((a, r) => (Math.abs((r[0] + r[1]) / 2 - spotY) < Math.abs((a[0] + a[1]) / 2 - spotY) ? r : a), rs[0]);

      // Outline where the P&L is actually within ZONE_FRAC of its max (or max loss), traced on the
      // map itself. Max profit/loss is only reached at expiry, so this is a wedge that widens
      // toward the expiry, not a box starting at "now".
      const drawZone = (kind: 'profit' | 'loss', v: number, tAt: number, sAt: number) => {
        const heat = heatRef.current;
        if (!heat) return;
        const { vals, cols, rows, cell: hc, x0 } = heat;
        const level = v * (1 - ZONE_FRAC);
        const sgn = kind === 'profit' ? 1 : -1;
        const tEnd = Math.min(lastExp, xToT(plotR - 2));
        const t0 = xToT(x0);
        if (tEnd <= t0 || rows < 2) return;

        // Cells of the map inside the zone, and how wide it is: tiny zones get a compact marker.
        let cells = 0;
        let firstCol = cols;
        const cEnd = Math.min(cols - 1, Math.floor((tToX(tEnd) - x0) / hc));
        for (let c = 0; c <= cEnd; c++)
          for (let r = 0; r < rows; r++)
            if (sgn * (vals[r * cols + c] - level) >= 0) {
              cells++;
              firstCol = Math.min(firstCol, c);
            }
        const zoneW = (cEnd - firstCol + 1) * hc;
        const areaPx = cells * hc * hc;
        let compact = cells > 0 && (zoneW < 40 || areaPx / zoneW < 12 || areaPx < 4000);

        const cacheKey = `${heat.key}|${kind}|${level}|${tAt}|${compact}`;
        let tr = zoneCacheRef.current.get(cacheKey);
        if (!tr) {
          tr = traceZone(!compact);
          const cache = zoneCacheRef.current;
          if (cache.size > 16) cache.clear();
          cache.set(cacheKey, tr);
        }

        function traceZone(outline: boolean): ZoneTrace {
          // While something is being dragged, trace a little coarser; the exact outline follows
          // as soon as it's dropped.
          const moving = hc === CELL_MOVING;
          // >= 0 inside the zone. Evaluated with the exact P&L, not read off the map's grid.
          const f = (y: number, t: number) => sgn * (pnlFn(yToP(y), t) - level);
          const strikeYs = [...new Set(legsForPnl.map((l) => pToY(l.strike)))].filter((y) => y > plotT && y < plotB);
          // Where P&L crosses the level at one moment: sign changes between sample prices (the
          // map's row centres, plus the plot's top and bottom), each narrowed down by bisection.
          const crossAt = (t: number, col?: number): { ys: number[]; topIn: boolean } => {
            const ys: number[] = [];
            const pts: [number, number][] = [[plotT, f(plotT, t)]];
            for (let r = 0; r < rows; r++) {
              const y = plotT + (r + 0.5) * hc;
              if (y >= plotB) break;
              pts.push([y, col === undefined ? f(y, t) : sgn * (vals[r * cols + col] - level)]);
            }
            pts.push([plotB, f(plotB, t)]);
            // Also at every strike: payoffs peak and kink there, and a band around a kink can be
            // thinner than the spacing above.
            for (const y of strikeYs) pts.push([y, f(y, t)]);
            if (strikeYs.length) pts.sort((p, q) => p[0] - q[0]);
            for (let k = 0; k + 1 < pts.length; k++) {
              let [a, fa] = pts[k];
              let [b] = pts[k + 1];
              if (fa >= 0 === pts[k + 1][1] >= 0) continue;
              for (let it = 0; it < (moving ? 5 : 14); it++) {
                const m = (a + b) / 2;
                const fm = f(m, t);
                if (fm >= 0 === fa >= 0) {
                  a = m;
                  fa = fm;
                } else b = m;
              }
              ys.push((a + b) / 2);
            }
            return { ys, topIn: pts[0][1] >= 0 };
          };

          // Caption at the moment the extreme is reached if the zone shows there, else at the
          // expiry nearest it where it shows (a spread's max is approached far off-screen well
          // before expiry, but it's on screen at expiry), else the end of the visible map.
          const clampT = (t: number) => Math.max(t0, Math.min(t, tEnd));
          const candidates = [
            tAt,
            ...[...new Set(legsForPnl.map((l) => l.expiry))].filter((e) => e > t0 && e <= tEnd).sort((a, b) => Math.abs(a - tAt) - Math.abs(b - tAt)),
            tEnd,
          ].map(clampT);
          let tRef = candidates[0];
          let atExpiry = runsFrom(crossAt(tRef));
          for (const t of candidates.slice(1)) {
            if (atExpiry.length) break;
            tRef = t;
            atExpiry = runsFrom(crossAt(t));
          }
          const segs: number[][] = [];
          if (!outline) return { segs, startRuns: [], endRuns: null, tRef, atExpiry };

          // Moments to trace at: every map column up to the end, plus ever-closer steps into each
          // expiry, where time value collapses and the boundary moves fastest.
          const colDt = xToT(x0 + hc) - t0;
          const samples: { t: number; col?: number }[] = [{ t: t0 }];
          for (let c = 0; c < cols; c++) {
            const t = xToT(x0 + (c + 0.5) * hc);
            if (t >= tEnd) break;
            samples.push({ t, col: c });
          }
          for (const e of new Set(legsForPnl.map((l) => l.expiry))) {
            if (e <= t0 || e > tEnd + 1) continue;
            for (let k = 0; k < (moving ? 8 : 22); k++) {
              const d = colDt * 1.5 * (moving ? 0.5 : 0.65) ** k;
              if (e - d > t0) samples.push({ t: e - d });
              // Just after an expiry too: the expired legs leave a kink the boundary can bend round.
              if (e + d < tEnd && k < (moving ? 2 : 10)) samples.push({ t: e + d });
            }
            samples.push({ t: e });
          }
          if (tEnd < lastExp) samples.push({ t: tEnd });
          samples.sort((a, b) => a.t - b.t);
          const traced = samples.map((sm) => ({ x: tToX(sm.t), t: sm.t, ...crossAt(sm.t, sm.col) }));

          const seg = (x1: number, y1: number, x2: number, y2: number) => segs.push([x1, y1, x2, y2]);
          // Join each crossing to its partner at the next moment: mutual nearest neighbours, so two
          // separate boundaries are never bridged.
          const nearestIn = (ys: number[], y: number) => {
            let best = -1;
            for (let k = 0; k < ys.length; k++) if (best < 0 || Math.abs(ys[k] - y) < Math.abs(ys[best] - y)) best = k;
            return best;
          };
          const maxJump = (plotB - plotT) * 0.25;
          type Traced = (typeof traced)[number];
          // A boundary pair that ends (or starts) between two moments is a tip of the zone. Find
          // the moment it closes by bisection, then walk in with steps that halve towards it (the
          // boundary bends sharply there, like a sideways parabola) rather than cutting across.
          const tips = (ys: number[], linked: Set<number>, from: Traced, to: Traced) => {
            for (let k = 0; k + 1 < ys.length; k++) {
              if (linked.has(k) || linked.has(k + 1)) continue;
              if (Math.abs(ys[k + 1] - ys[k]) > maxJump) continue;
              let lo = from.t;
              let hi = to.t;
              let [y1, y2] = [ys[k], ys[k + 1]];
              for (let it = 0; it < (moving ? 4 : 12); it++) {
                const mid = (lo + hi) / 2;
                const cs = crossAt(mid).ys;
                const i1 = nearestIn(cs, y1);
                const i2 = nearestIn(cs, y2);
                const reach = Math.max(hc * 2, Math.abs(y2 - y1));
                if (i1 >= 0 && i2 >= 0 && i1 !== i2 && Math.abs(cs[i1] - y1) < reach && Math.abs(cs[i2] - y2) < reach) {
                  lo = mid;
                  [y1, y2] = [cs[i1], cs[i2]];
                } else hi = mid;
              }
              const tStar = (lo + hi) / 2;
              let p1: [number, number] = [from.x, ys[k]];
              let p2: [number, number] = [from.x, ys[k + 1]];
              for (let m = 1; m <= (moving ? 1 : 10); m++) {
                const t = tStar + (from.t - tStar) * 0.5 ** m;
                const cs = crossAt(t).ys;
                const i1 = nearestIn(cs, p1[1]);
                const i2 = nearestIn(cs, p2[1]);
                if (i1 < 0 || i2 < 0 || i1 === i2) break;
                const x = tToX(t);
                seg(p1[0], p1[1], x, cs[i1]);
                seg(p2[0], p2[1], x, cs[i2]);
                p1 = [x, cs[i1]];
                p2 = [x, cs[i2]];
              }
              const tip: [number, number] = [tToX(tStar), (p1[1] + p2[1]) / 2];
              seg(p1[0], p1[1], tip[0], tip[1]);
              seg(p2[0], p2[1], tip[0], tip[1]);
              linked.add(k).add(k + 1);
            }
          };
          // Where the boundary moves steeply between two moments (a straight line would cut the
          // corner), add the moment halfway and recurse.
          const link = (ta: number, ya: number, tb: number, yb: number, depth: number) => {
            if (depth > 0 && Math.abs(yb - ya) > 2 && tToX(tb) - tToX(ta) > 0.01) {
              const tm = (ta + tb) / 2;
              const cs = crossAt(tm).ys;
              const i = nearestIn(cs, (ya + yb) / 2);
              if (i >= 0 && cs[i] >= Math.min(ya, yb) - 2 && cs[i] <= Math.max(ya, yb) + 2) {
                link(ta, ya, tm, cs[i], depth - 1);
                link(tm, cs[i], tb, yb, depth - 1);
                return;
              }
            }
            seg(tToX(ta), ya, tToX(tb), yb);
          };
          for (let i = 0; i + 1 < traced.length; i++) {
            const a = traced[i];
            const b = traced[i + 1];
            const linkedA = new Set<number>();
            const linkedB = new Set<number>();
            a.ys.forEach((y, k) => {
              const m = nearestIn(b.ys, y);
              if (m < 0 || nearestIn(a.ys, b.ys[m]) !== k || Math.abs(b.ys[m] - y) > maxJump) return;
              link(a.t, y, b.t, b.ys[m], moving ? 0 : 7);
              linkedA.add(k);
              linkedB.add(m);
            });
            tips(a.ys, linkedA, a, b);
            tips(b.ys, linkedB, b, a);
            // A boundary that leaves through the top or bottom of the plot between two moments:
            // follow it with ever-closer steps until it's off the edge.
            const exit = (ys: number[], linked: Set<number>, from: Traced, to: Traced) => {
              ys.forEach((y, k) => {
                if (linked.has(k)) return;
                let p: [number, number] = [from.x, y];
                for (let m = 1; m <= (moving ? 1 : 10); m++) {
                  const t = from.t + (to.t - from.t) * (1 - 0.5 ** m);
                  const cs = crossAt(t).ys;
                  const i = nearestIn(cs, p[1]);
                  if (i < 0 || Math.abs(cs[i] - p[1]) > Math.max(hc * 3, Math.min(p[1] - plotT, plotB - p[1]) + 2)) break;
                  const x = tToX(t);
                  seg(p[0], p[1], x, cs[i]);
                  p = [x, cs[i]];
                }
                const edgeY = p[1] - plotT < plotB - p[1] ? plotT : plotB;
                if (Math.abs(edgeY - p[1]) < hc * 2) seg(p[0], p[1], p[0], edgeY);
              });
            };
            exit(a.ys, linkedA, a, b);
            exit(b.ys, linkedB, b, a);
          }
          // Closing edges: the start of the map if the zone is already there, and the last expiry
          // (only when it's on screen; otherwise the zone carries on past the edge).
          return {
            segs,
            startRuns: runsFrom(traced[0]),
            endRuns: tEnd >= lastExp ? runsFrom(traced[traced.length - 1]) : null,
            tRef,
            atExpiry,
          };
        }

        function runsFrom({ ys, topIn }: { ys: number[]; topIn: boolean }) {
          const out: [number, number][] = [];
          let inside = topIn;
          let start = plotT;
          for (const y of ys) {
            if (inside) out.push([start, y]);
            else start = y;
            inside = !inside;
          }
          if (inside) out.push([start, plotB]);
          return out;
        }

        const rgb = kind === 'profit' ? C.profit : C.loss;
        const col = `rgb(${rgb.join(',')})`;
        const { tRef, segs } = tr;
        let atExpiry = tr.atExpiry;
        const xRef = Math.round(tToX(tRef));
        dbg.zones.push({ kind, v, level, runs: atExpiry, t: tRef, cell: hc, segs: compact ? undefined : segs });
        // A sharp peak (e.g. a butterfly at expiry) can be too narrow to show at all: mark the exact
        // point instead, if it's on screen.
        const yAt = pToY(sAt);
        if (!atExpiry.length && yAt > plotT && yAt < plotB && tAt <= tEnd) {
          atExpiry = [[yAt, yAt]];
          compact = true;
        }
        Object.assign(dbg.zones[dbg.zones.length - 1], { cells, width: zoneW, compact, runs: atExpiry });

        if (compact) {
          // A soft capsule on the expiry line over the prices where the max is reached.
          for (const [a0, b0] of atExpiry) {
            const mid = (a0 + b0) / 2;
            const top = Math.max(plotT + 1, Math.min(a0, mid - 6));
            const bot = Math.min(plotB - 1, Math.max(b0, mid + 6));
            ctx.save();
            ctx.shadowColor = `rgba(${rgb.join(',')},0.9)`;
            ctx.shadowBlur = 12;
            roundRect(ctx, xRef - 4, top, 8, bot - top, 4);
            ctx.fillStyle = `rgba(${rgb.join(',')},0.55)`;
            ctx.fill();
            ctx.restore();
            roundRect(ctx, xRef - 4, top, 8, bot - top, 4);
            ctx.strokeStyle = `rgba(${rgb.join(',')},0.95)`;
            ctx.lineWidth = 1;
            ctx.stroke();
          }
        } else {
          ctx.save();
          ctx.beginPath();
          ctx.rect(x0, plotT, tToX(tEnd) - x0 + 1, plotB - plotT);
          ctx.clip();
          ctx.strokeStyle = `rgba(${rgb.join(',')},0.95)`;
          ctx.lineWidth = 1.5;
          ctx.lineJoin = 'round';
          ctx.lineCap = 'round';
          ctx.beginPath();
          for (const [x1, y1, x2, y2] of segs) {
            ctx.moveTo(x1, y1);
            ctx.lineTo(x2, y2);
          }
          for (const [a, b] of tr.startRuns) {
            ctx.moveTo(x0 + 0.75, a);
            ctx.lineTo(x0 + 0.75, b);
          }
          for (const [a, b] of tr.endRuns ?? []) {
            ctx.moveTo(tToX(lastExp), a);
            ctx.lineTo(tToX(lastExp), b);
          }
          ctx.stroke();
          ctx.restore();
          ctx.lineWidth = 1;
          ctx.lineCap = 'butt';
        }
        if (!atExpiry.length) return;

        // Caption the zone nearest spot, inside its closed edge at expiry.
        const [y0, y1] = nearest(atExpiry);
        const atTop = y0 <= plotT + 1;
        const atBottom = y1 >= plotB - 1;
        let where: string;
        if (atTop && atBottom) where = 'across this range';
        else if (y1 - y0 < 8) where = `at ${strikeLabel((y0 + y1) / 2)}`;
        else if (atTop) where = `above ${strikeLabel(y1)}`;
        else if (atBottom) where = `below ${strikeLabel(y0)}`;
        else where = `${strikeLabel(y1)} – ${strikeLabel(y0)}`;
        const title = `${kind === 'profit' ? 'MAX PROFIT' : 'MAX LOSS'} ${signedUsd(v)}`;
        // Compact markers get the caption level with the bracket; outlines inside their closed edge.
        const capY = compact
          ? (Math.max(y0, plotT) + Math.min(y1, plotB)) / 2
          : !atTop
            ? y1 - y0 >= 22
              ? y0 + 12
              : y0 - 10
            : !atBottom
              ? y1 - 10
              : y0 + 12;
        ctx.font = `600 10.5px ${MONO}`;
        // Name the date when it isn't the (only) expiry: mixed expiries, or the expiry is past the
        // right edge and the zone is described where the chart ends.
        const full = mixedExpiry || tRef < lastExp - 60_000 ? `${title} · ${where} on ${fmtTime(tRef, false)}` : `${title} · ${where}`;
        const text = ctx.measureText(full).width < xRef - nowX - 16 ? full : title;
        const tw = ctx.measureText(text).width;
        const tx = Math.max(nowX + 6, xRef - (compact ? 12 : 8) - tw);
        const ty = Math.max(plotT + 8, Math.min(plotB - 8, capY));
        ctx.fillStyle = 'rgba(12,15,20,0.72)';
        ctx.fillRect(tx - 4, ty - 8, tw + 8, 16);
        dbg.rects.push([tx - 4, ty - 8, tw + 8, 16]);
        ctx.fillStyle = col;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, tx, ty + 0.5);
        dbg.zones[dbg.zones.length - 1].labelled = true;
      };

      if (maxP > tol && !unlimitedProfit) drawZone('profit', maxP, ext.maxT, ext.maxS);
      if (minP < -tol && !unlimitedLoss) drawZone('loss', minP, ext.minT, ext.minS);

      // ---- Open-ended tails ----
      // Past the outermost strike the payoff is a straight line. If it keeps falling, the loss has
      // no cap (upside) or only stops at a price of zero (downside): hatch that zone so it can't be
      // mistaken for a capped one, and tag which way it runs.
      const strikes = legsForPnl.map((l) => l.strike);
      const kMax = Math.max(...strikes);
      const kMin = Math.min(...strikes);
      const downLoss = ext.lossToZero;
      const downProfit = !downLoss && ext.profitToZero;
      // Value if the price went to ~0, at whichever expiry is most extreme.
      const zeroVals = [...new Set(legsForPnl.map((l) => l.expiry))].map((e) => pnlFn(spot * 1e-4, e));
      const atZero = downLoss ? Math.min(...zeroVals) : Math.max(...zeroVals);
      // Hatch the open-ended loss zone exactly where it is on the map: in each column, the run of
      // losing cells that touches the top (upside tail) or bottom (downside tail) edge.
      const hatchTail = (dir: 'up' | 'down') => {
        const heat = heatRef.current;
        if (!heat) return;
        const { vals, cols, rows, cell: hc, x0 } = heat;
        const live = new Path2D();
        const settled = new Path2D();
        for (let c = 0; c < cols; c++) {
          let n = 0;
          if (dir === 'up') while (n < rows && vals[n * cols + c] < 0) n++;
          else while (n < rows && vals[(rows - 1 - n) * cols + c] < 0) n++;
          if (!n) continue;
          const x = x0 + c * hc;
          const y = dir === 'up' ? plotT : plotT + (rows - n) * hc;
          (x + hc / 2 > expR ? settled : live).rect(x, y, hc, n * hc);
        }
        const stripes = (clip: Path2D, alpha: number) => {
          ctx.save();
          ctx.beginPath();
          ctx.rect(hx0, plotT, plotR - hx0, plotB - plotT);
          ctx.clip();
          ctx.clip(clip);
          ctx.strokeStyle = `rgba(${C.loss.join(',')},${alpha})`;
          ctx.lineWidth = 1.25;
          ctx.beginPath();
          const hgt = plotB - plotT;
          for (let k = -hgt; k < plotR - hx0; k += 9) {
            ctx.moveTo(hx0 + k, plotB);
            ctx.lineTo(hx0 + k + hgt, plotT);
          }
          ctx.stroke();
          ctx.restore();
        };
        stripes(live, 0.5);
        stripes(settled, 0.22);
      };
      const tag = (dir: 'up' | 'down', kind: 'profit' | 'loss', title: string, sub: string) => {
        dbg.tags.push({ dir, kind });
        const rgb = kind === 'profit' ? C.profit : C.loss;
        const col = `rgb(${rgb.join(',')})`;
        // The zone starts where the payoff turns to this kind past the outermost strike (the
        // expiry break-even), not at the strike itself.
        const k0 = dir === 'up' ? kMax : kMin;
        const hit = (S: number) => (kind === 'loss' ? pnlFn(S, firstExp) < 0 : pnlFn(S, firstExp) > 0);
        let edgeP = k0;
        let prev = k0;
        for (let i = 0; i <= 400; i++) {
          const S = dir === 'up' ? k0 * (1 + 2 * (i / 400)) : k0 * (1 - 0.999 * (i / 400));
          if (hit(S)) {
            // Narrow down to the exact break-even between the last two samples.
            let lo = prev;
            let hi = S;
            for (let j = 0; j < 30; j++) {
              const mid = (lo + hi) / 2;
              if (hit(mid)) hi = mid;
              else lo = mid;
            }
            edgeP = hi;
            break;
          }
          prev = S;
        }
        if (kind === 'loss') hatchTail(dir);
        ctx.font = `600 11px ${MONO}`;
        const tw = ctx.measureText(title).width;
        ctx.font = `11px ${SANS}`;
        const w2 = Math.max(tw + 16, ctx.measureText(sub).width) + 18;
        const right = ex + 14 + w2 < plotR;
        const lx = right ? ex + 14 : Math.max(4, ex - 14 - w2);
        const ly = dir === 'up' ? plotT + 8 : plotB - 44;
        roundRect(ctx, lx, ly, w2, 36, 5);
        dbg.rects.push([lx, ly, w2, 36]);
        ctx.fillStyle = 'rgba(12,15,20,0.92)';
        ctx.fill();
        ctx.strokeStyle = col;
        ctx.stroke();
        // Arrow: which way the payoff keeps going.
        ctx.fillStyle = col;
        ctx.beginPath();
        const ax = lx + 13;
        const ay = ly + 12;
        if (dir === 'up') {
          ctx.moveTo(ax - 5, ay + 4);
          ctx.lineTo(ax + 5, ay + 4);
          ctx.lineTo(ax, ay - 5);
        } else {
          ctx.moveTo(ax - 5, ay - 4);
          ctx.lineTo(ax + 5, ay - 4);
          ctx.lineTo(ax, ay + 5);
        }
        ctx.fill();
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.font = `600 11px ${MONO}`;
        ctx.fillText(title, lx + 24, ly + 12);
        ctx.font = `11px ${SANS}`;
        ctx.fillStyle = C.muted;
        ctx.fillText(sub.replace('{edge}', fmtPrice(edgeP, 0)), lx + 9, ly + 26);
      };
      if (unlimitedLoss) tag('up', 'loss', 'LOSS UNCAPPED', 'loses above {edge}, no limit');
      else if (unlimitedProfit) tag('up', 'profit', 'PROFIT UNCAPPED', 'profits above {edge}, no limit');
      if (downLoss) tag('down', 'loss', `LOSS GROWS TO ${signedUsd(atZero, 0)}`, `loses below {edge}, worst if ${spec.asset} hits 0`);
      else if (downProfit) tag('down', 'profit', `PROFIT UP TO ${signedUsd(atZero, 0)}`, `profits below {edge}, best if ${spec.asset} hits 0`);
    }

    // ---- Drawn path: the one being drawn, or the guide for the fitted position ----
    const drawnPath = drag?.kind === 'draw' ? drag.path! : p.guide;
    if (drawnPath && drawnPath.length >= 2) {
      const live = drag?.kind === 'draw';
      ctx.save();
      ctx.beginPath();
      ctx.rect(nowX, plotT, plotR - nowX, plotB - plotT);
      ctx.clip();
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      const trace = () => {
        ctx.beginPath();
        drawnPath.forEach((q, i) => (i ? ctx.lineTo(tToX(q.t), pToY(q.p)) : ctx.moveTo(tToX(q.t), pToY(q.p))));
      };
      // A dark casing first, so the line reads on both green and red.
      trace();
      ctx.strokeStyle = 'rgba(12,15,20,0.7)';
      ctx.lineWidth = live ? 5 : 4;
      ctx.stroke();
      trace();
      ctx.strokeStyle = live ? C.text : 'rgba(227,231,238,0.85)';
      ctx.lineWidth = live ? 2.5 : 1.75;
      if (!live) ctx.setLineDash([6, 4]);
      ctx.stroke();
      ctx.restore();
    }

    // ---- Leg markers ----
    const markers: Marker[] = [];
    const editableIds = new Set(editableLegs.map((l) => l.id));
    const staticIds = new Set(staticLegs.map((l) => l.id));
    ctx.font = `600 11px ${MONO}`;
    ctx.textBaseline = 'middle';
    const drawLeg = (l: Leg, ghost = false, part: 'line' | 'dot' | 'both' = 'both') => {
      const isStatic = staticIds.has(l.id) && !editableIds.has(l.id);
      const dimmed = isStatic && editableLegs.length > 0;
      const x = Math.min(tToX(l.expiry), plotR - 2);
      const y = pToY(l.strike);
      if (y < plotT - 4 || y > plotB + 4) return;
      const col = l.side > 0 ? C.long : C.short;
      ctx.globalAlpha = ghost ? 0.85 : dimmed ? 0.5 : 1;
      if (part !== 'dot') {
        ctx.strokeStyle = col;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(nowX, y);
        ctx.lineTo(x, y);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      if (part === 'line') {
        ctx.globalAlpha = 1;
        return;
      }
      const r = l.id === selectedLegId ? 6.5 : 5.5;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = col;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = l.id === selectedLegId ? C.text : '#0c0f14';
      if (ghost) ctx.setLineDash([2, 2]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineWidth = 1;
      ctx.globalAlpha = 1;
      if (!isStatic && !ghost) {
        const label = `${l.side > 0 ? 'Long' : 'Short'} ${l.qty} × ${fmtPrice(l.strike, 0)} ${l.type === 'C' ? 'Call' : 'Put'} · ${fmtTime(l.expiry, false)}`;
        markers.push({ id: l.id, x: x - 10, y: y - 10, w: 20, h: 20, label, color: col });
      }
    };
    // Two passes, so no leg's strike line is ever drawn over another leg's dot.
    for (const part of ['line', 'dot'] as const) {
      for (const l of staticLegs) if (!editableIds.has(l.id)) drawLeg(l, false, part);
      for (const l of editableLegs) {
        const o = override?.get(l.id);
        if (o) drawLeg({ ...l, strike: o.strike, expiry: o.expiry }, !!dragLeg || !!dragGroup, part);
        else drawLeg(l, false, part);
      }
    }

    // ---- Group handle: drag it to move every leg of the ticket together ----
    if (editableLegs.length >= 2) {
      const placed = editableLegs.map((l) => {
        const o = override?.get(l.id);
        return { x: Math.min(tToX(o?.expiry ?? l.expiry), plotR - 2), y: pToY(o?.strike ?? l.strike) };
      });
      const gx = placed.reduce((a, q) => a + q.x, 0) / placed.length;
      let gy = placed.reduce((a, q) => a + q.y, 0) / placed.length;
      // Keep it clear of the leg dots (e.g. two legs on one strike).
      if (placed.some((q) => Math.hypot(q.x - gx, q.y - gy) < 16)) gy -= 20;
      if (gy > plotT + 8 && gy < plotB - 8 && gx > nowX) {
        const hot = !!dragGroup || (hover && Math.hypot(hover.x - gx, hover.y - gy) < 12);
        ctx.beginPath();
        ctx.arc(gx, gy, 8, 0, Math.PI * 2);
        ctx.fillStyle = hot ? C.text : 'rgba(17,21,28,0.92)';
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = C.text;
        ctx.stroke();
        // Four-way arrow.
        ctx.strokeStyle = hot ? '#0c0f14' : C.text;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ]) {
          ctx.moveTo(gx + dx * 1.5, gy + dy * 1.5);
          ctx.lineTo(gx + dx * 5, gy + dy * 5);
          ctx.moveTo(gx + dx * 5 - dy * 1.8 - dx * 1.8, gy + dy * 5 - dx * 1.8 - dy * 1.8);
          ctx.lineTo(gx + dx * 5, gy + dy * 5);
          ctx.lineTo(gx + dx * 5 + dy * 1.8 - dx * 1.8, gy + dy * 5 + dx * 1.8 - dy * 1.8);
        }
        ctx.stroke();
        ctx.lineWidth = 1;
        markers.push({ id: GROUP_ID, x: gx - 11, y: gy - 11, w: 22, h: 22, label: `Move all ${editableLegs.length} legs together`, color: C.text });
      }
    }
    markersRef.current = markers;

    // Group drag: where each leg lands if dropped now.
    if (dragGroup && dragGroup.groupTo) {
      ctx.strokeStyle = 'rgba(227,231,238,0.75)';
      ctx.setLineDash([3, 3]);
      for (const l of dragGroup.groupTo) {
        ctx.beginPath();
        ctx.arc(Math.min(tToX(l.expiry), plotR - 2), pToY(l.strike), 9, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      const from = dragGroup.groupFrom!;
      const dK = dragGroup.groupTo[0].strike - from[0].strike;
      const top = dragGroup.groupTo.reduce((a, l) => (pToY(l.strike) < pToY(a.strike) ? l : a));
      const text = `${dK === 0 ? '±0' : `${dK > 0 ? '+' : '−'}${fmtPrice(Math.abs(dK), 0)}`} · ${[...new Set(dragGroup.groupTo.map((l) => fmtTime(l.expiry, false)))].join(', ')}`;
      ctx.font = `600 11px ${MONO}`;
      const tw = ctx.measureText(text).width + 12;
      const sx = Math.min(tToX(top.expiry), plotR - 2);
      const sy = pToY(top.strike) - 22;
      const tx = Math.max(nowX + 2, Math.min(plotR - tw - 2, sx - tw / 2));
      roundRect(ctx, tx, sy - 10, tw, 20, 4);
      ctx.fillStyle = 'rgba(17,21,28,0.92)';
      ctx.fill();
      ctx.fillStyle = C.text;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, tx + 6, sy + 0.5);
    }

    // Snap target while dragging: where the leg will land if dropped now.
    if (dragLeg) {
      const leg = legs.find((l) => l.id === dragLeg.id);
      const sx = tToX(dragLeg.expiry!);
      const sy = pToY(dragLeg.strike!);
      ctx.strokeStyle = 'rgba(227,231,238,0.75)';
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.arc(sx, sy, 9, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      if (leg) {
        const text = `${fmtPrice(dragLeg.strike!, 0)} ${leg.type} · ${fmtTime(dragLeg.expiry!, false)}`;
        ctx.font = `600 11px ${MONO}`;
        const tw = ctx.measureText(text).width + 12;
        const tx = Math.min(plotR - tw - 2, sx + 14);
        roundRect(ctx, tx, sy - 10, tw, 20, 4);
        ctx.fillStyle = 'rgba(17,21,28,0.92)';
        ctx.fill();
        ctx.fillStyle = C.text;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, tx + 6, sy + 0.5);
      }
    }

    // ---- Ghost for the active tool ----
    const overMarker = hover && markers.find((m) => hover.x >= m.x && hover.x <= m.x + m.w && hover.y >= m.y && hover.y <= m.y + m.h);
    let ghostInfo: string[] | null = null;
    // ---- Easy mode: a grid of bets ----
    // Columns run from one listed expiry to the next; rows are bands between listed strikes on
    // that expiry (merged until tall enough to tap), so boxes differ in size. Each box is one bet:
    // above the index, "ends above this band"; below it, "ends below". It shows its multiplier.
    let easyInfo: { q: BetQuote; box: EasyBox } | null = null;
    if (p.easy) {
      const easy = p.easy;
      const key = [spot.toFixed(2), Math.floor(now / 15000), w, h, g.lo.toFixed(3), g.hi.toFixed(3), view.horizon, nowX.toFixed(1), expiries.map((e) => e.ts).join(',')].join('#');
      if (!easyGridRef.current || easyGridRef.current.key !== key) {
        const boxes: EasyBox[] = [];
        let lastX = nowX;
        for (const e of [...expiries].sort((a, b) => a.ts - b.ts)) {
          const x = tToX(e.ts);
          if (x <= nowX + 4 || x > plotR) continue;
          if (x - lastX < 34) continue;
          const ks = market.strikes(e.ts).filter((k) => k > 0);
          const edges: number[] = [];
          for (const k of ks) {
            const y = pToY(k);
            if (y > plotB + 40) continue;
            if (!edges.length || pToY(edges[edges.length - 1]) - y >= 22) edges.push(k);
            if (y < plotT - 40) break;
          }
          for (let i = 0; i + 1 < edges.length; i++) {
            const q = easy.quote(e.ts, edges[i], edges[i + 1]);
            if (q) boxes.push({ expiry: e.ts, lo: edges[i], hi: edges[i + 1], x0: lastX, x1: x, q });
          }
          lastX = x;
        }
        easyGridRef.current = { key, boxes };
      }
      const boxes = easyGridRef.current.boxes;
      const hit = hover && !drag ? boxes.find((b) => hover.x > b.x0 && hover.x <= b.x1 && hover.y <= pToY(b.lo) && hover.y > pToY(b.hi)) : undefined;
      if (hit) easyInfo = { q: hit.q, box: hit };
      const rgbOf = (dir: 'above' | 'below') => (dir === 'above' ? C.profit : C.loss);
      ctx.save();
      ctx.beginPath();
      ctx.rect(nowX, plotT, plotR - nowX, plotB - plotT);
      ctx.clip();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const isPending = (b: EasyBox) => !!easy.pending && easy.pending.expiry === b.expiry && easy.pending.lo === b.lo && easy.pending.hi === b.hi;
      for (const b of boxes) {
        const x0 = b.x0 + 1.5;
        const x1 = b.x1 - 1.5;
        const y0 = pToY(b.hi) + 1.5;
        const y1 = pToY(b.lo) - 1.5;
        if (y1 < plotT || y0 > plotB || x1 - x0 < 6 || y1 - y0 < 4) continue;
        const rgb = rgbOf(b.q.dir).join(',');
        const m = multiplier(b.q.price);
        // Longer odds glow brighter, like the numbers on a betting board.
        const heat = Math.min(1, Math.log(m) / Math.log(40));
        const sel = isPending(b);
        const hov = hit === b;
        roundRect(ctx, x0, y0, x1 - x0, y1 - y0, 4);
        ctx.fillStyle = sel ? `rgba(${rgb},0.55)` : hov ? `rgba(${rgb},0.28)` : `rgba(${rgb},${0.03 + 0.07 * heat})`;
        ctx.fill();
        ctx.strokeStyle = sel || hov ? `rgba(${rgb},0.95)` : `rgba(${rgb},${0.1 + 0.15 * heat})`;
        ctx.lineWidth = sel ? 1.5 : 1;
        ctx.stroke();
        ctx.lineWidth = 1;
        if (y1 - y0 >= 12 && x1 - x0 >= 30) {
          ctx.font = `${sel || hov ? 700 : 600} ${y1 - y0 >= 18 ? 10.5 : 9.5}px ${MONO}`;
          ctx.fillStyle = sel ? '#0c0f14' : hov ? C.text : `rgba(${rgb},${0.45 + 0.55 * heat})`;
          ctx.fillText(fmtMultiplier(m), (x0 + x1) / 2, (y0 + y1) / 2 + 0.5);
        }
      }
      // Placed bets: an outline on their box, with the price paid and now.
      ctx.font = `600 9.5px ${MONO}`;
      for (const b of easy.bets) {
        const col = boxes.find((x) => x.expiry === b.expiry);
        const bx1 = col ? col.x1 : Math.min(tToX(b.expiry), plotR - 2);
        const bx0 = col ? col.x0 : bx1 - 40;
        const y0 = pToY(b.hi) + 1;
        const y1 = pToY(b.lo) - 1;
        if (y1 < plotT || y0 > plotB) continue;
        const rgb = rgbOf(b.dir).join(',');
        ctx.setLineDash([4, 3]);
        roundRect(ctx, bx0 + 1, y0, bx1 - bx0 - 2, Math.max(8, y1 - y0), 4);
        ctx.strokeStyle = `rgb(${rgb})`;
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.lineWidth = 1;
        const tw = ctx.measureText(b.label).width + 12;
        const tx = Math.max(nowX + 2, Math.min(plotR - tw - 2, bx1 - tw));
        roundRect(ctx, tx, y0 - 16, tw, 14, 3);
        ctx.fillStyle = `rgb(${rgb})`;
        ctx.fill();
        ctx.fillStyle = '#0c0f14';
        ctx.fillText(b.label, tx + tw / 2, y0 - 9);
      }
      ctx.restore();
    }
    if (snap && isLegTool(tool) && !overMarker) {
      const tl = TOOL_LEG[tool];
      const ghost: Leg = { id: '__ghost', asset: spec.asset, type: tl.type, side: tl.side, strike: snap.strike, expiry: snap.expiry, qty: 1 };
      drawLeg(ghost, true);
      const T = (snap.expiry - now) / YEAR;
      const iv = market.iv(tl.type, snap.strike, snap.expiry, now);
      const prem = bsPrice(tl.type, spot, snap.strike, T, iv);
      ghostInfo = [
        `${tl.label} ${fmtPrice(snap.strike, 0)} · ${fmtTime(snap.expiry, false)}`,
        `${tl.side > 0 ? 'Pay' : 'Receive'} ${compactUsd(prem)} · IV ${(iv * 100).toFixed(1)}%`,
      ];
    }

    // ---- Profile gutter: P&L across price at one moment ----
    const gx0 = plotR;
    ctx.fillStyle = '#0e1218';
    ctx.fillRect(gx0, plotT, PW, plotB - plotT);
    ctx.strokeStyle = C.line;
    ctx.beginPath();
    ctx.moveTo(gx0 + 0.5, plotT);
    ctx.lineTo(gx0 + 0.5, plotB);
    ctx.moveTo(gx0 + PW + 0.5, 0);
    ctx.lineTo(gx0 + PW + 0.5, h);
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
      const zx = gx0 + PW / 2;
      const half = PW / 2 - 6;
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
      ctx.fillRect(gx0 + 1, plotT, PW - 1, 30);
      ctx.font = `600 9px ${MONO}`;
      ctx.fillStyle = C.muted;
      ctx.textAlign = 'center';
      ctx.fillText(narrow ? (hoverT ? 'P&L' : 'EXP') : hoverT ? 'P&L AT' : 'AT EXPIRY', zx, plotT + 10);
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
    } else if (!p.easy) {
      ctx.font = `600 9px ${MONO}`;
      ctx.fillStyle = C.dim;
      ctx.textAlign = 'center';
      ctx.fillText('P&L', gx0 + PW / 2, plotT + 10);
    }

    // Spot tag on the axis.
    ctx.font = `600 11px ${MONO}`;
    const sLabel = fmtPrice(spot, narrow ? 0 : spec.priceDecimals);
    roundRect(ctx, plotR + PW + 2, sy - 9, AW - 4, 18, 3);
    ctx.fillStyle = C.text;
    ctx.fill();
    ctx.fillStyle = C.bg;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(sLabel, plotR + PW + 7, sy + 0.5);

    // ---- Crosshair + tooltip ----
    if (hover && hover.x < plotR && hover.y > plotT && hover.y < plotB && !drag) {
      const hy = Math.round(hover.y) + 0.5;
      ctx.strokeStyle = 'rgba(227,231,238,0.22)';
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(0, hy);
      ctx.lineTo(plotR + PW, hy);
      if (hover.x <= nowX) {
        ctx.moveTo(Math.round(hover.x) + 0.5, plotT);
        ctx.lineTo(Math.round(hover.x) + 0.5, plotB);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      const hp = yToP(hover.y);
      roundRect(ctx, plotR + PW + 2, hy - 9, AW - 4, 18, 3);
      ctx.fillStyle = C.line;
      ctx.fill();
      ctx.fillStyle = C.text;
      ctx.font = `11px ${MONO}`;
      ctx.fillText(fmtPrice(hp, hp < 100 ? 2 : 0), plotR + PW + 7, hy + 0.5);

      const lines: { text: string; color?: string; bold?: boolean }[] = [];
      const ht = xToT(hover.x);
      if (overMarker) lines.push({ text: overMarker.label, bold: true, color: overMarker.color });
      if (hover.x > nowX) {
        if (ghostInfo) {
          lines.push({ text: ghostInfo[0], bold: true, color: TOOL_LEG[tool as LegTool].side > 0 ? C.long : C.short });
          lines.push({ text: ghostInfo[1] });
        }
        if (easyInfo) {
          const { q } = easyInfo;
          const col = q.dir === 'above' ? `rgb(${C.profit.join(',')})` : `rgb(${C.loss.join(',')})`;
          const m = multiplier(q.price);
          lines.push({ text: `${betQuestion(spec.asset, q.dir, q.level)} on ${fmtTime(q.expiry, false)}`, bold: true, color: col });
          lines.push({ text: `${fmtMultiplier(m)} · $1 wins $${m.toFixed(2)} · ${Math.round(q.price * 100)}% chance`, bold: true });
          lines.push({ text: 'Click to bet', color: C.muted });
        }
        if (!easyInfo) lines.push({ text: `${fmtTime(ht, true)} UTC · ${fmtPrice(hp, hp < 100 ? 2 : 0)}`, color: C.muted });
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
    ctx.lineTo(plotR + PW, plotT - 0.5);
    ctx.stroke();

    // Cursor.
    let cursor = 'default';
    if (drag) cursor = drag.kind === 'axis' ? 'ns-resize' : drag.kind === 'group' ? 'move' : drag.kind === 'draw' ? 'crosshair' : 'grabbing';
    else if (tool === 'pointer' && hover && hover.x < plotR) cursor = overMarker ? 'grab' : 'move';
    else if (overMarker) cursor = 'grab';
    else if (hover && hover.x > plotR + PW) cursor = 'ns-resize';
    else if (snap && isLegTool(tool)) cursor = 'crosshair';
    else if (easyInfo) cursor = 'pointer';
    else if (tool === 'draw' && hover && hover.x > nowX && hover.x < plotR) cursor = 'crosshair';
    canvas.style.cursor = cursor;

    const testWin = window as unknown as { __TICKET_TEST__?: boolean; __chart?: unknown };
    if (testWin.__TICKET_TEST__) {
      const heat = heatRef.current;
      testWin.__chart = {
        ...dbg,
        spot,
        now,
        asset: spec.asset,
        geom: { nowX, plotR, plotT, plotB, lo: g.lo, hi: g.hi, expR, profileW: g.profileW },
        tToX,
        xToT,
        pToY,
        yToP,
        legs: legsForPnl.map((l) => ({ id: l.id, type: l.type, side: l.side, strike: l.strike, expiry: l.expiry, qty: l.qty, entry: l.entry })),
        markers: markers.map((m) => ({ id: m.id, x: m.x + m.w / 2, y: m.y + m.h / 2 })),
        guide: p.guide,
        easyHover: easyInfo ? { ...easyInfo.q } : null,
        easyBoxes: p.easy ? (easyGridRef.current?.boxes ?? []).map((b) => ({ expiry: b.expiry, lo: b.lo, hi: b.hi, x0: b.x0, x1: b.x1, y0: g.pToY(b.hi), y1: g.pToY(b.lo), price: b.q.price, dir: b.q.dir })) : null,
        heat: heat && maxAbs > 1e-9 ? { x0: heat.x0, cell: heat.cell, cols: heat.cols, rows: heat.rows, contour: heat.contour } : null,
        pnl: pnlFn,
        draw,
      };
    }
    } finally {
      // Always unwind, so a frame that fails part-way can't leave a clip behind and blank the next.
      ctx.restore();
    }
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

  // Wheel: scroll zooms time; shift/axis scroll zooms price. The zoom amount follows how far
  // you scrolled (so trackpads and mouse wheels feel the same) and eases toward the target.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const step = () => {
      const z = zoomRef.current;
      if (!z) return;
      const { onViewChange } = propsRef.current;
      const view = z.cur;
      const ease = (cur: number, target: number) => {
        const next = Math.exp(Math.log(cur) + (Math.log(target) - Math.log(cur)) * 0.28);
        return Math.abs(Math.log(target / next)) < 0.002 ? target : next;
      };
      const horizon = ease(view.horizon, z.horizon);
      const yZoom = ease(view.yZoom, z.yZoom);
      lastMoveRef.current = performance.now();
      z.cur = { ...view, horizon, yZoom };
      z.sent.push(z.cur);
      if (z.sent.length > 8) z.sent.shift();
      onViewChange(z.cur);
      if (horizon === z.horizon && yZoom === z.yZoom) zoomRef.current = null;
      else z.raf = requestAnimationFrame(step);
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const { view } = propsRef.current;
      const g = geomRef.current;
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? rect.height : 1;
      const raw = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
      const d = Math.max(-80, Math.min(80, raw * unit));
      const f = Math.exp(d * 0.0012);
      const z = zoomRef.current ?? { horizon: view.horizon, yZoom: view.yZoom, raf: 0, cur: view, sent: [] };
      if (e.shiftKey || (g && x > g.plotR)) z.yZoom = Math.min(4, Math.max(0.15, z.yZoom * f));
      else z.horizon = Math.min(MAX_HORIZON, Math.max(1.5 * DAY, z.horizon * f));
      if (!zoomRef.current) {
        zoomRef.current = z;
        z.raf = requestAnimationFrame(step);
      }
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      canvas.removeEventListener('wheel', onWheel);
      if (zoomRef.current) cancelAnimationFrame(zoomRef.current.raf);
      zoomRef.current = null;
    };
  }, []);

  // A view change that didn't come from the zoom animation (horizon buttons, axis drag, reset)
  // cancels the animation so it doesn't pull the view back.
  useEffect(() => {
    const z = zoomRef.current;
    if (z && !z.sent.includes(props.view)) {
      cancelAnimationFrame(z.raf);
      zoomRef.current = null;
    }
  }, [props.view]);

  const pos = (e: React.PointerEvent) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  /** `slack` widens the target for fingers. */
  const hitMarker = (x: number, y: number, slack = 0) =>
    [...markersRef.current]
      .reverse()
      .find((m) => x >= m.x - slack && x <= m.x + m.w + slack && y >= m.y - slack && y <= m.y + m.h + slack);

  // Touch: the chart lets vertical swipes scroll the page (touch-action: pan-y), except when the
  // finger lands on a leg or the price axis, where we block scrolling so the drag works.
  //
  // Gestures on top of that:
  // - long-press on empty chart: "inspect" — pins the crosshair and tooltip (premium, P&L) at that
  //   point; keep the finger down to scrub. The next tap dismisses it.
  // - long-press on a leg dot: removes the leg (undo brings it back).
  // - two-finger pinch: horizontal spread zooms time, vertical spread zooms price.
  const tapRef = useRef<{ x: number; y: number } | null>(null);
  const inspectRef = useRef(false);
  const longPressRef = useRef<number | null>(null);
  const pinchRef = useRef<{ dx: number; dy: number; horizon: number; yZoom: number } | null>(null);
  const cancelLongPress = () => {
    if (longPressRef.current !== null) window.clearTimeout(longPressRef.current);
    longPressRef.current = null;
  };
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const spread = (e: TouchEvent) => ({
      dx: Math.abs(e.touches[0].clientX - e.touches[1].clientX),
      dy: Math.abs(e.touches[0].clientY - e.touches[1].clientY),
    });
    const onTouchStart = (e: TouchEvent) => {
      const g = geomRef.current;
      if (!g) return;
      if (e.touches.length === 2) {
        // Second finger down: this is a pinch, not a tap, drag or inspect.
        e.preventDefault();
        cancelLongPress();
        tapRef.current = null;
        dragRef.current = null;
        inspectRef.current = false;
        hoverRef.current = null;
        const { view } = propsRef.current;
        pinchRef.current = { ...spread(e), horizon: view.horizon, yZoom: view.yZoom };
        return;
      }
      const t = e.touches[0];
      if (!t || e.touches.length > 2) return;
      const r = canvas.getBoundingClientRect();
      const x = t.clientX - r.left;
      const y = t.clientY - r.top;
      if (x > g.plotR + g.profileW || hitMarker(x, y, TOUCH_SLACK)) e.preventDefault();
      // Drawing a path: the finger draws instead of scrolling the page.
      else if (propsRef.current.tool === 'draw' && x > g.nowX && x < g.plotR) e.preventDefault();
    };
    const onTouchMove = (e: TouchEvent) => {
      const pinch = pinchRef.current;
      if (pinch && e.touches.length === 2) {
        e.preventDefault();
        const { dx, dy } = spread(e);
        const { view, onViewChange } = propsRef.current;
        const next = { ...view };
        // Only an axis the fingers are actually spread along gets zoomed.
        if (pinch.dx > 40) next.horizon = Math.min(MAX_HORIZON, Math.max(1.5 * DAY, pinch.horizon * (pinch.dx / Math.max(dx, 20))));
        if (pinch.dy > 40) next.yZoom = Math.min(4, Math.max(0.15, pinch.yZoom * (pinch.dy / Math.max(dy, 20))));
        lastMoveRef.current = performance.now();
        onViewChange(next);
        return;
      }
      // While inspecting, the finger scrubs the crosshair instead of scrolling the page.
      if (inspectRef.current) e.preventDefault();
    };
    const onTouchEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) pinchRef.current = null;
    };
    canvas.addEventListener('touchstart', onTouchStart, { passive: false });
    canvas.addEventListener('touchmove', onTouchMove, { passive: false });
    canvas.addEventListener('touchend', onTouchEnd);
    canvas.addEventListener('touchcancel', onTouchEnd);
    return () => {
      canvas.removeEventListener('touchstart', onTouchStart);
      canvas.removeEventListener('touchmove', onTouchMove);
      canvas.removeEventListener('touchend', onTouchEnd);
      canvas.removeEventListener('touchcancel', onTouchEnd);
      cancelLongPress();
    };
  }, []);

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || !e.isPrimary || pinchRef.current) return;
    const { x, y } = pos(e);
    const touch = e.pointerType === 'touch';
    if (touch && inspectRef.current) {
      // A tap while inspecting just dismisses the inspector.
      inspectRef.current = false;
      hoverRef.current = null;
      draw();
      return;
    }
    hoverRef.current = { x, y };
    const g = geomRef.current ?? computeGeom();
    const p = propsRef.current;
    if (x > g.plotR + g.profileW) {
      dragRef.current = { kind: 'axis', startX: x, startY: y, startShift: p.view.yShift, moved: false };
      (e.target as Element).setPointerCapture(e.pointerId);
      return;
    }
    const m = hitMarker(x, y, e.pointerType === 'touch' ? TOUCH_SLACK : 0);
    if (m && m.id === GROUP_ID) {
      const from = p.editableLegs.map((l) => ({ id: l.id, strike: l.strike, expiry: l.expiry }));
      dragRef.current = { kind: 'group', startX: x, startY: y, moved: false, groupFrom: from, groupTo: from };
      (e.target as Element).setPointerCapture(e.pointerId);
      draw();
      return;
    }
    if (!m && p.tool === 'draw' && x > g.nowX && x < g.plotR && y > g.plotT && y < g.plotB) {
      dragRef.current = { kind: 'draw', startX: x, startY: y, moved: false, path: [{ t: g.xToT(x), p: g.yToP(y) }] };
      (e.target as Element).setPointerCapture(e.pointerId);
      draw();
      return;
    }
    if (m) {
      const leg = p.editableLegs.find((l) => l.id === m.id)!;
      dragRef.current = { kind: 'leg', id: m.id, startX: x, startY: y, moved: false, strike: leg.strike, expiry: leg.expiry, grabDX: m.x + m.w / 2 - x, grabDY: m.y + m.h / 2 - y };
      (e.target as Element).setPointerCapture(e.pointerId);
      if (touch) {
        cancelLongPress();
        longPressRef.current = window.setTimeout(() => {
          longPressRef.current = null;
          const d = dragRef.current;
          if (d?.kind !== 'leg' || d.moved) return;
          dragRef.current = null;
          hoverRef.current = null;
          navigator.vibrate?.(15);
          propsRef.current.onRemove(d.id!);
        }, LONG_PRESS_MS);
      }
      draw();
      return;
    }
    // Clicks and taps act on release (see onPointerUp); if the pointer moves first, it's a pan.
    tapRef.current = { x, y };
    if (!touch) (e.target as Element).setPointerCapture(e.pointerId);
    if (touch) {
      cancelLongPress();
      longPressRef.current = window.setTimeout(() => {
        longPressRef.current = null;
        if (!tapRef.current) return;
        tapRef.current = null;
        inspectRef.current = true;
        navigator.vibrate?.(10);
        draw();
      }, LONG_PRESS_MS);
    }
    draw();
  };

  /** Click / tap on empty chart: place a leg with the active tool, or clear the selection. */
  const act = (g: Geom, x: number, y: number) => {
    const p = propsRef.current;
    if (p.easy) {
      const b = easyGridRef.current?.boxes.find((bx) => x > bx.x0 && x <= bx.x1 && y <= g.pToY(bx.lo) && y > g.pToY(bx.hi));
      if (b) p.easy.onPick(b.expiry, b.lo, b.hi);
      return;
    }
    if (!isLegTool(p.tool)) {
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
    if (!e.isPrimary || pinchRef.current) return;
    const { x, y } = pos(e);
    hoverRef.current = { x, y };
    const tap = tapRef.current;
    const touch = e.pointerType === 'touch';
    if (tap && Math.abs(x - tap.x) + Math.abs(y - tap.y) > (touch ? 10 : 4)) {
      // Moved before release: pan the chart instead of placing anything.
      tapRef.current = null;
      cancelLongPress();
      const p = propsRef.current;
      const g0 = geomRef.current;
      if (g0) {
        dragRef.current = {
          kind: 'pan',
          startX: tap.x,
          startY: tap.y,
          startFrac: g0.nowX / g0.plotR,
          startShift: p.view.yShift,
          moved: true,
          touch,
        };
      }
    }
    const d = dragRef.current;
    const g = geomRef.current;
    if (d && g) {
      if (Math.abs(x - d.startX) + Math.abs(y - d.startY) > 4) {
        d.moved = true;
        cancelLongPress();
      }
      if (d.kind === 'pan') {
        const p = propsRef.current;
        lastMoveRef.current = performance.now();
        const nowFrac = Math.min(0.92, Math.max(0.02, d.startFrac! + (x - d.startX) / g.plotR));
        // Fingers pan sideways only (up/down scrolls the page); a mouse pans both ways.
        const yShift = d.touch ? p.view.yShift : d.startShift! + ((y - d.startY) / (g.plotB - g.plotT)) * p.view.yZoom;
        p.onViewChange({ ...p.view, nowFrac, yShift });
      } else if (d.kind === 'axis') {
        const p = propsRef.current;
        lastMoveRef.current = performance.now();
        p.onViewChange({ ...p.view, yShift: d.startShift! + ((y - d.startY) / (g.plotB - g.plotT)) * p.view.yZoom });
      } else if (d.kind === 'draw') {
        // The path runs forward in time: moving back left redraws from there.
        const cx = Math.max(g.nowX + 1, Math.min(g.plotR - 1, x));
        const cy = Math.max(g.plotT + 1, Math.min(g.plotB - 1, y));
        const t = g.xToT(cx);
        const path = d.path!;
        while (path.length > 1 && path[path.length - 1].t >= t) path.pop();
        if (t > path[path.length - 1].t) path.push({ t, p: g.yToP(cy) });
      } else if (d.kind === 'group') {
        if (d.moved) {
          const p = propsRef.current;
          const cy = Math.max(g.plotT + 1, Math.min(g.plotB - 1, y));
          const dP = g.yToP(cy) - g.yToP(d.startY);
          const dT = g.xToT(Math.max(g.nowX + 3, Math.min(g.plotR, x))) - g.xToT(d.startX);
          const from = d.groupFrom!;
          // Drawn and priced continuously under the pointer…
          d.groupLive = from.map((l) => ({ id: l.id, strike: Math.max(1, l.strike + dP), expiry: Math.max(p.now + HOUR, l.expiry + dT) }));
          // …and landing on listed contracts: every leg shifts by the same number of expiries, and
          // by the same strike offset (taken from the first leg's snap), so the shape is kept.
          const exps = p.expiries.map((e) => e.ts);
          const idxOf = (ts: number) => exps.reduce((bi, e, i) => (Math.abs(e - ts) < Math.abs(exps[bi] - ts) ? i : bi), 0);
          if (exps.length) {
            const idx = from.map((l) => idxOf(l.expiry));
            const anchor = from.reduce((a, l, i) => (l.expiry < from[a].expiry ? i : a), 0);
            let k = idxOf(from[anchor].expiry + dT) - idx[anchor];
            k = Math.max(-Math.min(...idx), Math.min(exps.length - 1 - Math.max(...idx), k));
            const newExp = idx.map((i) => exps[i + k]);
            const snapped0 = p.market.snapStrike(from[0].strike + dP, newExp[0]);
            const dK = snapped0 - from[0].strike;
            d.groupTo = from.map((l, i) => ({ id: l.id, strike: p.market.snapStrike(l.strike + dK, newExp[i]), expiry: newExp[i] }));
          }
          lastMoveRef.current = performance.now();
        }
      } else if (d.moved) {
        const cx = Math.max(g.nowX + 3, Math.min(g.plotR, x + (d.grabDX ?? 0)));
        const cy = Math.max(g.plotT + 1, Math.min(g.plotB - 1, y + (d.grabDY ?? 0)));
        d.liveStrike = Math.max(1, g.yToP(cy));
        d.liveExpiry = Math.max(propsRef.current.now + HOUR, g.xToT(cx));
        const s = snapAt(g, cx, cy);
        if (s) {
          d.strike = s.strike;
          d.expiry = s.expiry;
        }
        lastMoveRef.current = performance.now();
      }
    }
    draw();
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (!e.isPrimary) return;
    cancelLongPress();
    const tap = tapRef.current;
    tapRef.current = null;
    if (tap && geomRef.current) act(geomRef.current, tap.x, tap.y);
    const d = dragRef.current;
    dragRef.current = null;
    if (d?.kind === 'leg') {
      const p = propsRef.current;
      if (d.moved) {
        settleRef.current = {
          moves: [{ id: d.id!, from: { strike: d.liveStrike ?? d.strike!, expiry: d.liveExpiry ?? d.expiry! }, to: { strike: d.strike!, expiry: d.expiry! } }],
          t0: performance.now(),
        };
        glide();
        p.onMove(d.id!, d.strike!, d.expiry!);
      } else p.onSelect(d.id!);
    }
    if (d?.kind === 'draw' && d.path) {
      const g = geomRef.current;
      const path = d.path;
      // Ignore a click or a tiny scribble: a path needs some length in time.
      if (g && path.length >= 2 && g.tToX(path[path.length - 1].t) - g.tToX(path[0].t) > 12) propsRef.current.onDraw(path);
    }
    if (d?.kind === 'group' && d.moved && d.groupTo && d.groupLive) {
      const live = new Map(d.groupLive.map((l) => [l.id, l]));
      settleRef.current = {
        moves: d.groupTo.map((l) => ({ id: l.id, from: live.get(l.id)!, to: { strike: l.strike, expiry: l.expiry } })),
        t0: performance.now(),
      };
      glide();
      propsRef.current.onMoveGroup(d.groupTo);
    }
    draw();
  };

  /** Redraws each frame while a drop settles. */
  const glide = () => {
    const step = () => {
      if (!settleRef.current) return;
      lastMoveRef.current = performance.now();
      draw();
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };

  const onContextMenu = (e: React.MouseEvent) => {
    const r = canvasRef.current!.getBoundingClientRect();
    const m = hitMarker(e.clientX - r.left, e.clientY - r.top);
    if (m) {
      e.preventDefault();
      if (m.id !== GROUP_ID) propsRef.current.onRemove(m.id);
    }
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    const g = geomRef.current;
    const r = canvasRef.current!.getBoundingClientRect();
    if (!g) return;
    const p = propsRef.current;
    if (e.clientX - r.left > g.plotR + g.profileW) p.onViewChange({ ...p.view, yZoom: 1, yShift: 0 });
    else if (p.tool === 'pointer') p.onViewChange({ ...p.view, yZoom: 1, yShift: 0, nowFrac: undefined });
  };

  return (
    <div ref={wrapRef} className="chart-canvas-wrap">
      <canvas
        ref={canvasRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          // The browser took over (usually a scroll): drop the gesture without acting on it.
          cancelLongPress();
          tapRef.current = null;
          dragRef.current = null;
          hoverRef.current = null;
          draw();
        }}
        onPointerLeave={() => {
          // An inspect keeps its crosshair after the finger lifts.
          if (!dragRef.current && !inspectRef.current) {
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

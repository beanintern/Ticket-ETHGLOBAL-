import { bsGreeks, bsPrice, normCdf, type Greeks, type OptType } from './bs';
import { DAY, YEAR, expiryLabel, impliedVol, type Asset, type MarketSpec } from './market';

export type Side = 1 | -1;

export interface Leg {
  id: string;
  asset: Asset;
  type: OptType;
  side: Side;
  strike: number;
  expiry: number;
  qty: number;
  /** Fill price per contract. Undefined for legs still in the builder (priced at mark). */
  entry?: number;
}

export interface Position {
  id: string;
  asset: Asset;
  name: string;
  legs: Leg[];
  openedAt: number;
  openSpot: number;
}

export interface ClosedPosition {
  id: string;
  asset: Asset;
  name: string;
  openedAt: number;
  closedAt: number;
  realized: number;
}

let seq = 0;
export const newId = (p = 'leg') => `${p}_${Date.now().toString(36)}_${(seq++).toString(36)}`;

export interface Model {
  legs: Leg[];
  ivs: number[];
  marks: number[];
  entries: number[];
  /** Positive = you pay (debit). */
  cost: number;
  /** Current mark-to-market value of the whole structure. */
  value: number;
  pnl: (S: number, t: number) => number;
}

export function buildModel(legs: Leg[], spec: MarketSpec, spot: number, now: number): Model {
  const ivs = legs.map((l) => impliedVol(spec, spot, l.strike, Math.max((l.expiry - now) / YEAR, 1e-6)));
  const marks = legs.map((l, i) => bsPrice(l.type, spot, l.strike, (l.expiry - now) / YEAR, ivs[i]));
  const entries = legs.map((l, i) => l.entry ?? marks[i]);
  let cost = 0;
  let value = 0;
  legs.forEach((l, i) => {
    cost += l.side * l.qty * entries[i];
    value += l.side * l.qty * marks[i];
  });
  const pnl = (S: number, t: number) => {
    let s = 0;
    for (let i = 0; i < legs.length; i++) {
      const l = legs[i];
      s += l.side * l.qty * (bsPrice(l.type, S, l.strike, (l.expiry - t) / YEAR, ivs[i]) - entries[i]);
    }
    return s;
  };
  return { legs, ivs, marks, entries, cost, value, pnl };
}

export interface Summary {
  horizon: number;
  maxProfit: number;
  maxLoss: number;
  unlimitedProfit: boolean;
  unlimitedLoss: boolean;
  breakevens: number[];
  pop: number;
  greeks: Greeks;
}

/** Payoff stats at the first expiry in the structure (later legs valued with Black-Scholes). */
export function summarize(model: Model, spec: MarketSpec, spot: number, now: number): Summary | null {
  const { legs } = model;
  if (!legs.length) return null;
  const horizon = Math.min(...legs.map((l) => l.expiry));
  const grid: number[] = [];
  const N = 900;
  for (let i = 0; i <= N; i++) grid.push(spot * Math.exp(Math.log(0.15) + (Math.log(5) - Math.log(0.15)) * (i / N)));
  for (const l of legs) grid.push(l.strike);
  grid.sort((a, b) => a - b);
  const vals = grid.map((S) => model.pnl(S, horizon));

  let maxProfit = -Infinity;
  let maxLoss = Infinity;
  for (const v of vals) {
    maxProfit = Math.max(maxProfit, v);
    maxLoss = Math.min(maxLoss, v);
  }
  const far1 = model.pnl(spot * 20, horizon);
  const far2 = model.pnl(spot * 40, horizon);
  const eps = 1e-6 * spot;
  const unlimitedProfit = far2 - far1 > eps;
  const unlimitedLoss = far1 - far2 > eps;

  const breakevens: number[] = [];
  for (let i = 1; i < vals.length; i++) {
    const a = vals[i - 1];
    const b = vals[i];
    if ((a < 0 && b >= 0) || (a > 0 && b <= 0)) {
      const f = a / (a - b);
      const be = grid[i - 1] + f * (grid[i] - grid[i - 1]);
      if (!breakevens.length || Math.abs(be - breakevens[breakevens.length - 1]) > spot * 1e-4) breakevens.push(be);
    }
  }

  // Probability of profit under a lognormal at ATM vol.
  const T = Math.max((horizon - now) / YEAR, 1e-6);
  const iv = impliedVol(spec, spot, spot, T);
  const sq = iv * Math.sqrt(T);
  const cdf = (x: number) => normCdf((Math.log(x / spot) + 0.5 * sq * sq) / sq);
  let pop = 0;
  if (vals[0] > 0) pop += cdf((grid[0] + grid[1]) / 2);
  for (let i = 1; i < grid.length - 1; i++) {
    if (vals[i] > 0) pop += cdf((grid[i] + grid[i + 1]) / 2) - cdf((grid[i - 1] + grid[i]) / 2);
  }
  if (vals[vals.length - 1] > 0) pop += 1 - cdf((grid[grid.length - 2] + grid[grid.length - 1]) / 2);

  const greeks: Greeks = { delta: 0, gamma: 0, theta: 0, vega: 0 };
  legs.forEach((l, i) => {
    const g = bsGreeks(l.type, spot, l.strike, (l.expiry - now) / YEAR, model.ivs[i]);
    const k = l.side * l.qty;
    greeks.delta += k * g.delta;
    greeks.gamma += k * g.gamma;
    greeks.theta += k * g.theta;
    greeks.vega += k * g.vega;
  });

  return { horizon, maxProfit, maxLoss, unlimitedProfit, unlimitedLoss, breakevens, pop, greeks };
}

const fmtK = (k: number) => (k >= 10000 ? `${+(k / 1000).toFixed(1)}k` : `${k}`);

/** Recognise the common shapes so positions get readable names. */
export function describe(legs: Leg[]): string {
  if (!legs.length) return 'Empty ticket';
  const byStrike = [...legs].sort((a, b) => a.strike - b.strike);
  const sameExpiry = legs.every((l) => l.expiry === legs[0].expiry);
  const exp = sameExpiry ? ` · ${expiryLabel(legs[0].expiry)}` : '';
  const typeName = (t: OptType) => (t === 'C' ? 'Call' : 'Put');

  if (legs.length === 1) {
    const l = legs[0];
    return `${l.side > 0 ? 'Long' : 'Short'} ${fmtK(l.strike)} ${typeName(l.type)}${exp}`;
  }
  if (legs.length === 2) {
    const [a, b] = byStrike;
    if (a.type === b.type && a.side !== b.side && a.qty === b.qty) {
      if (!sameExpiry && a.strike === b.strike) return `${fmtK(a.strike)} ${typeName(a.type)} Calendar`;
      if (sameExpiry) {
        const bull = a.type === 'C' ? a.side > 0 : a.side < 0;
        return `${bull ? 'Bull' : 'Bear'} ${typeName(a.type)} Spread ${fmtK(a.strike)}/${fmtK(b.strike)}${exp}`;
      }
    }
    if (a.type !== b.type && a.side === b.side && sameExpiry) {
      const long = a.side > 0 ? 'Long' : 'Short';
      return a.strike === b.strike
        ? `${long} ${fmtK(a.strike)} Straddle${exp}`
        : `${long} Strangle ${fmtK(a.strike)}/${fmtK(b.strike)}${exp}`;
    }
    if (a.type === 'P' && b.type === 'C' && a.side !== b.side && sameExpiry) {
      return `Risk Reversal ${fmtK(a.strike)}/${fmtK(b.strike)}${exp}`;
    }
  }
  if (legs.length === 4 && sameExpiry) {
    const [a, b, c, d] = byStrike;
    if (a.type === 'P' && b.type === 'P' && c.type === 'C' && d.type === 'C' && a.side === d.side && b.side === c.side && a.side !== b.side) {
      return `${b.side < 0 ? 'Iron Condor' : 'Reverse Condor'} ${fmtK(b.strike)}–${fmtK(c.strike)}${exp}`;
    }
  }
  return `Custom · ${legs.length} legs`;
}

export function daysLeft(expiry: number, now: number): string {
  const d = (expiry - now) / DAY;
  if (d <= 0) return 'expired';
  if (d < 1) return `${Math.max(1, Math.round(d * 24))}h`;
  return `${d.toFixed(d < 10 ? 1 : 0)}d`;
}

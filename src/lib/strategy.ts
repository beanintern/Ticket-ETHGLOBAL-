import type { BetInfo } from './binary';
import { bsGreeks, bsPrice, normCdf, type Greeks, type OptType } from './bs';
import type { Market } from '../data/types';
import { DAY, YEAR, expiryLabel, type Asset } from './market';

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
  /** Set for easy-mode Yes bets: the question and shares behind the legs. */
  bet?: BetInfo;
  /** Where it was traded: absent for paper, 'derive-testnet' for real (test-funds) orders. */
  venue?: 'derive-testnet';
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

export function buildModel(legs: Leg[], market: Market, now: number): Model {
  const spot = market.spot;
  const ivs = legs.map((l) => market.iv(l.type, l.strike, l.expiry, now));
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
  /** Loss keeps growing as price falls, until it reaches zero (e.g. a short put). */
  lossToZero: boolean;
  breakevens: number[];
  pop: number;
  greeks: Greeks;
}

export interface Extremes {
  maxP: number;
  maxS: number;
  /** When the max profit is reached. */
  maxT: number;
  minP: number;
  minS: number;
  minT: number;
  unlimitedProfit: boolean;
  unlimitedLoss: boolean;
  /** Loss keeps growing as price falls, until it reaches zero (e.g. a short put). */
  lossToZero: boolean;
  /** Profit keeps growing as price falls, until it reaches zero (e.g. a long put). */
  profitToZero: boolean;
}

/**
 * Best and worst P&L over the position's whole life, not just at the first expiry: legs that
 * expire later can keep adding (or losing) value after an earlier leg has settled. Samples every
 * expiry and points in between, a wide price range plus every strike exactly, then zooms in.
 */
export function lifetimeExtremes(pnl: (S: number, t: number) => number, legs: Leg[], spot: number, now: number): Extremes {
  const exps = [...new Set(legs.map((l) => l.expiry))].sort((a, b) => a - b);
  const times: number[] = [];
  let prev = now;
  for (const e of exps) {
    for (let k = 1; k < 5; k++) times.push(prev + ((e - prev) * k) / 5);
    times.push(e);
    prev = e;
  }
  const probe = [...legs.map((l) => l.strike), spot * 1e-4];
  for (let i = 0; i <= 600; i++) probe.push(spot * Math.exp(Math.log(0.05) + Math.log(400) * (i / 600)));
  let maxP = -Infinity, maxS = spot, maxT = exps[0];
  let minP = Infinity, minS = spot, minT = exps[0];
  for (const t of times) {
    for (const S of probe) {
      const v = pnl(S, t);
      if (v > maxP) [maxP, maxS, maxT] = [v, S, t];
      if (v < minP) [minP, minS, minT] = [v, S, t];
    }
  }
  // Peaks can fall between samples: zoom in around each extreme in price.
  for (let i = -100; i <= 100; i++) {
    const f = Math.exp(0.02 * (i / 100));
    const a = pnl(maxS * f, maxT);
    if (a > maxP) [maxP] = [a];
    const b = pnl(minS * f, minT);
    if (b < minP) [minP] = [b];
  }
  // Open-ended tails: does P&L keep rising/falling far above spot, or down toward zero, at any
  // expiry?
  const eps = 1e-6 * spot;
  let unlimitedProfit = false, unlimitedLoss = false, lossToZero = false, profitToZero = false;
  for (const e of exps) {
    const up = pnl(spot * 40, e) - pnl(spot * 20, e);
    if (up > eps) unlimitedProfit = true;
    if (up < -eps) unlimitedLoss = true;
    const down = pnl(spot * 0.02, e) - pnl(spot * 0.04, e);
    if (down < -eps) lossToZero = true;
    if (down > eps) profitToZero = true;
  }
  return { maxP, maxS, maxT, minP, minS, minT, unlimitedProfit, unlimitedLoss, lossToZero, profitToZero };
}

/**
 * Payoff stats. Max profit / max loss cover the position's whole life; break-evens and chance of
 * profit are at the first expiry (later legs valued with Black-Scholes).
 */
export function summarize(model: Model, market: Market, now: number): Summary | null {
  const spot = market.spot;
  const { legs } = model;
  if (!legs.length) return null;
  const horizon = Math.min(...legs.map((l) => l.expiry));
  const grid: number[] = [];
  const N = 900;
  for (let i = 0; i <= N; i++) grid.push(spot * Math.exp(Math.log(0.15) + (Math.log(5) - Math.log(0.15)) * (i / N)));
  for (const l of legs) grid.push(l.strike);
  grid.push(spot * 1e-4); // payoffs that only stop at a price of zero
  grid.sort((a, b) => a - b);
  const vals = grid.map((S) => model.pnl(S, horizon));

  const ext = lifetimeExtremes(model.pnl, legs, spot, now);
  const { unlimitedProfit, unlimitedLoss, lossToZero } = ext;
  const maxProfit = ext.maxP;
  const maxLoss = ext.minP;

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
  const iv = market.iv('C', spot, horizon, now);
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

  return { horizon, maxProfit, maxLoss, unlimitedProfit, unlimitedLoss, lossToZero, breakevens, pop, greeks };
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

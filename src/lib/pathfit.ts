// Turning a price path drawn on the chart into an option position that pays off along it.
//
// The drawn line is read as a forecast: "price goes here by then". On each listed expiry the path
// spans, a call butterfly (+1 below, −2 at, +1 above) is centred on the path's price at that
// expiry, so the position's best outcomes line up with the drawn path. The butterfly's wings are
// roughly half a standard deviation of the move expected by then (wider for later expiries), and
// every strike is a listed one.
import type { Market } from '../data/types';
import { YEAR, type Asset } from './market';
import { newId, type Leg } from './strategy';

export interface PathPoint {
  t: number;
  p: number;
}

export interface PathFit {
  legs: Leg[];
  /** Per expiry used: where the path is then, and the butterfly placed there. */
  targets: { expiry: number; price: number; center: number; lower: number; upper: number }[];
}

/** Most butterflies placed along one path, so the ticket stays readable (and tradable). */
export const MAX_TARGETS = 6;
/** Wing half-width as a fraction of the expected move (price × IV × √T) by the expiry. */
const WING_SD = 0.5;

/** The path's price at time t: linear between drawn points, flat beyond either end. */
export function pathAt(path: PathPoint[], t: number): number {
  if (t <= path[0].t) return path[0].p;
  for (let i = 1; i < path.length; i++) {
    if (t <= path[i].t) {
      const a = path[i - 1];
      const b = path[i];
      const f = b.t > a.t ? (t - a.t) / (b.t - a.t) : 1;
      return a.p + (b.p - a.p) * f;
    }
  }
  return path[path.length - 1].p;
}

/**
 * Up to MAX_TARGETS listed expiries covering the path's time span: the ones inside it, plus the
 * first one after it when the path runs well past the last (so its ending isn't dropped). When
 * there are more than that (dailies), the ones nearest evenly spaced moments along the path.
 */
export function pickExpiries(expiries: number[], t0: number, t1: number): number[] {
  const sorted = expiries.filter((e) => e >= t0).sort((a, b) => a - b);
  const inSpan = sorted.filter((e) => e <= t1);
  const after = sorted.find((e) => e > t1);
  const span = t1 - t0;
  const candidates = [...inSpan];
  if (after !== undefined && (!inSpan.length || t1 - inSpan[inSpan.length - 1] > span * 0.2)) candidates.push(after);
  if (candidates.length <= MAX_TARGETS) return candidates;
  const end = candidates[candidates.length - 1];
  const picked = new Set<number>([end]);
  for (let k = 1; k < MAX_TARGETS; k++) {
    const target = t0 + ((end - t0) * k) / MAX_TARGETS;
    picked.add(candidates.reduce((a, b) => (Math.abs(b - target) < Math.abs(a - target) ? b : a)));
  }
  return [...picked].sort((a, b) => a - b);
}

export function fitPath(path: PathPoint[], market: Market, asset: Asset, now: number): PathFit {
  const pts = path.filter((q) => q.t > now && q.p > 0).sort((a, b) => a.t - b.t);
  if (pts.length < 2) return { legs: [], targets: [] };
  const expiries = pickExpiries(
    market.expiries.map((e) => e.ts),
    pts[0].t,
    pts[pts.length - 1].t,
  ).filter((e) => e > now);
  const legs: Leg[] = [];
  const targets: PathFit['targets'] = [];
  for (const expiry of expiries) {
    const price = pathAt(pts, expiry);
    const center = market.snapStrike(price, expiry);
    const T = Math.max((expiry - now) / YEAR, 1 / 365);
    const iv = market.iv('C', center, expiry, now);
    const halfWidth = WING_SD * center * iv * Math.sqrt(T);
    // Step out one listed strike at a time until the wing reaches the target width, the same
    // number of strikes on each side (so the butterfly can't lose more than it cost).
    let lower = center;
    let upper = center;
    for (let i = 0; i < 40; i++) {
      const lo = market.stepStrike(lower, expiry, -1);
      const hi = market.stepStrike(upper, expiry, 1);
      if (lo === lower || hi === upper) break;
      lower = lo;
      upper = hi;
      if (center - lower >= halfWidth && upper - center >= halfWidth) break;
    }
    if (!(lower < center && center < upper)) continue;
    const leg = (strike: number, side: 1 | -1, qty: number): Leg => ({ id: newId(), asset, type: 'C', side, strike, expiry, qty });
    legs.push(leg(lower, 1, 1), leg(center, -1, 2), leg(upper, 1, 1));
    targets.push({ expiry, price, center, lower, upper });
  }
  return { legs, targets };
}

/** What the position makes if price follows the path: each leg settles at the path's price on its expiry. */
export function payoffAlongPath(legs: Leg[], path: PathPoint[], cost: number): number {
  const pts = [...path].sort((a, b) => a.t - b.t);
  let value = 0;
  for (const l of legs) {
    const S = pathAt(pts, l.expiry);
    const intrinsic = l.type === 'C' ? Math.max(S - l.strike, 0) : Math.max(l.strike - S, 0);
    value += l.side * l.qty * intrinsic;
  }
  return value - cost;
}

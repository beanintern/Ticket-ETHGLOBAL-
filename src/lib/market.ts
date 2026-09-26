// Mock market data. Everything here gets replaced by Derive's public API
// (instruments, tickers, index price) once the integration is built.

export type Asset = 'ETH' | 'BTC';

export interface MarketSpec {
  asset: Asset;
  name: string;
  spot0: number;
  baseIv: number;
  strikeStep: number;
  priceDecimals: number;
}

export const MARKETS: Record<Asset, MarketSpec> = {
  ETH: { asset: 'ETH', name: 'Ether', spot0: 2638.4, baseIv: 0.64, strikeStep: 50, priceDecimals: 2 },
  BTC: { asset: 'BTC', name: 'Bitcoin', spot0: 63840, baseIv: 0.52, strikeStep: 1000, priceDecimals: 0 },
};

export const MINUTE = 60e3;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
export const YEAR = 365 * DAY;

export type ExpiryKind = 'daily' | 'weekly' | 'monthly';

export interface Expiry {
  ts: number;
  kind: ExpiryKind;
  label: string;
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

export function expiryLabel(ts: number): string {
  const d = new Date(ts);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** Derive-style listing: dailies, Friday weeklies and last-Friday monthlies, all at 08:00 UTC. */
export function listExpiries(now: number): Expiry[] {
  const kinds = new Map<number, ExpiryKind>();
  const d = new Date(now);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const minTs = now + HOUR;

  let day = Date.UTC(y, m, d.getUTCDate(), 8);
  while (day <= minTs) day += DAY;
  for (let i = 0; i < 4; i++) kinds.set(day + i * DAY, 'daily');

  let fri = day;
  while (new Date(fri).getUTCDay() !== 5) fri += DAY;
  for (let i = 0; i < 6; i++) kinds.set(fri + i * 7 * DAY, 'weekly');

  let monthlies = 0;
  for (let k = 0; k < 8 && monthlies < 4; k++) {
    let last = Date.UTC(y, m + k + 1, 0, 8);
    while (new Date(last).getUTCDay() !== 5) last -= DAY;
    if (last > minTs) {
      kinds.set(last, 'monthly');
      monthlies++;
    }
  }

  return [...kinds.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ts, kind]) => ({ ts, kind, label: expiryLabel(ts) }));
}

export function strikeStepFor(spec: MarketSpec, expiry: number, now: number): number {
  return expiry - now > 21 * DAY ? spec.strikeStep * 2 : spec.strikeStep;
}

export function snapStrike(spec: MarketSpec, price: number, expiry: number, now: number): number {
  const step = strikeStepFor(spec, expiry, now);
  return Math.max(step, Math.round(price / step) * step);
}

/** Toy vol surface: mild smile with a put skew and a slightly lower front end. */
export function impliedVol(spec: MarketSpec, spot: number, strike: number, T: number): number {
  const t = Math.max(T, 1 / (365 * 24));
  const m = Math.max(-3, Math.min(3, Math.log(strike / spot) / Math.sqrt(Math.max(t, 2 / 365))));
  const term = 0.93 + 0.07 * Math.min(1, t * 6);
  return spec.baseIv * term * (1 + 0.32 * m * m - 0.07 * m);
}

export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gaussian(rand: () => number = Math.random): number {
  const u = Math.max(rand(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

/** Hourly candles ending at the current (partial) hour, walked backwards from spot0. */
export function generateHistory(spec: MarketSpec, now: number, days = 120): Candle[] {
  const rand = mulberry32(spec.asset === 'ETH' ? 20260925 : 1337);
  const hourStart = Math.floor(now / HOUR) * HOUR;
  const subSteps = 6;
  const baseStep = spec.baseIv * 0.9 * Math.sqrt(HOUR / YEAR / subSteps);
  const out: Candle[] = [];
  let p = spec.spot0;
  let regime = 1;
  for (let i = 0; i < days * 24; i++) {
    regime = Math.min(2.2, Math.max(0.5, regime * Math.exp(0.08 * gaussian(rand))));
    const drift = 0.00018 * Math.sin(i / 190);
    const c = p;
    let x = p;
    let h = p;
    let l = p;
    for (let s = 0; s < subSteps; s++) {
      x *= Math.exp(baseStep * regime * gaussian(rand) - drift / subSteps);
      h = Math.max(h, x);
      l = Math.min(l, x);
    }
    out.push({ t: hourStart - i * HOUR, o: x, h, l, c });
    p = x;
  }
  return out.reverse();
}

export function priceAt(candles: Candle[], t: number): number {
  let lo = 0;
  let hi = candles.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (candles[mid].t <= t) lo = mid;
    else hi = mid - 1;
  }
  return candles[lo].c;
}

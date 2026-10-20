// Assets and their trading rules. Live data fills these in from Derive (which assets have
// options, and each one's tick and contract sizes); the specs here are the demo market's numbers
// and the fallbacks.

/** An underlying with options on Derive: ETH, BTC, SOL, … (Derive's currency code). */
export type Asset = string;

/** Contract rules for an asset's options: price tick, smallest order and size step, in contracts. */
export interface TradeRules {
  tick: number;
  minAmount: number;
  amountStep: number;
}

export interface MarketSpec extends TradeRules {
  asset: Asset;
  name: string;
  /** Demo market's starting price. */
  spot0: number;
  baseIv: number;
  /** Demo market's strike spacing (near-dated). */
  strikeStep: number;
  priceDecimals: number;
  /**
   * How wide market makers quote this asset's spreads by RFQ: the preview's markup is
   * max(tick, rfqK × √(spread's fair price × index)) per contract (see rfqEdge in binary.ts).
   */
  rfqK: number;
}

/** Markup multiplier for assets with too few RFQ trades to calibrate: as cautious as the widest-quoted ones. */
export const RFQ_K_DEFAULT = 0.15;

const spec = (asset: Asset, name: string, spot0: number, baseIv: number, strikeStep: number, tick: number, minAmount: number, amountStep: number, rfqK = RFQ_K_DEFAULT): MarketSpec => ({
  asset,
  name,
  spot0,
  baseIv,
  strikeStep,
  tick,
  minAmount,
  amountStep,
  rfqK,
  priceDecimals: priceDecimalsFor(spot0),
});

/** Decimals that show a price sensibly: 63,840 · 2,638.40 · 105.20 · 1.3042 · 0.2186 · 0.004458. */
export function priceDecimalsFor(price: number): number {
  const p = Math.abs(price);
  return p >= 10000 ? 0 : p >= 10 ? 2 : p >= 0.01 ? 4 : 6;
}

/**
 * Derive's option assets as of October 2026, in the order the picker lists them, with their
 * contract rules from Derive's instrument listings (the live source reads them afresh), and each
 * one's RFQ markup: the smallest that was at least what takers actually paid over mark in 97% of
 * its two-leg vertical spreads traded by RFQ on Derive mainnet over the 30 days to 20 October 2026
 * (`npm run check:rfq` re-checks it). ADA (3 trades), VVV and CC (none) use the cautious default.
 */
export const MARKETS: Record<Asset, MarketSpec> = {
  ETH: { ...spec('ETH', 'Ether', 2638.4, 0.64, 50, 0.1, 0.1, 0.01, 0.015), priceDecimals: 2 },
  BTC: { ...spec('BTC', 'Bitcoin', 63840, 0.52, 1000, 1, 0.01, 0.00001, 0.015), priceDecimals: 0 },
  SOL: spec('SOL', 'Solana', 105.2, 0.75, 5, 0.1, 1, 0.1, 0.05),
  HYPE: spec('HYPE', 'Hyperliquid', 79.47, 0.85, 5, 0.01, 10, 1, 0.04),
  XRP: spec('XRP', 'XRP', 1.304, 0.75, 0.05, 0.0001, 100, 10, 0.08),
  ZEC: spec('ZEC', 'Zcash', 1147, 1.0, 50, 0.1, 1, 0.1, 0.08),
  XAUT: spec('XAUT', 'Tether Gold', 4139, 0.2, 50, 0.1, 0.1, 0.01, 0.04),
  ADA: spec('ADA', 'Cardano', 0.2188, 0.8, 0.01, 0.0001, 1000, 100),
  LIT: spec('LIT', 'Lighter', 3.197, 1.0, 0.25, 0.001, 50, 1, 0.19),
  VVV: spec('VVV', 'Venice', 24.84, 1.1, 1, 0.01, 10, 1),
  PUMP: spec('PUMP', 'Pump.fun', 0.004458, 1.1, 0.0005, 0.000001, 50000, 1000, 0.15),
  CC: spec('CC', 'Canton', 0.1067, 0.9, 0.005, 0.00001, 1000, 100),
};

/** The spec for an asset: a known one, or defaults for one Derive lists that this app doesn't know yet. */
export function specFor(asset: Asset, spot = 0): MarketSpec {
  return MARKETS[asset] ?? spec(asset, asset, spot || 1, 0.8, Math.max(1e-6, (spot || 1) / 50), Math.max(1e-6, (spot || 1) / 10000), 1, 0.01);
}

/** The default order size for an asset: one contract, or Derive's minimum when that's larger (50,000 PUMP). */
export const lotSize = (rules: TradeRules) => Math.max(1, rules.minAmount);

/** How Derive writes a strike in an instrument name: 1.7 → "1_7", 2500 → "2500". */
export const strikeCode = (k: number) => String(Number(k.toPrecision(12))).replace('.', '_');
/** The strike in an instrument name, back to a number: "1_7" → 1.7. */
export const parseStrike = (code: string) => Number(code.replace('_', '.'));

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

/**
 * Derive's listing pattern, all at 08:00 UTC: the next 5 days (dailies), the next 4 Fridays
 * (weeklies), the last Friday of the next 3 months (monthlies), then last-Friday quarterlies
 * (Mar/Jun/Sep/Dec) out to about a year.
 */
export function listExpiries(now: number): Expiry[] {
  const kinds = new Map<number, ExpiryKind>();
  const d = new Date(now);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const minTs = now + HOUR;

  let day = Date.UTC(y, m, d.getUTCDate(), 8);
  while (day <= minTs) day += DAY;
  for (let i = 0; i < 5; i++) kinds.set(day + i * DAY, 'daily');

  let fri = day;
  while (new Date(fri).getUTCDay() !== 5) fri += DAY;
  for (let i = 0; i < 4; i++) kinds.set(fri + i * 7 * DAY, 'weekly');

  const lastFriday = (year: number, month: number) => {
    let t = Date.UTC(year, month + 1, 0, 8);
    while (new Date(t).getUTCDay() !== 5) t -= DAY;
    return t;
  };
  let monthlies = 0;
  let k = 0;
  for (; k < 6 && monthlies < 3; k++) {
    const last = lastFriday(y, m + k);
    if (last > minTs) {
      kinds.set(last, 'monthly');
      monthlies++;
    }
  }
  for (; k < 13; k++) {
    const month = (m + k) % 12;
    if (month % 3 === 2) kinds.set(lastFriday(y, m + k), 'monthly'); // Mar, Jun, Sep, Dec
  }

  return [...kinds.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ts, kind]) => ({ ts, kind, label: expiryLabel(ts) }));
}

export function strikeStepFor(spec: MarketSpec, expiry: number, now: number): number {
  const t = expiry - now;
  return t > 120 * DAY ? spec.strikeStep * 4 : t > 21 * DAY ? spec.strikeStep * 2 : spec.strikeStep;
}

export function snapStrike(spec: MarketSpec, price: number, expiry: number, now: number): number {
  const step = strikeStepFor(spec, expiry, now);
  return Math.max(step, Math.round(price / step) * step);
}

/**
 * Toy vol surface: mild smile with a put skew and a slightly lower front end. Moneyness is
 * measured against at least a week of time and capped, so short-dated far wings stay in a
 * believable range (roughly up to 1.6x ATM vol) instead of exploding.
 */
export function impliedVol(spec: MarketSpec, spot: number, strike: number, T: number): number {
  const t = Math.max(T, 1 / (365 * 24));
  const m = Math.max(-2.5, Math.min(2.5, Math.log(strike / spot) / Math.sqrt(Math.max(t, 7 / 365))));
  const term = 0.93 + 0.07 * Math.min(1, t * 6);
  return spec.baseIv * term * (1 + 0.12 * m * m - 0.04 * m);
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
  // Fixed seeds for ETH and BTC (the chart checks replay them); others from the ticker.
  const rand = mulberry32(spec.asset === 'ETH' ? 20260925 : spec.asset === 'BTC' ? 1337 : [...spec.asset].reduce((a, ch) => a * 31 + ch.charCodeAt(0), 7));
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

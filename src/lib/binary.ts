// Easy mode: prediction-market style "Yes" shares built from tight option spreads.
//
// "Will ETH be above $L on <expiry>?" is a call spread between the two listed strikes around L
// (+1 call at the lower, −1 call at the upper), sized so the gap between them is $1: it pays $1
// per share if ETH settles above the upper strike, $0 below the lower, and a straight-line
// amount in between. "Below" is the mirror image with puts. With rates ~0, the spread's fair price
// per $1 is the market's implied probability of finishing past the midpoint L.
//
// Bets trade by RFQ: market makers quote the whole spread, so any listed strikes can be bet on,
// book or no book. Until someone asks, there's no firm price, so each bet shows a preview set on
// the expensive side of where makers usually quote (`rfqEdge`): the firm quote is usually better,
// rarely worse.
import type { Market } from '../data/types';
import { bsPrice } from './bs';
import { fmtStrike } from './format';
import { YEAR, type Asset, type TradeRules } from './market';
import { newId, type Leg } from './strategy';
import { BUILDER } from '../account/orders';

export type BetDir = 'above' | 'below';

export interface BetQuote {
  asset: Asset;
  expiry: number;
  dir: BetDir;
  /** The listed strikes the spread is built from. */
  lo: number;
  hi: number;
  /** The question's price level: halfway between the strikes. */
  level: number;
  /** Fair price of one $1 share, 0–1: the implied probability of "Yes", exactly, not rounded. */
  price: number;
  /** What a share is expected to cost at most by RFQ, 0–1 (before fees): the price shown. */
  preview: number;
  /** Each leg's fair price per contract (bought leg, then sold leg). */
  legPrices: [number, number];
  /** The preview's leg prices: the bought leg marked up, the sold leg marked down. */
  previewLegPrices: [number, number];
  /** Why this bet can't be placed (too unlikely to price, or nothing to win), or null. */
  unavailable: string | null;
  /** The asset's contract rules: price tick and order sizes. */
  rules: TradeRules;
  /** The asset's RFQ markup multiplier. */
  rfqK: number;
}

/**
 * How far from mark a maker's RFQ price for a whole spread is expected to be, on the expensive
 * side, per contract: max(one $0.10 tick, 1.5% × √(spread's fair price × index)). Makers quote the
 * package, so it scales with the spread, not its legs. Calibrated on Derive mainnet's two-leg
 * vertical spreads traded by RFQ over 30 days to October 2026 (634 trades): it's at least what the
 * taker actually paid over mark in 98% of them for ETH and BTC alike (96–97% for narrow spreads),
 * typically by 3–5¢ a share on a narrow band.
 */
export const RFQ_EDGE = 0.015;
/**
 * The markup for a spread per contract, with `k` the asset's own multiplier (MarketSpec.rfqK:
 * makers quote SOL or LIT far wider than ETH); never under one price tick (ETH's is $0.10,
 * PUMP's $0.000001).
 */
export const rfqEdge = (spreadMark: number, spot: number, tick = 0.1, k = RFQ_EDGE) => Math.max(tick, k * Math.sqrt(Math.max(spreadMark, 0) * spot));

/** Leg prices with a package edge split between them (half each way; whatever the sold leg can't give, the bought one takes). */
function edgedLegs(buyPx: number, sellPx: number, edge: number): [number, number] {
  const sellAt = Math.max(0, sellPx - edge / 2);
  return [buyPx + edge - (sellPx - sellAt), sellAt];
}

/**
 * Derive's option fees (the same on mainnet and testnet, and for every asset). Contract sizes and
 * the price tick differ by asset and come from the market (`Market.rules`). An RFQ taker pays one $0.50 base fee plus, per contract, 0.03% of the index
 * capped at 12.5% of the option's price, on the dearer leg of a two-leg spread (the other leg is
 * free; checked against Derive's public RFQ trades). Estimates here charge both legs, to be safe.
 */
export const DERIVE_OPTION = { baseFee: 0.5, takerRate: 0.0003, feeCap: 0.125 };
/** Smallest bet: keeps the $0.50 base fee a small part of the stake. */
export const MIN_BET = 10;
/** Below this fair price (0.2¢ a share) there's nothing to price; at a preview over 99¢ nothing to win. */
export const MIN_FAIR = 0.002;
export const MAX_PRICE = 0.99;

export interface BetInfo {
  dir: BetDir;
  level: number;
  lo: number;
  hi: number;
  expiry: number;
  shares: number;
  /** Price paid per share, 0–1. */
  entry: number;
}

/**
 * The bet for a price (or an explicit band of listed strikes, e.g. one box of the easy-mode grid).
 * Bets above the current index are "above", below it "below".
 */
export function quoteBet(market: Market, asset: Asset, expiry: number, price: number, now: number, band?: { lo: number; hi: number }): BetQuote | null {
  if (expiry <= now || !(price > 0)) return null;
  const spot = market.spot;
  let lo: number;
  let hi: number;
  if (band) {
    ({ lo, hi } = band);
  } else {
    // The two listed strikes either side of the clicked price.
    const snapped = market.snapStrike(price, expiry);
    lo = snapped <= price ? snapped : market.stepStrike(snapped, expiry, -1);
    hi = market.stepStrike(lo, expiry, 1);
  }
  if (!(hi > lo) || lo <= 0) return null;
  const dir: BetDir = (lo + hi) / 2 >= spot ? 'above' : 'below';
  const T = (expiry - now) / YEAR;
  const w = hi - lo;
  const type = dir === 'above' ? 'C' : 'P';
  const [buyK, sellK] = dir === 'above' ? [lo, hi] : [hi, lo];
  const buyPx = bsPrice(type, spot, buyK, T, market.iv(type, buyK, expiry, now));
  const sellPx = bsPrice(type, spot, sellK, T, market.iv(type, sellK, expiry, now));
  const p = Math.min(1, Math.max(0, (buyPx - sellPx) / w));
  const [buyAt, sellAt] = edgedLegs(buyPx, sellPx, rfqEdge(buyPx - sellPx, spot, market.rules.tick, market.spec.rfqK));
  const preview = Math.min(1, Math.max(0, (buyAt - sellAt) / w));
  let unavailable: string | null = null;
  if (p < MIN_FAIR) unavailable = 'Under a 0.2% chance: too unlikely to price';
  else if (preview > MAX_PRICE) unavailable = 'Costs over 99¢ a share: nothing to win';
  return { asset, expiry, dir, lo, hi, level: (lo + hi) / 2, price: p, preview, legPrices: [buyPx, sellPx], previewLegPrices: [buyAt, sellAt], unavailable, rules: market.rules, rfqK: market.spec.rfqK };
}

/**
 * Estimated RFQ taker fee for a spread of `contracts` with these leg prices: both legs charged (an
 * overestimate), plus this app's builder fee, which Derive charges as a fixed amount on each leg.
 */
export function rfqFee(contracts: number, prices: number[], spot: number, builderFee = BUILDER.code ? BUILDER.extraFee : 0): number {
  const { baseFee, takerRate, feeCap } = DERIVE_OPTION;
  return baseFee + prices.reduce((a, px) => a + Math.min(takerRate * spot, feeCap * Math.max(px, 0)), 0) * contracts + builderFee * prices.length;
}

/** What selling a bet's shares is expected to fetch at least by RFQ, per share, 0–1 (before fees). */
export function previewBid(q: Pick<BetQuote, 'legPrices' | 'lo' | 'hi'>, spot: number, tick = 0.1, k = RFQ_EDGE): number {
  const [held, sold] = q.legPrices;
  const w = q.hi - q.lo;
  return Math.min(1, Math.max(0, (held - sold - rfqEdge(held - sold, spot, tick, k)) / w));
}

export interface BetSize {
  /** Contracts of each leg, on Derive's 0.01 grid. */
  contracts: number;
  shares: number;
  /** Net option premium, fees, and the two together (what the bet costs). */
  premium: number;
  fees: number;
  cost: number;
}

/**
 * The bet that `stake` dollars buys at the preview price, fees included, rounded down to a size
 * Derive accepts. Null if that's under Derive's minimum. A firm quote at or below the preview
 * costs no more than this.
 */
export function sizeBet(q: BetQuote, stake: number, spot: number): BetSize | null {
  const { baseFee } = DERIVE_OPTION;
  const { amountStep, minAmount } = q.rules;
  // Cost per contract of the spread, fees' per-contract part included; the base fee is fixed.
  const perContract = betOfSize(q, 1, spot).cost - baseFee;
  if (!(perContract > 0)) return null;
  const contracts = Number((Math.floor(((stake - baseFee) / perContract + 1e-9) / amountStep) * amountStep).toPrecision(12));
  return contracts >= minAmount - 1e-9 ? betOfSize(q, contracts, spot) : null;
}

/** A bet of `contracts` at the preview price, with estimated RFQ fees. */
export function betOfSize(q: BetQuote, contracts: number, spot: number): BetSize {
  const [b, s] = q.previewLegPrices;
  const premium = (b - s) * contracts;
  const fees = rfqFee(contracts, q.previewLegPrices, spot);
  return { contracts, shares: contracts * (q.hi - q.lo), premium, fees, cost: premium + fees };
}

/** The least you can bet on this: MIN_BET, or more if Derive's minimum order costs more. */
export function minStake(q: BetQuote, spot: number): number {
  return Math.max(MIN_BET, Math.ceil(betOfSize(q, q.rules.minAmount, spot).cost));
}

/**
 * What a bet pays back if right, as a multiple of what goes in, for a share price p (it pays $1):
 * "6.2×", "25×". Rounded down, so it's what you get at least.
 */
export function fmtMultiple(p: number): string {
  if (!(p > 0)) return '–';
  const m = 1 / p;
  return m >= 10 ? `${Math.floor(m)}×` : `${(Math.floor(m * 10) / 10).toFixed(1)}×`;
}

/** A chance in percent, to a tenth below 10%. */
export const fmtChance = (p: number) => `${p * 100 >= 10 ? Math.round(p * 100) : (Math.round(p * 1000) / 10).toFixed(1)}%`;

/** The option legs for `shares` Yes shares: the spread, sized so it pays $1 per share. */
export function betLegs(q: Pick<BetQuote, 'asset' | 'expiry' | 'dir' | 'lo' | 'hi'>, shares: number): Leg[] {
  const qty = shares / (q.hi - q.lo);
  const leg = (type: 'C' | 'P', side: 1 | -1, strike: number): Leg => ({ id: newId(), asset: q.asset, type, side, strike, expiry: q.expiry, qty });
  return q.dir === 'above' ? [leg('C', 1, q.lo), leg('C', -1, q.hi)] : [leg('P', 1, q.hi), leg('P', -1, q.lo)];
}

/** What a share pays at expiry if the index settles at S: $1, $0, or in between. */
export function sharePayoff(b: Pick<BetInfo, 'dir' | 'lo' | 'hi'>, S: number): number {
  const f = (S - b.lo) / (b.hi - b.lo);
  const up = Math.min(1, Math.max(0, f));
  return b.dir === 'above' ? up : 1 - up;
}

export const betQuestion = (asset: Asset, dir: BetDir, level: number) => `${asset} ${dir} $${fmtStrike(level)}`;

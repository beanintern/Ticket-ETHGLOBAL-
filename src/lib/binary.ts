// Easy mode: prediction-market style "Yes" shares built from tight option spreads.
//
// "Will ETH be above $L on <expiry>?" is a call spread between the two listed strikes around L
// (+1 call at the lower, −1 call at the upper), sized so the gap between them is $1: it pays $1
// per share if ETH settles above the upper strike, $0 below the lower, and a straight-line
// amount in between. "Below" is the mirror image with puts. With rates ~0, the spread's price
// per $1 is the market's implied probability of finishing past the midpoint L, which is what
// the share is priced (and labelled) at.
import type { Market } from '../data/types';
import { bsPrice } from './bs';
import { YEAR, type Asset } from './market';
import { newId, type Leg } from './strategy';

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
  /** Price of one $1 share, 0–1 (also the implied probability of "Yes"), exactly, not rounded. */
  price: number;
  /** Each leg's price per contract (bought leg, then sold leg). */
  legPrices: [number, number];
  /** Why this bet can't be placed (too unlikely, too certain, or nobody quoting a leg), or null. */
  unavailable: string | null;
}

/**
 * Derive's rules for option orders (the same on mainnet and testnet): sizes in 0.01-contract
 * steps, at least 0.1 contracts, and each order pays a $0.50 base fee plus 0.03% of the index per
 * contract, that part capped at 12.5% of the option's price.
 */
export const DERIVE_OPTION = { minAmount: 0.1, amountStep: 0.01, baseFee: 0.5, takerRate: 0.0003, feeCap: 0.125 };
/** Smallest bet: keeps the two $0.50 base fees to a tenth of the stake or less. */
export const MIN_BET = 10;
/** Bets are offered between these share prices: below 1¢ a share is a lottery ticket nobody makes a market in, above 99¢ there's nothing to win. */
export const MIN_PRICE = 0.01;
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
  let unavailable: string | null = null;
  if (p < MIN_PRICE) unavailable = 'Under a 1% chance: too unlikely to offer';
  else if (p > MAX_PRICE) unavailable = 'Over a 99% chance: nothing to win';
  else {
    // On Derive, the bought leg needs someone selling it and the sold leg someone buying it.
    const bq = market.quote(type, buyK, expiry);
    const sq = market.quote(type, sellK, expiry);
    if (bq && !(bq.ask && bq.ask > 0)) unavailable = `Nobody is selling the ${buyK} ${type === 'C' ? 'call' : 'put'} right now`;
    else if (sq && !(sq.bid && sq.bid > 0)) unavailable = `Nobody is buying the ${sellK} ${type === 'C' ? 'call' : 'put'} right now`;
  }
  return { asset, expiry, dir, lo, hi, level: (lo + hi) / 2, price: p, legPrices: [buyPx, sellPx], unavailable };
}

/** Derive's fee for one option order of `contracts` at `price` each, with the index at `spot`. */
export function optionFee(contracts: number, price: number, spot: number): number {
  const { baseFee, takerRate, feeCap } = DERIVE_OPTION;
  return baseFee + Math.min(takerRate * spot, feeCap * price) * contracts;
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
 * The bet that `stake` dollars buys at the quoted prices, fees included, rounded down to a size
 * Derive accepts. Null if that's under Derive's minimum order.
 */
export function sizeBet(q: BetQuote, stake: number, spot: number): BetSize | null {
  const { baseFee, takerRate, feeCap, amountStep, minAmount } = DERIVE_OPTION;
  const [b, s] = q.legPrices;
  // Cost per contract of the pair, fees' per-contract part included; the base fees are fixed.
  const perContract = b - s + Math.min(takerRate * spot, feeCap * b) + Math.min(takerRate * spot, feeCap * s);
  if (!(perContract > 0)) return null;
  const contracts = Math.floor(((stake - 2 * baseFee) / perContract + 1e-9) / amountStep) * amountStep;
  return contracts >= minAmount - 1e-9 ? betOfSize(q, contracts, spot) : null;
}

export function betOfSize(q: BetQuote, contracts: number, spot: number): BetSize {
  const [b, s] = q.legPrices;
  const premium = (b - s) * contracts;
  const fees = optionFee(contracts, b, spot) + optionFee(contracts, s, spot);
  return { contracts, shares: contracts * (q.hi - q.lo), premium, fees, cost: premium + fees };
}

/** The least you can bet on this: MIN_BET, or more if Derive's minimum order costs more. */
export function minStake(q: BetQuote, spot: number): number {
  return Math.max(MIN_BET, Math.ceil(betOfSize(q, DERIVE_OPTION.minAmount, spot).cost));
}

/** A share price in cents, to a tenth of a cent below 10¢ (so 0.8¢ never shows as 1¢): "21¢", "4.5¢", "0.8¢". */
export function fmtCents(p: number): string {
  const c = p * 100;
  return c >= 9.95 ? `${Math.round(c)}¢` : `${(Math.round(c * 10) / 10).toFixed(1)}¢`;
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

export const betQuestion = (asset: Asset, dir: BetDir, level: number) => `${asset} ${dir} $${Math.round(level).toLocaleString('en-US')}`;

/** One leg of a bet as sent to (or quoted by) the exchange. */
export interface BetFill {
  direction: 'buy' | 'sell';
  /** Contracts. */
  amount: number;
  price: number;
  fee: number;
}

/**
 * The real cost of a bet on the exchange from its legs' quotes or fills: net premium plus fees,
 * and per share. A share needs every leg, so the shares you actually get are limited by the
 * least-filled leg.
 */
export function betCost(legs: BetFill[], strikeGap: number): { cost: number; fees: number; shares: number; perShare: number } {
  const shares = legs.length ? Math.min(...legs.map((l) => l.amount)) * strikeGap : 0;
  const premium = legs.reduce((a, l) => a + (l.direction === 'buy' ? 1 : -1) * l.price * l.amount, 0);
  const fees = legs.reduce((a, l) => a + l.fee, 0);
  const cost = premium + fees;
  return { cost, fees, shares, perShare: shares > 0 ? cost / shares : 0 };
}

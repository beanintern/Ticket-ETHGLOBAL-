// Easy mode: prediction-market style "Yes" shares built from tight option spreads.
//
// "Will ETH be above $L on <expiry>?" is a call spread between the two listed strikes around L
// (+1 call at the lower, −1 call at the upper), sized so the gap between them is $1: it pays $1
// per share if ETH settles above the upper strike, $0 below the lower, and a straight-line
// amount in between. "Below" is the mirror image with puts. With rates ~0, the spread's price
// per $1 is the market's implied probability of finishing past the midpoint L, which is what
// the share is priced (and labelled) at.
import type { Market } from '../data/types';
import { bsPrice, normCdf } from './bs';
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
  /** Price of one $1 share, 0–1 (also the implied probability of "Yes"). */
  price: number;
}

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
  const value =
    dir === 'above'
      ? bsPrice('C', spot, lo, T, market.iv('C', lo, expiry, now)) - bsPrice('C', spot, hi, T, market.iv('C', hi, expiry, now))
      : bsPrice('P', spot, hi, T, market.iv('P', hi, expiry, now)) - bsPrice('P', spot, lo, T, market.iv('P', lo, expiry, now));
  const p = Math.min(0.99, Math.max(0.01, value / w));
  return { asset, expiry, dir, lo, hi, level: (lo + hi) / 2, price: p };
}

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

/**
 * The probability cone behind easy mode: at time t, the implied chance the index ends up beyond
 * price S in S's direction from spot (above if S is above spot, below if below).
 */
export function beyondProbability(spot: number, S: number, T: number, iv: number): number {
  if (T <= 0 || iv <= 0) return 0;
  const sq = iv * Math.sqrt(T);
  const d2 = (Math.log(spot / S) - 0.5 * sq * sq) / sq;
  return S >= spot ? normCdf(d2) : normCdf(-d2);
}

/** Payout per $1 staked at a share price (0–1): Euphoria-style multiplier, capped at 100x. */
export const multiplier = (price: number) => Math.min(100, 1 / Math.max(price, 0.01));
export const fmtMultiplier = (m: number) => (m >= 99.95 ? '100x' : m >= 10 ? `${m.toFixed(1)}x` : `${m.toFixed(2)}x`);

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

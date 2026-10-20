// Turning chart legs into Derive orders: instrument names, limit prices on the tick grid, and the
// builder fee attached to every order.
import type { Market } from '../data/types';
import type { Leg } from '../lib/strategy';

/**
 * Builder code and fee, set at build time. With a code set, every order carries
 * `referral_code` and `extra_fee` (USDC for the whole order, on top of Derive's fees: Derive's
 * max-fee rule divides it by the order's amount), credited to the builder. Unset: orders go out
 * without a builder fee.
 */
export const BUILDER = {
  code: (import.meta.env.VITE_DERIVE_REFERRAL_CODE as string | undefined)?.trim() || null,
  extraFee: Number(import.meta.env.VITE_DERIVE_EXTRA_FEE ?? 0) || 0,
};

/** "market": fill now against the book (immediate-or-cancel, limited by SLIPPAGE). "limit": rest at mark. */
export type OrderMode = 'market' | 'limit';

/** How far past the best bid/ask a market order may fill. */
export const SLIPPAGE = 0.03;

export interface Instrument {
  tick: number;
  amountStep: number;
  minAmount: number;
  /** Taker fee as a fraction of the index, per contract. */
  takerRate: number;
  /** Fixed fee per taker order, USDC. */
  baseFee: number;
}

export interface LegOrder {
  legId: string;
  instrument: string;
  direction: 'buy' | 'sell';
  /** Contracts, as a decimal string on the amount grid. */
  amount: string;
  /** Limit price, as a decimal string on the tick grid. */
  limitPrice: string;
  /** Most fee per contract the order is signed to accept, USDC (see maxFee). */
  maxFee: string;
  mark: number;
  reduceOnly: boolean;
}

const ymd = (ts: number) => new Date(ts).toISOString().slice(0, 10).replace(/-/g, '');

export const instrumentName = (leg: Pick<Leg, 'asset' | 'expiry' | 'strike' | 'type'>) => `${leg.asset}-${ymd(leg.expiry)}-${leg.strike}-${leg.type}`;

const decimals = (step: number) => {
  const s = String(step);
  return s.includes('e-') ? Number(s.split('e-')[1]) : (s.split('.')[1] ?? '').length;
};

/** A value on a step grid, as a string with exactly the step's decimals. */
export function onGrid(v: number, step: number, dir: 'up' | 'down' | 'nearest'): string {
  const n = v / step;
  const k = dir === 'up' ? Math.ceil(n - 1e-9) : dir === 'down' ? Math.floor(n + 1e-9) : Math.round(n);
  return (k * step).toFixed(decimals(step));
}

/**
 * One order per leg. Market orders cross the spread up to SLIPPAGE past the best price (or mark,
 * when that side of the book is empty); limit orders sit at mark. `close` flips each leg and
 * marks it reduce-only.
 */
export function legOrders(legs: Leg[], market: Market, instruments: Map<string, Instrument>, mode: OrderMode, close = false): LegOrder[] {
  return legs.map((leg) => {
    const name = instrumentName(leg);
    const spec = instruments.get(name);
    if (!spec) throw new Error(`${name} isn't listed on Derive`);
    const buy = close ? leg.side < 0 : leg.side > 0;
    const q = market.quote(leg.type, leg.strike, leg.expiry);
    const mark = q?.mark ?? 0;
    let price: string;
    if (mode === 'limit') {
      price = onGrid(Math.max(mark, spec.tick), spec.tick, 'nearest');
    } else if (buy) {
      price = onGrid((q?.ask ?? mark) * (1 + SLIPPAGE), spec.tick, 'up');
    } else {
      price = onGrid(Math.max((q?.bid ?? mark) * (1 - SLIPPAGE), spec.tick), spec.tick, 'down');
    }
    if (!(Number(price) > 0)) throw new Error(`No price for ${name}`);
    const amount = onGrid(leg.qty, spec.amountStep, 'down');
    if (Number(amount) < spec.minAmount) throw new Error(`${name}: minimum size is ${spec.minAmount}`);
    return {
      legId: leg.id,
      instrument: name,
      direction: buy ? 'buy' : 'sell',
      amount,
      limitPrice: price,
      maxFee: maxFee(spec, market.spot, Number(price)),
      mark,
      reduceOnly: close,
    };
  });
}

/**
 * The per-contract fee cap signed into an order. Derive rejects an order whose cap is below
 * `2 × taker rate × max(index, limit) + extra_fee / amount` (resting), plus `base_fee / fill amount`
 * when it takes liquidity. The fixed parts are spread over the smallest fill Derive allows, so a
 * partial fill still fits, and the proportional part gets 1.5× headroom for the index moving
 * between signing and matching. It's a ceiling: what's charged is Derive's fee schedule.
 */
export function maxFee(spec: Instrument, index: number, limitPrice: number): string {
  const proportional = 2 * spec.takerRate * Math.max(index, limitPrice) * 1.5;
  const fixed = (spec.baseFee + (BUILDER.code ? BUILDER.extraFee : 0)) / spec.minAmount;
  return (proportional + fixed).toFixed(6);
}

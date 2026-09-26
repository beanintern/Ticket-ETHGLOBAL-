import type { OptType } from '../lib/bs';
import type { Asset, Candle, Expiry, MarketSpec } from '../lib/market';

/** An exchange quote for one option (live data only). */
export interface Quote {
  mark: number;
  bid: number | null;
  ask: number | null;
  iv: number;
}

/** Everything the app needs to know about one underlying's options market. */
export interface Market {
  asset: Asset;
  spec: MarketSpec;
  /** Index price. */
  readonly spot: number;
  /** Hourly price history, oldest first; the last candle is the current hour. */
  readonly candles: Candle[];
  /** Listed expiries still open, soonest first. */
  readonly expiries: Expiry[];
  /** Listed strikes for an expiry, ascending. */
  strikes(expiry: number): number[];
  /** The listed strike nearest a price. */
  snapStrike(price: number, expiry: number): number;
  /** The next listed strike above (dir 1) or below (dir -1). */
  stepStrike(strike: number, expiry: number, dir: 1 | -1): number;
  /** Implied vol used to price this option (the exchange's mark IV for live data). */
  iv(type: OptType, strike: number, expiry: number, now: number): number;
  /** The exchange's quote, when there is one. */
  quote(type: OptType, strike: number, expiry: number): Quote | null;
}

export type SourceKind = 'mock' | 'live';

export interface MarketSource {
  kind: SourceKind;
  /** 'connecting' until the first full snapshot has arrived. */
  readonly status: 'connecting' | 'ready' | 'error';
  readonly error: string | null;
  markets: Record<Asset, Market>;
  /** Called whenever prices change. Returns an unsubscribe function. */
  subscribe(cb: () => void): () => void;
  close(): void;
}

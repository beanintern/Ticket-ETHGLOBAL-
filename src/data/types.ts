import type { OptType } from '../lib/bs';
import type { Asset, Candle, Expiry, MarketSpec, TradeRules } from '../lib/market';

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
  /** Index price (0 until it has loaded). */
  readonly spot: number;
  /** Price tick and contract sizes for this asset's options. */
  readonly rules: TradeRules;
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

/** One asset in the picker: its price and 24-hour change, without loading its options. */
export interface AssetInfo {
  asset: Asset;
  name: string;
  /** Index price; 0 if not known yet. */
  spot: number;
  /** Fractional change over 24 hours, or null. */
  change24h: number | null;
  /** Derive's margin group for its options (live data): only subaccounts in it can trade them. */
  group?: { id: number; name: string };
}

/** Demo data, Derive mainnet, or Derive's v3 testnet (Sepolia). */
export type SourceKind = 'mock' | 'live' | 'testnet';

export interface MarketSource {
  kind: SourceKind;
  /** 'connecting' until the first full snapshot has arrived. */
  readonly status: 'connecting' | 'ready' | 'error';
  readonly error: string | null;
  /** Every asset with options, in display order. */
  readonly assets: AssetInfo[];
  /**
   * Markets by asset, created and loaded on first access: an asset that hasn't loaded yet has
   * no spot and no candles.
   */
  markets: Record<Asset, Market>;
  /** Called whenever prices change. Returns an unsubscribe function. */
  subscribe(cb: () => void): () => void;
  close(): void;
}

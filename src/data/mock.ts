// Simulated market: generated price history, a random-walk index and a toy vol surface.
// This is the "demo data" source, and the one the automated chart check runs against.
import type { OptType } from '../lib/bs';
import {
  HOUR,
  MARKETS,
  YEAR,
  gaussian,
  generateHistory,
  impliedVol,
  listExpiries,
  snapStrike,
  strikeStepFor,
  type Asset,
  type Candle,
  type Expiry,
} from '../lib/market';
import type { Market, MarketSource } from './types';

function mockMarket(asset: Asset, now: number): Market & { tick(t: number): void } {
  const spec = MARKETS[asset];
  // A year+ of history, so the past side of the chart is filled when zoomed out to 1Y.
  const candles: Candle[] = generateHistory(spec, now, 400);
  let spot = candles[candles.length - 1].c;
  let expiries: Expiry[] = listExpiries(now);
  let expiriesHour = Math.floor(now / HOUR);
  return {
    asset,
    spec,
    get spot() {
      return spot;
    },
    candles,
    get expiries() {
      const h = Math.floor(Date.now() / HOUR);
      if (h !== expiriesHour) {
        expiries = listExpiries(Date.now());
        expiriesHour = h;
      }
      return expiries;
    },
    strikes(expiry) {
      const step = strikeStepFor(spec, expiry, Date.now());
      const out: number[] = [];
      for (let k = Math.ceil((spot * 0.4) / step) * step; k <= spot * 2; k += step) out.push(k);
      return out;
    },
    snapStrike: (price, expiry) => snapStrike(spec, price, expiry, Date.now()),
    stepStrike: (strike, expiry, dir) => Math.max(strikeStepFor(spec, expiry, Date.now()), strike + dir * strikeStepFor(spec, expiry, Date.now())),
    iv: (_type: OptType, strike, expiry, t) => impliedVol(spec, spot, strike, Math.max((expiry - t) / YEAR, 1e-6)),
    quote: () => null,
    tick(t) {
      spot *= Math.exp(spec.baseIv * 1.4 * Math.sqrt(1000 / YEAR) * gaussian());
      const last = candles[candles.length - 1];
      const hour = Math.floor(t / HOUR) * HOUR;
      if (hour > last.t) candles.push({ t: hour, o: last.c, h: Math.max(last.c, spot), l: Math.min(last.c, spot), c: spot });
      else {
        last.c = spot;
        last.h = Math.max(last.h, spot);
        last.l = Math.min(last.l, spot);
      }
    },
  };
}

export function createMockSource(): MarketSource {
  const now = Date.now();
  const markets = { ETH: mockMarket('ETH', now), BTC: mockMarket('BTC', now) };
  const listeners = new Set<() => void>();
  // One random-walk step per second per asset.
  const timer = setInterval(() => {
    const t = Date.now();
    markets.ETH.tick(t);
    markets.BTC.tick(t);
    listeners.forEach((cb) => cb());
  }, 1000);
  return {
    kind: 'mock',
    status: 'ready',
    error: null,
    markets,
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    close: () => clearInterval(timer),
  };
}

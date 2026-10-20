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
import type { AssetInfo, Market, MarketSource } from './types';

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
    rules: { tick: spec.tick, minAmount: spec.minAmount, amountStep: spec.amountStep },
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
      // Counted in steps (not added up), so small steps like 0.0005 don't pick up float noise.
      for (let i = Math.ceil((spot * 0.4) / step); i * step <= spot * 2; i++) out.push(Number((i * step).toPrecision(12)));
      return out;
    },
    snapStrike: (price, expiry) => Number(snapStrike(spec, price, expiry, Date.now()).toPrecision(12)),
    stepStrike: (strike, expiry, dir) => {
      const step = strikeStepFor(spec, expiry, Date.now());
      return Number(Math.max(step, strike + dir * step).toPrecision(12));
    },
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
  // Every demo asset, each created (with its year of history) the first time it's used.
  const made = new Map<Asset, ReturnType<typeof mockMarket>>();
  const get = (a: Asset) => {
    let m = made.get(a);
    if (!m && MARKETS[a]) {
      m = mockMarket(a, now);
      made.set(a, m);
    }
    return m;
  };
  const markets = new Proxy({} as Record<Asset, Market>, {
    get: (_t, a) => (typeof a === 'string' ? get(a) : undefined),
    has: (_t, a) => typeof a === 'string' && !!MARKETS[a],
    ownKeys: () => Object.keys(MARKETS),
    getOwnPropertyDescriptor: (_t, a) => (typeof a === 'string' && MARKETS[a] ? { enumerable: true, configurable: true, value: get(a) } : undefined),
  });
  const listeners = new Set<() => void>();
  // One random-walk step per second per asset in use. `?freeze=1` holds prices still (the chart
  // check uses it so a failing case can be replayed exactly).
  const frozen = typeof location !== 'undefined' && new URLSearchParams(location.search).get('freeze') === '1';
  const timer = setInterval(() => {
    if (frozen) return;
    const t = Date.now();
    for (const m of made.values()) m.tick(t);
    listeners.forEach((cb) => cb());
  }, 1000);
  return {
    kind: 'mock',
    status: 'ready',
    error: null,
    // The picker's list: an asset not yet created shows its demo starting price.
    get assets(): AssetInfo[] {
      return Object.values(MARKETS).map((spec) => {
        const m = made.get(spec.asset);
        if (!m) return { asset: spec.asset, name: spec.name, spot: spec.spot0, change24h: null };
        const c = m.candles;
        const dayAgo = c[Math.max(0, c.length - 25)]?.c;
        return { asset: spec.asset, name: spec.name, spot: m.spot, change24h: dayAgo ? m.spot / dayAgo - 1 : null };
      });
    },
    markets,
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    close: () => clearInterval(timer),
  };
}

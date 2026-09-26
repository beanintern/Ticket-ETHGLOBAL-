// Live market data from Derive's public API, over its WebSocket.
//
// Everything goes over wss://api.lyra.finance/ws (JSON-RPC requests plus subscriptions), which
// also avoids CORS: the REST endpoints don't allow browser origins other than Derive's own.
// Read-only: no account, keys or signing are involved here.
import { bsPrice, type OptType } from '../lib/bs';
import { DAY, HOUR, MARKETS, YEAR, expiryLabel, type Asset, type Candle, type Expiry, type ExpiryKind } from '../lib/market';
import type { Market, MarketSource, Quote } from './types';

export const DERIVE_WS = 'wss://api.lyra.finance/ws';
const ASSETS: Asset[] = ['ETH', 'BTC'];
/** How often every expiry's quotes are re-fetched. */
const QUOTE_REFRESH_MS = 10_000;

type Json = Record<string, unknown>;

/** Minimal JSON-RPC-over-WebSocket client with reconnect and re-subscribe. */
class DeriveSocket {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private channels = new Map<string, (data: Json) => void>();
  private closed = false;
  private retry = 0;
  onState: (s: 'open' | 'closed', err?: string) => void = () => {};

  constructor(private url: string) {
    this.connect();
  }

  private connect() {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      if (this.channels.size) this.send('subscribe', { channels: [...this.channels.keys()] });
      this.onState('open');
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data)) as Json;
      if (msg.method === 'subscription') {
        const p = msg.params as { channel: string; data: Json };
        this.channels.get(p.channel)?.(p.data);
        return;
      }
      const id = msg.id as number;
      const req = this.pending.get(id);
      if (!req) return;
      this.pending.delete(id);
      if (msg.error) req.reject(new Error(JSON.stringify(msg.error)));
      else req.resolve(msg.result);
    };
    ws.onclose = () => {
      for (const r of this.pending.values()) r.reject(new Error('connection closed'));
      this.pending.clear();
      if (this.closed) return;
      this.onState('closed', 'Connection to Derive lost, reconnecting…');
      const delay = Math.min(30_000, 1000 * 2 ** this.retry++);
      setTimeout(() => !this.closed && this.connect(), delay);
    };
    ws.onerror = () => ws.close();
  }

  private send(method: string, params: Json) {
    const id = this.nextId++;
    this.ws?.send(JSON.stringify({ method, params, id }));
    return id;
  }

  call<T>(method: string, params: Json): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const go = () => {
        const id = this.send(method, params);
        this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      };
      if (this.ws?.readyState === WebSocket.OPEN) go();
      else {
        const t = setInterval(() => {
          if (this.closed) {
            clearInterval(t);
            reject(new Error('closed'));
          } else if (this.ws?.readyState === WebSocket.OPEN) {
            clearInterval(t);
            go();
          }
        }, 100);
      }
    });
  }

  subscribe(channel: string, cb: (data: Json) => void) {
    this.channels.set(channel, cb);
    if (this.ws?.readyState === WebSocket.OPEN) this.send('subscribe', { channels: [channel] });
  }

  close() {
    this.closed = true;
    this.ws?.close();
  }
}

// ---- helpers ----

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
};

const ymd = (ts: number) => new Date(ts).toISOString().slice(0, 10).replace(/-/g, '');

function expiryKind(ts: number): ExpiryKind {
  const d = new Date(ts);
  if (d.getUTCDay() !== 5) return 'daily';
  // Last Friday of the month = monthly; other Fridays = weekly.
  return new Date(ts + 7 * DAY).getUTCMonth() !== d.getUTCMonth() ? 'monthly' : 'weekly';
}

/** Implied vol that makes our Black-Scholes (spot, r = 0) reproduce the exchange's mark. */
function solveIv(type: OptType, S: number, K: number, T: number, price: number): number | null {
  if (T <= 0 || price <= 0) return null;
  const intrinsic = type === 'C' ? Math.max(S - K, 0) : Math.max(K - S, 0);
  if (price <= intrinsic + 1e-9) return null;
  let lo = 0.01;
  let hi = 5;
  if (bsPrice(type, S, K, T, hi) < price) return null;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (bsPrice(type, S, K, T, mid) < price) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

interface RawQuote extends Quote {
  /** Derive's own IV (computed on the forward); used when ours can't be solved. */
  deriveIv: number;
}

interface LiveState {
  spot: number;
  candles: Candle[];
  expiries: Expiry[];
  strikesByExpiry: Map<number, number[]>;
  /** key `${expiry}|${strike}|${type}` → quote */
  quotes: Map<string, RawQuote>;
}

const qkey = (expiry: number, strike: number, type: OptType) => `${expiry}|${strike}|${type}`;

function liveMarket(asset: Asset, st: LiveState): Market {
  const spec = MARKETS[asset];
  const nearestExpiry = (ts: number) =>
    st.expiries.reduce((a, e) => (Math.abs(e.ts - ts) < Math.abs(a - ts) ? e.ts : a), st.expiries[0]?.ts ?? ts);
  const strikesFor = (expiry: number) => st.strikesByExpiry.get(expiry) ?? st.strikesByExpiry.get(nearestExpiry(expiry)) ?? [];

  /** Our IV for one listed option, from its mark (falls back to Derive's IV). */
  const ivAt = (type: OptType, strike: number, expiry: number, now: number): number | null => {
    const q = st.quotes.get(qkey(expiry, strike, type)) ?? st.quotes.get(qkey(expiry, strike, type === 'C' ? 'P' : 'C'));
    if (!q) return null;
    return solveIv(type, st.spot, strike, (expiry - now) / YEAR, q.mark) ?? q.deriveIv;
  };

  const market: Market = {
    asset,
    spec,
    get spot() {
      return st.spot;
    },
    get candles() {
      return st.candles;
    },
    get expiries() {
      const now = Date.now();
      return st.expiries.filter((e) => e.ts > now);
    },
    strikes: strikesFor,
    snapStrike(price, expiry) {
      const ks = strikesFor(expiry);
      if (!ks.length) return Math.round(price);
      return ks.reduce((a, k) => (Math.abs(k - price) < Math.abs(a - price) ? k : a), ks[0]);
    },
    stepStrike(strike, expiry, dir) {
      const ks = strikesFor(expiry);
      if (!ks.length) return strike;
      if (dir > 0) return ks.find((k) => k > strike) ?? ks[ks.length - 1];
      return [...ks].reverse().find((k) => k < strike) ?? ks[0];
    },
    iv(type, strike, expiry, now) {
      const exp = st.strikesByExpiry.has(expiry) ? expiry : nearestExpiry(expiry);
      const direct = ivAt(type, strike, exp, now);
      if (direct !== null) return direct;
      // Not a listed strike (e.g. "at the money"): interpolate between the nearest quoted strikes.
      const ks = strikesFor(exp).filter((k) => ivAt(type, k, exp, now) !== null);
      if (!ks.length) return spec.baseIv;
      const above = ks.find((k) => k >= strike);
      const below = [...ks].reverse().find((k) => k <= strike);
      if (above === undefined) return ivAt(type, below!, exp, now)!;
      if (below === undefined || above === below) return ivAt(type, above, exp, now)!;
      const f = (strike - below) / (above - below);
      return ivAt(type, below, exp, now)! * (1 - f) + ivAt(type, above, exp, now)! * f;
    },
    quote(type, strike, expiry) {
      const q = st.quotes.get(qkey(expiry, strike, type));
      return q ? { mark: q.mark, bid: q.bid, ask: q.ask, iv: q.iv } : null;
    },
  };
  return market;
}

export function createDeriveSource(url = DERIVE_WS): MarketSource {
  const sock = new DeriveSocket(url);
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((cb) => cb());
  const states = {} as Record<Asset, LiveState>;
  for (const a of ASSETS) states[a] = { spot: 0, candles: [], expiries: [], strikesByExpiry: new Map(), quotes: new Map() };

  const source: MarketSource & { status: MarketSource['status']; error: string | null } = {
    kind: 'live',
    status: 'connecting',
    error: null,
    markets: { ETH: liveMarket('ETH', states.ETH), BTC: liveMarket('BTC', states.BTC) },
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    close() {
      closed = true;
      clearInterval(refreshTimer);
      sock.close();
    },
  };
  let closed = false;
  sock.onState = (s, err) => {
    if (s === 'closed') source.error = err ?? 'Disconnected';
    else if (source.status === 'ready') source.error = null;
    notify();
  };

  const onSpot = (asset: Asset, price: number, ts: number) => {
    const st = states[asset];
    st.spot = price;
    const hour = Math.floor(ts / HOUR) * HOUR;
    const last = st.candles[st.candles.length - 1];
    if (!last) return;
    if (hour > last.t) st.candles.push({ t: hour, o: last.c, h: Math.max(last.c, price), l: Math.min(last.c, price), c: price });
    else {
      last.c = price;
      last.h = Math.max(last.h, price);
      last.l = Math.min(last.l, price);
    }
  };

  async function loadInstruments(asset: Asset) {
    type Instr = { instrument_name: string; option_details: { expiry: number; strike: string; option_type: OptType } };
    const list = await sock.call<Instr[]>('public/get_instruments', { currency: asset, instrument_type: 'option', expired: false });
    const byExpiry = new Map<number, Set<number>>();
    for (const i of list) {
      const ts = i.option_details.expiry * 1000;
      const k = Number(i.option_details.strike);
      if (!byExpiry.has(ts)) byExpiry.set(ts, new Set());
      byExpiry.get(ts)!.add(k);
    }
    const st = states[asset];
    st.strikesByExpiry = new Map([...byExpiry].map(([ts, ks]) => [ts, [...ks].sort((a, b) => a - b)]));
    st.expiries = [...byExpiry.keys()].sort((a, b) => a - b).map((ts) => ({ ts, kind: expiryKind(ts), label: expiryLabel(ts) }));
  }

  async function loadHistory(asset: Asset) {
    // The endpoint returns at most 500 points, so fetch ~40 days of hourly prices in two halves.
    type Pt = { price: string; timestamp: number };
    const now = Math.floor(Date.now() / 1000);
    const span = 20 * 86400;
    const parts = await Promise.all(
      [now - 2 * span, now - span].map((start) =>
        sock.call<{ spot_feed_history: Pt[] }>('public/get_spot_feed_history', { currency: asset, start_timestamp: start, end_timestamp: start + span, period: 3600 }),
      ),
    );
    const seen = new Set<number>();
    const pts = parts
      .flatMap((p) => p.spot_feed_history)
      .map((p) => ({ t: p.timestamp * 1000, price: Number(p.price) }))
      .filter((p) => Number.isFinite(p.price) && !seen.has(p.t) && seen.add(p.t))
      .sort((a, b) => a.t - b.t);
    // The feed gives one price per hour; draw each hour as a candle from the previous close.
    const candles: Candle[] = [];
    for (const p of pts) {
      const o = candles.length ? candles[candles.length - 1].c : p.price;
      candles.push({ t: p.t, o, h: Math.max(o, p.price), l: Math.min(o, p.price), c: p.price });
    }
    const st = states[asset];
    st.candles = candles;
    if (!st.spot && candles.length) st.spot = candles[candles.length - 1].c;
  }

  async function loadQuotes(asset: Asset, expiry: number) {
    type Tk = { M: string; b: string; a: string; I: string; option_pricing: { i: string } | null };
    const res = await sock.call<{ tickers: Record<string, Tk> }>('public/get_tickers', { instrument_type: 'option', currency: asset, expiry_date: ymd(expiry) });
    const st = states[asset];
    for (const [name, t] of Object.entries(res.tickers)) {
      // ETH-20261030-3000-C
      const parts = name.split('-');
      const type = parts[3] as OptType;
      const strike = Number(parts[2]);
      const mark = num(t.M);
      if (mark === null || !Number.isFinite(strike)) continue;
      const bid = num(t.b);
      const ask = num(t.a);
      const deriveIv = num(t.option_pricing?.i) ?? MARKETS[asset].baseIv;
      st.quotes.set(qkey(expiry, strike, type), { mark, bid: bid && bid > 0 ? bid : null, ask: ask && ask > 0 ? ask : null, iv: deriveIv, deriveIv });
      if (!st.spot) st.spot = num(t.I) ?? st.spot;
    }
  }

  async function refreshAllQuotes() {
    const now = Date.now();
    for (const a of ASSETS) {
      for (const e of states[a].expiries) {
        if (closed) return;
        if (e.ts <= now) continue;
        await loadQuotes(a, e.ts).catch(() => {});
      }
      notify();
    }
  }

  let refreshTimer = 0 as unknown as ReturnType<typeof setInterval>;
  (async () => {
    try {
      await Promise.all(ASSETS.flatMap((a) => [loadInstruments(a), loadHistory(a)]));
      for (const a of ASSETS) {
        sock.subscribe(`spot_feed.${a}`, (data) => {
          const feeds = data.feeds as Record<string, { price: string }> | undefined;
          const p = num(feeds?.[a]?.price);
          if (p) {
            onSpot(a, p, Number(data.timestamp) || Date.now());
            notify();
          }
        });
      }
      await refreshAllQuotes();
      source.status = 'ready';
      source.error = null;
      notify();
      refreshTimer = setInterval(() => void refreshAllQuotes(), QUOTE_REFRESH_MS);
    } catch (e) {
      source.status = 'error';
      source.error = `Couldn't load Derive market data: ${(e as Error).message}`;
      notify();
    }
  })();

  return source;
}

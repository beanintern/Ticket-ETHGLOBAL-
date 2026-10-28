// Live market data from Derive's public API, over its WebSocket.
//
// Two networks on Derive's v3 API: mainnet (wss://api.derive.xyz/v3/ws) and the testnet on Sepolia
// (wss://testnet.api.derive.xyz/v3/ws). Everything goes over the WebSocket (JSON-RPC requests
// plus subscriptions), which also avoids CORS: the REST endpoints don't allow browser origins
// other than Derive's own. Read-only: no account, keys or signing are involved here.
import { bsPrice, type OptType } from '../lib/bs';
import { DAY, MARKETS, MINUTE, YEAR, expiryLabel, parseStrike, specFor, type Asset, type Candle, type Expiry, type ExpiryKind, type MarketSpec, type TradeRules } from '../lib/market';
import type { AssetInfo, Market, MarketSource, Quote } from './types';

export interface DeriveNetwork {
  kind: 'live' | 'testnet';
  url: string;
}

export const DERIVE_MAINNET: DeriveNetwork = { kind: 'live', url: 'wss://api.derive.xyz/v3/ws' };
export const DERIVE_TESTNET: DeriveNetwork = { kind: 'testnet', url: 'wss://testnet.api.derive.xyz/v3/ws' };
/** How often the quotes of assets in use are re-fetched. */
const QUOTE_REFRESH_MS = 10_000;
/** How often the asset list (prices, 24h change, new listings) is re-fetched. */
const ASSETS_REFRESH_MS = 15_000;
/** An asset counts as in use (keeps its quotes fresh) this long after it was last looked at. */
const IN_USE_MS = 60_000;
/** A request Derive hasn't answered in this long (including waiting to connect) fails. */
const REQUEST_TIMEOUT_MS = 20_000;
/** Retrying a failed load: the wait doubles from the first to the last. */
const RETRY_FIRST_MS = 2_000;
const RETRY_MAX_MS = 30_000;
const backoff = (fails: number) => Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** Math.max(0, fails - 1));

/** Derive's error (a JSON-RPC error object as text) in words: its message, not the JSON. */
export function deriveErrorText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  try {
    const j = JSON.parse(msg) as { message?: string; data?: unknown };
    const data = typeof j.data === 'string' && j.data !== j.message ? `: ${j.data}` : '';
    if (j.message) return `${j.message}${data}`;
  } catch {
    /* not JSON */
  }
  return msg;
}

type Json = Record<string, unknown>;

/** Minimal JSON-RPC-over-WebSocket client with reconnect and re-subscribe. */
class DeriveSocket {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private channels = new Map<string, (data: Json) => void>();
  private closed = false;
  private retry = 0;
  private opened = false;
  onState: (s: 'open' | 'closed', err?: string) => void = () => {};

  constructor(private url: string) {
    this.connect();
  }

  private connect() {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.opened = true;
      if (this.channels.size) this.send('subscribe', { channels: [...this.channels.keys()] });
      this.onState('open');
    };
    ws.onmessage = (ev) => {
      let msg: Json;
      try {
        msg = JSON.parse(String(ev.data)) as Json;
      } catch {
        return;
      }
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
      this.onState(
        'closed',
        this.opened ? 'Connection to Derive lost, reconnecting…' : `Can't reach Derive (${new URL(this.url).host}), retrying…`,
      );
      const delay = Math.min(30_000, 1000 * 2 ** this.retry++);
      setTimeout(() => !this.closed && this.connect(), delay);
    };
    ws.onerror = () => ws.close();
  }

  private send(method: string, params: Json) {
    const id = this.nextId++;
    this.ws?.send(JSON.stringify({ jsonrpc: '2.0', method, params, id }));
    return id;
  }

  /** A request; fails if Derive doesn't answer within REQUEST_TIMEOUT_MS, so a stalled exchange can't hang a load. */
  call<T>(method: string, params: Json): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let id = 0;
      let wait: ReturnType<typeof setInterval> | undefined;
      const timeout = setTimeout(() => {
        clearInterval(wait);
        if (id) this.pending.delete(id);
        reject(new Error(`Derive didn't answer in time (${method})`));
      }, REQUEST_TIMEOUT_MS);
      const done = { resolve: (v: unknown) => (clearTimeout(timeout), resolve(v as T)), reject: (e: Error) => (clearTimeout(timeout), reject(e)) };
      const go = () => {
        id = this.send(method, params);
        this.pending.set(id, done);
      };
      if (this.ws?.readyState === WebSocket.OPEN) go();
      else {
        wait = setInterval(() => {
          if (this.closed) {
            clearInterval(wait);
            done.reject(new Error('closed'));
          } else if (this.ws?.readyState === WebSocket.OPEN) {
            clearInterval(wait);
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
  spec: MarketSpec;
  rules: TradeRules;
  /** Load started; finished once candles and expiries are in. */
  loading: boolean;
  loaded: boolean;
  /** Failed loads in a row, and when the next try may start. */
  fails: number;
  retryAt: number;
  lastUsed: number;
  spot: number;
  candles: Candle[];
  expiries: Expiry[];
  strikesByExpiry: Map<number, number[]>;
  /** key `${expiry}|${strike}|${type}` → quote */
  quotes: Map<string, RawQuote>;
}

const qkey = (expiry: number, strike: number, type: OptType) => `${expiry}|${strike}|${type}`;

function liveMarket(asset: Asset, st: LiveState, touch: () => void): Market {
  const spec = st.spec;
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
      touch();
      return st.loaded ? st.spot : 0;
    },
    get rules() {
      return st.rules;
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

export function createDeriveSource(network: DeriveNetwork = DERIVE_MAINNET): MarketSource {
  const sock = new DeriveSocket(network.url);
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((cb) => cb());
  let assets: AssetInfo[] = [];
  const states = new Map<Asset, LiveState>();
  const made = new Map<Asset, Market>();

  /** An asset's state, created (and its options loaded) the first time it's asked for. */
  const stateOf = (asset: Asset): LiveState => {
    let st = states.get(asset);
    if (!st) {
      const spec = specFor(asset, assets.find((a) => a.asset === asset)?.spot);
      st = { spec, rules: { tick: spec.tick, minAmount: spec.minAmount, amountStep: spec.amountStep }, loading: false, loaded: false, fails: 0, retryAt: 0, lastUsed: Date.now(), spot: 0, candles: [], expiries: [], strikesByExpiry: new Map(), quotes: new Map() };
      states.set(asset, st);
    }
    return st;
  };
  const marketOf = (asset: Asset): Market => {
    let m = made.get(asset);
    if (!m) {
      const st = stateOf(asset);
      m = liveMarket(asset, st, () => {
        st.lastUsed = Date.now();
        if (!st.loading && Date.now() >= st.retryAt) void loadAsset(asset);
      });
      made.set(asset, m);
    }
    return m;
  };
  const markets = new Proxy({} as Record<Asset, Market>, {
    get: (_t, a) => (typeof a === 'string' ? marketOf(a) : undefined),
    has: (_t, a) => typeof a === 'string',
    ownKeys: () => assets.map((a) => a.asset),
    getOwnPropertyDescriptor: (_t, a) => (typeof a === 'string' ? { enumerable: true, configurable: true, value: marketOf(a) } : undefined),
  });

  // The connection's problem (lost, reconnecting) comes first, then a failed load's.
  let socketError: string | null = null;
  let loadError: string | null = null;
  const loadErrors = new Map<Asset, string>();
  const setLoadError = () => (loadError = loadErrors.size ? [...loadErrors.values()][0] : null);
  const source: MarketSource & { status: MarketSource['status'] } = {
    kind: network.kind,
    status: 'connecting',
    get error() {
      return socketError ?? loadError;
    },
    get assets() {
      return assets;
    },
    markets,
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    close() {
      closed = true;
      clearInterval(refreshTimer);
      clearInterval(assetsTimer);
      clearTimeout(startTimer);
      sock.close();
    },
  };
  let closed = false;
  sock.onState = (s, err) => {
    socketError = s === 'closed' ? (err ?? 'Disconnected') : null;
    notify();
  };

  const onSpot = (asset: Asset, price: number, ts: number) => {
    const st = stateOf(asset);
    st.spot = price;
    // Live ticks build 1-minute candles, carrying on from the loaded 1-minute history.
    const minute = Math.floor(ts / MINUTE) * MINUTE;
    const last = st.candles[st.candles.length - 1];
    if (!last) return;
    if (minute > last.t) st.candles.push({ t: minute, o: last.c, h: Math.max(last.c, price), l: Math.min(last.c, price), c: price });
    else {
      last.c = price;
      last.h = Math.max(last.h, price);
      last.l = Math.min(last.l, price);
    }
  };

  async function loadInstruments(asset: Asset) {
    type Instr = {
      instrument_name: string;
      is_active: boolean;
      tick_size: string;
      minimum_amount: string;
      amount_step: string;
      option_details: { expiry: number; strike: string; option_type: OptType };
    };
    let list: Instr[] = [];
    // Paginated, at most 1000 per page.
    for (let page = 1; ; page++) {
      const res = await sock.call<{ instruments: Instr[]; pagination: { num_pages: number } }>('public/get_all_instruments', {
        currency: asset,
        instrument_type: 'option',
        expired: false,
        page,
        page_size: 1000,
      });
      list = list.concat(res.instruments);
      if (page >= res.pagination.num_pages) break;
    }
    const byExpiry = new Map<number, Set<number>>();
    // Listed but not yet trading (scheduled for later) instruments have no quotes: skip them.
    for (const i of list.filter((x) => x.is_active !== false)) {
      const ts = i.option_details.expiry * 1000;
      const k = Number(i.option_details.strike);
      if (!byExpiry.has(ts)) byExpiry.set(ts, new Set());
      byExpiry.get(ts)!.add(k);
    }
    const st = stateOf(asset);
    // The asset's contract rules, from its listings (the same for all its options).
    const first = list.find((x) => x.is_active !== false);
    if (first) st.rules = { tick: num(first.tick_size) ?? st.rules.tick, minAmount: num(first.minimum_amount) ?? st.rules.minAmount, amountStep: num(first.amount_step) ?? st.rules.amountStep };
    st.strikesByExpiry = new Map([...byExpiry].map(([ts, ks]) => [ts, [...ks].sort((a, b) => a - b)]));
    st.expiries = [...byExpiry.keys()].sort((a, b) => a - b).map((ts) => ({ ts, kind: expiryKind(ts), label: expiryLabel(ts) }));
  }

  async function loadHistory(asset: Asset) {
    const now = Math.floor(Date.now() / 1000);
    const span = 20 * 86400;
    // Real OHLC candles, finer towards now: daily for the year before, hourly for the last 40
    // days, 5-minute for the last day and 1-minute for the last 6 hours (each call stays under
    // Derive's 500-point limit). Each series covers up to where the next, finer one starts.
    type Oc = { open_price: string; high_price: string; low_price: string; close_price: string; timestamp: number };
    const chart = (start: number, end: number, period: number) =>
      sock.call<Oc[]>('public/get_index_chart_data', { currency: asset, start_timestamp: start, end_timestamp: end, period });
    const hourlyFrom = now - 2 * span;
    const fiveFrom = Math.floor((now - 86400) / 3600) * 3600;
    const oneFrom = Math.floor((now - 6 * 3600) / 300) * 300;
    const series = await Promise.all([
      chart(hourlyFrom - 400 * 86400, hourlyFrom, 86400).then((r) => ({ r, from: -Infinity, to: hourlyFrom })),
      chart(hourlyFrom, now, 3600).then((r) => ({ r, from: hourlyFrom, to: fiveFrom })),
      chart(fiveFrom, now, 300).then((r) => ({ r, from: fiveFrom, to: oneFrom })),
      chart(oneFrom, now, 60).then((r) => ({ r, from: oneFrom, to: Infinity })),
    ]);
    const candles: Candle[] = series
      .flatMap(({ r, from, to }) => r.filter((c) => c.timestamp >= from && c.timestamp < to))
      .map((c) => ({ t: c.timestamp * 1000, o: Number(c.open_price), h: Number(c.high_price), l: Number(c.low_price), c: Number(c.close_price) }))
      .filter((c) => [c.o, c.h, c.l, c.c].every(Number.isFinite))
      .sort((a, b) => a.t - b.t);
    const st = stateOf(asset);
    st.candles = candles;
    if (!st.spot && candles.length) st.spot = candles[candles.length - 1].c;
  }

  async function loadQuotes(asset: Asset, expiry: number) {
    type Tk = { M: string; b: string; a: string; I: string; option_pricing: { i: string } | null };
    const res = await sock.call<{ tickers: Record<string, Tk> }>('public/get_tickers', { instrument_type: 'option', currency: asset, expiry_date: ymd(expiry) });
    const st = stateOf(asset);
    for (const [name, t] of Object.entries(res.tickers)) {
      // ETH-20261030-3000-C
      const parts = name.split('-');
      const type = parts[3] as OptType;
      const strike = parseStrike(parts[2]);
      const mark = num(t.M);
      if (mark === null || !Number.isFinite(strike)) continue;
      const bid = num(t.b);
      const ask = num(t.a);
      const deriveIv = num(t.option_pricing?.i) ?? st.spec.baseIv;
      st.quotes.set(qkey(expiry, strike, type), { mark, bid: bid && bid > 0 ? bid : null, ask: ask && ask > 0 ? ask : null, iv: deriveIv, deriveIv });
      if (!st.spot) st.spot = num(t.I) ?? st.spot;
    }
  }

  async function loadAllQuotes(asset: Asset) {
    const now = Date.now();
    for (const e of stateOf(asset).expiries) {
      if (closed) return;
      if (e.ts > now) await loadQuotes(asset, e.ts).catch(() => {});
    }
  }

  /** Loads an asset's options the first time it's used: listings, history, live index and quotes. */
  async function loadAsset(asset: Asset) {
    const st = stateOf(asset);
    st.loading = true;
    try {
      await Promise.all([loadInstruments(asset), loadHistory(asset)]);
      sock.subscribe(`spot_feed.${asset}`, (data) => {
        const feeds = data.feeds as Record<string, { price: string }> | undefined;
        const p = num(feeds?.[asset]?.price);
        if (p) {
          onSpot(asset, p, Number(data.timestamp) || Date.now());
          notify();
        }
      });
      await loadAllQuotes(asset);
      st.loaded = true;
      st.fails = 0;
      loadErrors.delete(asset);
      setLoadError();
      notify();
    } catch (e) {
      // Let a later use try again, waiting longer after each failure so an outage isn't hammered.
      st.loading = false;
      st.fails++;
      st.retryAt = Date.now() + backoff(st.fails);
      loadErrors.set(asset, `Couldn't load ${asset} from Derive (${deriveErrorText(e)}). Retrying…`);
      setLoadError();
      notify();
    }
  }

  // Whether each asset has options trading right now (some are set up with none active yet).
  const tradable = new Map<Asset, { yes: boolean; at: number }>();
  async function hasActiveOptions(asset: Asset): Promise<boolean> {
    const known = tradable.get(asset);
    if (known && Date.now() - known.at < 10 * 60_000) return known.yes;
    type Page = { instruments: { is_active: boolean }[] };
    const res = await sock.call<Page>('public/get_all_instruments', { currency: asset, instrument_type: 'option', expired: false, page: 1, page_size: 1000 });
    const yes = res.instruments.some((i) => i.is_active !== false);
    tradable.set(asset, { yes, at: Date.now() });
    return yes;
  }

  /** Every asset with options trading on Derive, with its price and 24-hour change, known assets first. */
  async function loadAssets() {
    type Cur = {
      currency: string;
      spot_price: string;
      spot_price_24h: string | null;
      option?: { universes?: { risk_universe_id: number; risk_universe_name: string }[] } | null;
    };
    const list = await sock.call<Cur[]>('public/get_all_currencies', {});
    const order = Object.keys(MARKETS);
    const rank = (a: string) => (order.includes(a) ? order.indexOf(a) : order.length);
    const withOptions = list.filter((c) => c.option);
    // "Instrument not found" means none listed; on any other error keep what was known (or show it).
    const active = await Promise.all(
      withOptions.map((c) =>
        hasActiveOptions(c.currency).catch((e: Error) => (/not found|12001/i.test(e.message) ? false : (tradable.get(c.currency)?.yes ?? true))),
      ),
    );
    assets = withOptions
      .filter((_, i) => active[i])
      .map((c) => {
        const spot = num(c.spot_price) ?? 0;
        const before = num(c.spot_price_24h);
        const u = c.option?.universes?.[0];
        return {
          asset: c.currency,
          name: specFor(c.currency, spot).name,
          spot,
          change24h: before ? spot / before - 1 : null,
          group: u ? { id: u.risk_universe_id, name: u.risk_universe_name } : undefined,
        };
      })
      .sort((a, b) => rank(a.asset) - rank(b.asset) || a.asset.localeCompare(b.asset));
  }

  // One refresh at a time: when Derive is slow, a refresh can take longer than the interval.
  let refreshing = false;
  async function refreshInUse() {
    if (refreshing) return;
    refreshing = true;
    try {
      const now = Date.now();
      for (const [a, st] of states) {
        if (closed) return;
        if (st.loaded && now - st.lastUsed < IN_USE_MS) {
          await loadAllQuotes(a);
          notify();
        }
      }
    } finally {
      refreshing = false;
    }
  }

  let refreshTimer = 0 as unknown as ReturnType<typeof setInterval>;
  let assetsTimer = 0 as unknown as ReturnType<typeof setInterval>;
  let startTimer = 0 as unknown as ReturnType<typeof setTimeout>;
  // The first load retries until it works (with a growing wait), so a Derive outage clears by itself.
  const start = async (fails: number) => {
    try {
      await loadAssets();
      if (closed) return;
      source.status = 'ready';
      loadErrors.delete('*');
      setLoadError();
      notify();
      refreshTimer = setInterval(() => void refreshInUse(), QUOTE_REFRESH_MS);
      assetsTimer = setInterval(() => void loadAssets().then(notify, () => {}), ASSETS_REFRESH_MS);
    } catch (e) {
      if (closed) return;
      const wait = backoff(fails + 1);
      source.status = 'error';
      loadErrors.set('*', `Derive said: ${deriveErrorText(e)}. Retrying in ${Math.round(wait / 1000)}s…`);
      setLoadError();
      notify();
      startTimer = setTimeout(() => void start(fails + 1), wait);
    }
  };
  void start(0);

  return source;
}

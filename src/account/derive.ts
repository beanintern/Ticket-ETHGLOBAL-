// A Derive account (mainnet or testnet) connected with a session key.
//
// The session key is a delegated signing key registered to the wallet, so the wallet's own key
// never enters the app. It signs the WebSocket login here, and orders later on. It lives in this
// browser only: in memory, plus sessionStorage (or localStorage if "remember" is ticked).
//
// The Derive SDK (and ethers) are loaded on demand, so the chart doesn't pay for them.
import type { DeriveClient } from '@derivexyz/derive-ts';
import type { OptType } from '../lib/bs';
import { BUILDER, type Instrument, type LegOrder } from './orders';
import { parseStrike, type Asset } from '../lib/market';
import { NETS, type DeriveNet } from './network';

export interface Credentials {
  /** The wallet that owns the Derive account. */
  owner: string;
  /** The session key's private key. */
  sessionKey: string;
}

export interface AccountPosition {
  instrument: string;
  asset: Asset;
  type: OptType;
  strike: number;
  /** Expiry date as YYYYMMDD, from the instrument name. */
  expiryYmd: string;
  /** Signed contracts: positive long, negative short. */
  amount: number;
  averagePrice: number;
  markPrice: number;
  unrealizedPnl: number;
  openedAt: number;
}

export interface AccountOrder {
  id: string;
  instrument: string;
  direction: 'buy' | 'sell';
  amount: number;
  filled: number;
  limitPrice: number;
  status: string;
}

export interface Portfolio {
  subaccountId: number;
  value: number;
  collateral: { asset: string; amount: number; value: number }[];
  initialMargin: number;
  maintenanceMargin: number;
  positions: AccountPosition[];
  /** Positions this app can't draw (perps, spot, other underlyings). */
  otherPositions: { instrument: string; amount: number; unrealizedPnl: number }[];
  openOrders: AccountOrder[];
  updatedAt: number;
}

export interface AccountState {
  status: 'connecting' | 'ready' | 'error';
  error: string | null;
  owner: string;
  signer: string;
  subaccountIds: number[];
  subaccountId: number | null;
  /**
   * Each subaccount's margin group (Derive's risk universe id). A subaccount only trades the
   * assets in its group: PRIME (ETH, BTC), MIDCAP (HYPE), ALT (SOL, XRP, …), RWA (XAUT).
   */
  groups: Record<number, number>;
  /** The key's protocol scopes, when Derive lets the key read them. */
  scopes: string[] | null;
  canTrade: boolean | null;
  portfolio: Portfolio | null;
}

/** Derive's dry-run of one order: will it go through, at what price and fee. */
export interface OrderPreview {
  valid: boolean;
  reason: string | null;
  fillPrice: number;
  fillAmount: number;
  fee: number;
}

export interface OrderResult {
  order: LegOrder;
  ok: boolean;
  status: string;
  filled: number;
  averagePrice: number;
  error: string | null;
}

/** One leg of an RFQ, from the taker's side. */
export interface RfqLegIn {
  instrument: string;
  /** Contracts, as a decimal string on the amount grid. */
  amount: string;
  direction: 'buy' | 'sell';
}

/** A maker's firm quote for a whole package, as the taker sees it. */
export interface RfqQuote {
  rfqId: string;
  /** Buying or selling the package (the legs as given). */
  direction: 'buy' | 'sell';
  /** What the SDK needs to execute it. */
  quote: { rfq_id: string; quote_id: string; direction: 'buy' | 'sell'; legs: { instrument_name: string; amount: string; direction: 'buy' | 'sell'; price: string }[] };
  /** Premium for the whole package: positive is paid, negative received. USDC. */
  premium: number;
  /** Derive's fee estimate for executing it. USDC. */
  fee: number;
  /** Fee cap to sign the execution with (Derive's suggestion). */
  maxFee: string;
  /** Each leg's quoted price per contract. */
  prices: Record<string, number>;
}

export interface RfqFill {
  ok: boolean;
  /** Fraction of the package filled, 0–1. */
  filled: number;
  fee: number;
  error: string | null;
  /** Derive didn't say whether it traded (a timeout or a dropped connection): it may have. */
  uncertain?: boolean;
}

/** Errors after which an order may or may not have gone through: a timeout or a dropped connection. */
const UNCERTAIN = /\b9000\b|time ?out|timed out|connection|closed|network|socket/i;
/** After an uncertain execution: how often, and how many times, to look for its trades. */
const CONFIRM_POLL_MS = 2000;
const CONFIRM_TRIES = 5;
/** Shown when Derive never said whether an order traded. */
const UNCERTAIN_TEXT = 'Derive didn’t confirm whether this traded. It may still have gone through: check your positions before trying again.';

/** How long to collect maker quotes for: the first one, then a little longer for a better one. */
const RFQ_WAIT_MS = 7000;
const RFQ_SETTLE_MS = 1500;
const RFQ_POLL_MS = 500;

const REFRESH_MS = 5000;
/** Saved credentials per network (the testnet name predates mainnet support). */
const store = (net: DeriveNet) => `ticket.derive.${net}.session`;

const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Whether one of the key's grants covers a required scope (grants form a tree; `all` covers children). */
export function scopeAllows(grants: string[], required: string): boolean {
  const req = required.split(':');
  return grants.some((g) => {
    if (g === 'admin' || g === 'all') return true;
    const parts = g.split(':');
    for (let i = 0; i < parts.length; i++) {
      if (parts[i] === 'all') return true;
      if (parts[i] !== req[i]) return false;
    }
    return parts.length === req.length;
  });
}

/** ETH-20261030-3000-C or ADA-20261225-1_7-P → its parts, or null for anything that isn't an option. */
export function parseOptionName(name: string): { asset: Asset; expiryYmd: string; strike: number; type: OptType } | null {
  const m = /^([A-Z0-9]+)-(\d{8})-(\d+(?:_\d+)?)-([CP])$/.exec(name);
  if (!m) return null;
  return { asset: m[1], expiryYmd: m[2], strike: parseStrike(m[3]), type: m[4] as OptType };
}

/** Even touching `localStorage` can throw (blocked site data), so every access is guarded. */
function storage(remember: boolean): Storage | null {
  try {
    return remember ? globalThis.localStorage : globalThis.sessionStorage;
  } catch {
    return null;
  }
}

export function loadCredentials(net: DeriveNet): { creds: Credentials; remember: boolean } | null {
  for (const remember of [false, true]) {
    try {
      const raw = storage(remember)?.getItem(store(net));
      if (raw) return { creds: JSON.parse(raw) as Credentials, remember };
    } catch {
      /* storage unavailable */
    }
  }
  return null;
}

function saveCredentials(net: DeriveNet, creds: Credentials | null, remember: boolean) {
  try {
    storage(false)?.removeItem(store(net));
    storage(true)?.removeItem(store(net));
    if (creds) storage(remember)?.setItem(store(net), JSON.stringify(creds));
  } catch {
    /* storage unavailable: stays connected until reload */
  }
}

/** Plain-language version of an SDK/exchange error. */
export function explainError(e: unknown, net?: DeriveNet): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/14026|Session key not found/i.test(msg))
    return `Derive doesn’t know this session key for that wallet. Check it’s registered${net ? ` on ${NETS[net].name}` : ''} and not expired.`;
  if (/401|Unauthorized/i.test(msg)) return 'Derive rejected the login. Check the wallet address and session key.';
  if (/invalid private key|invalid BytesLike|invalid hexlify/i.test(msg)) return 'That doesn’t look like a private key (64 hex characters, optionally starting with 0x).';
  if (/invalid address/i.test(msg)) return 'That doesn’t look like a wallet address.';
  return msg.replace(/^private\/\w+: |^public\/\w+: /, '');
}

export class DeriveAccount {
  state: AccountState;
  private client: DeriveClient | null = null;
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private instrumentCache = new Map<string, Promise<Instrument>>();

  private constructor(
    readonly net: DeriveNet,
    owner: string,
    signer: string,
  ) {
    this.state = { status: 'connecting', error: null, owner, signer, subaccountIds: [], subaccountId: null, groups: {}, scopes: null, canTrade: null, portfolio: null };
  }

  /** Validates the credentials, logs in over the WebSocket and starts polling the portfolio. */
  static async connect(net: DeriveNet, creds: Credentials, remember: boolean): Promise<DeriveAccount> {
    const [{ DeriveClient }, { Wallet, getAddress }] = await Promise.all([import('@derivexyz/derive-ts'), import('ethers')]);
    let owner: string;
    let key: InstanceType<typeof Wallet>;
    try {
      owner = getAddress(creds.owner.trim().toLowerCase());
    } catch {
      throw new Error('That doesn’t look like a wallet address (0x followed by 40 hex characters).');
    }
    try {
      const pk = creds.sessionKey.trim();
      key = new Wallet(pk.startsWith('0x') ? pk : `0x${pk}`);
    } catch {
      throw new Error('That doesn’t look like a private key (64 hex characters, optionally starting with 0x).');
    }
    if (key.address === owner) {
      throw new Error('That’s the wallet’s own private key. Use a session key registered to the wallet instead, so the wallet key never leaves your wallet.');
    }

    const acct = new DeriveAccount(net, owner, key.address);
    const client = new DeriveClient({ network: net, sessionKey: key, ownerAddress: owner });
    acct.client = client;
    try {
      await client.connect();
      const ids = ((await client.login()) as number[]).slice().sort((a, b) => a - b);
      acct.state.subaccountIds = ids;
      acct.state.subaccountId = ids[0] ?? null;
    } catch (e) {
      await client.close().catch(() => {});
      throw new Error(explainError(e, net));
    }
    saveCredentials(net, { owner, sessionKey: key.privateKey }, remember);

    // The key's scopes decide whether it can place orders. Reading them may itself need a scope,
    // so a failure here just means "unknown".
    try {
      const res = await client.send('private/session_keys', { wallet: owner });
      const mine = res.public_session_keys.find((k) => k.public_session_key.toLowerCase() === key.address.toLowerCase());
      if (mine) {
        acct.state.scopes = mine.protocol_scopes as string[];
        acct.state.canTrade = scopeAllows(acct.state.scopes, 'trade:orderbook:option');
      }
    } catch {
      /* scopes unknown */
    }

    await acct.refresh();
    acct.timer = setInterval(() => void acct.refresh(), REFRESH_MS);
    return acct;
  }

  get sdk(): DeriveClient {
    if (!this.client) throw new Error('not connected');
    return this.client;
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  private emit() {
    this.state = { ...this.state };
    this.listeners.forEach((cb) => cb());
  }

  selectSubaccount(id: number) {
    this.state.subaccountId = id;
    this.state.portfolio = null;
    this.emit();
    void this.refresh();
  }

  /** Picks up subaccounts created since login (e.g. by a deposit) and learns each one's margin group. */
  private async refreshSubaccounts() {
    if (!this.client) return;
    try {
      const ids = (await this.client.subaccounts.list()).slice().sort((a, b) => a - b);
      this.state.subaccountIds = ids;
      if (this.state.subaccountId === null && ids.length) this.state.subaccountId = ids[0];
      await Promise.all(
        ids
          .filter((id) => this.state.groups[id] === undefined)
          .map(async (id) => {
            const s = await this.client!.subaccounts.get(id);
            this.state.groups = { ...this.state.groups, [id]: s.risk_universe_id };
          }),
      );
    } catch {
      /* try again on the next refresh */
    }
  }

  async refresh() {
    if (this.closed || !this.client) return;
    await this.refreshSubaccounts();
    const id = this.state.subaccountId;
    if (id === null) {
      this.state.status = 'ready';
      this.emit();
      return;
    }
    try {
      const s = await this.client.subaccounts.get(id);
      const positions: AccountPosition[] = [];
      const otherPositions: Portfolio['otherPositions'] = [];
      for (const p of s.positions) {
        const opt = parseOptionName(p.instrument_name);
        const amount = num(p.amount);
        if (!amount) continue;
        if (!opt) {
          otherPositions.push({ instrument: p.instrument_name, amount, unrealizedPnl: num(p.unrealized_pnl) });
          continue;
        }
        positions.push({
          instrument: p.instrument_name,
          ...opt,
          amount,
          averagePrice: num(p.average_price),
          markPrice: num(p.mark_price),
          unrealizedPnl: num(p.unrealized_pnl),
          openedAt: p.creation_timestamp > 1e12 ? p.creation_timestamp : p.creation_timestamp * 1000,
        });
      }
      this.state.portfolio = {
        subaccountId: id,
        value: num(s.subaccount_value),
        collateral: s.collaterals.map((c) => ({ asset: c.asset_name, amount: num(c.amount), value: num(c.mark_value) })),
        initialMargin: num(s.initial_margin),
        maintenanceMargin: num(s.maintenance_margin),
        positions,
        otherPositions,
        openOrders: s.open_orders.map((o) => ({
          id: o.order_id,
          instrument: o.instrument_name,
          direction: o.direction as 'buy' | 'sell',
          amount: num(o.amount),
          filled: num(o.filled_amount),
          limitPrice: num(o.limit_price),
          status: String(o.order_status),
        })),
        updatedAt: Date.now(),
      };
      this.state.status = 'ready';
      this.state.error = null;
    } catch (e) {
      // Keep showing the last snapshot; the SDK reconnects (and logs in again) on its own.
      this.state.error = explainError(e, this.net);
      if (!this.state.portfolio) this.state.status = 'error';
    }
    if (!this.closed) this.emit();
  }

  /** Tick size, amount grid and fees per instrument (fixed for an instrument's life, so cached). */
  async instruments(names: string[]): Promise<Map<string, Instrument>> {
    const out = new Map<string, Instrument>();
    await Promise.all(
      names.map(async (name) => {
        let p = this.instrumentCache.get(name);
        if (!p) {
          p = this.sdk.send('public/get_instrument', { instrument_name: name }).then((i) => ({
            tick: num(i.tick_size),
            amountStep: num(i.amount_step),
            minAmount: num(i.minimum_amount),
            takerRate: num(i.taker_fee_rate),
            baseFee: num(i.base_fee),
          }));
          p.catch(() => this.instrumentCache.delete(name));
          this.instrumentCache.set(name, p);
        }
        try {
          out.set(name, await p);
        } catch {
          /* not listed: legOrders reports it */
        }
      }),
    );
    return out;
  }

  private params(o: LegOrder, mode: 'market' | 'limit') {
    if (this.state.subaccountId === null) throw new Error('No subaccount');
    return {
      subaccountId: this.state.subaccountId,
      instrumentName: o.instrument,
      direction: o.direction,
      amount: o.amount,
      limitPrice: o.limitPrice,
      maxFee: o.maxFee,
      orderType: 'limit' as const,
      timeInForce: mode === 'market' ? ('ioc' as const) : ('gtc' as const),
      reduceOnly: o.reduceOnly || undefined,
      label: 'ticket',
      ...(BUILDER.code ? { referralCode: BUILDER.code, extraFee: BUILDER.extraFee ? String(BUILDER.extraFee) : undefined } : {}),
    };
  }

  /** Signs each order and asks Derive what would happen, without placing anything. */
  async preview(orders: LegOrder[], mode: 'market' | 'limit'): Promise<OrderPreview[]> {
    return Promise.all(
      orders.map(async (o) => {
        try {
          const q = await this.sdk.orders.getOrderQuote(this.params(o, mode));
          return { valid: q.is_valid, reason: q.invalid_reason ? String(q.invalid_reason) : null, fillPrice: num(q.estimated_fill_price), fillAmount: num(q.estimated_fill_amount), fee: num(q.estimated_fee) };
        } catch (e) {
          return { valid: false, reason: explainError(e, this.net), fillPrice: 0, fillAmount: 0, fee: 0 };
        }
      }),
    );
  }

  /**
   * Places the orders one at a time, stopping at the first one Derive rejects so a failed leg
   * doesn't leave the rest of the structure half-built. Reports what happened to each.
   */
  async place(orders: LegOrder[], mode: 'market' | 'limit'): Promise<OrderResult[]> {
    const results: OrderResult[] = [];
    for (const o of orders) {
      try {
        const res = await this.sdk.orders.place(this.params(o, mode));
        const filled = num(res.order.filled_amount);
        results.push({ order: o, ok: true, status: String(res.order.order_status), filled, averagePrice: num(res.order.average_price), error: null });
      } catch (e) {
        const unsure = UNCERTAIN.test(e instanceof Error ? e.message : String(e));
        results.push({ order: o, ok: false, status: unsure ? 'unconfirmed' : 'rejected', filled: 0, averagePrice: 0, error: unsure ? UNCERTAIN_TEXT : explainError(e, this.net) });
        break;
      }
    }
    void this.refresh();
    return results;
  }

  /**
   * Asks market makers to quote a package (e.g. both legs of a bet) and returns the best firm
   * quote, or null if none came within RFQ_WAIT_MS (the RFQ is then cancelled). Nothing trades
   * until `rfqExecute`. The builder code rides on the RFQ.
   */
  async rfqQuote(legs: RfqLegIn[], direction: 'buy' | 'sell'): Promise<RfqQuote | null> {
    const subaccountId = this.state.subaccountId;
    if (subaccountId === null) throw new Error('No subaccount');
    const wire = legs.map((l) => ({ instrument_name: l.instrument, amount: l.amount, direction: l.direction }));
    let rfqId: string;
    try {
      const rfq = await this.sdk.send('private/send_rfq', {
        subaccount_id: subaccountId,
        legs: wire,
        label: 'ticket',
        ...(BUILDER.code ? { referral_code: BUILDER.code, ...(BUILDER.extraFee ? { extra_fee: String(BUILDER.extraFee) } : {}) } : {}),
      });
      rfqId = rfq.rfq_id;
    } catch (e) {
      throw new Error(explainError(e, this.net));
    }
    const sdkLegs = legs.map((l) => ({ instrumentName: l.instrument, amount: l.amount, direction: l.direction }));
    const start = Date.now();
    let firstAt = 0;
    let best: RfqQuote | null = null;
    while (Date.now() - start < RFQ_WAIT_MS && !(firstAt && Date.now() - firstAt >= RFQ_SETTLE_MS)) {
      await new Promise((r) => setTimeout(r, RFQ_POLL_MS));
      try {
        const res = await this.sdk.rfq.getBestQuote({ subaccountId, rfqId, direction, legs: sdkLegs });
        const q = res.best_quote;
        if (!q || !res.is_valid) continue;
        const prices: Record<string, number> = {};
        let net = 0;
        for (const l of q.legs) {
          prices[l.instrument_name] = num(l.price);
          net += (l.direction === 'buy' ? 1 : -1) * num(l.price) * num(l.amount);
        }
        best = {
          rfqId,
          direction,
          quote: { rfq_id: q.rfq_id, quote_id: q.quote_id, direction: q.direction, legs: q.legs },
          // The quote's legs are the RFQ's legs, from the taker's side; selling the package reverses them.
          premium: direction === 'buy' ? net : -net,
          fee: num(res.estimated_fee),
          maxFee: res.suggested_max_fee,
          prices,
        };
        if (!firstAt) firstAt = Date.now();
      } catch {
        /* keep polling */
      }
    }
    if (!best) await this.rfqCancel(rfqId);
    return best;
  }

  /** Executes a quote from `rfqQuote`: the whole package fills at its prices, or nothing does. */
  async rfqExecute(q: RfqQuote): Promise<RfqFill> {
    const subaccountId = this.state.subaccountId;
    if (subaccountId === null) throw new Error('No subaccount');
    const startedAt = Date.now();
    try {
      const res = await this.sdk.rfq.executeQuote({ subaccountId, quote: q.quote as never, maxFee: q.maxFee, label: 'ticket' });
      // A fraction of the package (1 = all of it); read a percentage the same way.
      const raw = num(res.fill_pct);
      const filled = raw > 1 ? raw / 100 : raw;
      return { ok: filled > 0, filled, fee: num(res.fee), error: filled > 0 ? null : `Not filled (${res.status})` };
    } catch (e) {
      // A timeout doesn't mean it didn't trade: look for the trade before saying anything.
      if (UNCERTAIN.test(e instanceof Error ? e.message : String(e))) return this.rfqFillFromHistory(q, subaccountId, startedAt);
      return { ok: false, filled: 0, fee: 0, error: explainError(e, this.net) };
    } finally {
      void this.refresh();
    }
  }

  /** What an RFQ execution Derive didn't confirm actually did, from the subaccount's trades. */
  private async rfqFillFromHistory(q: RfqQuote, subaccountId: number, since: number): Promise<RfqFill> {
    const leg = q.quote.legs[0];
    for (let i = 0; i < CONFIRM_TRIES; i++) {
      await new Promise((r) => setTimeout(r, CONFIRM_POLL_MS));
      try {
        const res = await this.sdk.send('private/get_trade_history', { subaccount_id: subaccountId, from_timestamp: since - 60_000, page_size: 100 });
        const trades = res.trades.filter((t) => t.rfq_id === q.rfqId);
        if (!trades.length) continue;
        const filled = Math.min(1, trades.filter((t) => t.instrument_name === leg.instrument_name).reduce((a, t) => a + num(t.trade_amount), 0) / num(leg.amount));
        return { ok: filled > 0, filled, fee: trades.reduce((a, t) => a + num(t.trade_fee), 0), error: null };
      } catch {
        /* try again */
      }
    }
    return { ok: false, filled: 0, fee: 0, error: UNCERTAIN_TEXT, uncertain: true };
  }

  async rfqCancel(rfqId: string) {
    const subaccountId = this.state.subaccountId;
    if (subaccountId === null) return;
    await this.sdk.rfq.cancelRfq({ subaccountId, rfqId }).catch(() => {});
  }

  async cancel(orderId: string, instrument: string) {
    if (this.state.subaccountId === null) return;
    await this.sdk.orders.cancel({ subaccountId: this.state.subaccountId, orderId, instrumentName: instrument });
    await this.refresh();
  }

  async disconnect() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    saveCredentials(this.net, null, false);
    await this.client?.close().catch(() => {});
    this.client = null;
  }
}

import { useEffect, useRef, useState } from 'react';
import type { RfqFill, RfqQuote } from '../account/derive';
import type { Trading } from './DeriveReview';
import { betLegs, betQuestion, fmtCents, fmtChance, MIN_BET, minStake, previewBid, rfqFee, sharePayoff, sizeBet, type BetQuote } from '../lib/binary';
import { instrumentName } from '../account/orders';
import { signedUsd, usd } from '../lib/format';
import { expiryLabel, type Asset } from '../lib/market';
import { buildModel, type Position } from '../lib/strategy';
import type { Market } from '../data/types';
import type { NetInfo } from '../account/network';

const cents = fmtCents;
const pnlClass = (v: number) => (v > 0.005 ? 'up' : v < -0.005 ? 'down' : '');

interface Props {
  asset: Asset;
  now: number;
  markets: Record<Asset, Market>;
  pending: BetQuote | null;
  stake: number;
  onStake: (v: number) => void;
  onCancel: () => void;
  /** Paper bet at the preview price. */
  onBuy: (q: BetQuote, stake: number) => void;
  bets: Position[];
  /** Paper sale at the estimate the Sell button shows. */
  onSellPaper: (id: string) => void;
  /** Why a bet held on Derive can't be sold from here right now (wrong network, not connected), or null. */
  sellBlocked: (pos: Position) => string | null;
  /** Paper bets, a prompt to connect (Derive data, no account), or real bets on Derive by RFQ (mainnet or testnet). */
  venue:
    | { kind: 'paper' }
    | { kind: 'connect'; info: NetInfo; onConnect: () => void }
    | {
        kind: 'live';
        trading: Trading;
        onBoughtLive: (q: BetQuote, quote: RfqQuote, fill: RfqFill) => void;
        onSoldLive: (id: string, quote: RfqQuote, fill: RfqFill) => void;
      };
}

/** Current fair price of one share of a bet: the legs' value at mark, per share. */
export function sharePrice(pos: Position, markets: Record<Asset, Market>, now: number): number {
  const m = buildModel(pos.legs, markets[pos.asset], now);
  return pos.bet ? Math.min(1, Math.max(0, m.value / pos.bet.shares)) : 0;
}

/** What selling a bet is expected to fetch at least by RFQ, after estimated fees: what Sell shows. */
export function sellEstimate(pos: Position, markets: Record<Asset, Market>, now: number): { perShare: number; proceeds: number } {
  if (!pos.bet || pos.legs.length < 2) return { perShare: 0, proceeds: 0 };
  const market = markets[pos.asset];
  const [held, sold] = buildModel(pos.legs, market, now).marks;
  const perShare = previewBid({ legPrices: [held, sold], lo: pos.bet.lo, hi: pos.bet.hi }, market.spot);
  const fees = rfqFee(pos.legs[0].qty, [held, sold], market.spot);
  return { perShare, proceeds: Math.max(0, perShare * pos.bet.shares - fees) };
}

/** Buying or selling by RFQ: confirm (real money), collect quotes, then fill or ask. */
type Flow =
  | { kind: 'idle' }
  | { kind: 'confirm' }
  | { kind: 'quoting' }
  | { kind: 'none' }
  | { kind: 'worse'; quote: RfqQuote; total: number }
  | { kind: 'filling' }
  | { kind: 'error'; message: string };

export function EasyPanel({ asset, now, markets, pending, stake, onStake: setStake, onCancel, onBuy, bets, onSellPaper, sellBlocked, venue }: Props) {
  const spot = pending ? markets[pending.asset].spot : 0;
  // What the stake buys at the preview price, Derive's fees included, on Derive's size grid.
  const size = pending ? sizeBet(pending, stake, spot) : null;
  const minBet = pending ? minStake(pending, spot) : 0;
  const tooSmall = !!pending && stake < minBet;
  const shares = size?.shares ?? 0;
  const blocked = !size || tooSmall || !!pending?.unavailable;
  const live = venue.kind === 'live' ? venue : null;

  // A new box or amount starts the buy over (and drops a quote for the old one).
  const buyKey = pending ? `${pending.asset}|${pending.expiry}|${pending.lo}|${pending.hi}|${stake}` : '';
  const [buy, setBuy] = useState<Flow>({ kind: 'idle' });
  const worseRef = useRef<RfqQuote | null>(null);
  useEffect(() => {
    setBuy({ kind: 'idle' });
    if (worseRef.current && live) void live.trading.rfqCancel(worseRef.current);
    worseRef.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buyKey]);

  const fillBuy = async (quote: RfqQuote) => {
    if (!live || !pending) return;
    setBuy({ kind: 'filling' });
    worseRef.current = null;
    const fill = await live.trading.rfqExecute(quote);
    if (fill.ok) {
      setBuy({ kind: 'idle' });
      live.onBoughtLive(pending, quote, fill);
    } else setBuy({ kind: 'error', message: `Couldn’t fill that quote: ${fill.error ?? 'rejected'}. Try again for a fresh one.` });
  };

  const startBuy = async () => {
    if (!live || !pending || !size || blocked) return;
    if (live.trading.info.real && buy.kind !== 'confirm') {
      setBuy({ kind: 'confirm' });
      return;
    }
    setBuy({ kind: 'quoting' });
    try {
      const quote = await live.trading.rfqQuote(betLegs(pending, shares), 'buy');
      if (!quote) {
        setBuy({ kind: 'none' });
        return;
      }
      const total = quote.premium + quote.fee;
      // At or under the preview: fill it. Over it: show the real price and ask.
      if (total <= size.cost + 0.005) await fillBuy(quote);
      else {
        worseRef.current = quote;
        setBuy({ kind: 'worse', quote, total });
      }
    } catch (e) {
      setBuy({ kind: 'error', message: (e as Error).message });
    }
  };

  // The options behind the bet, at the preview's prices (the most paid, the least received).
  const [showLegs, setShowLegs] = useState(false);
  const underlying = pending
    ? betLegs(pending, shares).map((l, i) => ({ instrument: instrumentName(l), buy: l.side > 0, amount: l.qty.toFixed(2), price: pending.previewLegPrices[i] }))
    : [];
  const u0Text = pending
    ? `Each contract is on 1 ${pending.asset}. The two strikes are $${(pending.hi - pending.lo).toLocaleString('en-US')} apart, so ${underlying[0]?.amount ?? '–'} contracts pay up to $${shares.toFixed(2)}: $1 for each of your ${shares.toFixed(1)} shares.`
    : '';
  // On narrow screens the card sits below the chart: bring it into view when a bet is picked.
  const cardRef = useRef<HTMLDivElement>(null);
  const pickKey = pending ? `${pending.expiry}|${pending.level}` : '';
  useEffect(() => {
    if (pickKey && window.innerWidth <= 960) cardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [pickKey]);

  // Selling, per bet.
  const [sells, setSells] = useState<Record<string, Flow>>({});
  const setSell = (id: string, f: Flow) => setSells((s) => ({ ...s, [id]: f }));
  const fillSell = async (pos: Position, quote: RfqQuote) => {
    if (!live) return;
    setSell(pos.id, { kind: 'filling' });
    const fill = await live.trading.rfqExecute(quote);
    if (fill.ok) {
      setSell(pos.id, { kind: 'idle' });
      live.onSoldLive(pos.id, quote, fill);
    } else setSell(pos.id, { kind: 'error', message: `Couldn’t fill: ${fill.error ?? 'rejected'}` });
  };
  const startSell = async (pos: Position) => {
    if (!pos.venue) return onSellPaper(pos.id);
    const why = sellBlocked(pos);
    if (why || !live) return setSell(pos.id, { kind: 'error', message: why ?? 'Connect your account to sell this bet.' });
    const flow = sells[pos.id]?.kind ?? 'idle';
    if (live.trading.info.real && flow !== 'confirm') return setSell(pos.id, { kind: 'confirm' });
    setSell(pos.id, { kind: 'quoting' });
    try {
      const quote = await live.trading.rfqQuote(pos.legs, 'sell');
      if (!quote) return setSell(pos.id, { kind: 'none' });
      const total = -quote.premium - quote.fee;
      if (total >= sellEstimate(pos, markets, now).proceeds - 0.005) await fillSell(pos, quote);
      else setSell(pos.id, { kind: 'worse', quote, total });
    } catch (e) {
      setSell(pos.id, { kind: 'error', message: (e as Error).message });
    }
  };

  const open = bets.filter((b) => b.bet && b.bet.expiry > now);
  const settled = bets.filter((b) => b.bet && b.bet.expiry <= now);
  const value = open.reduce((a, b) => a + sharePrice(b, markets, now) * b.bet!.shares, 0);
  const cost = open.reduce((a, b) => a + b.bet!.entry * b.bet!.shares, 0);
  const busy = buy.kind === 'quoting' || buy.kind === 'filling';

  return (
    <aside className="sidebar easy" aria-label="Predict">
      <div className="panel-body">
        {!pending ? (
          <div className="easy-intro">
            <div className="eyebrow">Predict {asset}</div>
            <h2>Where will {asset} be?</h2>
            <p>
              Tap a box <b className="up">above</b> the price to bet {asset} ends higher than it, or <b className="down">below</b> to bet it ends lower,
              on that box's date.
            </p>
            <p className="fine">
              Each box shows the most a share that pays $1 if you're right should cost: <b>25¢</b> means about a 25% chance, and $10 buys about 40 shares
              (less Derive's fees). When you buy, market makers quote a firm price, usually lower. Further away and sooner is cheaper. Bets start at $10.
            </p>
          </div>
        ) : (
          <div className={`bet-card ${pending.dir}`} ref={cardRef}>
            <div className="bet-head">
              <div className="eyebrow">{expiryLabel(pending.expiry)} · 08:00 UTC</div>
              <button className="ghost" onClick={onCancel} aria-label="Cancel">
                ✕
              </button>
            </div>
            <h2>
              Will {asset} be {pending.dir} ${Math.round(pending.level).toLocaleString('en-US')} on {expiryLabel(pending.expiry)}?
            </h2>
            <div className="bet-price">
              <span className="num">{cents(pending.preview)}</span>
              <span>
                a share at most · fair {cents(pending.price)}, a {fmtChance(pending.price)} chance
                <br />
                each share pays $1 if right
              </span>
            </div>
            <label className="bet-stake">
              <span>Amount</span>
              <div className="stake-input">
                <span>$</span>
                <input type="number" min={minBet} step={1} value={stake} onChange={(e) => setStake(Math.max(0, Number(e.target.value) || 0))} />
              </div>
              <div className="stake-quick">
                {[10, 50, 100].map((v) => (
                  <button key={v} className="ghost" onClick={() => setStake(v)}>
                    ${v}
                  </button>
                ))}
              </div>
            </label>
            {pending.unavailable ? (
              <p className="form-error">{pending.unavailable}. Pick another box.</p>
            ) : tooSmall ? (
              <p className="form-error">
                The minimum bet here is {usd(minBet, 0)}
                {minBet > MIN_BET ? ": Derive's smallest order (0.1 contracts) plus its fee." : ', so the $0.50 Derive fee stays a small part of it.'}
              </p>
            ) : null}
            {size && !tooSmall && !pending.unavailable && size.fees > size.cost * 0.1 && (
              <p className="fine">Derive's fees are up to {Math.round((size.fees / size.cost) * 100)}% of this bet: a $0.50 base fee plus up to 12.5% of the options' price.</p>
            )}
            <dl className="bet-sum">
              <div>
                <dt>Shares</dt>
                <dd className="num">{blocked ? '–' : shares.toFixed(1)}</dd>
              </div>
              <div>
                <dt>Derive fees</dt>
                <dd className="num">{blocked ? '–' : `≤ ${usd(size!.fees, 2)}`}</dd>
              </div>
              <div>
                <dt>If Yes, you get</dt>
                <dd className="num up">{blocked ? '–' : usd(shares, 2)}</dd>
              </div>
              <div>
                <dt>Profit if right</dt>
                <dd className="num up">{blocked ? '–' : `≥ ${signedUsd(shares - size!.cost)}`}</dd>
              </div>
            </dl>
            {live ? (
              <div className="bet-live">
                {live.trading.canTrade === false && <p className="form-error">This session key can't trade: reconnect to create a trading key.</p>}
                {buy.kind === 'confirm' && (
                  <p className="real-note">
                    Real money: spends up to {usd(size?.cost ?? 0, 2)} USDC from your Derive account. Market makers quote a firm price; it buys at once if that's at
                    or under this, and asks you if it's more. Click again to get quotes.
                  </p>
                )}
                {buy.kind === 'none' && <p className="form-error">No market maker quoted this just now. Try again in a moment, or pick another box.</p>}
                {buy.kind === 'error' && <p className="form-error">{buy.message}</p>}
                {buy.kind === 'worse' ? (
                  <>
                    <p className="form-error">
                      The best quote is {usd(buy.total, 2)} for {shares.toFixed(1)} shares ({cents(buy.quote.premium / shares)} a share), above the{' '}
                      {usd(size?.cost ?? 0, 2)} shown.
                    </p>
                    <button className="primary" onClick={() => void fillBuy(buy.quote)}>
                      Buy at {usd(buy.total, 2)}
                    </button>
                    <button
                      className="link"
                      onClick={() => {
                        void live.trading.rfqCancel(buy.quote);
                        worseRef.current = null;
                        setBuy({ kind: 'idle' });
                      }}
                    >
                      Don't buy
                    </button>
                  </>
                ) : (
                  <button
                    className={`primary ${buy.kind === 'confirm' ? 'is-confirm' : ''}`}
                    disabled={blocked || busy || live.trading.canTrade === false}
                    onClick={() => void startBuy()}
                  >
                    {buy.kind === 'quoting'
                      ? 'Getting quotes…'
                      : buy.kind === 'filling'
                        ? 'Buying…'
                        : buy.kind === 'confirm'
                          ? `Confirm: buy for up to ${usd(size?.cost ?? 0, 2)} USDC`
                          : `Buy Yes on ${live.trading.info.name} · up to ${size && !tooSmall ? usd(size.cost, 2) : usd(stake, 0)}`}
                  </button>
                )}
                <button className="link" disabled={blocked || busy} onClick={() => onBuy(pending, stake)}>
                  Paper bet instead
                </button>
              </div>
            ) : (
              <>
                <button className="primary" disabled={blocked} onClick={() => onBuy(pending, stake)}>
                  Buy Yes · {size && !tooSmall ? usd(size.cost, 2) : usd(stake, 0)}
                  {venue.kind === 'connect' ? ' (paper)' : ''}
                </button>
                {venue.kind === 'connect' && (
                  <button className="link" onClick={venue.onConnect}>
                    Connect your {venue.info.name} account to bet for real ({venue.info.real ? 'USDC' : 'test funds'})
                  </button>
                )}
              </>
            )}
            <button className={`ghost underlying-btn ${showLegs ? 'is-on' : ''}`} onClick={() => setShowLegs((v) => !v)} aria-expanded={showLegs}>
              {showLegs ? 'Hide' : 'Show'} underlying positions
            </button>
            {showLegs && (
              <div className="underlying">
                <p className="fine">
                  This bet is a {pending.dir === 'above' ? 'call' : 'put'} spread on Derive, bought as one package by RFQ. Prices are the preview's: at most this
                  for the option bought, at least this for the one sold.
                </p>
                <table>
                  <tbody>
                    {underlying.map((u) => (
                      <tr key={u.instrument}>
                        <td className={u.buy ? 'long' : 'short'}>{u.buy ? 'Buy' : 'Sell'}</td>
                        <td className="num">
                          {u.amount} × {u.instrument}
                        </td>
                        <td className="num">{usd(u.price)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="fine">{u0Text}</p>
              </div>
            )}
            <p className="fine">
              {(() => {
                const [win, lose] = pending.dir === 'above' ? [pending.hi, pending.lo] : [pending.lo, pending.hi];
                const [winWord, loseWord] = pending.dir === 'above' ? ['above', 'below'] : ['below', 'above'];
                return `Pays $1 per share if ${asset} settles ${winWord} $${win.toLocaleString('en-US')} on ${expiryLabel(pending.expiry)}, nothing ${loseWord} $${lose.toLocaleString('en-US')}, and part-way in between. Built from a ${pending.lo}/${pending.hi} ${pending.dir === 'above' ? 'call' : 'put'} spread; you can sell any time before. ${live ? `On ${live.trading.info.name}${live.trading.info.real ? ' with real USDC' : ''}: market makers quote both options as one package, which fills whole or not at all.` : 'Paper trade, at the price shown.'}`;
              })()}
            </p>
          </div>
        )}

        <section className="bets">
          <div className="section-head">
            <div className="eyebrow">Your bets</div>
            {open.length > 0 && (
              <span className={`num ${pnlClass(value - cost)}`}>
                {usd(value)} · {signedUsd(value - cost)}
              </span>
            )}
          </div>
          {open.length === 0 && settled.length === 0 && <p className="fine">No bets yet.</p>}
          <ul className="bet-list">
            {[...open, ...settled].map((b) => {
              const bet = b.bet!;
              const done = bet.expiry <= now;
              const px = done ? sharePayoff(bet, markets[b.asset].spot) : sharePrice(b, markets, now);
              const pnl = (px - bet.entry) * bet.shares;
              const est = done ? null : sellEstimate(b, markets, now);
              const flow = sells[b.id] ?? { kind: 'idle' };
              return (
                <li key={b.id} className={bet.dir}>
                  <div className="bet-row">
                    <b>
                      {betQuestion(b.asset, bet.dir, bet.level)} · {expiryLabel(bet.expiry)}
                      {b.venue && <span className={`venue-tag ${b.venue === 'derive-mainnet' ? 'is-real' : ''}`}>{b.venue === 'derive-mainnet' ? 'Derive' : 'Testnet'}</span>}
                    </b>
                    <span className={`num ${pnlClass(pnl)}`}>{signedUsd(pnl)}</span>
                  </div>
                  <div className="bet-row fine">
                    <span className="num">
                      {usd(bet.entry * bet.shares)} in · {done ? 'settled' : 'now'} {usd(px * bet.shares)} · wins {usd(bet.shares)}
                    </span>
                    {est &&
                      (flow.kind === 'worse' ? (
                        <span className="sell-ask">
                          <button className="link is-confirm" onClick={() => void fillSell(b, flow.quote)}>
                            Sell for {usd(flow.total)}
                          </button>
                          <button
                            className="link"
                            onClick={() => {
                              if (live) void live.trading.rfqCancel(flow.quote);
                              setSell(b.id, { kind: 'idle' });
                            }}
                          >
                            Keep
                          </button>
                        </span>
                      ) : (
                        <button
                          className={`link ${flow.kind === 'confirm' ? 'is-confirm' : ''}`}
                          disabled={flow.kind === 'quoting' || flow.kind === 'filling'}
                          onClick={() => void startSell(b)}
                        >
                          {flow.kind === 'quoting'
                            ? 'Getting quotes…'
                            : flow.kind === 'filling'
                              ? 'Selling…'
                              : flow.kind === 'confirm'
                                ? `Confirm: sell for at least ${usd(est.proceeds)}`
                                : `Sell ${b.venue ? '≥ ' : ''}${usd(est.proceeds)}`}
                        </button>
                      ))}
                  </div>
                  {flow.kind === 'worse' && <p className="fine">The best bid is {usd(flow.total)} after fees, under the {usd(est?.proceeds ?? 0)} shown.</p>}
                  {flow.kind === 'none' && <p className="fine">No market maker bid for it just now. Try again in a moment.</p>}
                  {flow.kind === 'error' && <p className="form-error">{flow.message}</p>}
                  <div className="bet-bar" aria-hidden="true">
                    <div style={{ width: `${Math.round(px * 100)}%` }} />
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      </div>
    </aside>
  );
}

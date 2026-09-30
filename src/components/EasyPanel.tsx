import { useEffect, useRef, useState } from 'react';
import type { OrderPreview } from '../account/derive';
import type { LegOrder } from '../account/orders';
import type { Trading } from './DeriveReview';
import { betCost, betLegs, betQuestion, fmtCents, fmtChance, MIN_BET, minStake, sharePayoff, sizeBet, type BetQuote } from '../lib/binary';
import { instrumentName } from '../account/orders';
import { signedUsd, usd } from '../lib/format';
import { expiryLabel, type Asset } from '../lib/market';
import { buildModel, type Position } from '../lib/strategy';
import type { Market } from '../data/types';

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
  onBuy: (q: BetQuote, stake: number) => void;
  bets: Position[];
  onSell: (id: string) => void;
  /** Paper bets, a prompt to connect (testnet, no account), or real orders on Derive testnet. */
  venue: { kind: 'paper' } | { kind: 'connect'; onConnect: () => void } | { kind: 'live'; trading: Trading; onBuyLive: (q: BetQuote, orders: LegOrder[], estFees: number) => Promise<void> };
}

/** Exchange errors a bettor can act on, in plain words. */
function friendlyError(msg: string, q: BetQuote): string {
  if (/minimum size is ([\d.]+)/i.test(msg)) {
    const min = Number(/minimum size is ([\d.]+)/i.exec(msg)![1]);
    const shares = min * (q.hi - q.lo);
    return `Too small for Derive: the minimum here is ${shares.toFixed(0)} shares, about $${Math.ceil(shares * q.price)} at the fair price. Increase the amount.`;
  }
  if (/zero liquidity|no liquidity/i.test(msg)) return 'Nobody is quoting one of these options on testnet right now. Try a nearer date or a price closer to today’s.';
  return msg;
}

type LiveQuote = { key: string; orders: LegOrder[]; previews: OrderPreview[] } | { key: string; error: string };

/** Current price of one share of a bet: the legs' value now, per share. */
export function sharePrice(pos: Position, markets: Record<Asset, Market>, now: number): number {
  const m = buildModel(pos.legs, markets[pos.asset], now);
  return pos.bet ? Math.min(1, Math.max(0, m.value / pos.bet.shares)) : 0;
}

export function EasyPanel({ asset, now, markets, pending, stake, onStake: setStake, onCancel, onBuy, bets, onSell, venue }: Props) {
  const spot = pending ? markets[pending.asset].spot : 0;
  // What the stake buys at the quoted prices, Derive's fees included, on Derive's size grid.
  const size = pending ? sizeBet(pending, stake, spot) : null;
  const minBet = pending ? minStake(pending, spot) : 0;
  const tooSmall = !!pending && stake < minBet;
  const fairShares = size?.shares ?? 0;

  // Live (testnet): ask Derive for a dry run of both legs, so the card shows the real cost.
  const live = venue.kind === 'live' ? venue : null;
  const quoteKey = live && pending && !pending.unavailable && !tooSmall && size ? `${pending.asset}|${pending.expiry}|${pending.dir}|${pending.lo}|${pending.hi}|${stake}` : '';
  const [liveQuote, setLiveQuote] = useState<LiveQuote | null>(null);
  const [sending, setSending] = useState(false);
  useEffect(() => {
    if (!quoteKey || !live || !pending) return;
    let alive = true;
    const gapNow = pending.hi - pending.lo;
    // Quote at the fair price first, then resize once at Derive's real price (spread and fees
    // included), so what you pay is the amount you entered.
    const quote = async () => {
      const first = await live.trading.prepare(betLegs(pending, fairShares), 'market');
      const c = betCost(first.orders.map((o, i) => ({ direction: o.direction, amount: first.previews[i].fillAmount, price: first.previews[i].fillPrice, fee: first.previews[i].fee })), gapNow);
      if (!(c.perShare > 0) || Math.abs(c.cost - stake) < stake * 0.02) return first;
      return live.trading.prepare(betLegs(pending, stake / c.perShare), 'market');
    };
    const t = setTimeout(() => {
      quote()
        .then((r) => alive && setLiveQuote({ key: quoteKey, ...r }))
        .catch((e) => alive && setLiveQuote({ key: quoteKey, error: friendlyError((e as Error).message, pending) }));
    }, 350);
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quoteKey]);
  const lq = liveQuote && liveQuote.key === quoteKey ? liveQuote : null;
  const gap = pending ? pending.hi - pending.lo : 1;
  const liveOk = lq && 'orders' in lq ? lq : null;
  const liveShares = liveOk ? Math.min(...liveOk.orders.map((o) => Number(o.amount))) * gap : 0;
  const liveCost = liveOk
    ? betCost(
        liveOk.orders.map((o, i) => ({ direction: o.direction, amount: liveOk.previews[i].fillAmount, price: liveOk.previews[i].fillPrice, fee: liveOk.previews[i].fee })),
        gap,
      )
    : null;
  const liveInvalid = liveOk?.previews.find((p) => !p.valid)?.reason ?? null;
  const partial = liveCost && liveCost.shares < liveShares - 1e-9;
  const shares = live ? liveShares : fairShares;

  // The options behind the bet: the exact orders when live, else the legs at their marks.
  const [showLegs, setShowLegs] = useState(false);
  const underlying = (() => {
    if (!pending) return [];
    if (liveOk)
      return liveOk.orders.map((o, i) => ({
        instrument: o.instrument,
        buy: o.direction === 'buy',
        amount: o.amount,
        price: liveOk.previews[i].fillAmount > 0 ? liveOk.previews[i].fillPrice : Number(o.limitPrice),
      }));
    const legs = betLegs(pending, fairShares);
    const marks = buildModel(legs, markets[pending.asset], now).marks;
    return legs.map((l, i) => ({ instrument: instrumentName(l), buy: l.side > 0, amount: l.qty.toFixed(2), price: marks[i] }));
  })();
  const u0Text = pending
    ? `Each contract is on 1 ${pending.asset}. The two strikes are $${(pending.hi - pending.lo).toLocaleString('en-US')} apart, so ${underlying[0]?.amount ?? '–'} contracts pay up to $${shares.toFixed(2)}: $1 for each of your ${shares.toFixed(1)} shares.`
    : '';
  // On narrow screens the card sits below the chart: bring it into view when a bet is picked.
  const cardRef = useRef<HTMLDivElement>(null);
  const pickKey = pending ? `${pending.expiry}|${pending.level}` : '';
  useEffect(() => {
    if (pickKey && window.innerWidth <= 960) cardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [pickKey]);
  const open = bets.filter((b) => b.bet && b.bet.expiry > now);
  const settled = bets.filter((b) => b.bet && b.bet.expiry <= now);
  const value = open.reduce((a, b) => a + sharePrice(b, markets, now) * b.bet!.shares, 0);
  const cost = open.reduce((a, b) => a + b.bet!.entry * b.bet!.shares, 0);

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
              Each box shows the price of a share that pays $1 if you're right: <b>25¢</b> means the market gives it a 25% chance, and $10 buys 40 shares
              (less Derive's fees). Further away and sooner is cheaper. Faint boxes can't be traded right now. Bets start at $10.
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
              <span className="num">{cents(pending.price)}</span>
              <span>
                a share · {fmtChance(pending.price)} chance
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
                {minBet > MIN_BET
                  ? ": Derive's smallest order (0.1 contracts) plus its $0.50 fee on each of the two options."
                  : ', so the $0.50 Derive fee on each of the two options stays a small part of it.'}
              </p>
            ) : null}
            {!live && size && !tooSmall && !pending.unavailable && size.fees > size.cost * 0.1 && (
              <p className="fine">
                Derive's fees are {Math.round((size.fees / size.cost) * 100)}% of this bet: each option pays a $0.50 base fee plus up to 12.5% of its price.
              </p>
            )}
            <dl className="bet-sum">
              <div>
                <dt>Shares</dt>
                <dd className="num">{tooSmall || pending.unavailable ? '–' : shares.toFixed(1)}</dd>
              </div>
              {!live && (
                <div>
                  <dt>Derive fees</dt>
                  <dd className="num">{size && !tooSmall ? usd(size.fees, 2) : '–'}</dd>
                </div>
              )}
              <div>
                <dt>If Yes, you get</dt>
                <dd className="num up">{tooSmall || pending.unavailable ? '–' : usd(shares, 2)}</dd>
              </div>
              <div>
                <dt>Profit if right</dt>
                <dd className="num up">{tooSmall || pending.unavailable ? '–' : signedUsd(shares - (live ? (liveCost?.cost ?? 0) : (size?.cost ?? 0)))}</dd>
              </div>
            </dl>
            {live ? (
              <div className="bet-live">
                {!lq ? (
                  <p className="fine">Checking Derive testnet…</p>
                ) : 'error' in lq ? (
                  <p className="form-error">{lq.error}</p>
                ) : (
                  <div className="live-cost">
                    <div>
                      <span>On Derive testnet</span>
                      <b className="num">{liveCost && liveCost.shares > 0 ? cents(liveCost.perShare) : '–'}</b>
                      <span className="fine">per share · fair {cents(pending.price)}</span>
                    </div>
                    <div>
                      <span>Cost now</span>
                      <b className="num">{liveCost ? usd(liveCost.cost) : '–'}</b>
                      <span className="fine">incl. {liveCost ? usd(liveCost.fees) : '–'} fees</span>
                    </div>
                  </div>
                )}
                {liveInvalid && <p className="form-error">{liveInvalid}</p>}
                {liveCost && liveCost.perShare >= 1 && (
                  <p className="form-error">At this price a share costs more than the $1 it can pay: don't buy.</p>
                )}
                {liveCost && liveCost.perShare < 1 && liveCost.perShare - pending.price > Math.max(0.1, pending.price * 0.5) && (
                  <p className="form-error">
                    Thin market: you'd pay {cents(liveCost.perShare)} for a {fmtChance(pending.price)} chance. Try a nearer date or price, or bet on paper.
                  </p>
                )}
                {partial && !liveInvalid && (
                  <p className="fine">Only {liveCost!.shares.toFixed(1)} shares can fill right now; the rest of the order is cancelled.</p>
                )}
                {live.trading.canTrade === false && <p className="form-error">This session key can't trade: reconnect to create a trading key.</p>}
                <button
                  className="primary"
                  disabled={!liveOk || !!liveInvalid || !liveCost || liveCost.shares <= 0 || liveCost.perShare >= 1 || sending || live.trading.canTrade === false}
                  onClick={async () => {
                    if (!liveOk) return;
                    setSending(true);
                    try {
                      await live.onBuyLive(pending, liveOk.orders, liveCost?.fees ?? 0);
                    } finally {
                      setSending(false);
                    }
                  }}
                >
                  {sending ? 'Sending…' : `Buy Yes on Derive · ${liveCost ? usd(liveCost.cost, 2) : usd(stake, 0)}`}
                </button>
                <button className="link" disabled={!size || tooSmall || !!pending.unavailable} onClick={() => onBuy(pending, stake)}>
                  Paper bet instead
                </button>
              </div>
            ) : (
              <>
                <button className="primary" disabled={!size || tooSmall || !!pending.unavailable} onClick={() => onBuy(pending, stake)}>
                  Buy Yes · {size && !tooSmall ? usd(size.cost, 2) : usd(stake, 0)}
                  {venue.kind === 'connect' ? ' (paper)' : ''}
                </button>
                {venue.kind === 'connect' && (
                  <button className="link" onClick={venue.onConnect}>
                    Connect your Derive testnet account to bet for real (test funds)
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
                  This bet is a {pending.dir === 'above' ? 'call' : 'put'} spread on Derive: {live ? 'these orders are sent' : 'these positions are opened (paper)'}{' '}
                  when you buy.
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
                <p className="fine">
                  {u0Text}
                </p>
              </div>
            )}
            <p className="fine">
              {(() => {
                const [win, lose] = pending.dir === 'above' ? [pending.hi, pending.lo] : [pending.lo, pending.hi];
                const [winWord, loseWord] = pending.dir === 'above' ? ['above', 'below'] : ['below', 'above'];
                return `Pays $1 per share if ${asset} settles ${winWord} $${win.toLocaleString('en-US')} on ${expiryLabel(pending.expiry)}, nothing ${loseWord} $${lose.toLocaleString('en-US')}, and part-way in between. Built from a ${pending.lo}/${pending.hi} ${pending.dir === 'above' ? 'call' : 'put'} spread; you can sell any time before. ${live ? `On Derive testnet: two orders sent together, the buy first, each filling now within 3% of the best price or cancelled.` : 'Paper trade.'}`;
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
              return (
                <li key={b.id} className={bet.dir}>
                  <div className="bet-row">
                    <b>
                      {betQuestion(b.asset, bet.dir, bet.level)} · {expiryLabel(bet.expiry)}
                      {b.venue === 'derive-testnet' && <span className="venue-tag">Derive</span>}
                    </b>
                    <span className={`num ${pnlClass(pnl)}`}>{signedUsd(pnl)}</span>
                  </div>
                  <div className="bet-row fine">
                    <span className="num">
                      {usd(bet.entry * bet.shares)} in · {done ? 'settled' : 'now'} {usd(px * bet.shares)} · wins {usd(bet.shares)}
                    </span>
                    {!done && (
                      <button className="link" onClick={() => onSell(b.id)}>
                        Sell {usd(px * bet.shares)}
                      </button>
                    )}
                  </div>
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

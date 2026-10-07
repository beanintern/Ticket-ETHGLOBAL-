import { useEffect, useState } from 'react';
import type { OrderPreview, OrderResult } from '../account/derive';
import { BUILDER, SLIPPAGE, type LegOrder, type OrderMode } from '../account/orders';
import { usd } from '../lib/format';
import type { Leg } from '../lib/strategy';
import type { NetInfo } from '../account/network';

/** What the builder needs to trade on Derive; App provides it while an account is connected. */
export interface Trading {
  /** Which Derive the account is on: mainnet orders spend real USDC. */
  info: NetInfo;
  /** False when the session key's scopes don't include orderbook trading; null if unknown. */
  canTrade: boolean | null;
  subaccountId: number | null;
  prepare: (legs: Leg[], mode: OrderMode) => Promise<{ orders: LegOrder[]; previews: OrderPreview[] }>;
  place: (orders: LegOrder[], mode: OrderMode) => Promise<OrderResult[]>;
}

type Prepared = { orders: LegOrder[]; previews: OrderPreview[] };

/** Order review for real orders (mainnet or testnet): one signed order per leg, previewed by Derive first. */
export function DeriveReview({ legs, trading, onBack, onPaper, onDone }: { legs: Leg[]; trading: Trading; onBack: () => void; onPaper: () => void; onDone: (r: OrderResult[]) => void }) {
  const [mode, setMode] = useState<OrderMode>('market');
  const [prep, setPrep] = useState<Prepared | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const legKey = legs.map((l) => `${l.side}${l.qty}${l.type}${l.strike}@${l.expiry}`).join('|');

  useEffect(() => {
    let live = true;
    setPrep(null);
    setError(null);
    trading
      .prepare(legs, mode)
      .then((p) => live && setPrep(p))
      .catch((e) => live && setError((e as Error).message));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [legKey, mode, trading.subaccountId]);

  const invalid = prep?.previews.some((p) => !p.valid) ?? false;
  // Market: what Derive expects to fill now. Limit: the full order at its limit.
  const cost = prep
    ? prep.orders.reduce((a, o, i) => {
        const p = prep.previews[i];
        const [px, amt] = mode === 'market' ? [p.fillPrice, p.fillAmount] : [Number(o.limitPrice), Number(o.amount)];
        return a + (o.direction === 'buy' ? 1 : -1) * px * amt;
      }, 0)
    : 0;
  const fees = prep ? prep.previews.reduce((a, p) => a + p.fee, 0) : 0;
  const contracts = prep ? prep.orders.reduce((a, o) => a + Number(o.amount), 0) : 0;
  const blocked = trading.canTrade === false ? 'This session key is read-only: give it a trade scope (trade:orderbook) on Derive to place orders.' : null;

  const send = async () => {
    if (!prep) return;
    setSending(true);
    try {
      onDone(await trading.place(prep.orders, mode));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="review">
      <div className="review-head">
        <div className="eyebrow">
          {trading.info.name} · #{trading.subaccountId}
          {trading.info.real && <span className="real-tag">Real money</span>}
        </div>
        <div className="seg" role="group" aria-label="Order type">
          <button className={mode === 'market' ? 'is-active' : ''} onClick={() => setMode('market')} title={`Fill now against the book, up to ${SLIPPAGE * 100}% past the best price`}>
            Market
          </button>
          <button className={mode === 'limit' ? 'is-active' : ''} onClick={() => setMode('limit')} title="Rest on the book at the mark price until filled or cancelled">
            Limit at mark
          </button>
        </div>
      </div>
      {error ? (
        <p className="form-error">{error}</p>
      ) : !prep ? (
        <p className="fine">Checking with Derive…</p>
      ) : (
        <>
          <table>
            <tbody>
              {prep.orders.map((o, i) => {
                const p = prep.previews[i];
                return (
                  <tr key={o.legId} title={p.valid ? undefined : (p.reason ?? 'Derive would reject this order')}>
                    <td className={o.direction === 'buy' ? 'long' : 'short'}>{o.direction === 'buy' ? 'Buy' : 'Sell'}</td>
                    <td>
                      {o.amount} × {o.instrument}
                      {!p.valid && <div className="form-error">{p.reason ?? 'Derive would reject this order'}</div>}
                      {p.valid && mode === 'market' && p.fillAmount < Number(o.amount) && (
                        <div className="fine">{p.fillAmount > 0 ? `Only ${p.fillAmount} available now: the rest is cancelled` : 'Nothing to fill against right now'}</div>
                      )}
                    </td>
                    <td className="num">
                      {mode === 'market' && p.valid && p.fillAmount > 0 ? usd(p.fillPrice) : usd(Number(o.limitPrice))}
                      <div className="fine">limit {o.limitPrice}</div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="review-total">
            <span>{cost >= 0 ? 'You pay' : 'You receive'}</span>
            <b className="num">{usd(Math.abs(cost))}</b>
          </div>
          <div className="review-total sub">
            <span>Fees{BUILDER.code && BUILDER.extraFee ? `, incl. builder ${usd(BUILDER.extraFee * contracts)}` : ''}</span>
            <span className="num">{usd(fees)}</span>
          </div>
        </>
      )}
      {blocked && <p className="form-error">{blocked}</p>}
      <p className="fine">
        {mode === 'market'
          ? 'Sent as one immediate-or-cancel order per leg, signed with your session key. If Derive rejects one, the rest aren’t sent.'
          : 'Sent as one limit order per leg at mark, resting until filled; cancel from the Positions tab.'}
        {BUILDER.code ? ` Builder code ${BUILDER.code} attached.` : ''}
      </p>
      {trading.info.real && <p className="real-note">These orders trade real USDC from your Derive account. Fills can’t be undone.</p>}
      <div className="review-actions">
        <button className="ghost" onClick={onBack}>
          Back
        </button>
        <button className="primary" disabled={!prep || invalid || sending || !!blocked} onClick={send}>
          {sending ? 'Sending…' : trading.info.real ? `Place real order${cost > 0 ? ` · ${usd(cost + fees)}` : ''}` : 'Place on Derive testnet'}
        </button>
      </div>
      <button className="link" onClick={onPaper}>
        Paper trade instead
      </button>
    </div>
  );
}

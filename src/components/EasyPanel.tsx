import { useEffect, useRef } from 'react';
import { betQuestion, sharePayoff, type BetQuote } from '../lib/binary';
import { signedUsd, usd } from '../lib/format';
import { expiryLabel, type Asset } from '../lib/market';
import { buildModel, type Position } from '../lib/strategy';
import type { Market } from '../data/types';

const cents = (p: number) => `${Math.round(p * 100)}¢`;
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
}

/** Current price of one share of a bet: the legs' value now, per share. */
export function sharePrice(pos: Position, markets: Record<Asset, Market>, now: number): number {
  const m = buildModel(pos.legs, markets[pos.asset], now);
  return pos.bet ? Math.min(1, Math.max(0, m.value / pos.bet.shares)) : 0;
}

export function EasyPanel({ asset, now, markets, pending, stake, onStake: setStake, onCancel, onBuy, bets, onSell }: Props) {
  const shares = pending ? stake / pending.price : 0;
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
              Tap the chart <b className="up">above</b> the price to bet {asset} ends higher, or <b className="down">below</b> to bet it ends lower,
              on any listed date.
            </p>
            <p className="fine">
              Each share costs its chance of happening, in cents, and pays <b>$1</b> if you're right. Brighter areas on the chart are more likely.
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
                Yes · {Math.round(pending.price * 100)}% chance
                <br />
                pays $1 per share
              </span>
            </div>
            <label className="bet-stake">
              <span>Amount</span>
              <div className="stake-input">
                <span>$</span>
                <input type="number" min={1} step={1} value={stake} onChange={(e) => setStake(Math.max(0, Number(e.target.value) || 0))} />
              </div>
              <div className="stake-quick">
                {[10, 50, 100].map((v) => (
                  <button key={v} className="ghost" onClick={() => setStake(v)}>
                    ${v}
                  </button>
                ))}
              </div>
            </label>
            <dl className="bet-sum">
              <div>
                <dt>Shares</dt>
                <dd className="num">{shares.toFixed(1)}</dd>
              </div>
              <div>
                <dt>If Yes, you get</dt>
                <dd className="num up">{usd(shares, 2)}</dd>
              </div>
              <div>
                <dt>Profit if right</dt>
                <dd className="num up">{signedUsd(shares - stake)}</dd>
              </div>
            </dl>
            <button className="primary" disabled={!(stake > 0)} onClick={() => onBuy(pending, stake)}>
              Buy Yes · {usd(stake, 0)}
            </button>
            <p className="fine">
              {(() => {
                const [win, lose] = pending.dir === 'above' ? [pending.hi, pending.lo] : [pending.lo, pending.hi];
                const [winWord, loseWord] = pending.dir === 'above' ? ['above', 'below'] : ['below', 'above'];
                return `Pays $1 per share if ${asset} settles ${winWord} $${win.toLocaleString('en-US')} on ${expiryLabel(pending.expiry)}, nothing ${loseWord} $${lose.toLocaleString('en-US')}, and part-way in between. Built from a ${pending.lo}/${pending.hi} ${pending.dir === 'above' ? 'call' : 'put'} spread; you can sell any time before. Paper trade.`;
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
                    </b>
                    <span className={`num ${pnlClass(pnl)}`}>{signedUsd(pnl)}</span>
                  </div>
                  <div className="bet-row fine">
                    <span className="num">
                      {bet.shares.toFixed(1)} shares · {cents(bet.entry)} → {done ? `settled ${cents(px)}` : cents(px)}
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

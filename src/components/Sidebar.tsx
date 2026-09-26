import { useMemo, useState } from 'react';
import type { Focus, Preset } from '../App';
import { compactUsd, price as fmtPrice, signed, signedUsd, usd } from '../lib/format';
import { MARKETS, expiryLabel, listExpiries, strikeStepFor, type Asset, type Candle, type MarketSpec } from '../lib/market';
import {
  buildModel,
  daysLeft,
  describe,
  summarize,
  type ClosedPosition,
  type Leg,
  type Model,
  type Position,
} from '../lib/strategy';

interface Props {
  tab: 'build' | 'positions';
  onTab: (t: 'build' | 'positions') => void;
  spec: MarketSpec;
  spot: number;
  now: number;
  feeds: Record<Asset, { candles: Candle[]; spot: number }>;
  builderLegs: Leg[];
  builderModel: Model;
  selectedLegId: string | null;
  onSelectLeg: (id: string | null) => void;
  onUpdateLeg: (id: string, patch: Partial<Leg>) => void;
  onRemoveLeg: (id: string) => void;
  onClear: () => void;
  onPreset: (p: Preset) => void;
  onPlace: () => void;
  positions: Position[];
  closed: ClosedPosition[];
  focus: Focus;
  onFocus: (id: string) => void;
  onClosePosition: (id: string) => void;
}

const PRESETS: [Preset, string][] = [
  ['callSpread', 'Call spread'],
  ['putSpread', 'Put spread'],
  ['straddle', 'Straddle'],
  ['strangle', 'Strangle'],
  ['condor', 'Iron condor'],
  ['chaos', 'Chaos'],
];

const pnlClass = (v: number) => (v > 0.005 ? 'up' : v < -0.005 ? 'down' : '');

export function Sidebar(props: Props) {
  const { tab, onTab, positions } = props;
  return (
    <aside className="sidebar" aria-label="Position">
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'build'} className={tab === 'build' ? 'is-active' : ''} onClick={() => onTab('build')}>
          Build
        </button>
        <button role="tab" aria-selected={tab === 'positions'} className={tab === 'positions' ? 'is-active' : ''} onClick={() => onTab('positions')}>
          Positions <span className="count">{positions.length}</span>
        </button>
      </div>
      {tab === 'build' ? <Builder {...props} /> : <Positions {...props} />}
    </aside>
  );
}

function Builder({ spec, spot, now, builderLegs: legs, builderModel: model, selectedLegId, onSelectLeg, onUpdateLeg, onRemoveLeg, onClear, onPreset, onPlace }: Props) {
  const [reviewing, setReviewing] = useState(false);
  const summary = useMemo(() => summarize(model, spec, spot, now), [model, spec, spot, now]);
  const expiries = useMemo(() => listExpiries(now), [Math.floor(now / 3600e3)]); // eslint-disable-line react-hooks/exhaustive-deps
  const debit = model.cost;
  const ccy = (v: number) => (Math.abs(v) >= 1000 ? usd(v, 0) : usd(v));

  return (
    <div className="panel-body">
      <div className="ticket-head">
        <div>
          <div className="eyebrow">{spec.asset} options · priced at mid</div>
          <h2>{describe(legs)}</h2>
        </div>
        {legs.length > 0 && (
          <button className="link" onClick={onClear}>
            Clear
          </button>
        )}
      </div>

      <div className="presets" aria-label="Strategy presets">
        {PRESETS.map(([k, label]) => (
          <button key={k} className="chip" onClick={() => onPreset(k)}>
            {label}
          </button>
        ))}
      </div>

      {!summary ? (
        <div className="empty">
          <p>Pick <strong>Buy Call</strong> in the toolbar, then click on the chart at the date and price you think {spec.asset} will be above.</p>
          <p>Add more legs to shape the payoff. Green is where you make money, red is where you lose it.</p>
        </div>
      ) : (
        <>
          <dl className="summary">
            <div>
              <dt>{debit >= 0 ? 'Net debit' : 'Net credit'}</dt>
              <dd className="num">{ccy(debit)}</dd>
            </div>
            <div>
              <dt>Chance of profit</dt>
              <dd className="num">{(summary.pop * 100).toFixed(0)}%</dd>
            </div>
            <div>
              <dt>Max profit</dt>
              <dd className="num up">{summary.unlimitedProfit ? 'Unlimited' : ccy(summary.maxProfit)}</dd>
            </div>
            <div>
              <dt>Max loss</dt>
              <dd className="num down">{summary.unlimitedLoss ? 'Unlimited' : ccy(Math.min(0, summary.maxLoss))}</dd>
            </div>
            <div className="wide">
              <dt>Break-even at {expiryLabel(summary.horizon)}</dt>
              <dd className="num">
                {summary.breakevens.length ? summary.breakevens.map((b) => fmtPrice(b, spec.priceDecimals > 0 ? 1 : 0)).join('  ·  ') : 'None'}
              </dd>
            </div>
          </dl>

          <div className="greeks" aria-label="Greeks">
            <div>
              <span>Δ</span>
              <b className="num">{signed(summary.greeks.delta, 3)}</b>
            </div>
            <div>
              <span>Γ</span>
              <b className="num">{signed(summary.greeks.gamma * spot * 0.01, 3)}</b>
            </div>
            <div>
              <span>Θ/day</span>
              <b className={`num ${pnlClass(summary.greeks.theta)}`}>{signedUsd(summary.greeks.theta)}</b>
            </div>
            <div>
              <span>Vega</span>
              <b className="num">{signedUsd(summary.greeks.vega)}</b>
            </div>
          </div>

          <ol className="legs">
            {legs.map((l, i) => {
              const step = strikeStepFor(spec, l.expiry, now);
              return (
                <li key={l.id} className={`leg ${l.id === selectedLegId ? 'is-selected' : ''}`} onClick={() => onSelectLeg(l.id)}>
                  <div className="leg-row">
                    <button
                      className={`side side-${l.side > 0 ? 'long' : 'short'}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onUpdateLeg(l.id, { side: l.side > 0 ? -1 : 1 });
                      }}
                      title="Flip buy / sell"
                    >
                      {l.side > 0 ? 'Buy' : 'Sell'}
                    </button>
                    <button
                      className="type"
                      onClick={(e) => {
                        e.stopPropagation();
                        onUpdateLeg(l.id, { type: l.type === 'C' ? 'P' : 'C' });
                      }}
                      title="Switch call / put"
                    >
                      {l.type === 'C' ? 'Call' : 'Put'}
                    </button>
                    <div className="stepper" aria-label="Strike">
                      <button onClick={(e) => (e.stopPropagation(), onUpdateLeg(l.id, { strike: Math.max(step, l.strike - step) }))} aria-label="Lower strike">
                        −
                      </button>
                      <span className="num">{fmtPrice(l.strike, 0)}</span>
                      <button onClick={(e) => (e.stopPropagation(), onUpdateLeg(l.id, { strike: l.strike + step }))} aria-label="Raise strike">
                        +
                      </button>
                    </div>
                    <button
                      className="remove"
                      onClick={(e) => {
                        e.stopPropagation();
                        onRemoveLeg(l.id);
                      }}
                      aria-label="Remove leg"
                    >
                      ✕
                    </button>
                  </div>
                  <div className="leg-row leg-meta">
                    <select
                      id={`exp-${l.id}`}
                      value={l.expiry}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => onUpdateLeg(l.id, { expiry: Number(e.target.value) })}
                      aria-label="Expiry"
                    >
                      {expiries.map((e) => (
                        <option key={e.ts} value={e.ts}>
                          {e.label} · {e.kind}
                        </option>
                      ))}
                    </select>
                    <div className="stepper small" aria-label="Contracts">
                      <button onClick={(e) => (e.stopPropagation(), onUpdateLeg(l.id, { qty: Math.max(1, l.qty - 1) }))} aria-label="Fewer contracts">
                        −
                      </button>
                      <span className="num">×{l.qty}</span>
                      <button onClick={(e) => (e.stopPropagation(), onUpdateLeg(l.id, { qty: l.qty + 1 }))} aria-label="More contracts">
                        +
                      </button>
                    </div>
                    <span className="mark num" title="Mark price per contract · implied vol">
                      {compactUsd(model.marks[i])} <em>{(model.ivs[i] * 100).toFixed(0)}%</em>
                    </span>
                  </div>
                </li>
              );
            })}
          </ol>

          <div className="order">
            {!reviewing ? (
              <button className="primary" onClick={() => setReviewing(true)}>
                Review order
              </button>
            ) : (
              <div className="review">
                <div className="eyebrow">Order preview · limit at mid</div>
                <table>
                  <tbody>
                    {legs.map((l, i) => (
                      <tr key={l.id}>
                        <td className={l.side > 0 ? 'long' : 'short'}>{l.side > 0 ? 'Buy' : 'Sell'}</td>
                        <td>
                          {l.qty} × {spec.asset}-{expiryLabel(l.expiry).replace(' ', '')}-{l.strike}-{l.type}
                        </td>
                        <td className="num">{usd(model.marks[i])}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="review-total">
                  <span>{debit >= 0 ? 'You pay' : 'You receive'}</span>
                  <b className="num">{usd(debit)}</b>
                </div>
                <p className="fine">
                  Paper trade. When Derive is connected this submits one signed RFQ for all legs with your builder code attached.
                </p>
                <div className="review-actions">
                  <button className="ghost" onClick={() => setReviewing(false)}>
                    Back
                  </button>
                  <button
                    className="primary"
                    onClick={() => {
                      setReviewing(false);
                      onPlace();
                    }}
                  >
                    Place paper order
                  </button>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const W = 120;
  const H = 34;
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  const span = max - min || 1;
  const x = (i: number) => (i / (values.length - 1)) * W;
  const y = (v: number) => H - 2 - ((v - min) / span) * (H - 4);
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const last = values[values.length - 1];
  const cls = last >= 0 ? 'up' : 'down';
  return (
    <svg className={`spark ${cls}`} viewBox={`0 0 ${W} ${H}`} width={W} height={H} aria-hidden="true">
      <line x1="0" x2={W} y1={y(0)} y2={y(0)} className="spark-zero" />
      <path d={`${d}L${W},${y(0)}L0,${y(0)}Z`} className="spark-area" />
      <path d={d} className="spark-line" />
      <circle cx={W} cy={y(last)} r="2.5" className="spark-dot" />
    </svg>
  );
}

function PositionCard({ pos, now, feeds, focused, onFocus, onClose }: { pos: Position; now: number; feeds: Props['feeds']; focused: boolean; onFocus: () => void; onClose: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const spec = MARKETS[pos.asset];
  const feed = feeds[pos.asset];
  const model = buildModel(pos.legs, spec, feed.spot, now);
  const pnl = model.value - model.cost;
  const pct = model.cost !== 0 ? (pnl / Math.abs(model.cost)) * 100 : 0;
  const summary = summarize(model, spec, feed.spot, now);
  const firstExpiry = Math.min(...pos.legs.map((l) => l.expiry));

  const series = useMemo(() => {
    const pts: number[] = [];
    const cs = feed.candles.filter((c) => c.t >= pos.openedAt - 3600e3);
    const stride = Math.max(1, Math.floor(cs.length / 60));
    pts.push(0);
    for (let i = 0; i < cs.length; i += stride) pts.push(model.pnl(cs[i].c, Math.max(cs[i].t + 3600e3, pos.openedAt)));
    pts.push(pnl);
    return pts;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pos, Math.floor(now / 5000), feed.candles.length]);

  const captured = summary && !summary.unlimitedProfit && summary.maxProfit > 0 ? Math.max(0, Math.min(1, pnl / summary.maxProfit)) : null;

  return (
    <li className={`pos ${focused ? 'is-focused' : ''}`}>
      <div className="pos-head">
        <div>
          <div className="eyebrow">
            {pos.asset} · opened {daysLeft(now, pos.openedAt)} ago at {fmtPrice(pos.openSpot, spec.priceDecimals)}
          </div>
          <h3>{pos.name}</h3>
        </div>
        <Sparkline values={series} />
      </div>
      <div className="pos-pnl">
        <b className={`num ${pnlClass(pnl)}`}>{signedUsd(pnl)}</b>
        <span className={`num ${pnlClass(pnl)}`}>{signed(pct, 1)}%</span>
        <span className="pos-exp">expires in {daysLeft(firstExpiry, now)}</span>
      </div>
      {captured !== null && (
        <div className="progress" title="Share of max profit captured">
          <div className="progress-bar" style={{ width: `${captured * 100}%` }} />
          <span>{(captured * 100).toFixed(0)}% of max profit {usd(summary!.maxProfit, 0)}</span>
        </div>
      )}
      <ul className="pos-legs">
        {pos.legs.map((l, i) => (
          <li key={l.id} className="num">
            <span className={l.side > 0 ? 'long' : 'short'}>
              {l.side > 0 ? '+' : '−'}
              {l.qty}
            </span>{' '}
            {fmtPrice(l.strike, 0)} {l.type} · {expiryLabel(l.expiry)}
            <span className="pos-leg-px">
              {compactUsd(model.entries[i])} → {compactUsd(model.marks[i])}
            </span>
          </li>
        ))}
      </ul>
      <div className="pos-actions">
        <button className={focused ? 'ghost is-on' : 'ghost'} onClick={onFocus}>
          {focused ? 'Showing on chart' : 'Show on chart'}
        </button>
        {confirming ? (
          <>
            <button className="ghost" onClick={() => setConfirming(false)}>
              Keep
            </button>
            <button className="danger" onClick={onClose}>
              Close at {signedUsd(pnl, 0)}
            </button>
          </>
        ) : (
          <button className="ghost" onClick={() => setConfirming(true)}>
            Close
          </button>
        )}
      </div>
    </li>
  );
}

function Positions({ positions, closed, now, feeds, focus, onFocus, onClosePosition }: Props) {
  let open = 0;
  let deltaUsd = 0;
  for (const p of positions) {
    const spec = MARKETS[p.asset];
    const s = feeds[p.asset].spot;
    const m = buildModel(p.legs, spec, s, now);
    open += m.value - m.cost;
    const sum = summarize(m, spec, s, now);
    if (sum) deltaUsd += sum.greeks.delta * s;
  }
  const realized = closed.reduce((a, c) => a + c.realized, 0);

  return (
    <div className="panel-body">
      <dl className="summary">
        <div>
          <dt>Open P&amp;L</dt>
          <dd className={`num ${pnlClass(open)}`}>{signedUsd(open)}</dd>
        </div>
        <div>
          <dt>Realized</dt>
          <dd className={`num ${pnlClass(realized)}`}>{signedUsd(realized)}</dd>
        </div>
        <div className="wide">
          <dt>Net delta exposure</dt>
          <dd className="num">{signedUsd(deltaUsd, 0)}</dd>
        </div>
      </dl>
      {positions.length === 0 ? (
        <div className="empty">
          <p>No open positions. Build one on the chart and place a paper order to track it here.</p>
        </div>
      ) : (
        <ul className="positions">
          {positions.map((p) => (
            <PositionCard
              key={p.id}
              pos={p}
              now={now}
              feeds={feeds}
              focused={focus.kind === 'position' && focus.id === p.id}
              onFocus={() => onFocus(p.id)}
              onClose={() => onClosePosition(p.id)}
            />
          ))}
        </ul>
      )}
      {closed.length > 0 && (
        <div className="closed">
          <div className="eyebrow">Closed</div>
          <ul>
            {closed.slice(0, 8).map((c) => (
              <li key={c.id}>
                <span>
                  {c.asset} · {c.name}
                </span>
                <b className={`num ${pnlClass(c.realized)}`}>{signedUsd(c.realized)}</b>
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="fine">Example positions are simulated. Nothing here is a real trade.</p>
    </div>
  );
}

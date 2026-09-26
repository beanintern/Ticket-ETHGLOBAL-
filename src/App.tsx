import { useCallback, useEffect, useRef, useState } from 'react';
import { Chart, TOOL_LEG, type ChartView, type Tool } from './components/Chart';
import { Sidebar } from './components/Sidebar';
import type { OptType } from './lib/bs';
import { bsPrice } from './lib/bs';
import { price as fmtPrice, signed } from './lib/format';
import { createSource, pickSourceKind } from './data';
import type { Market, MarketSource } from './data/types';
import { DAY, HOUR, MARKETS, YEAR, priceAt, type Asset } from './lib/market';
import {
  buildModel,
  describe,
  newId,
  type ClosedPosition,
  type Leg,
  type Position,
  type Side,
} from './lib/strategy';

// Paper positions are kept per data source, so demo trades never mix with live-priced ones.
const storeKey = (kind: MarketSource['kind']) => (kind === 'mock' ? 'ticket.positions.v1' : `ticket.positions.${kind}.v1`);

export type Preset = 'callSpread' | 'putSpread' | 'straddle' | 'strangle' | 'condor' | 'chaos';

function presetLegs(preset: Preset, market: Market, now: number): Leg[] {
  const { asset, spot } = market;
  const exps = market.expiries;
  if (!exps.length) return [];
  const expiry = (exps.find((e) => e.kind !== 'daily' && e.ts - now > 4 * DAY) ?? exps[0]).ts;
  // Strikes are "n listed strikes away" so presets work on any strike grid (mock or exchange).
  const off = (k: number, n: number, exp = expiry) => {
    for (let i = 0; i < Math.abs(n); i++) k = market.stepStrike(k, exp, n > 0 ? 1 : -1);
    return k;
  };
  const atm = market.snapStrike(spot, expiry);
  const w = asset === 'ETH' ? 4 : 3;
  const mk = (type: OptType, side: Side, strike: number): Leg => ({ id: newId(), asset, type, side, strike, expiry, qty: 1 });
  switch (preset) {
    case 'callSpread':
      return [mk('C', 1, off(atm, 1)), mk('C', -1, off(atm, 1 + w))];
    case 'putSpread':
      return [mk('P', 1, off(atm, -1)), mk('P', -1, off(atm, -1 - w))];
    case 'straddle':
      return [mk('C', 1, atm), mk('P', 1, atm)];
    case 'strangle':
      return [mk('P', 1, off(atm, -w)), mk('C', 1, off(atm, w))];
    case 'condor':
      return [mk('P', 1, off(atm, -2 * w)), mk('P', -1, off(atm, -w)), mk('C', -1, off(atm, w)), mk('C', 1, off(atm, 2 * w))];
    case 'chaos': {
      // A demo of what stacking legs can do. Any piecewise-linear payoff can be built from calls:
      // each call bends the payoff line at its strike by its quantity. Two zig-zags ("sawtooth")
      // on different expiries, out of phase, turn the P&L map into stripes that shift over time.
      const weeklies = exps.filter((e) => e.kind !== 'daily' && e.ts - now > 2 * DAY && e.ts - now < 20 * DAY).map((e) => e.ts);
      const e1 = weeklies[0] ?? expiry;
      const e2 = weeklies[1] ?? e1;
      const legs: Leg[] = [];
      const zigzag = (exp: number, width: number, kinks: number, amp: number, phase: number) => {
        let prev = 0;
        const mid = market.snapStrike(spot, exp);
        for (let i = 0; i <= kinks; i++) {
          const strike = off(mid, (i - kinks / 2) * width, exp);
          const slope = i === kinks ? 0 : (i + phase) % 2 === 0 ? amp : -amp;
          const d = slope - prev;
          if (d !== 0) legs.push({ id: newId(), asset, type: 'C', side: d > 0 ? 1 : -1, strike, expiry: exp, qty: Math.abs(d) });
          prev = slope;
        }
      };
      zigzag(e1, 2, 12, 1, 0);
      zigzag(e2, 4, 8, 2, 1);
      return legs;
    }
  }
}

/** Example positions so the tracking view isn't empty on first load. */
function demoPositions(markets: Record<Asset, Market>, now: number): Position[] {
  const make = (asset: Asset, openedAgo: number, build: (spot: number, exps: number[]) => Omit<Leg, 'id' | 'asset' | 'entry'>[]) => {
    const market = markets[asset];
    const openedAt = now - openedAgo;
    const openSpot = priceAt(market.candles, openedAt);
    const exps = market.expiries.filter((e) => e.kind !== 'daily').map((e) => e.ts);
    const legs: Leg[] = build(openSpot, exps).map((l) => {
      const T = (l.expiry - openedAt) / YEAR;
      const iv = market.iv(l.type, l.strike, l.expiry, openedAt);
      return { ...l, id: newId(), asset, entry: bsPrice(l.type, openSpot, l.strike, T, iv) };
    });
    return { id: newId('pos'), asset, name: describe(legs), legs, openedAt, openSpot };
  };
  return [
    make('ETH', 3 * DAY + 5 * HOUR, (s, e) => {
      const k = Math.round(s / 50) * 50;
      return [
        { type: 'C', side: 1, strike: k + 50, expiry: e[1], qty: 2 },
        { type: 'C', side: -1, strike: k + 300, expiry: e[1], qty: 2 },
      ];
    }),
    make('BTC', 6 * DAY + 2 * HOUR, (s, e) => {
      const k = Math.round(s / 1000) * 1000;
      return [
        { type: 'P', side: 1, strike: k - 6000, expiry: e[2], qty: 1 },
        { type: 'P', side: -1, strike: k - 3000, expiry: e[2], qty: 1 },
        { type: 'C', side: -1, strike: k + 3000, expiry: e[2], qty: 1 },
        { type: 'C', side: 1, strike: k + 6000, expiry: e[2], qty: 1 },
      ];
    }),
  ];
}

function loadStore(kind: MarketSource['kind']): { positions: Position[]; closed: ClosedPosition[] } | null {
  try {
    const raw = localStorage.getItem(storeKey(kind));
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (!Array.isArray(v.positions)) return null;
    return v;
  } catch {
    return null;
  }
}

export type Focus = { kind: 'builder' } | { kind: 'position'; id: string };

export default function App() {
  const [source] = useState<MarketSource>(() => createSource(pickSourceKind()));
  const markets = source.markets;

  const [now, setNow] = useState(() => Date.now());
  const [asset, setAsset] = useState<Asset>('ETH');
  const [tool, setTool] = useState<Tool>('buyC');
  const [view, setView] = useState<ChartView>({ horizon: 21 * DAY, yZoom: 1, yShift: 0 });
  const [builder, setBuilder] = useState<Record<Asset, Leg[]>>(() => ({
    ETH: presetLegs('callSpread', markets.ETH, Date.now()),
    BTC: presetLegs('putSpread', markets.BTC, Date.now()),
  }));
  const [positions, setPositions] = useState<Position[]>(
    () => loadStore(source.kind)?.positions ?? (source.kind === 'mock' ? demoPositions(markets, Date.now()) : []),
  );
  const [closed, setClosed] = useState<ClosedPosition[]>(() => loadStore(source.kind)?.closed ?? []);
  const [focus, setFocus] = useState<Focus>({ kind: 'builder' });
  const [tab, setTab] = useState<'build' | 'positions'>('build');
  const [includePortfolio, setIncludePortfolio] = useState(false);
  const [selectedLegId, setSelectedLegId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // Re-render whenever the market data changes.
  useEffect(() => source.subscribe(() => setNow(Date.now())), [source]);

  // Live data arrives after mount: give each market its starter spread once expiries are known.
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || source.status !== 'ready') return;
    seeded.current = true;
    setBuilder((b) => ({
      ETH: b.ETH.length ? b.ETH : presetLegs('callSpread', markets.ETH, Date.now()),
      BTC: b.BTC.length ? b.BTC : presetLegs('putSpread', markets.BTC, Date.now()),
    }));
  }, [source.status, markets, now]);
  useEffect(() => () => source.close(), [source]);

  useEffect(() => {
    try {
      localStorage.setItem(storeKey(source.kind), JSON.stringify({ positions, closed }));
    } catch {
      /* storage unavailable: positions just won't persist */
    }
  }, [positions, closed, source.kind]);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(id);
  }, [toast]);

  const market = markets[asset];
  const spec = market.spec;
  const spot = market.spot;
  const expiries = market.expiries;
  const builderLegs = builder[asset];
  const assetPositions = positions.filter((p) => p.asset === asset);
  const focusedPosition = focus.kind === 'position' ? positions.find((p) => p.id === focus.id) : undefined;

  // Drop expired builder legs as time passes.
  useEffect(() => {
    if (builderLegs.some((l) => l.expiry <= now)) {
      setBuilder((b) => ({ ...b, [asset]: b[asset].filter((l) => l.expiry > now) }));
    }
  }, [now, asset, builderLegs]);

  const editableLegs = focusedPosition ? [] : builderLegs;
  const staticLegs = focusedPosition ? focusedPosition.legs : includePortfolio ? assetPositions.flatMap((p) => p.legs) : [];
  const chartLegs = [...staticLegs, ...editableLegs];
  const chartModel = buildModel(chartLegs, market, now);
  const builderModel = buildModel(builderLegs, market, now);

  // Undo / redo for ticket edits. Each entry is the whole builder plus the market it was edited on.
  // Placing an order is a real (paper) trade, so it clears the history instead of being undoable.
  type Snapshot = { builder: Record<Asset, Leg[]>; asset: Asset };
  const builderRef = useRef(builder);
  builderRef.current = builder;
  const history = useRef<{ past: Snapshot[]; future: Snapshot[] }>({ past: [], future: [] });
  const [, setHistoryVersion] = useState(0);
  const canUndo = history.current.past.length > 0;
  const canRedo = history.current.future.length > 0;

  const setLegs = useCallback(
    (fn: (legs: Leg[]) => Leg[]) => {
      const b = builderRef.current;
      const next = fn(b[asset]);
      if (next === b[asset]) return;
      const h = history.current;
      h.past.push({ builder: b, asset });
      if (h.past.length > 200) h.past.shift();
      h.future = [];
      builderRef.current = { ...b, [asset]: next };
      setBuilder(builderRef.current);
      setHistoryVersion((v) => v + 1);
    },
    [asset],
  );

  const stepHistory = useCallback(
    (dir: 'undo' | 'redo') => {
      const h = history.current;
      const from = dir === 'undo' ? h.past : h.future;
      const to = dir === 'undo' ? h.future : h.past;
      const snap = from.pop();
      if (!snap) return;
      to.push({ builder: builderRef.current, asset });
      builderRef.current = snap.builder;
      setBuilder(snap.builder);
      if (snap.asset !== asset) setAsset(snap.asset);
      setFocus({ kind: 'builder' });
      setTab('build');
      setSelectedLegId(null);
      setHistoryVersion((v) => v + 1);
    },
    [asset],
  );

  const onAdd = useCallback(
    (type: OptType, side: Side, strike: number, expiry: number) => {
      if (focus.kind !== 'builder') setFocus({ kind: 'builder' });
      setTab('build');
      const same = builderLegs.find((l) => l.type === type && l.strike === strike && l.expiry === expiry);
      if (!same) {
        const leg: Leg = { id: newId(), asset, type, side, strike, expiry, qty: 1 };
        setSelectedLegId(leg.id);
        setLegs((legs) => [...legs, leg]);
        return;
      }
      // Clicking the same contract nets against what's already there.
      const net = same.side * same.qty + side;
      setLegs((legs) =>
        net === 0
          ? legs.filter((l) => l.id !== same.id)
          : legs.map((l) => (l.id === same.id ? { ...l, side: (net > 0 ? 1 : -1) as Side, qty: Math.abs(net) } : l)),
      );
    },
    [asset, focus.kind, setLegs, builderLegs],
  );

  const onMove = useCallback(
    (id: string, strike: number, expiry: number) => setLegs((legs) => legs.map((l) => (l.id === id ? { ...l, strike, expiry } : l))),
    [setLegs],
  );
  const onRemove = useCallback((id: string) => setLegs((legs) => legs.filter((l) => l.id !== id)), [setLegs]);

  // Keyboard: 1-4 pick a leg tool, V pointer, Delete removes the selected leg,
  // Cmd/Ctrl+Z undo, Cmd/Ctrl+Shift+Z or Ctrl+Y redo.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest('input, textarea, select')) return;
      if (e.metaKey || e.ctrlKey) {
        const k = e.key.toLowerCase();
        if (k === 'z' || k === 'y') {
          e.preventDefault();
          stepHistory(k === 'y' || e.shiftKey ? 'redo' : 'undo');
        }
        return;
      }
      const map: Record<string, Tool> = { '1': 'buyC', '2': 'sellC', '3': 'buyP', '4': 'sellP', v: 'pointer', Escape: 'pointer' };
      if (map[e.key]) setTool(map[e.key]);
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedLegId) {
        onRemove(selectedLegId);
        setSelectedLegId(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedLegId, onRemove, stepHistory]);

  const placeOrder = () => {
    if (!builderLegs.length) return;
    const legs = builderLegs.map((l, i) => ({ ...l, id: newId(), entry: builderModel.marks[i] }));
    const pos: Position = { id: newId('pos'), asset, name: describe(legs), legs, openedAt: now, openSpot: spot };
    setPositions((p) => [pos, ...p]);
    builderRef.current = { ...builderRef.current, [asset]: [] };
    setBuilder(builderRef.current);
    history.current = { past: [], future: [] };
    setSelectedLegId(null);
    setTab('positions');
    setToast(`Filled (paper): ${pos.name}`);
  };

  const closePosition = (id: string) => {
    const pos = positions.find((p) => p.id === id);
    if (!pos) return;
    const m = buildModel(pos.legs, markets[pos.asset], now);
    setPositions((ps) => ps.filter((p) => p.id !== id));
    setClosed((c) => [{ id, asset: pos.asset, name: pos.name, openedAt: pos.openedAt, closedAt: now, realized: m.value - m.cost }, ...c]);
    if (focus.kind === 'position' && focus.id === id) setFocus({ kind: 'builder' });
    setToast(`Closed (paper): ${pos.name}`);
  };

  // Test hook for scripts/check-chart.mjs; only present when a test sets window.__TICKET_TEST__.
  useEffect(() => {
    const w = window as unknown as { __TICKET_TEST__?: boolean; __ticket?: unknown };
    if (!w.__TICKET_TEST__) return;
    w.__ticket = {
      setLegs: (a: Asset, legs: Omit<Leg, 'id' | 'asset'>[]) => {
        setAsset(a);
        setFocus({ kind: 'builder' });
        setIncludePortfolio(false);
        setBuilder((b) => ({ ...b, [a]: legs.map((l) => ({ ...l, id: newId(), asset: a })) }));
      },
      setView: (v: ChartView) => setView(v),
      spot: (a: Asset) => markets[a].spot,
      specs: MARKETS,
      expiries: (a: Asset = 'ETH') => markets[a].expiries.map((e) => e.ts),
    };
  }, [markets]);

  // Until live data has arrived there is nothing to chart yet.
  if (!market.candles.length || !spot) {
    return (
      <div className="loading">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          Ticket
        </div>
        {source.status === 'error' ? (
          <>
            <p className="loading-error">{source.error}</p>
            <a href="?source=mock">Use demo data instead</a>
          </>
        ) : (
          <p>Connecting to Derive…</p>
        )}
      </div>
    );
  }

  const dayAgo = priceAt(market.candles, now - DAY);
  const change = (spot / dayAgo - 1) * 100;
  const atmIv = market.iv('C', spot, now + 30 * DAY, now);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          Ticket
        </div>
        <nav className="markets" aria-label="Markets">
          {(Object.keys(MARKETS) as Asset[]).map((a) => {
            const f = markets[a];
            const ch = (f.spot / priceAt(f.candles, now - DAY) - 1) * 100;
            return (
              <button
                key={a}
                className={`market ${a === asset ? 'is-active' : ''}`}
                onClick={() => {
                  setAsset(a);
                  setFocus({ kind: 'builder' });
                  setSelectedLegId(null);
                  setView((v) => ({ ...v, yZoom: 1, yShift: 0, nowFrac: undefined }));
                }}
              >
                <span className="market-sym">{a}</span>
                <span className="market-px">{fmtPrice(f.spot, MARKETS[a].priceDecimals)}</span>
                <span className={ch >= 0 ? 'up' : 'down'}>{signed(ch)}%</span>
              </button>
            );
          })}
        </nav>
        <div className="stats">
          <div>
            <span className="label">Index</span>
            <span className="num">{fmtPrice(spot, spec.priceDecimals)}</span>
          </div>
          <div>
            <span className="label">24h</span>
            <span className={`num ${change >= 0 ? 'up' : 'down'}`}>{signed(change)}%</span>
          </div>
          <div>
            <span className="label">30d ATM IV</span>
            <span className="num">{(atmIv * 100).toFixed(1)}%</span>
          </div>
        </div>
        {source.kind === 'live' ? (
          <div className={`conn ${source.error ? 'is-warn' : 'is-live'}`} title={source.error ?? 'Live market data from Derive. Orders are still paper trades.'}>
            <span className="conn-dot" /> <span className="wide-only">Derive · </span>
            {source.error ? 'reconnecting' : 'live'}
          </div>
        ) : (
          <div className="conn" title="Simulated prices. Nothing is sent to Derive.">
            <span className="conn-dot" /> <span className="wide-only">Derive · </span>mock data
          </div>
        )}
      </header>

      <main className="workspace">
        <section className="chart-panel" aria-label="Chart">
          <div className="chart-toolbar">
            <div className="tools" role="toolbar" aria-label="Leg tools">
              <button className={`tool ${tool === 'pointer' ? 'is-active' : ''}`} onClick={() => setTool('pointer')} title="Select and drag (V)">
                <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
                  <path d="M2 1.5l9 5-4 1-1.5 4z" fill="currentColor" />
                </svg>
              </button>
              {(Object.keys(TOOL_LEG) as Exclude<Tool, 'pointer'>[]).map((t, i) => {
                const tl = TOOL_LEG[t];
                return (
                  <button
                    key={t}
                    className={`tool tool-${tl.side > 0 ? 'long' : 'short'} ${tool === t ? 'is-active' : ''}`}
                    onClick={() => setTool(t)}
                    title={`${tl.label} (${i + 1})`}
                  >
                    <span className={`glyph glyph-${tl.type}`} aria-hidden="true" />
                    {tl.label}
                    <kbd>{i + 1}</kbd>
                  </button>
                );
              })}
            </div>
            <div className="history" role="group" aria-label="History">
              <button className="tool icon" onClick={() => stepHistory('undo')} disabled={!canUndo} title="Undo (Ctrl/⌘ Z)" aria-label="Undo">
                <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
                  <path d="M5 3L2 6l3 3M2.5 6H9a3 3 0 010 6H6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              <button className="tool icon" onClick={() => stepHistory('redo')} disabled={!canRedo} title="Redo (Ctrl/⌘ Shift Z)" aria-label="Redo">
                <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
                  <path d="M9 3l3 3-3 3M11.5 6H5a3 3 0 000 6h3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </div>
            <div className="chart-controls">
              {focusedPosition ? (
                <button className="focus-chip" onClick={() => setFocus({ kind: 'builder' })}>
                  Viewing {focusedPosition.name} <span aria-hidden="true">✕</span>
                </button>
              ) : (
                <label className="switch">
                  <input id="include-portfolio" type="checkbox" checked={includePortfolio} onChange={(e) => setIncludePortfolio(e.target.checked)} />
                  <span className="switch-track" aria-hidden="true" />
                  <span className="wide-only">Include open positions</span>
                  <span className="narrow-only">Positions</span>
                </label>
              )}
              <div className="seg" role="group" aria-label="Time horizon">
                {[
                  ['3D', 3 * DAY],
                  ['1W', 7 * DAY],
                  ['3W', 21 * DAY],
                  ['2M', 60 * DAY],
                  ['4M', 120 * DAY],
                ].map(([label, ms]) => (
                  <button
                    key={label}
                    className={Math.abs(view.horizon - (ms as number)) < DAY / 4 ? 'is-active' : ''}
                    onClick={() => setView((v) => ({ ...v, horizon: ms as number }))}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <Chart
            spec={spec}
            market={market}
            candles={market.candles}
            spot={spot}
            now={now}
            expiries={expiries}
            editableLegs={editableLegs}
            staticLegs={staticLegs}
            model={chartModel}
            tool={focusedPosition ? 'pointer' : tool}
            selectedLegId={selectedLegId}
            view={view}
            onViewChange={setView}
            onAdd={onAdd}
            onMove={onMove}
            onSelect={setSelectedLegId}
            onRemove={(id) => {
              const leg = builderLegs.find((l) => l.id === id);
              onRemove(id);
              if (leg) setToast(`Removed ${leg.side > 0 ? 'long' : 'short'} ${fmtPrice(leg.strike, 0)} ${leg.type === 'C' ? 'call' : 'put'}. Undo with ↶`);
            }}
          />
          <div className="chart-legend">
            <span>
              <i className="sw sw-profit" /> Profit
            </span>
            <span>
              <i className="sw sw-loss" /> Loss
            </span>
            <span>
              <i className="sw sw-be" /> Break-even
            </span>
            <span>
              <i className="sw sw-open" /> Uncapped loss
            </span>
            <span>
              <i className="sw sw-zone" /> Within 5% of max profit / loss
            </span>
            <span className="hint-touch">Tap to place · swipe sideways to pan · hold to inspect · hold a dot to remove · pinch to zoom</span>
            <span className="hint">
              Click to add a leg · drag the chart to pan · drag legs to move · right-click to remove · scroll to zoom, shift-scroll for price · double-click to reset
            </span>
          </div>
        </section>

        <Sidebar
          tab={tab}
          onTab={setTab}
          spec={spec}
          spot={spot}
          now={now}
          markets={markets}
          builderLegs={builderLegs}
          builderModel={builderModel}
          selectedLegId={selectedLegId}
          onSelectLeg={setSelectedLegId}
          onUpdateLeg={(id, patch) => setLegs((legs) => legs.map((l) => (l.id === id ? { ...l, ...patch } : l)))}
          onRemoveLeg={onRemove}
          onClear={() => setLegs(() => [])}
          onPreset={(p) => {
            setFocus({ kind: 'builder' });
            setLegs(() => presetLegs(p, market, now));
          }}
          onPlace={placeOrder}
          positions={positions}
          closed={closed}
          focus={focus}
          onFocus={(id) => {
            const p = positions.find((x) => x.id === id);
            if (p && p.asset !== asset) setAsset(p.asset);
            setFocus(focus.kind === 'position' && focus.id === id ? { kind: 'builder' } : { kind: 'position', id });
          }}
          onClosePosition={closePosition}
        />
      </main>
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}

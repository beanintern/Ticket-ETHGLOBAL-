import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Chart, TOOL_LEG, type ChartView, type Tool } from './components/Chart';
import { Sidebar } from './components/Sidebar';
import type { OptType } from './lib/bs';
import { bsPrice } from './lib/bs';
import { price as fmtPrice, signed } from './lib/format';
import {
  DAY,
  HOUR,
  MARKETS,
  YEAR,
  gaussian,
  generateHistory,
  impliedVol,
  listExpiries,
  priceAt,
  snapStrike,
  type Asset,
  type Candle,
} from './lib/market';
import {
  buildModel,
  describe,
  newId,
  type ClosedPosition,
  type Leg,
  type Position,
  type Side,
} from './lib/strategy';

const STORE_KEY = 'ticket.positions.v1';

interface Feed {
  candles: Candle[];
  spot: number;
}

function initFeeds(now: number): Record<Asset, Feed> {
  const out = {} as Record<Asset, Feed>;
  for (const a of Object.keys(MARKETS) as Asset[]) {
    const candles = generateHistory(MARKETS[a], now);
    out[a] = { candles, spot: candles[candles.length - 1].c };
  }
  return out;
}

export type Preset = 'callSpread' | 'putSpread' | 'straddle' | 'strangle' | 'condor';

function presetLegs(preset: Preset, asset: Asset, spot: number, now: number): Leg[] {
  const spec = MARKETS[asset];
  const exps = listExpiries(now);
  const expiry = (exps.find((e) => e.kind !== 'daily' && e.ts - now > 4 * DAY) ?? exps[0]).ts;
  const step = spec.strikeStep;
  const atm = snapStrike(spec, spot, expiry, now);
  const w = step * (asset === 'ETH' ? 4 : 3);
  const mk = (type: OptType, side: Side, strike: number): Leg => ({ id: newId(), asset, type, side, strike, expiry, qty: 1 });
  switch (preset) {
    case 'callSpread':
      return [mk('C', 1, atm + step), mk('C', -1, atm + step + w)];
    case 'putSpread':
      return [mk('P', 1, atm - step), mk('P', -1, atm - step - w)];
    case 'straddle':
      return [mk('C', 1, atm), mk('P', 1, atm)];
    case 'strangle':
      return [mk('P', 1, atm - w), mk('C', 1, atm + w)];
    case 'condor':
      return [mk('P', 1, atm - 2 * w), mk('P', -1, atm - w), mk('C', -1, atm + w), mk('C', 1, atm + 2 * w)];
  }
}

/** Example positions so the tracking view isn't empty on first load. */
function demoPositions(feeds: Record<Asset, Feed>, now: number): Position[] {
  const make = (asset: Asset, openedAgo: number, build: (spot: number, exps: number[]) => Omit<Leg, 'id' | 'asset' | 'entry'>[]) => {
    const spec = MARKETS[asset];
    const openedAt = now - openedAgo;
    const openSpot = priceAt(feeds[asset].candles, openedAt);
    const exps = listExpiries(now).filter((e) => e.kind !== 'daily').map((e) => e.ts);
    const legs: Leg[] = build(openSpot, exps).map((l) => {
      const T = (l.expiry - openedAt) / YEAR;
      const iv = impliedVol(spec, openSpot, l.strike, T);
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

function loadStore(): { positions: Position[]; closed: ClosedPosition[] } | null {
  try {
    const raw = localStorage.getItem(STORE_KEY);
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
  const feedsRef = useRef<Record<Asset, Feed> | null>(null);
  if (!feedsRef.current) feedsRef.current = initFeeds(Date.now());
  const feeds = feedsRef.current;

  const [now, setNow] = useState(() => Date.now());
  const [asset, setAsset] = useState<Asset>('ETH');
  const [tool, setTool] = useState<Tool>('buyC');
  const [view, setView] = useState<ChartView>({ horizon: 21 * DAY, yZoom: 1, yShift: 0 });
  const [builder, setBuilder] = useState<Record<Asset, Leg[]>>(() => ({
    ETH: presetLegs('callSpread', 'ETH', feeds.ETH.spot, Date.now()),
    BTC: presetLegs('putSpread', 'BTC', feeds.BTC.spot, Date.now()),
  }));
  const [positions, setPositions] = useState<Position[]>(() => loadStore()?.positions ?? demoPositions(feeds, Date.now()));
  const [closed, setClosed] = useState<ClosedPosition[]>(() => loadStore()?.closed ?? []);
  const [focus, setFocus] = useState<Focus>({ kind: 'builder' });
  const [tab, setTab] = useState<'build' | 'positions'>('build');
  const [includePortfolio, setIncludePortfolio] = useState(false);
  const [selectedLegId, setSelectedLegId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // Simulated index feed: one GBM tick per second per asset.
  useEffect(() => {
    const id = setInterval(() => {
      const t = Date.now();
      for (const a of Object.keys(MARKETS) as Asset[]) {
        const f = feeds[a];
        const spec = MARKETS[a];
        f.spot *= Math.exp(spec.baseIv * 1.4 * Math.sqrt(1000 / YEAR) * gaussian());
        const last = f.candles[f.candles.length - 1];
        const hour = Math.floor(t / HOUR) * HOUR;
        if (hour > last.t) f.candles.push({ t: hour, o: last.c, h: Math.max(last.c, f.spot), l: Math.min(last.c, f.spot), c: f.spot });
        else {
          last.c = f.spot;
          last.h = Math.max(last.h, f.spot);
          last.l = Math.min(last.l, f.spot);
        }
      }
      setNow(t);
    }, 1000);
    return () => clearInterval(id);
  }, [feeds]);

  useEffect(() => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ positions, closed }));
    } catch {
      /* storage unavailable: positions just won't persist */
    }
  }, [positions, closed]);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(id);
  }, [toast]);

  const spec = MARKETS[asset];
  const feed = feeds[asset];
  const spot = feed.spot;
  const expiries = useMemo(() => listExpiries(now), [Math.floor(now / HOUR)]); // eslint-disable-line react-hooks/exhaustive-deps
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
  const chartModel = buildModel(chartLegs, spec, spot, now);
  const builderModel = buildModel(builderLegs, spec, spot, now);

  const setLegs = useCallback((fn: (legs: Leg[]) => Leg[]) => setBuilder((b) => ({ ...b, [asset]: fn(b[asset]) })), [asset]);

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

  // Keyboard: 1-4 pick a leg tool, V pointer, Delete removes the selected leg.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest('input, textarea, select')) return;
      const map: Record<string, Tool> = { '1': 'buyC', '2': 'sellC', '3': 'buyP', '4': 'sellP', v: 'pointer', Escape: 'pointer' };
      if (map[e.key]) setTool(map[e.key]);
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedLegId) {
        onRemove(selectedLegId);
        setSelectedLegId(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedLegId, onRemove]);

  const placeOrder = () => {
    if (!builderLegs.length) return;
    const legs = builderLegs.map((l, i) => ({ ...l, id: newId(), entry: builderModel.marks[i] }));
    const pos: Position = { id: newId('pos'), asset, name: describe(legs), legs, openedAt: now, openSpot: spot };
    setPositions((p) => [pos, ...p]);
    setLegs(() => []);
    setSelectedLegId(null);
    setTab('positions');
    setToast(`Filled (paper): ${pos.name}`);
  };

  const closePosition = (id: string) => {
    const pos = positions.find((p) => p.id === id);
    if (!pos) return;
    const m = buildModel(pos.legs, MARKETS[pos.asset], feeds[pos.asset].spot, now);
    setPositions((ps) => ps.filter((p) => p.id !== id));
    setClosed((c) => [{ id, asset: pos.asset, name: pos.name, openedAt: pos.openedAt, closedAt: now, realized: m.value - m.cost }, ...c]);
    if (focus.kind === 'position' && focus.id === id) setFocus({ kind: 'builder' });
    setToast(`Closed (paper): ${pos.name}`);
  };

  const dayAgo = priceAt(feed.candles, now - DAY);
  const change = (spot / dayAgo - 1) * 100;
  const atmIv = impliedVol(spec, spot, spot, 30 / 365);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          Ticket
        </div>
        <nav className="markets" aria-label="Markets">
          {(Object.keys(MARKETS) as Asset[]).map((a) => {
            const f = feeds[a];
            const ch = (f.spot / priceAt(f.candles, now - DAY) - 1) * 100;
            return (
              <button
                key={a}
                className={`market ${a === asset ? 'is-active' : ''}`}
                onClick={() => {
                  setAsset(a);
                  setFocus({ kind: 'builder' });
                  setSelectedLegId(null);
                  setView((v) => ({ ...v, yZoom: 1, yShift: 0 }));
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
        <div className="conn" title="The mockup uses simulated prices. Nothing is sent to Derive.">
          <span className="conn-dot" /> Derive · mock data
        </div>
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
            <div className="chart-controls">
              {focusedPosition ? (
                <button className="focus-chip" onClick={() => setFocus({ kind: 'builder' })}>
                  Viewing {focusedPosition.name} <span aria-hidden="true">✕</span>
                </button>
              ) : (
                <label className="switch">
                  <input id="include-portfolio" type="checkbox" checked={includePortfolio} onChange={(e) => setIncludePortfolio(e.target.checked)} />
                  <span className="switch-track" aria-hidden="true" />
                  Include open positions
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
            candles={feed.candles}
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
            onRemove={onRemove}
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
            <span className="hint">
              Click an expiry column to add a leg · drag legs to move · right-click to remove · scroll to zoom time, shift-scroll or drag the price axis for price
            </span>
          </div>
        </section>

        <Sidebar
          tab={tab}
          onTab={setTab}
          spec={spec}
          spot={spot}
          now={now}
          feeds={feeds}
          builderLegs={builderLegs}
          builderModel={builderModel}
          selectedLegId={selectedLegId}
          onSelectLeg={setSelectedLegId}
          onUpdateLeg={(id, patch) => setLegs((legs) => legs.map((l) => (l.id === id ? { ...l, ...patch } : l)))}
          onRemoveLeg={onRemove}
          onClear={() => setLegs(() => [])}
          onPreset={(p) => {
            setFocus({ kind: 'builder' });
            setLegs(() => presetLegs(p, asset, spot, now));
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

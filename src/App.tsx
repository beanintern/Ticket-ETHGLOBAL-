import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DeriveAccount, loadCredentials, type AccountState, type Credentials, type OrderResult, type Portfolio } from './account/derive';
import { forgetSessionKey, hasMetaMask, metaMaskSigner, registerSessionKey, savedSessionKey } from './account/metamask';
import { instrumentName, legOrders, type LegOrder, type OrderMode } from './account/orders';
import type { Trading } from './components/DeriveReview';
import { AccountButton, AccountPanel } from './components/AccountPanel';
import { Chart, TOOL_LEG, type ChartView, type LegTool, type Tool } from './components/Chart';
import { fitPath, payoffAlongPath, type PathPoint } from './lib/pathfit';
import { betCost, betLegs, betQuestion, fmtCents, minStake, quoteBet, sizeBet, type BetQuote } from './lib/binary';
import { EasyPanel, sharePrice } from './components/EasyPanel';
import { Sidebar } from './components/Sidebar';
import type { OptType } from './lib/bs';
import { bsPrice } from './lib/bs';
import { price as fmtPrice, signed, signedUsd, usd } from './lib/format';
import { createSource, pickSourceKind } from './data';
import type { Market, MarketSource } from './data/types';
import { DAY, HOUR, MARKETS, YEAR, expiryLabel, priceAt, type Asset } from './lib/market';
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

 /** YYYYMMDD (UTC) of a timestamp, as in Derive instrument names. */
const ymd = (ts: number) => new Date(ts).toISOString().slice(0, 10).replace(/-/g, '');

/** The exchange account's option positions as one position per underlying, so they chart like paper ones. */
function exchangePositions(portfolio: Portfolio | null, markets: Record<Asset, Market>): Position[] {
  if (!portfolio) return [];
  return (Object.keys(MARKETS) as Asset[]).flatMap((asset) => {
    const held = portfolio.positions.filter((p) => p.asset === asset);
    if (!held.length) return [];
    const market = markets[asset];
    const legs: Leg[] = held.map((p) => {
      const listed = market.expiries.find((e) => ymd(e.ts) === p.expiryYmd);
      // Derive options expire at 08:00 UTC.
      const y = p.expiryYmd;
      const expiry = listed?.ts ?? Date.UTC(+y.slice(0, 4), +y.slice(4, 6) - 1, +y.slice(6, 8), 8);
      return { id: `derive-${p.instrument}`, asset, type: p.type, side: p.amount > 0 ? 1 : -1, strike: p.strike, expiry, qty: Math.abs(p.amount), entry: p.averagePrice };
    });
    const openedAt = Math.min(...held.map((p) => p.openedAt));
    return [{ id: `derive-${asset}`, asset, name: describe(legs), legs, openedAt, openSpot: priceAt(market.candles, openedAt) || market.spot }];
  });
}

export type Focus = { kind: 'builder' } | { kind: 'position'; id: string };

/** Derive mainnet, Derive testnet, or the simulator. Switching reloads the page with ?source=…. */
function SourceSwitch({ source }: { source: MarketSource }) {
  // The single-file preview can't open network connections, so it only has demo data.
  const networkAvailable = import.meta.env.MODE !== 'artifact';
  const go = (kind: MarketSource['kind']) => {
    if (kind === source.kind) return;
    const u = new URL(location.href);
    u.searchParams.set('source', kind);
    location.href = u.toString();
  };
  const networkButton = (kind: 'live' | 'testnet', label: string, about: string) => {
    const active = source.kind === kind;
    const state = !active ? '' : source.error ? 'is-warn' : 'is-live';
    return (
      <button
        className={active ? `is-active ${state}` : ''}
        onClick={() => go(kind)}
        disabled={!networkAvailable}
        title={
          !networkAvailable
            ? 'Derive data needs the app running on your machine (npm run dev); this preview only has demo data.'
            : active
              ? (source.error ?? about)
              : `Switch to ${about.charAt(0).toLowerCase()}${about.slice(1)}`
        }
      >
        <span className="conn-dot" aria-hidden="true" />
        {active && source.error ? 'Reconnecting' : label}
      </button>
    );
  };
  return (
    <div className="conn" role="group" aria-label="Market data">
      <span className="wide-only conn-label">Derive</span>
      <div className="seg conn-seg">
        {networkButton('live', 'Live', 'Live market data from Derive mainnet. Orders are paper trades.')}
        {networkButton('testnet', 'Testnet', "Market data from Derive's testnet (Sepolia), with test funds.")}
        <button className={source.kind === 'mock' ? 'is-active' : ''} onClick={() => go('mock')} title="Simulated prices. Nothing is sent to Derive.">
          Demo
        </button>
      </div>
    </div>
  );
}

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
  // Easy mode: prediction-market style Yes bets instead of the full options ticket.
  const [mode, setModeState] = useState<'easy' | 'pro'>(() => {
    const q = new URLSearchParams(location.search).get('mode');
    if (q === 'easy' || q === 'pro') return q;
    try {
      return localStorage.getItem('ticket.mode') === 'easy' ? 'easy' : 'pro';
    } catch {
      return 'pro';
    }
  });
  const setMode = (m: 'easy' | 'pro') => {
    setModeState(m);
    try {
      localStorage.setItem('ticket.mode', m);
    } catch {
      /* not remembered */
    }
  };
  const easy = mode === 'easy';
  const [pick, setPick] = useState<{ asset: Asset; expiry: number; lo: number; hi: number } | null>(null);
  const [stake, setStake] = useState(20);
  // Positions ticked in the Positions tab: their legs are added to the chart's P&L map (with the
  // ticket being built), so their exposure compounds.
  const [compound, setCompound] = useState<Set<string>>(() => new Set());
  const [selectedLegId, setSelectedLegId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // Derive account (testnet only): connected with a session key that stays in this browser.
  const accountEnabled = source.kind === 'testnet';
  const [account, setAccount] = useState<DeriveAccount | null>(null);
  const [accountState, setAccountState] = useState<AccountState | null>(null);
  const [accountOpen, setAccountOpen] = useState(false);
  const [savedCreds] = useState(() => (accountEnabled ? loadCredentials() : null));
  const connectAccount = useCallback(async (creds: Credentials, remember: boolean) => {
    const acct = await DeriveAccount.connect(creds, remember);
    setAccount((prev) => {
      void prev?.disconnect();
      return acct;
    });
  }, []);
  useEffect(() => {
    if (!account) {
      setAccountState(null);
      return;
    }
    setAccountState(account.state);
    return account.subscribe(() => setAccountState(account.state));
  }, [account]);
  // Reconnect with the key saved earlier in this tab (or on this device, if remembered).
  const reconnected = useRef(false);
  useEffect(() => {
    if (!savedCreds || reconnected.current) return;
    reconnected.current = true;
    connectAccount(savedCreds.creds, savedCreds.remember).catch((e) => setToast(`Couldn't reconnect to Derive: ${(e as Error).message}`));
  }, [savedCreds, connectAccount]);
  // MetaMask: reuse this browser's trading key for the wallet if it's still valid, else register one.
  const connectMetaMask = async (onStep: (s: string) => void) => {
    const owner = await metaMaskSigner();
    const saved = savedSessionKey(owner.address);
    if (saved) {
      try {
        onStep('Reconnecting with your trading key…');
        await connectAccount({ owner: owner.address, sessionKey: saved }, true);
        return;
      } catch {
        forgetSessionKey(owner.address);
      }
    }
    const creds = await registerSessionKey(owner, onStep);
    onStep('Loading your account…');
    await connectAccount(creds, true);
  };
  const disconnectAccount = () => {
    if (account) forgetSessionKey(account.state.owner);
    void account?.disconnect();
    setAccount(null);
    setAccountOpen(false);
  };

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
    const id = setTimeout(() => setToast(null), toast.length > 80 ? 7000 : 3200);
    return () => clearTimeout(id);
  }, [toast]);

  const market = markets[asset];
  const spec = market.spec;
  const spot = market.spot;
  const expiries = market.expiries;
  const builderLegs = builder[asset];
  const onExchange = exchangePositions(accountState?.portfolio ?? null, markets);
  const allPositions = [...onExchange, ...positions];
  const assetPositions = allPositions.filter((p) => p.asset === asset);
  const focusedPosition = focus.kind === 'position' ? allPositions.find((p) => p.id === focus.id) : undefined;

  // Drop expired builder legs as time passes.
  useEffect(() => {
    if (builderLegs.some((l) => l.expiry <= now)) {
      setBuilder((b) => ({ ...b, [asset]: b[asset].filter((l) => l.expiry > now) }));
    }
  }, [now, asset, builderLegs]);

  const editableLegs = focusedPosition ? [] : builderLegs;
  const compounded = assetPositions.filter((p) => compound.has(p.id));
  const staticLegs = focusedPosition ? focusedPosition.legs : compounded.flatMap((p) => p.legs);
  const toggleCompound = (id: string) => {
    setCompound((c) => {
      const next = new Set(c);
      if (!next.delete(id)) next.add(id);
      return next;
    });
    // Ticking is about the combined view, so leave the single-position view.
    if (focus.kind === 'position') setFocus({ kind: 'builder' });
  };
  const setCompoundAll = (on: boolean) =>
    setCompound((c) => {
      const next = new Set(c);
      for (const p of assetPositions) {
        if (on) next.add(p.id);
        else next.delete(p.id);
      }
      return next;
    });
  // Easy mode: the chart is a grid of bets (no payoff map); the picked box is the bet being set up.
  const pendingBet: BetQuote | null =
    easy && pick && pick.asset === asset ? quoteBet(market, asset, pick.expiry, pick.lo, now, { lo: pick.lo, hi: pick.hi }) : null;
  const chartLegs = easy ? [] : [...staticLegs, ...editableLegs];
  const chartModel = buildModel(chartLegs, market, now);
  const bets = positions.filter((p) => p.bet);
  const buyBet = (q: BetQuote, amount: number) => {
    // Sized as it would be on Derive: fees included, contracts on its 0.01 grid, at least its minimum.
    const size = q.unavailable || amount < minStake(q, markets[q.asset].spot) ? null : sizeBet(q, amount, markets[q.asset].spot);
    if (!size) {
      setToast(q.unavailable ?? `The minimum bet here is $${minStake(q, markets[q.asset].spot)}.`);
      return;
    }
    const { shares, fees } = size;
    const legs = betLegs(q, shares);
    const m = buildModel(legs, markets[q.asset], now);
    const pos: Position = {
      id: newId('pos'),
      asset: q.asset,
      name: `${betQuestion(q.asset, q.dir, q.level)} · ${expiryLabel(q.expiry)}`,
      legs: legs.map((l, i) => ({ ...l, entry: m.marks[i] })),
      openedAt: now,
      openSpot: markets[q.asset].spot,
      // What was paid per share: the legs at mark plus Derive's fees.
      bet: { dir: q.dir, level: q.level, lo: q.lo, hi: q.hi, expiry: q.expiry, shares, entry: (m.cost + fees) / shares },
    };
    setPositions((ps) => [pos, ...ps]);
    setPick(null);
    setToast(`Bought ${shares.toFixed(1)} Yes shares at ${fmtCents(m.cost / shares)} plus ${usd(fees, 2)} fees: ${pos.name} (paper)`);
  };
  const easyLayer = easy
    ? {
        quote: (expiry: number, lo: number, hi: number) => quoteBet(market, asset, expiry, lo, now, { lo, hi }),
        onPick: (expiry: number, lo: number, hi: number) => setPick({ asset, expiry, lo, hi }),
        pending: pendingBet,
        bets: bets
          .filter((b) => b.asset === asset && b.bet!.expiry > now)
          .map((b) => {
            const px = sharePrice(b, markets, now);
            return {
              id: b.id,
              expiry: b.bet!.expiry,
              lo: b.bet!.lo,
              hi: b.bet!.hi,
              dir: b.bet!.dir,
              label: `$${(b.bet!.entry * b.bet!.shares).toFixed(0)} → $${(px * b.bet!.shares).toFixed(0)}`,
              up: px > b.bet!.entry,
            };
          }),
      }
    : null;
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
  // Draw tool: the last drawn path per market, shown as a guide while its position is on the chart.
  const [guides, setGuides] = useState<Partial<Record<Asset, PathPoint[]>>>({});
  const onDraw = (path: PathPoint[]) => {
    const fit = fitPath(path, market, asset, now);
    if (!fit.legs.length) {
      setToast('Draw further right: the path needs to reach a listed expiry.');
      return;
    }
    setFocus({ kind: 'builder' });
    setTab('build');
    setSelectedLegId(null);
    setLegs(() => fit.legs);
    setGuides((g) => ({ ...g, [asset]: path }));
    const cost = buildModel(fit.legs, market, now).cost;
    const n = fit.targets.length;
    setToast(
      `${n} butterfl${n > 1 ? 'ies' : 'y'} along your path: ${signedUsd(payoffAlongPath(fit.legs, path, cost), 0)} if ${asset} follows it. Undo with ↶`,
    );
  };
  // Clearing the ticket drops its guide, so an old path never hangs over a new position.
  useEffect(() => {
    if (!builderLegs.length && guides[asset]) setGuides((g) => ({ ...g, [asset]: undefined }));
  }, [builderLegs.length, guides, asset]);
  const onMoveGroup = useCallback(
    (moves: { id: string; strike: number; expiry: number }[]) => {
      const to = new Map(moves.map((m) => [m.id, m]));
      setLegs((legs) => legs.map((l) => (to.has(l.id) ? { ...l, strike: to.get(l.id)!.strike, expiry: to.get(l.id)!.expiry } : l)));
    },
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
      const map: Record<string, Tool> = { '1': 'buyC', '2': 'sellC', '3': 'buyP', '4': 'sellP', '5': 'draw', v: 'pointer', Escape: 'pointer' };
      if (map[e.key]) setTool(map[e.key]);
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedLegId) {
        onRemove(selectedLegId);
        setSelectedLegId(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedLegId, onRemove, stepHistory]);

  // Real orders on Derive testnet, while an account with a subaccount is connected.
  const subaccountId = accountState?.subaccountId ?? null;
  const canTrade = accountState?.canTrade ?? null;
  const trading = useMemo<Trading | null>(() => {
    if (!account || subaccountId === null) return null;
    return {
      canTrade,
      subaccountId,
      prepare: async (legs, mode: OrderMode) => {
        const m = markets[legs[0]?.asset ?? 'ETH'];
        const instruments = await account.instruments(legs.map(instrumentName));
        const orders = legOrders(legs, m, instruments, mode);
        return { orders, previews: await account.preview(orders, mode) };
      },
      place: (orders, mode) => account.place(orders, mode),
    };
  }, [account, subaccountId, canTrade, markets]);

  const reportOrders = (results: OrderResult[], what: string) => {
    const rejected = results.find((r) => !r.ok);
    const filled = results.filter((r) => r.filled > 0).length;
    const sent = results.filter((r) => r.ok).length;
    if (rejected) {
      setToast(
        `${what}: ${rejected.order.instrument} rejected: ${rejected.error}${sent ? ` (${sent} earlier order${sent > 1 ? 's' : ''} went through)` : ''}`,
      );
    } else {
      setToast(`${what}: ${sent} order${sent > 1 ? 's' : ''} sent, ${filled} filled${filled < sent ? '; the rest are open or cancelled (see Positions)' : ''}`);
    }
  };

  const onPlaced = (results: OrderResult[]) => {
    reportOrders(results, 'Derive');
    if (!results.some((r) => r.ok)) return;
    builderRef.current = { ...builderRef.current, [asset]: [] };
    setBuilder(builderRef.current);
    history.current = { past: [], future: [] };
    setSelectedLegId(null);
    setTab('positions');
  };

  const closeExchangePosition = async (pos: Position) => {
    if (!account) return;
    try {
      const instruments = await account.instruments(pos.legs.map(instrumentName));
      const orders = legOrders(pos.legs, markets[pos.asset], instruments, 'market', true);
      reportOrders(await account.place(orders, 'market'), `Close ${pos.asset}`);
    } catch (e) {
      setToast(`Couldn't close: ${(e as Error).message}`);
    }
  };

  // Easy mode on Derive testnet: a bet is its two legs, sent together (the buy first, so a
  // half-filled bet leaves a bought option, never a naked sale).
  const buyBetLive = async (q: BetQuote, orders: LegOrder[], estFees: number) => {
    if (!trading) return;
    const results = await trading.place(orders, 'market');
    const gap = q.hi - q.lo;
    const allFilled = results.length === orders.length && results.every((r) => r.ok && r.filled > 0);
    if (!allFilled) {
      const first = results[0];
      if (first?.ok && first.filled > 0)
        setToast(
          `Only part of the bet went through: bought ${first.filled} ${first.order.instrument} but the other leg didn't fill. You hold that option: see Pro › Positions to close it.`,
        );
      else reportOrders(results, 'Bet');
      return;
    }
    const amount = Math.min(...results.map((r) => r.filled));
    const shares = amount * gap;
    // Fills don't report fees, so use Derive's estimate from the quote, scaled to what filled.
    const ordered = Math.min(...orders.map((o) => Number(o.amount)));
    const fees = ordered > 0 ? estFees * (amount / ordered) : 0;
    const cost = betCost(
      results.map((r, i) => ({ direction: r.order.direction, amount, price: r.averagePrice, fee: i === 0 ? fees : 0 })),
      gap,
    );
    const legs = betLegs(q, shares).map((l, i) => ({ ...l, entry: results[i].averagePrice }));
    const pos: Position = {
      id: newId('pos'),
      asset: q.asset,
      name: `${betQuestion(q.asset, q.dir, q.level)} · ${expiryLabel(q.expiry)}`,
      legs,
      openedAt: now,
      openSpot: markets[q.asset].spot,
      venue: 'derive-testnet',
      bet: { dir: q.dir, level: q.level, lo: q.lo, hi: q.hi, expiry: q.expiry, shares, entry: cost.perShare },
    };
    setPositions((ps) => [pos, ...ps]);
    setPick(null);
    const extra = results.some((r) => r.filled > amount + 1e-9) ? ' (one leg filled a little more; the extra shows in Pro › Positions)' : '';
    setToast(`Bought ${shares.toFixed(1)} Yes shares at ${fmtCents(cost.perShare)} on Derive testnet: ${pos.name}${extra}`);
  };

  // Selling a testnet bet: close the sold leg first, then the bought one, reduce-only.
  const sellBet = async (id: string) => {
    const pos = positions.find((p) => p.id === id);
    if (!pos) return;
    if (pos.venue !== 'derive-testnet') return closePosition(id);
    if (!account) {
      setToast('Connect your Derive testnet account to sell this bet.');
      return;
    }
    try {
      const closing = [...pos.legs].sort((a, b) => a.side - b.side);
      const instruments = await account.instruments(closing.map(instrumentName));
      const results = await account.place(legOrders(closing, markets[pos.asset], instruments, 'market', true), 'market');
      if (!results.every((r) => r.ok && r.filled > 0)) {
        reportOrders(results, 'Sell');
        return;
      }
      const proceeds = results.reduce((a, r) => a + (r.order.direction === 'sell' ? 1 : -1) * r.averagePrice * r.filled, 0);
      const paid = pos.bet ? pos.bet.entry * pos.bet.shares : 0;
      setPositions((ps) => ps.filter((p) => p.id !== id));
      setClosed((c) => [{ id, asset: pos.asset, name: pos.name, openedAt: pos.openedAt, closedAt: now, realized: proceeds - paid }, ...c]);
      setToast(`Sold on Derive testnet: ${pos.name} (${signedUsd(proceeds - paid)})`);
    } catch (e) {
      setToast(`Couldn't sell: ${(e as Error).message}`);
    }
  };

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
        setCompound(new Set());
        setBuilder((b) => ({ ...b, [a]: legs.map((l) => ({ ...l, id: newId(), asset: a })) }));
      },
      setView: (v: ChartView) => setView(v),
      spot: (a: Asset) => markets[a].spot,
      specs: MARKETS,
      expiries: (a: Asset = 'ETH') => markets[a].expiries.map((e) => e.ts),
      strikes: (a: Asset, expiry: number) => markets[a].strikes(expiry),
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
        <div className="seg mode-seg" role="group" aria-label="Mode">
          <button className={easy ? 'is-active' : ''} onClick={() => setMode('easy')} title="Prediction-market style: tap above or below the price">
            Easy
          </button>
          <button className={!easy ? 'is-active' : ''} onClick={() => setMode('pro')} title="The full options ticket">
            Pro
          </button>
        </div>
        <SourceSwitch source={source} />
        {accountEnabled && <AccountButton account={accountState} onOpen={() => setAccountOpen(true)} />}
      </header>
      {accountOpen && (
        <AccountPanel
          account={accountState}
          initial={savedCreds}
          onConnect={connectAccount}
          onMetaMask={connectMetaMask}
          metaMaskAvailable={hasMetaMask()}
          onDisconnect={disconnectAccount}
          onSelectSubaccount={(id) => account?.selectSubaccount(id)}
          onClose={() => setAccountOpen(false)}
        />
      )}

      <main className="workspace">
        <section className="chart-panel" aria-label="Chart">
          <div className="chart-toolbar">
            {easy ? (
              <div className="easy-hint">
                <span className="up">▲ Tap above the price</span> to bet it ends higher · <span className="down">▼ below</span> to bet lower
              </div>
            ) : (
            <>
            <div className="tools" role="toolbar" aria-label="Leg tools">
              <button className={`tool ${tool === 'pointer' ? 'is-active' : ''}`} onClick={() => setTool('pointer')} title="Select and drag (V)">
                <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
                  <path d="M2 1.5l9 5-4 1-1.5 4z" fill="currentColor" />
                </svg>
              </button>
              {(Object.keys(TOOL_LEG) as LegTool[]).map((t, i) => {
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
              <button
                className={`tool tool-draw ${tool === 'draw' ? 'is-active' : ''}`}
                onClick={() => setTool('draw')}
                aria-label="Draw path"
                title="Draw a price path: the ticket becomes a position that pays off along it (5)"
              >
                <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
                  <path d="M1.5 11c2-5 3.5-6.5 5-4s3 1.5 5.5-4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span className="wide-only">Draw path</span>
                <kbd>5</kbd>
              </button>
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
            </>
            )}
            <div className="chart-controls">
              {easy ? null : focusedPosition ? (
                <button className="focus-chip" onClick={() => setFocus({ kind: 'builder' })}>
                  Viewing {focusedPosition.name} <span aria-hidden="true">✕</span>
                </button>
              ) : (
                <label className="switch">
                  <input
                    id="include-portfolio"
                    type="checkbox"
                    checked={compounded.length > 0}
                    disabled={!assetPositions.length}
                    onChange={(e) => setCompoundAll(e.target.checked)}
                  />
                  <span className="switch-track" aria-hidden="true" />
                  <span className="wide-only">
                    Include open positions
                    {compounded.length > 0 && compounded.length < assetPositions.length ? ` (${compounded.length}/${assetPositions.length})` : ''}
                  </span>
                  <span className="narrow-only">Positions</span>
                </label>
              )}
              <div className="seg" role="group" aria-label="Time horizon">
                {[
                  ['1W', 7 * DAY],
                  ['3W', 21 * DAY],
                  ['2M', 60 * DAY],
                  ['6M', 182 * DAY],
                  ['1Y', 365 * DAY],
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
            editableLegs={easy ? [] : editableLegs}
            staticLegs={easy ? [] : staticLegs}
            model={chartModel}
            tool={focusedPosition || easy ? 'pointer' : tool}
            selectedLegId={selectedLegId}
            view={view}
            onViewChange={setView}
            onAdd={onAdd}
            onMove={onMove}
            onMoveGroup={onMoveGroup}
            onDraw={onDraw}
            easy={easyLayer}
            guide={!easy && !focusedPosition && builderLegs.length ? (guides[asset] ?? null) : null}
            onSelect={setSelectedLegId}
            onRemove={(id) => {
              const leg = builderLegs.find((l) => l.id === id);
              onRemove(id);
              if (leg) setToast(`Removed ${leg.side > 0 ? 'long' : 'short'} ${fmtPrice(leg.strike, 0)} ${leg.type === 'C' ? 'call' : 'put'}. Undo with ↶`);
            }}
          />
          <div className="chart-legend">
            {easy ? (
              <>
                <span>
                  <i className="sw sw-profit" /> Ends above
                </span>
                <span>
                  <i className="sw sw-loss" /> Ends below
                </span>
                <span className="hint">Each box is a share's price: it pays $1 if the price ends past it on that date · drag to pan · scroll to zoom</span>
                <span className="hint-touch">Tap a box to bet · a share pays $1 if the price ends past it</span>
              </>
            ) : (
              <>
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
              </>
            )}
          </div>
        </section>

        {easy ? (
          <EasyPanel
            asset={asset}
            now={now}
            markets={markets}
            pending={pendingBet}
            stake={stake}
            onStake={setStake}
            onCancel={() => setPick(null)}
            onBuy={buyBet}
            bets={bets}
            onSell={(id) => void sellBet(id)}
            venue={
              trading
                ? { kind: 'live', trading, onBuyLive: buyBetLive }
                : accountEnabled
                  ? { kind: 'connect', onConnect: () => setAccountOpen(true) }
                  : { kind: 'paper' }
            }
          />
        ) : (
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
          trading={trading}
          onPlaced={onPlaced}
          positions={positions}
          compound={compound}
          onToggleCompound={toggleCompound}
          exchange={
            accountEnabled
              ? {
                  account: accountState,
                  positions: onExchange,
                  onConnect: () => setAccountOpen(true),
                  onClose: (pos) => void closeExchangePosition(pos),
                  onCancelOrder: (id, instrument) =>
                    void account?.cancel(id, instrument).catch((e) => setToast(`Couldn't cancel: ${(e as Error).message}`)),
                }
              : null
          }
          closed={closed}
          focus={focus}
          onFocus={(id) => {
            const p = allPositions.find((x) => x.id === id);
            if (p && p.asset !== asset) setAsset(p.asset);
            setFocus(focus.kind === 'position' && focus.id === id ? { kind: 'builder' } : { kind: 'position', id });
          }}
          onClosePosition={closePosition}
        />
        )}
      </main>
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}

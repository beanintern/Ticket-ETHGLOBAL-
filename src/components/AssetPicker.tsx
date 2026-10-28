import { useEffect, useMemo, useRef, useState } from 'react';
import type { AssetInfo } from '../data/types';
import { price as fmtPrice, signed } from '../lib/format';
import { priceDecimalsFor, type Asset } from '../lib/market';
import { TickFlash } from './TickFlash';

// Token logos, bundled (small enough to inline): src/assets/tokens/<TICKER>.png|jpg.
const LOGOS = Object.fromEntries(
  Object.entries(import.meta.glob('../assets/tokens/*.{png,jpg}', { eager: true, import: 'default' }) as Record<string, string>).map(([path, url]) => [
    path.split('/').pop()!.replace(/\.(png|jpg)$/, ''),
    url,
  ]),
);

/** A token's bundled logo URL, if there is one. */
export const tokenLogo = (asset: Asset): string | undefined => LOGOS[asset];

/** A token's logo, or a lettered badge in a colour of its own for one without a logo. */
export function TokenIcon({ asset, size = 20 }: { asset: Asset; size?: number }) {
  const [failed, setFailed] = useState(false);
  const src = LOGOS[asset];
  if (src && !failed) return <img className="token-icon" src={src} alt="" width={size} height={size} onError={() => setFailed(true)} />;
  const hue = [...asset].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 17);
  return (
    <span className="token-icon token-badge" style={{ width: size, height: size, background: `hsl(${hue} 45% 32%)`, fontSize: size * 0.42 }} aria-hidden="true">
      {asset.slice(0, asset.length > 3 ? 2 : 3)}
    </span>
  );
}

const pct = (c: number | null) => (c === null ? null : c * 100);

/**
 * The market picker: the current asset with its price and 24h change; opens a searchable list of
 * every asset with options on Derive.
 */
export function AssetPicker({ assets, current, pending, onPick }: { assets: AssetInfo[]; current: Asset; pending: Asset | null; onPick: (a: Asset) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return assets;
    // Ticker matches first, then name matches.
    const byTicker = assets.filter((a) => a.asset.toLowerCase().startsWith(q));
    const rest = assets.filter((a) => !byTicker.includes(a) && (a.asset.toLowerCase().includes(q) || a.name.toLowerCase().includes(q)));
    return [...byTicker, ...rest];
  }, [assets, query]);

  // Reset the search as part of opening (not in an effect after it), so typing straight away is kept.
  const toggle = () => {
    if (!open) {
      setQuery('');
      setActive(Math.max(0, assets.findIndex((a) => a.asset === current)));
    }
    setOpen(!open);
  };
  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => input.current?.focus());
    const away = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', away);
    return () => window.removeEventListener('pointerdown', away);
  }, [open]);
  const search = (q: string) => {
    setQuery(q);
    setActive(0);
  };
  useEffect(() => {
    list.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  const pick = (a: Asset) => {
    setOpen(false);
    onPick(a);
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(shown.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (shown[active]) pick(shown[active].asset);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
    }
  };

  const cur = assets.find((a) => a.asset === current);
  const curChange = pct(cur?.change24h ?? null);
  return (
    <div className="asset-picker" ref={root}>
      <button className={`asset-trigger ${open ? 'is-open' : ''}`} onClick={toggle} aria-haspopup="listbox" aria-expanded={open}>
        <TokenIcon asset={current} size={22} />
        <span className="asset-sym">{current}</span>
        {pending ? (
          <span className="asset-loading">Loading {pending}…</span>
        ) : (
          cur && (
            <>
              <TickFlash value={cur.spot} className="asset-px num">
                {fmtPrice(cur.spot, priceDecimalsFor(cur.spot))}
              </TickFlash>
              {curChange !== null && <span className={`num wide-only ${curChange >= 0 ? 'up' : 'down'}`}>{signed(curChange)}%</span>}
            </>
          )
        )}
        <svg className="caret" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </button>
      {open && (
        <div className="asset-pop" role="dialog" aria-label="Choose a market" onKeyDown={onKey}>
          <div className="asset-search">
            <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
              <circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" strokeWidth="1.6" />
              <path d="m11 11 3.5 3.5" stroke="currentColor" strokeWidth="1.6" />
            </svg>
            <input
              ref={input}
              value={query}
              onChange={(e) => search(e.target.value)}
              placeholder="Search markets"
              aria-label="Search markets"
              role="combobox"
              aria-controls="asset-list"
              aria-expanded="true"
              aria-activedescendant={shown[active] ? `asset-${shown[active].asset}` : undefined}
              spellCheck={false}
              autoComplete="off"
            />
          </div>
          <div className="asset-head" aria-hidden="true">
            <span>Market</span>
            <span>Price</span>
            <span>24h</span>
          </div>
          <ul className="asset-list" id="asset-list" role="listbox" ref={list}>
            {shown.map((a, i) => {
              const c = pct(a.change24h);
              return (
                <li
                  key={a.asset}
                  id={`asset-${a.asset}`}
                  role="option"
                  aria-selected={a.asset === current}
                  data-active={i === active}
                  className={`${i === active ? 'is-active' : ''} ${a.asset === current ? 'is-current' : ''}`}
                  onPointerEnter={() => setActive(i)}
                  onClick={() => pick(a.asset)}
                >
                  <span className="asset-name">
                    <TokenIcon asset={a.asset} size={22} />
                    <span>
                      <b>{a.asset}</b>
                      <small>{a.name}</small>
                    </span>
                  </span>
                  <span className="num">{a.spot ? fmtPrice(a.spot, priceDecimalsFor(a.spot)) : '–'}</span>
                  <span className={`num ${c === null ? 'muted' : c >= 0 ? 'up' : 'down'}`}>{c === null ? '–' : `${signed(c)}%`}</span>
                </li>
              );
            })}
            {!shown.length && <li className="asset-empty">No market matches “{query}”.</li>}
          </ul>
        </div>
      )}
    </div>
  );
}

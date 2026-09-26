# Ticket

An options trading UI that feels like trading perps. The chart is the ticket: click a future
expiry at a price to place a leg, and the P&L map shows where the position makes and loses money.

Market data can be **live from Derive** or **simulated (demo)**. Orders are paper trades in
both modes; nothing is signed or sent to Derive yet.

## Run it

```sh
npm install
npm run dev              # http://localhost:5173 (live Derive data)
                         # add ?source=mock to the URL for demo data
npm run build            # typecheck + production build
npm run build:artifact   # single-file HTML preview in dist-artifact/ticket.html (demo data)
```

### Market data: Live vs Demo

Switch with the **Live / Demo** control in the header, or `?source=live` / `?source=mock` in the
URL, or `VITE_SOURCE=live|mock` at build time. The default is live, except the single-file
preview build, which can't open network connections and always uses demo data.

- **Live** (`src/data/derive.ts`): Derive's public API over `wss://api.lyra.finance/ws`.
  Listed expiries and strikes, the index price (`spot_feed.<ASSET>`), ~40 days of hourly
  history (`public/get_spot_feed_history`), and each option's mark, bid, ask and IV
  (`public/get_tickers`, refreshed every 10 s). Read-only: no account or keys. Everything goes
  over the WebSocket because Derive's REST endpoints don't send CORS headers for other origins.
- **Demo** (`src/data/mock.ts`): generated price history, a random-walk index and a toy
  volatility smile. The automated chart check runs against this.

Both implement `MarketSource` / `Market` in `src/data/types.ts`; the rest of the app only talks
to that interface.

## Checks

```sh
npm run check:chart   # random positions vs an independent Black-Scholes calculation (demo data)
N=200 SEED=7 npm run check:chart
npm run check:live    # the live Derive layer against the real exchange
```

- `check:chart` places random positions and verifies, pixel by pixel, that leg dots, the P&L
  colours, the break-even line, the max profit/loss outlines, the uncapped tags and the Build
  panel all match an independent calculation. Failures are screenshotted to
  `check-chart-failures/`.
- `check:live` loads real Derive data with the app's own code and checks expiries, strikes,
  the index and history, that our pricing reproduces Derive's mark prices (within 0.5%), and
  that IV for unlisted strikes is interpolated sensibly.

## How it works

- **Chart** (`src/components/Chart.tsx`, canvas). Past price as candles left of *now*; the
  future shows the listed expiries. Click with a leg tool to add a leg at the snapped expiry and
  listed strike. Drag a leg to move it, right-click (or long-press on touch) to remove it. The
  future region is shaded by the position's P&L at each (time, price) point, with a break-even
  line, outlines where P&L is within 5% of its max profit / max loss, and hatching for
  open-ended losses. The strip next to the price axis shows P&L across price at the first
  expiry, or at the time under the cursor.
- **Build tab**. Strategy name, net debit/credit, max profit/loss, break-evens, chance of
  profit, greeks and an editable leg list. Presets for common structures.
- **Positions tab**. Paper fills with live P&L, a P&L sparkline since entry, progress toward
  max profit, and close. Stored per data source in the browser.
- **Pricing** (`src/lib/bs.ts`, `src/lib/strategy.ts`). Black-Scholes on the index price. With
  live data, each option's IV is the one that reproduces Derive's mark, so today's P&L matches
  exchange prices and the map projects forward from there.

Keys: `1`–`4` pick Buy Call / Sell Call / Buy Put / Sell Put, `V` or `Esc` for the pointer,
`Delete` removes the selected leg, `Ctrl/⌘ Z` undo. Scroll zooms time; shift-scroll or drag the
price axis for price; drag the chart to pan; double-click to reset.

## Next: trading on Derive

| Now | Next |
| --- | --- |
| paper fill at mark | signed order (or RFQ for multi-leg) with the builder code attached |
| positions in localStorage | account positions and fills for the subaccount |
| no account | wallet connection and a Derive session key |

Builder code details (how it's attached to orders, fee settings) still need confirming against
Derive's docs before that step.

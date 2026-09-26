# Ticket

An options trading UI that feels like trading perps. The chart is the ticket: click a future
expiry at a price to place a leg, and the P&L map shows where the position makes and loses money.

This is a **UI mockup**. Prices, the vol surface and fills are simulated in the browser.
Nothing talks to Derive yet.

## Run it

```sh
npm install
npm run dev          # http://localhost:5173
npm run build        # typecheck + production build
npm run build:artifact   # single-file HTML preview in dist-artifact/ticket.html
```

## How it works

- **Chart** (`src/components/Chart.tsx`, canvas). Past price as candles left of *now*; the
  future is a grid of Derive-style expiries (dailies, Friday weeklies, last-Friday monthlies,
  08:00 UTC). Click with a leg tool to add a leg at the snapped expiry and strike. Drag a leg
  to move it, right-click to remove it. The future region is shaded by the position's P&L at
  each (time, price) point, with a break-even line. The gutter next to the price axis shows
  P&L across price at the first expiry, or at the time under the cursor.
- **Build tab**. Strategy name, net debit/credit, max profit/loss, break-evens, chance of
  profit, greeks and an editable leg list. Presets for common structures.
- **Positions tab**. Paper fills with live P&L, a P&L sparkline since entry, progress toward
  max profit, and close. "Show on chart" puts a position's P&L map on the chart; "Include open
  positions" overlays the whole book while building a new trade.
- **Pricing** (`src/lib/bs.ts`, `src/lib/strategy.ts`). Black-Scholes with a toy smile
  (`src/lib/market.ts`).

Keys: `1`–`4` pick Buy Call / Sell Call / Buy Put / Sell Put, `V` or `Esc` for the pointer,
`Delete` removes the selected leg. Scroll zooms time; shift-scroll or drag the price axis
for price, double-click the axis to reset.

## Derive integration (next)

The mock pieces map onto Derive like this:

| Mock | Derive |
| --- | --- |
| `listExpiries`, strike grid | instruments list for `option` instruments per currency |
| `impliedVol`, `bsPrice` marks | ticker mark price, bid/ask and IV per instrument |
| simulated index feed | index price subscription over WebSocket |
| `placeOrder` paper fill | signed order (or RFQ for multi-leg) with the builder code attached |
| `positions` in localStorage | account positions and fills for the subaccount |

Builder code details (how it's attached to orders, fee settings) still need confirming
against Derive's docs before that step.

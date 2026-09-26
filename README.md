# Ticket

An options trading UI that feels like trading perps. The chart is the ticket: click a future
expiry at a price to place a leg, and the P&L map shows where the position makes and loses money.

Market data can be **live from Derive** (mainnet or testnet) or **simulated (demo)**. On testnet,
with a Derive account connected, orders are real (test funds) and carry the builder code;
everywhere else they're paper trades.

## Run it

```sh
npm install
npm run dev              # http://localhost:5173 (live Derive data)
                         # add ?source=mock to the URL for demo data
npm run build            # typecheck + production build
npm run build:artifact   # single-file HTML preview in dist-artifact/ticket.html (demo data)
```

### Deploy (Railway)

The repo is ready to deploy as a Railway service from GitHub; no environment variables are
required. To attach your builder code to orders, set `VITE_DERIVE_REFERRAL_CODE` (and optionally
`VITE_DERIVE_EXTRA_FEE`) as service variables. They're read at build time, so redeploy after
changing them.

- `railway.json` sets the build (`npm run build`), start (`npm start`) and health check
  (`/healthz`).
- `npm start` runs `server.mjs`, a dependency-free static server for `dist/` on `$PORT`, with
  long-lived caching for fingerprinted assets and a single-page-app fallback.
- The deployed app defaults to live Derive data: each visitor's browser connects to Derive's
  WebSocket directly, so the server only serves files. Add `?source=mock` for demo data, or set
  `VITE_SOURCE=mock` as a build variable to make demo the default.

To test the production build locally: `npm run build && npm start` (http://localhost:3000).

### Market data: Live, Testnet, Demo

Switch with the **Live / Testnet / Demo** control in the header, or `?source=live|testnet|mock`
in the URL, or `VITE_SOURCE=live|testnet|mock` at build time. The default is live, except the single-file
preview build, which can't open network connections and always uses demo data.

- **Live** (`src/data/derive.ts`): Derive's public API over `wss://api.lyra.finance/ws`.
  Listed expiries and strikes, the index price (`spot_feed.<ASSET>`), ~40 days of hourly
  history (`public/get_spot_feed_history`), and each option's mark, bid, ask and IV
  (`public/get_tickers`, refreshed every 10 s). Read-only: no account or keys. Everything goes
  over the WebSocket because Derive's REST endpoints don't send CORS headers for other origins.
- **Testnet** (same file, `DERIVE_TESTNET`): Derive's v3 testnet on Sepolia,
  `wss://testnet.api.derive.xyz/v3/ws`. Same data, with the v3 method names
  (`public/get_all_instruments`, and OHLC candles from `public/get_index_chart_data`). The
  testnet index follows the real one; its history only goes back a few months.
- **Demo** (`src/data/mock.ts`): generated price history, a random-walk index and a toy
  volatility smile. The automated chart check runs against this.

Both implement `MarketSource` / `Market` in `src/data/types.ts`; the rest of the app only talks
to that interface.

## Checks

```sh
npm run check:chart   # random positions vs an independent Black-Scholes calculation (demo data)
N=200 SEED=7 npm run check:chart
npm run check:live    # the live Derive layer against the real exchange
NETWORK=testnet npm run check:live
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

## Derive account (testnet)

In **Testnet** mode, **Connect** in the header links a Derive testnet account
(`src/account/derive.ts`, using Derive's TypeScript SDK, loaded only when you connect):

- Enter the wallet address that owns the account and a **session key** registered to it. The app
  refuses the wallet's own key. The session key signs the WebSocket login and orders in the
  browser; it's kept in sessionStorage, or localStorage if you tick "remember", and
  **Disconnect** forgets it.
- The account panel shows the subaccount, value, margin, collateral and whether the key's scopes
  allow trading. The Positions tab lists the subaccount's option positions (drawn on the chart
  like paper positions), other instruments and open orders, refreshed every 5 s.
- Test funds: Sepolia ETH from a faucet, then **Mint** test USDC and deposit at
  [testnet.app.derive.xyz/developers](https://testnet.app.derive.xyz/developers).

### Placing orders

With an account connected, **Review order** asks Derive for a dry run of every leg
(`private/order_quote`: validity, expected fill and fees) before anything is sent.

- **Market**: one immediate-or-cancel limit order per leg, priced up to 3% past the best bid/ask,
  so it fills now against the book or not at all.
- **Limit at mark**: one good-till-cancelled order per leg at the mark price. Cancel it from the
  Positions tab.

Legs are sent one at a time (`src/account/orders.ts`, `DeriveAccount.place`), and the app stops
at the first leg Derive rejects. Close on a Derive position sends reduce-only market orders for
each leg.

### Builder code

Set these as build variables, locally in `.env.local` or as Railway service variables:

```sh
VITE_DERIVE_REFERRAL_CODE=your-code   # your builder / referral code
VITE_DERIVE_EXTRA_FEE=0.1             # optional builder fee, USDC per contract
```

With a code set, every order carries `referral_code` and `extra_fee`, the review panel shows the
builder part of the fees, and Derive credits the fees to that code. Without one, orders go out
with no builder fee. Whether testnet fees count toward the broker program is something to confirm
with Derive.

## Next

- One RFQ for multi-leg structures, so all legs fill together at one price (`private/send_rfq` +
  `private/execute_quote`) instead of leg by leg.
- Mainnet: the same flow against `wss://api.derive.xyz/v3/ws`, once the market data moves from
  the v2 API to v3.

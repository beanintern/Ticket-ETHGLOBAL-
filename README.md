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
SEED=7 ONLY=113 npm run check:chart   # replay one case
npm run check:live    # the live Derive layer against the real exchange
NETWORK=testnet npm run check:live
npm run check:draw    # draws paths with the mouse and checks the position built from each
npm run check:easy    # Easy mode grid: boxes, share prices vs independent pricing, sizes, fees, $1 payout
```

- `check:chart` checks named structures (spreads, condors, butterflies, calendars, single
  options, each at several zooms and with the expiry at the chart's edge) and then random
  positions. For each it verifies, against an independent calculation, the leg dots, the P&L
  colours, the break-even line, the uncapped tags, the Build panel, and the max profit/loss
  zones: their value, their label, and that the outline follows the 95% contour over time,
  right up to each expiry (every contour point within 3 px of the outline, and no outline off the
  contour). The demo market is seeded from `SEED` and frozen (`?freeze=1`), so a run replays
  exactly; `ONLY=n` re-runs one case. Failures are screenshotted to `check-chart-failures/`.
- `check:draw` draws price paths on the chart with the mouse and checks that each builds call
  butterflies on listed strikes and expiries, that at each butterfly's expiry the legs still
  alive then pay most within half a wing of the path (independent pricing), that the path is
  shown as a guide, and that undo restores the previous ticket.
- `check:easy` checks the whole grid across assets and zooms (no overlapping boxes, columns
  ending on their expiries, edges on listed strikes, the right direction, and every box's
  share price against an independent spread valuation, exactly; boxes under 1¢ or over 99¢
  unavailable and unclickable), then bets on boxes above and below the price: the card's share
  price, the underlying positions listed, that a bet under the minimum can't be placed, that $X
  buys a Derive-sized order costing at most $X with fees, that shares pay exactly $1 / $0 /
  50¢, and that bets list and sell.
- `check:live` loads real Derive data with the app's own code and checks expiries, strikes,
  the index and history, that our pricing reproduces Derive's mark prices (within 0.5%), and
  that IV for unlisted strikes is interpolated sensibly.

## How it works

- **Chart** (`src/components/Chart.tsx`, canvas). Past price as candles left of *now*; the
  future shows the listed expiries. Click with a leg tool to add a leg at the snapped expiry and
  listed strike. Drag a leg to move it, right-click (or long-press on touch) to remove it. With
  two or more legs, a handle between them moves the whole structure at once: every leg shifts by
  the same strike offset and the same number of expiries, so a spread keeps its shape. The
  future region is shaded by the position's P&L at each (time, price) point, with a break-even
  line, outlines where P&L is within 5% of its max profit / max loss, and hatching for
  open-ended losses. The outlines are traced with the exact P&L, not the shading grid: time is
  sampled ever more finely approaching each expiry (where time value collapses and the boundary
  moves fastest), prices are checked at every strike (where payoffs peak), and steep stretches,
  tips and exits through the plot edge are refined, so the outline meets the expiry at the right
  price. The strip next to the price axis shows P&L across price at the first
  expiry, or at the time under the cursor.
- **Build tab**. Strategy name, net debit/credit, max profit/loss, break-evens, chance of
  profit, greeks and an editable leg list. Presets for common structures.
- **Positions tab**. Paper fills with live P&L, a P&L sparkline since entry, progress toward
  max profit, and close. Stored per data source in the browser.
- **Easy mode** (`src/lib/binary.ts`, `src/components/EasyPanel.tsx`). The header's Easy / Pro
  switch (or `?mode=easy`) turns the chart into a betting grid, in the style of Euphoria. Columns
  run from one listed expiry to the next; rows are bands between listed strikes on that expiry
  (merged until they're tall enough to tap), so boxes differ in size: near-dated strikes are
  finer. Each box is one bet: above the index, "ends above this band on that date"; below it,
  "ends below". The box shows the price of a share that pays $1 if right, which is also the
  market's implied chance (21¢ = 21%). Under the hood a bet is a call (or put) spread between the
  band's strikes, sized so the gap is $1 per share: it pays $1 past the far strike, $0 on the
  losing side and part-way inside the band. Prices are exact (a 0.8¢ share shows 0.8¢, never
  rounded up) and refresh with every market update.
  Only bets that can really trade are offered: share prices between 1¢ and 99¢, and on Derive
  data, the bought option must have a seller and the sold one a buyer (other boxes are faint
  and can't be clicked). Bets start at $10, or more where Derive's smallest order (0.1
  contracts) costs more (BTC bands are $1,000 wide). A stake buys what it would on Derive:
  contracts rounded down to Derive's 0.01 step, and Derive's fees included ($0.50 per option
  plus 0.03% of the index per contract, capped at 12.5% of the option's price). The card says
  when fees are a big part of a bet, which happens on cheap far-away shares. The card shows
  the share price, chance, shares, fees and payout, and **Show underlying positions** lists the
  exact options opened (instrument, side, size, price). Placed bets are outlined on their box
  with what went in and what they're worth now, and can be sold any time. There's no payoff map
  in Easy mode.

  On **Testnet** with a Derive account connected, bets are real orders (test funds). The card
  asks Derive for a dry run of both legs and shows the real price per share (spread and fees
  included) next to the fair price, sizing the bet so what you pay is the amount you entered.
  It warns when the book is thin (e.g. 51¢ for a 10% chance) and refuses a share that would cost
  more than $1. Buying sends both legs as immediate-or-cancel orders, the bought option first,
  so a half-filled bet leaves a bought option, never a naked sale. A filled bet is recorded at
  its fill prices (plus Derive's fee estimate) and tagged Derive; selling closes the sold leg
  first, then the bought one, reduce-only. Without an account, testnet bets are paper, with a
  link to connect. The builder code rides on every order as usual.
- **Draw path** (`src/lib/pathfit.ts`). Pick the Draw tool (`5`) and draw where you think price
  goes, left to right. On release the ticket becomes a position that pays off along that path:
  on each listed expiry the path spans (up to six, spread evenly, plus the next one if the path
  runs past the last), a call butterfly (+1 / −2 / +1, equal wings on listed strikes) is centred
  on the path's price at that date, with wings about half the expected move by then. The path
  stays on the chart as a dashed guide, the toast says what the position makes if price follows
  it, and undo restores the previous ticket. Legs can then be dragged like any others.
- **Compounding positions**. Tick positions in the Positions tab to add them to the chart
  together, on top of whatever is on the Build tab, so you can see a new trade against what you
  already hold. A Combined box shows their joint P&L, delta and max profit/loss. The toolbar's
  "Include open positions" switch ticks or unticks all of them.
- **Pricing** (`src/lib/bs.ts`, `src/lib/strategy.ts`). Black-Scholes on the index price. With
  live data, each option's IV is the one that reproduces Derive's mark, so today's P&L matches
  exchange prices and the map projects forward from there.

Keys: `1`–`4` pick Buy Call / Sell Call / Buy Put / Sell Put, `5` Draw path, `V` or `Esc` for the pointer,
`Delete` removes the selected leg, `Ctrl/⌘ Z` undo. Scroll zooms time; shift-scroll or drag the
price axis for price; drag the chart to pan; double-click to reset.

## Derive account (testnet)

In **Testnet** mode, **Connect** in the header opens the account panel (`src/account/`, using
Derive's TypeScript SDK, loaded only when you connect).

**Connect MetaMask** (`src/account/metamask.ts`):

1. MetaMask shares the address and switches to Sepolia, the chain Derive's testnet signs for.
2. The wallet signs a Derive login (EIP-191 over a timestamp; no transaction, no gas).
3. The app generates a session key in the browser, and the wallet authorises it with one EIP-712
   signature (`private/set_session_key`). The key is scoped to `trade:orderbook:all` and
   `trade:rfq:all` (it can't withdraw) and expires after 7 days. Before asking MetaMask to sign,
   the app checks that its typed data hashes to exactly the digest Derive verifies.

From then on the session key signs logins and orders without popups. It's saved in this browser
per wallet and reused on the next connect until it's within an hour of expiry. **Disconnect**
forgets it. The wallet's own key never leaves MetaMask. A wallet needs a Derive testnet account
first: get Sepolia ETH from a faucet, then **Mint** test USDC and deposit at
[testnet.app.derive.xyz/developers](https://testnet.app.derive.xyz/developers).

**Use an existing session key instead**: paste the wallet address and a session key you
registered elsewhere. The app refuses the wallet's own key.

Once connected, the panel shows the subaccount, value, margin, collateral and whether the key can
trade. The Positions tab lists the subaccount's option positions (drawn on the chart like paper
positions), other instruments and open orders, refreshed every 5 s.

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

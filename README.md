# Ticket

An options trading UI that feels like trading perps. The chart is the ticket: click a future
expiry at a price to place a leg, and the P&L map shows where the position makes and loses money.

Market data can be **live from Derive** (mainnet or testnet, both on Derive's v3 API) or
**simulated (demo)**. With a Derive account connected, orders are real and carry the builder code:
real USDC on **Live** (mainnet), test funds on **Testnet**. Without an account, and in Demo,
they're paper trades.

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

- **Live** (`src/data/derive.ts`): Derive's v3 mainnet API over `wss://api.derive.xyz/v3/ws`.
  Listed expiries and strikes (`public/get_all_instruments`, skipping ones not yet active), the
  index price (`spot_feed.<ASSET>`), OHLC candles (`public/get_index_chart_data`: hourly for 40
  days, daily for the year before), and each option's mark, bid, ask and IV
  (`public/get_tickers`, refreshed every 10 s). Market data needs no account or keys. Everything
  goes over the WebSocket because Derive's REST endpoints don't send CORS headers for other origins.
- **Testnet** (same file, `DERIVE_TESTNET`): Derive's v3 testnet on Sepolia,
  `wss://testnet.api.derive.xyz/v3/ws`. Same API and data; the testnet index follows the real
  one, but its history only goes back a few months.
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
npm run check:rfq     # Easy mode's RFQ preview and fee estimate against Derive's real RFQ trades
npm run check:deposit # the in-app deposit against Derive's real contracts (nothing is sent)
NETWORK=testnet npm run check:deposit
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
- `check:easy` checks the whole grid across assets and zooms: no overlapping boxes, columns
  ending on their expiries, edges on listed strikes, boxes reaching past every edge of the visible
  chart, the right direction, and every box's fair price and preview against an independent
  calculation (only boxes under 0.2¢ fair or over 99¢ preview unavailable, and unclickable). Then
  it bets on boxes above and below the price: the card's preview, the underlying positions, that
  a bet under the minimum can't be placed, that a paper bet fills at the preview's leg prices and
  costs at most $X with RFQ fees on a Derive-sized order, that shares pay exactly $1 / $0 / 50¢,
  and that bets list and sell.
- `check:live` loads real Derive data with the app's own code and checks expiries, strikes,
  the index and history, that our pricing reproduces Derive's mark prices (within 0.5%), and
  that IV for unlisted strikes is interpolated sensibly.
- `check:rfq` takes Derive mainnet's last 30 days of two-leg vertical spreads traded by RFQ and
  checks the app's preview (`rfqEdge`) was at least what the taker paid over mark in 95%+ of them,
  for ETH and BTC, and that the RFQ fee estimate is never below the fee Derive charged.
- `check:deposit` runs the app's deposit code with a wallet that records transactions instead of
  sending them, then replays each deposit with `eth_call` against Derive's real contracts (USDC
  balance and allowance set by state override). It must succeed, revert without the approval,
  and refuse less than Derive's minimum.

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
  finer. Every box even partly on screen is built (the column running off the right edge, the
  bands crossing the top and bottom), labelled in its visible part, so none pop in while panning.
  Each box is one bet: above the index, "ends above this band on that date"; below it, "ends
  below". Under the hood a bet is a call (or put) spread between the band's strikes, sized so the
  gap is $1 per share: it pays $1 past the far strike, $0 on the losing side and part-way inside
  the band. Its fair price per share is the market's implied chance (21¢ = 21%).

  **Bets trade by RFQ**, so every listed band can be bet on, book or no book: market makers quote
  the whole spread as one package, which fills whole or not at all. Before anyone asks there's no
  firm price, so each box shows a **preview**: the fair price plus a markup set on the expensive
  side of where makers quote, max($0.10, 1.5% × √(spread's fair price × index)) per contract.
  Against Derive mainnet's two-leg vertical spreads taken by RFQ over 30 days (634 trades), the
  preview was at least what the taker paid in about 98% of them, typically 1–2¢ a share above it
  (`npm run check:rfq` re-runs this). The firm quote is usually better than what you saw, rarely
  worse. Boxes are blank only under 0.2¢ fair (nothing to price) or over 99¢ preview (nothing to
  win). Bets start at $10, or more where Derive's smallest order (0.1 contracts) costs more. A
  stake is sized at the preview with fees included: contracts rounded down to Derive's 0.01 step;
  RFQ fees estimated high (Derive charges one $0.50 base fee plus, per contract, min(0.03% of the
  index, 12.5% of the price) on the dearer leg only; the estimate charges both, plus any builder
  fee on each leg). The card shows the preview, the fair price and chance, shares, fees (at most)
  and payout; **Show underlying positions** lists the two options at the preview's leg prices.
  Placed bets are outlined on their box with what went in and what they're worth now.

  With a Derive account connected, bets are real: real USDC on **Live**, test funds on
  **Testnet**. **Buy** sends an RFQ for the spread and collects quotes for a few seconds. If the
  best costs no more than the preview (fees included), it fills at once; if it's more, the card
  shows the real price and asks ("Buy at $Y" or "Don't buy"); if nobody quotes, it says so. On
  Live, Buy first takes a confirming click saying how much USDC at most. **Sell** works the same
  way the other way round: the button shows a conservative bid (fair value less the same markup
  and fees), sells at once if a quote meets it, and asks otherwise. Without an account, bets are
  paper: filled at the preview and sold at the bid shown, never better than a real RFQ would be.
  The builder code rides on every RFQ.
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

## Derive account (mainnet or testnet)

In **Live** or **Testnet** mode, **Connect** in the header opens the account panel (`src/account/`,
using Derive's TypeScript SDK, loaded only when you connect). On Live it's your real Derive
account, trading real USDC: the panel, order review and Easy bet card say so. Each network keeps
its own saved keys (`src/account/network.ts` holds what differs between them).

**Connect MetaMask** (`src/account/metamask.ts`):

1. MetaMask shares the address and switches to the chain Derive signs for: Ethereum for
   mainnet, Sepolia for the testnet.
2. The wallet signs a Derive login (EIP-191 over a timestamp; no transaction, no gas).
3. The app generates a session key in the browser, and the wallet authorises it with one EIP-712
   signature (`private/set_session_key`). The key is scoped to `trade:orderbook:all` and
   `trade:rfq:all` (it can't withdraw) and expires after 7 days. Before asking MetaMask to sign,
   the app checks that its typed data hashes to exactly the digest Derive verifies.

From then on the session key signs logins and orders without popups. It's saved in this browser
per wallet and reused on the next connect until it's within an hour of expiry. **Disconnect**
forgets it. The wallet's own key never leaves MetaMask. A wallet needs a Derive account on that
network first, which a deposit creates (below).

### Deposits (`src/account/deposit.ts`, `src/components/DepositForm.tsx`)

USDC goes from the wallet into Derive without leaving the app: **New to Derive? Deposit USDC**
in the connect panel creates the account, and **Deposit USDC** in the account panel tops up the
connected subaccount. It's two transactions the wallet signs and pays gas for, on Ethereum
(mainnet) or Sepolia (testnet), through the SDK's contract-call deposit:

1. `approve` Derive's ActionManager to pull the USDC (skipped if already allowed);
2. `depositToNewSubaccount` (first deposit: creates the account under the margin manager for
   ETH and BTC options) or `deposit` (into the connected subaccount).

Which token, protocol asset, manager and minimum to use come from Derive's
`public/get_risk_universes` at the time, not constants: today USDC
(`0xA0b8…eB48` on Ethereum), manager 1 (standard margin, ETH/BTC options and perps), $5
minimum. The form shows the wallet's USDC and ETH (for gas), refuses less than the minimum or
more than the balance, checks a connected account's deposit comes from its owner wallet, links
the transaction, and polls `public/get_pending_deposits` until Derive credits it. Test USDC for
the testnet still comes from Derive's faucet at
[testnet.app.derive.xyz/developers](https://testnet.app.derive.xyz/developers).

**Use an existing session key instead**: paste the wallet address and a session key you
registered elsewhere. The app refuses the wallet's own key.

Once connected, the panel shows the subaccount, value, margin, collateral and whether the key can
trade. The Positions tab lists the subaccount's option positions (drawn on the chart like paper
positions), other instruments and open orders, refreshed every 5 s.

### Placing orders

With an account connected, **Review order** (marked **Real money** on Live) asks Derive for a dry run of every leg
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
VITE_DERIVE_REFERRAL_CODE=your-code   # your builder / referral code (case sensitive)
VITE_DERIVE_EXTRA_FEE=0.1             # optional builder fee, USDC per order (0.000001–1000)
```

With a code set, every order carries `referral_code` and `extra_fee`, the review panel shows the
builder part of the fees, and Derive credits the fees to that code. Without one, orders go out
with no builder fee. `extra_fee` is a fixed amount per order (per leg trade in an RFQ), not per
contract: Derive's max-fee rule divides it by the order's amount, and its public trade history shows
it charged on each leg of an RFQ. Builder fees need the code registered in Derive's
[API Broker program](https://docs.derive.xyz/integrators/programs/api-broker-program), applied
for within two weeks of the first referred trade; fees are paid to the registered Derive wallet
every four weeks.

### Fee cap on each order

Each order is signed with a `max_fee` per contract (`maxFee` in `src/account/orders.ts`) from
Derive's rule: `2 × taker rate × max(index, limit)`, with 1.5× headroom, plus the base fee and any
builder fee spread over the smallest fill Derive allows (0.1 contracts). The SDK's default
(3 × (taker rate × index + base fee)) is below what Derive requires for small orders, which it
would reject as `signed_max_fee_too_low`. The cap is a ceiling; what's charged is Derive's fee
schedule.

## Derive's terms and requirements

What this app does about them, as of October 2026:

- **Who may use Derive.** Derive's [Terms of Use](https://www.derive.xyz/terms-of-use) (updated
  23 Sep 2026) exclude US, Canadian, Australian and Panamanian residents and citizens (tax
  residents too), people in sanctioned or listed countries, under-18s, and anyone using a VPN or
  proxy to get around this; in the UK only investment professionals and high-net-worth
  investors. On mainnet the account panel asks the user to confirm this and agree to the Terms
  before connecting or depositing (`src/components/Eligibility.tsx`, remembered per browser until
  the Terms change). It's a self-declaration: the app doesn't geo-block by IP itself.
- **Market data.** Derive's [Data Usage Policy](https://www.derive.xyz/data-usage-policy) (30 Jun
  2026) limits Derive data to personal or internal use; showing it in a commercial trading app
  for others needs Lyra Technologies' prior written consent or a separate agreement. **Get this
  from Derive (e.g. alongside the API Broker application) before running this publicly.** The app
  credits Derive as the source of its market data.
- **Name and marks.** "Derive" is used only to say where orders and data go; no Derive logos.
  Using Derive's marks otherwise needs their consent.
- **Builder fees.** See above: register the code with the API Broker program within two weeks of
  the first referred trade.

## Next

- One RFQ for multi-leg structures, so all legs fill together at one price (`private/send_rfq` +
  `private/execute_quote`) instead of leg by leg.

// Backtests Easy mode's RFQ preview (src/lib/binary.ts: rfqEdge) against real RFQ trades on Derive
// mainnet, and checks the RFQ fee rule the app's fee estimates assume.
//
//   npm run check:rfq
//
// From Derive's public trade history (last 30 days of ETH and BTC options), it takes every
// two-leg vertical spread a taker bought or sold by RFQ, and for each asks: would the preview
// (fair price plus rfqEdge) have been at least as expensive as what the taker actually paid
// over mark? The preview is meant to be on the expensive side, so the firm quote is usually
// better: this fails if it covers less than 95% of trades for either asset.
// It also checks the fee rule: a taker pays a $0.50 base fee plus min(0.03% × index,
// 12.5% × price) per contract on one leg, plus any builder fee (extra_fee) on each leg; the app's
// estimate (both legs, plus the builder fee each trade carried) must never be lower.
import { createServer } from 'vite';
import { DeriveClient } from '@derivexyz/derive-ts';

const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
const { rfqEdge, rfqFee } = await vite.ssrLoadModule('/src/lib/binary.ts');
const MIN_COVER = 0.95;

const c = new DeriveClient({ network: 'mainnet' });
await c.connect();
const now = Date.now();
let trades = [];
for (const currency of ['ETH', 'BTC']) {
  for (let page = 1; page <= 10; page++) {
    const r = await c.send('public/get_trade_history', { currency, instrument_type: 'option', from_timestamp: now - 30 * 864e5, to_timestamp: now, page, page_size: 1000 });
    trades = trades.concat(r.trades);
    if (page >= r.pagination.num_pages) break;
  }
}
await c.close();

const N = Number;
const blocks = new Map();
for (const t of trades.filter((t) => t.rfq_id && t.liquidity_role === 'taker')) {
  const k = `${t.rfq_id}|${t.subaccount_id}`;
  if (!blocks.has(k)) blocks.set(k, []);
  blocks.get(k).push(t);
}
// Vertical spreads, like Easy bets: same expiry and type, one leg bought, one sold.
const spreads = [...blocks.values()].filter((g) => {
  if (g.length !== 2 || g[0].direction === g[1].direction) return false;
  const [a, b] = g.map((t) => t.instrument_name.split('-'));
  return a[1] === b[1] && a[3] === b[3];
});
console.log(`${trades.length} option trades in 30 days · ${spreads.length} two-leg vertical spreads taken by RFQ\n`);

const q = (a, p) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))];
let failed = 0;
let feeMisses = 0;
for (const cur of ['ETH', 'BTC']) {
  const rows = spreads
    .filter((g) => g[0].instrument_name.startsWith(cur))
    .map((g) => {
      // The package from the taker's side: what was paid over mark, per contract.
      let paid = 0;
      let mark = 0;
      for (const t of g) {
        const s = t.direction === 'buy' ? 1 : -1;
        paid += s * N(t.trade_price);
        mark += s * N(t.mark_price);
      }
      const amt = N(g[0].trade_amount);
      const S = N(g[0].index_price);
      // A sold spread is the bought one reversed: its mark-to-paid gap is measured the other way.
      const over = mark >= 0 ? paid - mark : mark - paid;
      const fee = g.reduce((a, t) => a + N(t.trade_fee), 0);
      // Other builders' fees ride on some trades, a fixed amount on each leg: count them as the app counts its own.
      const estimate = rfqFee(amt, g.map((t) => N(t.trade_price)), S, Math.max(...g.map((t) => N(t.extra_fee))));
      if (fee > estimate + 1e-6) {
        feeMisses++;
        if (process.env.DEBUG) console.log('   fee miss', g.map((t) => `${t.direction} ${t.trade_amount} ${t.instrument_name} @ ${t.trade_price} fee ${t.trade_fee} extra ${t.extra_fee} idx ${t.index_price}`).join(' + '), `→ charged ${fee.toFixed(4)}, estimate ${estimate.toFixed(4)}`);
      }
      return { over, preview: rfqEdge(Math.abs(mark), S), width: Math.abs(N(g[0].instrument_name.split('-')[2]) - N(g[1].instrument_name.split('-')[2])) };
    });
  if (!rows.length) continue;
  const cover = rows.filter((r) => r.preview >= r.over).length / rows.length;
  const extra = q(rows.map((r) => ((r.preview - r.over) / r.width) * 100), 0.5);
  const ok = cover >= MIN_COVER;
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${cur}: preview at least what was paid in ${(cover * 100).toFixed(1)}% of ${rows.length} spreads (need ${MIN_COVER * 100}%) · typically ${extra.toFixed(1)}¢ a share above it`);
}
console.log(`${feeMisses ? 'FAIL' : 'ok  '} fee estimate never below the fee Derive charged${feeMisses ? ` (below it on ${feeMisses} spreads)` : ''}`);
if (feeMisses) failed++;
await vite.close();
process.exit(failed ? 1 : 0);

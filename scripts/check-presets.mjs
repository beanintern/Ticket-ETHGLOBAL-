// Checks every strategy preset (the Build tab's template trades) in the chart, the way a user gets
// there: pick the market in the header, click the preset, then look at it at every zoom, panned
// and stretched vertically, panned in time, and on a phone-sized screen. Each view goes through
// the same verifier as check:chart (leg dots, P&L colours, break-even, max profit / loss outlines,
// tags, Build panel), and the page must not throw.
//
//   npm run check:presets
//   ASSETS=ETH,PUMP npm run check:presets      # some markets only
import { chromium } from 'playwright';
import { preview } from 'vite';
import { mkdirSync } from 'node:fs';
import { inspect } from './chart-inspect.mjs';

const DAY = 864e5;
const OUT = process.env.OUT ?? 'check-presets-failures';
const ASSETS = (process.env.ASSETS ?? 'ETH,BTC,SOL,ADA,PUMP').split(',');
const PRESETS = ['Call spread', 'Put spread', 'Straddle', 'Strangle', 'Iron condor', 'Chaos'];
const HORIZONS = { '1D': 1, '1W': 7, '3W': 21, '2M': 60, '6M': 182, '1Y': 365 };
// Beyond the zoom buttons: stretched, squeezed and panned vertically; panned in time.
const VIEWS = [
  ['zoomed in', { yZoom: 0.5 }],
  ['zoomed out', { yZoom: 2 }],
  ['panned up', { yShift: 0.3 }],
  ['panned down', { yShift: -0.3 }],
  ['now at left', { nowFrac: 0.15 }],
  ['now at right', { nowFrac: 0.7 }],
];
const SCREENS = [
  ['desktop', { width: 1440, height: 860 }],
  ['phone', { width: 390, height: 844 }],
];

const server = await preview({ preview: { port: 4181 }, logLevel: 'warn' });
const url = server.resolvedUrls.local[0];
const browser = await chromium.launch();
let failed = 0;
let total = 0;
let samples = 0;
for (const [screen, viewport] of SCREENS) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => {
    window.__TICKET_TEST__ = true;
    localStorage.setItem('ticket.mode', 'pro');
  });
  await page.goto(`${url}?source=mock&freeze=1`);
  await page.waitForFunction(() => window.__ticket && window.__chart);
  const phone = viewport.width < 600;
  for (const asset of ASSETS) {
    await page.click('.asset-trigger');
    await page.fill('.asset-search input', asset.toLowerCase());
    await page.keyboard.press('Enter');
    await page.waitForFunction((a) => window.__chart?.asset === a, asset);
    for (const preset of PRESETS) {
      // Fewer views on the phone: the zooms people use there.
      const zooms = phone ? ['1W', '3W', '2M'] : Object.keys(HORIZONS);
      const views = [...zooms.map((z) => [z, null]), ...(phone ? [] : VIEWS.map(([n, v]) => [`2M ${n}`, v]))];
      for (const [name, extra] of views) {
        total++;
        await page.getByRole('tab', { name: 'Build' }).click();
        await page.getByRole('button', { name: preset, exact: true }).click();
        // Each view starts from the default (no pan, no stretch), as after a double-click.
        await page.evaluate(() => window.__ticket.setView({ horizon: 21 * 864e5, yZoom: 1, yShift: 0 }));
        const zoom = name.slice(0, 2);
        await page.getByRole('group', { name: 'Time horizon' }).getByRole('button', { name: zoom, exact: true }).click();
        if (extra) await page.evaluate((v) => window.__ticket.setView({ horizon: 60 * 864e5, yZoom: 1, yShift: 0, ...v }), extra);
        // Keep the cursor (and its tooltip) off the chart.
        await page.mouse.move(viewport.width - 5, viewport.height - 5);
        await page.waitForTimeout(150);
        const res = await page.evaluate(inspect);
        const legs = await page.evaluate(() => window.__chart.legs.length);
        if (!legs) res.failures.push('the preset added no legs');
        if (errors.length) res.failures.push(`page error: ${errors.splice(0).join('; ')}`);
        samples += res.colourSamples;
        const label = `${screen} ${asset} ${preset} · ${name} (${legs} legs)`;
        if (res.failures.length) {
          failed++;
          mkdirSync(OUT, { recursive: true });
          const file = `${OUT}/${screen}-${asset}-${preset}-${name}.png`.replace(/ /g, '_');
          await page.screenshot({ path: file });
          console.log(`FAIL ${label}  → ${file}`);
          for (const f of res.failures.slice(0, 6)) console.log(`     - ${f}`);
        } else if (process.env.VERBOSE) console.log(`ok   ${label}`);
        if (process.env.SHOTS && name === '2M' && asset === ASSETS[0]) {
          mkdirSync(process.env.SHOTS, { recursive: true });
          await page.screenshot({ path: `${process.env.SHOTS}/${screen}-${preset.replace(/ /g, '_')}.png` });
        }
      }
    }
    console.log(`${screen} ${asset}: done`);
  }
  await page.close();
}
console.log(`\n${total - failed}/${total} preset views passed · ${samples} colour samples checked`);
if (failed) console.log(`Screenshots of failures in ./${OUT}/`);
await browser.close();
await server.httpServer.close();
process.exit(failed ? 1 : 0);

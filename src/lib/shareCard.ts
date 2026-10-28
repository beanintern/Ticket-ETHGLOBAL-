// The share card for a trade: a 1200×630 image (the size social sites preview), drawn on a canvas
// so it can be downloaded or shared as a picture. In order of emphasis: the multiple, the price
// target, the date; then how far the price has to move, the chance, a small chart with the
// target on it, and optionally the size; the referral link along the bottom.
import type { Asset } from './market';
import { fmtStrike, price as fmtPrice } from './format';

export interface ShareData {
  asset: Asset;
  dir: 'above' | 'below';
  /** The price target. */
  level: number;
  /** Settles at this time (ms). */
  expiry: number;
  /** What it pays back if right, as a multiple of the stake, fees included. */
  multiple: number;
  /** The market's chance it's right, when known (at entry). */
  chance?: number;
  /** The index when the trade was made. */
  spot: number;
  /** Put in and paid out if right, USD (shown only if asked). */
  stake: number;
  payout: number;
  /** Recent closes for the chart, oldest first. */
  closes: { t: number; c: number }[];
  /** Token logo URL, if bundled. */
  logo?: string;
}

export interface ShareOptions {
  showSize: boolean;
  /** The referral link to print, or null for none. */
  link: string | null;
}

export const CARD_W = 1200;
export const CARD_H = 630;

const GREEN = [46, 201, 139];
const RED = [239, 90, 85];
const SANS = 'Geist, Inter, system-ui, -apple-system, sans-serif';
const MONO = "'Geist Mono', ui-monospace, SFMono-Regular, Menlo, monospace";

/** "6.2×" / "25×", rounded down (the least it pays). */
export function multipleText(m: number): string {
  return m >= 10 ? `${Math.floor(m)}×` : `${(Math.floor(m * 10) / 10).toFixed(1)}×`;
}
export const targetText = (d: Pick<ShareData, 'asset' | 'dir' | 'level'>) => `${d.asset} ${d.dir} $${fmtStrike(d.level)}`;
export const dateText = (expiry: number) =>
  `by ${new Date(expiry).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })} · 08:00 UTC`;

const loadImage = (src: string) =>
  new Promise<HTMLImageElement | null>((res) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => res(null);
    img.src = src;
  });

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

/** A text that fits `maxW`: the font size shrinks until it does. */
function fitFont(ctx: CanvasRenderingContext2D, text: string, weight: number, size: number, family: string, maxW: number) {
  let s = size;
  ctx.font = `${weight} ${s}px ${family}`;
  while (s > 12 && ctx.measureText(text).width > maxW) {
    s -= 2;
    ctx.font = `${weight} ${s}px ${family}`;
  }
  return s;
}

/** Draws the card onto `canvas` (sized for `scale`× pixels). */
export async function drawShareCard(canvas: HTMLCanvasElement, d: ShareData, o: ShareOptions, scale = 2) {
  await Promise.all([document.fonts?.load(`700 200px ${SANS}`), document.fonts?.load(`600 30px ${MONO}`)].map((p) => p?.catch(() => null)));
  const logo = d.logo ? await loadImage(d.logo) : null;
  canvas.width = CARD_W * scale;
  canvas.height = CARD_H * scale;
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  const tone = (d.dir === 'above' ? GREEN : RED).join(',');

  // Background: near-black with a glow in the trade's colour.
  ctx.fillStyle = '#0b0e13';
  ctx.fillRect(0, 0, CARD_W, CARD_H);
  const glow = ctx.createRadialGradient(240, 250, 20, 240, 250, 720);
  glow.addColorStop(0, `rgba(${tone},0.22)`);
  glow.addColorStop(1, `rgba(${tone},0)`);
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, CARD_W, CARD_H);
  ctx.strokeStyle = 'rgba(148,163,190,0.06)';
  ctx.lineWidth = 1;
  for (let x = 0; x <= CARD_W; x += 60) {
    ctx.beginPath();
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, CARD_H);
    ctx.stroke();
  }
  for (let y = 0; y <= CARD_H; y += 60) {
    ctx.beginPath();
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(CARD_W, y + 0.5);
    ctx.stroke();
  }

  // Brand, top left; the market, top right.
  ctx.fillStyle = `rgb(${GREEN.join(',')})`;
  roundRect(ctx, 72, 52, 34, 16, 5);
  ctx.fill();
  ctx.fillStyle = `rgb(${RED.join(',')})`;
  roundRect(ctx, 72, 72, 34, 16, 5);
  ctx.fill();
  ctx.fillStyle = '#e3e7ee';
  ctx.font = `700 34px ${SANS}`;
  ctx.textBaseline = 'middle';
  ctx.fillText('Ticket', 120, 71);
  ctx.font = `600 30px ${MONO}`;
  const assetW = ctx.measureText(d.asset).width;
  ctx.fillText(d.asset, CARD_W - 72 - assetW, 71);
  if (logo) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(CARD_W - 72 - assetW - 32, 71, 20, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(logo, CARD_W - 72 - assetW - 52, 51, 40, 40);
    ctx.restore();
  }

  // 1. The multiple.
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = `rgb(${tone})`;
  fitFont(ctx, multipleText(d.multiple), 800, 210, SANS, 600);
  ctx.fillText(multipleText(d.multiple), 66, 300);
  // 2. The price target.
  ctx.fillStyle = '#f2f4f8';
  const target = `If ${targetText(d)}`;
  fitFont(ctx, target, 700, 62, SANS, 620);
  ctx.fillText(target, 72, 384);
  // 3. The date.
  ctx.fillStyle = '#93a0b4';
  ctx.font = `500 32px ${SANS}`;
  ctx.fillText(dateText(d.expiry), 72, 436);

  // Pills: how far it has to move, the chance, and (if chosen) the size.
  const move = d.level / d.spot - 1;
  const pills = [
    `${move >= 0 ? '+' : '−'}${Math.abs(move * 100).toFixed(1)}% from $${fmtPrice(d.spot, d.spot >= 10_000 ? 0 : d.spot >= 10 ? 2 : 4)}`,
    ...(d.chance !== undefined ? [`${d.chance * 100 >= 10 ? Math.round(d.chance * 100) : (d.chance * 100).toFixed(1)}% chance`] : []),
    ...(o.showSize ? [`$${Math.round(d.stake).toLocaleString('en-US')} → $${Math.floor(d.payout).toLocaleString('en-US')} if right`] : []),
  ];
  ctx.font = `600 24px ${MONO}`;
  let px = 72;
  for (const p of pills) {
    const w = ctx.measureText(p).width + 36;
    if (px + w > CARD_W - 72) break;
    ctx.fillStyle = 'rgba(227,231,238,0.06)';
    roundRect(ctx, px, 478, w, 48, 24);
    ctx.fill();
    ctx.strokeStyle = 'rgba(227,231,238,0.14)';
    ctx.stroke();
    ctx.fillStyle = '#d6dbe4';
    ctx.textBaseline = 'middle';
    ctx.fillText(p, px + 18, 503);
    px += w + 12;
  }

  // A small chart of the recent price, with the target across it.
  const cx0 = 760;
  const cx1 = CARD_W - 72;
  const cy0 = 150;
  const cy1 = 430;
  const pts = d.closes.filter((p) => Number.isFinite(p.c));
  if (pts.length > 2) {
    const lo = Math.min(d.level, ...pts.map((p) => p.c));
    const hi = Math.max(d.level, ...pts.map((p) => p.c));
    const pad = (hi - lo) * 0.12 || hi * 0.01;
    const yOf = (v: number) => cy1 - ((v - (lo - pad)) / (hi + pad - (lo - pad))) * (cy1 - cy0);
    const t0 = pts[0].t;
    const t1 = pts[pts.length - 1].t;
    const xOf = (t: number) => cx0 + ((t - t0) / (t1 - t0 || 1)) * (cx1 - 60 - cx0);
    const area = ctx.createLinearGradient(0, cy0, 0, cy1);
    area.addColorStop(0, 'rgba(227,231,238,0.14)');
    area.addColorStop(1, 'rgba(227,231,238,0)');
    ctx.beginPath();
    ctx.moveTo(xOf(pts[0].t), cy1);
    for (const p of pts) ctx.lineTo(xOf(p.t), yOf(p.c));
    ctx.lineTo(xOf(t1), cy1);
    ctx.closePath();
    ctx.fillStyle = area;
    ctx.fill();
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(xOf(p.t), yOf(p.c)) : ctx.moveTo(xOf(p.t), yOf(p.c))));
    ctx.strokeStyle = '#e3e7ee';
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    ctx.stroke();
    // Now, and the target.
    const nx = xOf(t1);
    const ny = yOf(pts[pts.length - 1].c);
    ctx.fillStyle = '#e3e7ee';
    ctx.beginPath();
    ctx.arc(nx, ny, 7, 0, Math.PI * 2);
    ctx.fill();
    const ty = yOf(d.level);
    ctx.setLineDash([10, 8]);
    ctx.strokeStyle = `rgba(${tone},0.95)`;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(cx0, ty);
    ctx.lineTo(cx1, ty);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = `600 22px ${MONO}`;
    const label = `$${fmtStrike(d.level)}`;
    const lw = ctx.measureText(label).width + 20;
    ctx.fillStyle = `rgb(${tone})`;
    roundRect(ctx, cx1 - lw, ty + (d.dir === 'above' ? -40 : 10), lw, 30, 6);
    ctx.fill();
    ctx.fillStyle = '#0b0e13';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, cx1 - lw + 10, ty + (d.dir === 'above' ? -25 : 25));
  }

  // Footer: the referral link (or just the site), and what it's built on.
  ctx.fillStyle = 'rgba(227,231,238,0.08)';
  ctx.fillRect(0, CARD_H - 70, CARD_W, 1);
  ctx.textBaseline = 'middle';
  ctx.font = `500 24px ${MONO}`;
  ctx.fillStyle = '#93a0b4';
  const foot = o.link ? `Trade it with my link: ${o.link.replace(/^https?:\/\//, '')}` : 'Trade options simply on Ticket';
  fitFont(ctx, foot, 500, 24, MONO, 820);
  ctx.fillText(foot, 72, CARD_H - 35);
  ctx.font = `500 22px ${SANS}`;
  const right = 'Options on Derive';
  ctx.fillStyle = '#6b778a';
  ctx.fillText(right, CARD_W - 72 - ctx.measureText(right).width, CARD_H - 35);
}

/** The words that go with a share: the multiple, the target, the date. */
export const shareText = (d: ShareData) => `${multipleText(d.multiple)} if ${targetText(d)} ${dateText(d.expiry).replace(' · 08:00 UTC', '')}.`;

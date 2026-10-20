export function usd(n: number, dec = 2): string {
  if (!isFinite(n)) return '—';
  return `$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec })}`;
}

export function signedUsd(n: number, dec = 2): string {
  if (!isFinite(n)) return '—';
  const s = usd(n, dec);
  if (Math.abs(n) < 0.5 * 10 ** -dec) return s;
  return n > 0 ? `+${s}` : `−${s}`;
}

export function price(n: number, dec: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

export function compactUsd(n: number): string {
  const a = Math.abs(n);
  const sign = n < 0 ? '−' : '';
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e4) return `${sign}$${(a / 1e3).toFixed(1)}k`;
  // Under a cent (an option on a tiny-priced token), show the significant digits.
  if (a > 0 && a < 0.01) return `${sign}$${Number(a.toPrecision(2))}`;
  return `${sign}$${a.toFixed(a >= 100 ? 0 : 2)}`;
}

/**
 * A strike or level with just the decimals it needs: 63,000 · 2,525 · 1.7 · 0.0035. Large values
 * get thousands separators; small ones keep their significant digits.
 */
export function fmtStrike(n: number): string {
  const a = Math.abs(n);
  const dec = a >= 1000 ? 0 : a >= 1 ? 2 : Math.min(8, 2 - Math.floor(Math.log10(a || 1)) + 1);
  return Number(n.toFixed(dec)).toLocaleString('en-US', { maximumFractionDigits: dec });
}

/** Decimals for axis labels spaced `step` apart (the step's own decimals): 500 → 0, 0.25 → 2, 0.0005 → 4. */
export const decimalsForStep = (step: number) => Math.min(8, (String(Number(step.toPrecision(6))).split('.')[1] ?? '').length);

export function signed(n: number, dec = 2): string {
  const s = Math.abs(n).toFixed(dec);
  return n > 0 ? `+${s}` : n < 0 ? `−${s}` : s;
}

/** A contract count, short when large: 1 · 2.5 · 1,200 · 50k · 1.2M. */
export function fmtQty(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e6) return `${Number((n / 1e6).toPrecision(3))}M`;
  if (a >= 1e4) return `${Number((n / 1e3).toPrecision(3))}k`;
  return Number(n.toPrecision(6)).toLocaleString('en-US');
}

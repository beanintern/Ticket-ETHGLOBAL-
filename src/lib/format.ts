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
  return `${sign}$${a.toFixed(a >= 100 ? 0 : 2)}`;
}

export function signed(n: number, dec = 2): string {
  const s = Math.abs(n).toFixed(dec);
  return n > 0 ? `+${s}` : n < 0 ? `−${s}` : s;
}

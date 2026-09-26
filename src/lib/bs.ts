// Black-Scholes with r = 0 (Derive options are cash-settled against an index; rates are negligible for a mockup).

export type OptType = 'C' | 'P';

export function normPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

// Abramowitz & Stegun 7.1.26
export function normCdf(x: number): number {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429;
  const p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + p * z);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-z * z);
  return 0.5 * (1 + sign * y);
}

export function intrinsic(type: OptType, S: number, K: number): number {
  return type === 'C' ? Math.max(S - K, 0) : Math.max(K - S, 0);
}

/** T in years. */
export function bsPrice(type: OptType, S: number, K: number, T: number, iv: number): number {
  if (T <= 0 || iv <= 0) return intrinsic(type, S, K);
  const sq = iv * Math.sqrt(T);
  const d1 = (Math.log(S / K) + 0.5 * sq * sq) / sq;
  const d2 = d1 - sq;
  return type === 'C' ? S * normCdf(d1) - K * normCdf(d2) : K * normCdf(-d2) - S * normCdf(-d1);
}

export interface Greeks {
  delta: number;
  gamma: number;
  /** per day */
  theta: number;
  /** per 1 vol point */
  vega: number;
}

export function bsGreeks(type: OptType, S: number, K: number, T: number, iv: number): Greeks {
  if (T <= 0 || iv <= 0) {
    const itm = type === 'C' ? S > K : S < K;
    return { delta: itm ? (type === 'C' ? 1 : -1) : 0, gamma: 0, theta: 0, vega: 0 };
  }
  const sq = iv * Math.sqrt(T);
  const d1 = (Math.log(S / K) + 0.5 * sq * sq) / sq;
  const pdf = normPdf(d1);
  return {
    delta: type === 'C' ? normCdf(d1) : normCdf(d1) - 1,
    gamma: pdf / (S * sq),
    theta: -(S * pdf * iv) / (2 * Math.sqrt(T)) / 365,
    vega: (S * pdf * Math.sqrt(T)) / 100,
  };
}

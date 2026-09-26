// Black-Scholes (r = 0), written separately from the app's copy so checks don't just echo it.
const normCdf = (x) => {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + p * z);
  return 0.5 * (1 + sign * (1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-z * z)));
};
export function bsPriceForCheck(type, S, K, T, iv) {
  if (T <= 0) return type === 'C' ? Math.max(S - K, 0) : Math.max(K - S, 0);
  const sq = iv * Math.sqrt(T);
  const d1 = (Math.log(S / K) + 0.5 * sq * sq) / sq;
  const d2 = d1 - sq;
  return type === 'C' ? S * normCdf(d1) - K * normCdf(d2) : K * normCdf(-d2) - S * normCdf(-d1);
}

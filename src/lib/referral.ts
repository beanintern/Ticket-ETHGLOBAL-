// Referrals, the groundwork only: each browser gets a stable referral code, share links carry it
// (?ref=CODE), and a visitor arriving through one remembers who referred them. Rewards and
// tracking come later.
const OWN = 'ticket.ref';
const BY = 'ticket.referredBy';
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** This browser's referral code (made the first time it's asked for). */
export function referralCode(): string {
  try {
    const have = localStorage.getItem(OWN);
    if (have) return have;
    const bytes = crypto.getRandomValues(new Uint8Array(6));
    const code = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join('');
    localStorage.setItem(OWN, code);
    return code;
  } catch {
    return 'TICKET';
  }
}

/** Where share links point: the public site (VITE_PUBLIC_URL), else this page's own address. */
export function siteUrl(): string {
  const env = (import.meta.env.VITE_PUBLIC_URL as string | undefined)?.trim();
  return (env || `${location.origin}${location.pathname}`).replace(/\/$/, '');
}

export const referralLink = (code = referralCode()) => `${siteUrl()}/?ref=${code}`;

/** On arrival: remember the code of whoever referred this visitor (the first one wins). */
export function captureReferral() {
  try {
    const ref = new URLSearchParams(location.search).get('ref')?.trim().toUpperCase();
    if (!ref || !/^[A-Z0-9]{4,12}$/.test(ref) || ref === localStorage.getItem(OWN) || localStorage.getItem(BY)) return;
    localStorage.setItem(BY, ref);
  } catch {
    /* not remembered */
  }
}

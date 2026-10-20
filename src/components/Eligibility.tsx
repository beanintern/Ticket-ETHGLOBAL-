import { useState } from 'react';

/** Derive's Terms of Use version the confirmation was given for (updated 23 Sep 2026, effective 3 Oct 2026). */
const TERMS_VERSION = '2026-09-23';
const KEY = `ticket.derive.eligible.${TERMS_VERSION}`;

function stored(): boolean {
  try {
    return globalThis.localStorage?.getItem(KEY) === 'yes';
  } catch {
    return false;
  }
}

/**
 * Before connecting or depositing on Derive mainnet: the user confirms they're eligible under
 * Derive's Terms of Use and agrees to them. Remembered per browser until the terms change.
 */
export function useEligibility() {
  const [ok, setOk] = useState(stored);
  const set = (v: boolean) => {
    setOk(v);
    try {
      if (v) globalThis.localStorage?.setItem(KEY, 'yes');
      else globalThis.localStorage?.removeItem(KEY);
    } catch {
      /* stays for this visit */
    }
  };
  return [ok, set] as const;
}

export function EligibilityCheck({ ok, onChange }: { ok: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="check eligibility">
      <input type="checkbox" checked={ok} onChange={(e) => onChange(e.target.checked)} />
      <span>
        I’m 18 or over and not a resident, citizen or tax resident of the United States, Canada, Australia or Panama, or in a sanctioned or restricted
        country (in the UK, I’m an investment professional or high-net-worth investor), and I’m not using a VPN or proxy to get around this. I agree to
        Derive’s{' '}
        <a href="https://www.derive.xyz/terms-of-use" target="_blank" rel="noreferrer">
          Terms of Use
        </a>
        .
      </span>
    </label>
  );
}

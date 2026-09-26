import { useState } from 'react';
import type { AccountState, Credentials } from '../account/derive';
import { signedUsd, usd } from '../lib/format';

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Header button: "Connect" or the connected subaccount and its value. */
export function AccountButton({ account, onOpen }: { account: AccountState | null; onOpen: () => void }) {
  if (!account) {
    return (
      <button className="acct-btn" onClick={onOpen} title="Connect your Derive testnet account with a session key">
        Connect
      </button>
    );
  }
  const p = account.portfolio;
  return (
    <button className={`acct-btn is-on ${account.error ? 'is-warn' : ''}`} onClick={onOpen} title={account.error ?? `Derive testnet · ${account.owner}`}>
      <span className="conn-dot" aria-hidden="true" />
      {account.subaccountId === null ? 'No subaccount' : `#${account.subaccountId}`}
      {p && <span className="num">{usd(p.value, 0)}</span>}
    </button>
  );
}

interface Props {
  account: AccountState | null;
  initial: { creds: Credentials; remember: boolean } | null;
  onConnect: (creds: Credentials, remember: boolean) => Promise<void>;
  /** Connect with MetaMask; reports progress through onStep. */
  onMetaMask: (onStep: (s: string) => void) => Promise<void>;
  metaMaskAvailable: boolean;
  onDisconnect: () => void;
  onSelectSubaccount: (id: number) => void;
  onClose: () => void;
}

export function AccountPanel({ account, initial, onConnect, onMetaMask, metaMaskAvailable, onDisconnect, onSelectSubaccount, onClose }: Props) {
  const [manual, setManual] = useState(false);
  const [step, setStep] = useState<string | null>(null);
  const [owner, setOwner] = useState(initial?.creds.owner ?? '');
  const [sessionKey, setSessionKey] = useState('');
  const [remember, setRemember] = useState(initial?.remember ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const metaMask = async () => {
    setBusy(true);
    setError(null);
    setStep('Connecting to MetaMask…');
    try {
      await onMetaMask(setStep);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      setStep(null);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onConnect({ owner, sessionKey }, remember);
      setSessionKey('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="acct-title">
        <div className="modal-head">
          <div>
            <div className="eyebrow">Derive testnet · Sepolia</div>
            <h2 id="acct-title">{account ? 'Account' : 'Connect account'}</h2>
          </div>
          <button className="ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        {!account && !manual ? (
          <div className="acct-form">
            <button className="primary mm" onClick={metaMask} disabled={busy}>
              <MetaMaskIcon />
              {busy ? (step ?? 'Connecting…') : metaMaskAvailable ? 'Connect MetaMask' : 'Connect MetaMask (not installed)'}
            </button>
            {error && <p className="form-error">{error}</p>}
            <ol className="steps">
              <li>MetaMask shares your address and switches to Sepolia.</li>
              <li>You sign in to Derive (a signature, no transaction, no gas).</li>
              <li>
                You authorise a trading key this app creates in your browser. It can place and cancel orders but can’t withdraw, and it expires in 7 days.
                After that, trades need no popups.
              </li>
            </ol>
            <p className="fine">
              Your wallet’s key never leaves MetaMask. No Derive account yet? Get Sepolia ETH from a faucet, then Mint test USDC and deposit at{' '}
              <a href="https://testnet.app.derive.xyz/developers" target="_blank" rel="noreferrer">
                testnet.app.derive.xyz
              </a>
              .
            </p>
            <button className="link" onClick={() => setManual(true)}>
              Use an existing session key instead
            </button>
          </div>
        ) : !account ? (
          <form className="acct-form" onSubmit={submit}>
            <label>
              <span>Wallet address</span>
              <input value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="0x…" spellCheck={false} autoComplete="off" required />
              <small>The wallet that owns your Derive account.</small>
            </label>
            <label>
              <span>Session key (private key)</span>
              <input
                type="password"
                value={sessionKey}
                onChange={(e) => setSessionKey(e.target.value)}
                placeholder="0x…"
                spellCheck={false}
                autoComplete="off"
                required
              />
              <small>A key registered to that wallet on Derive. Never your wallet’s own key.</small>
            </label>
            <label className="check">
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
              <span>Remember on this device (otherwise it’s forgotten when this tab closes)</span>
            </label>
            {error && <p className="form-error">{error}</p>}
            <button className="primary" disabled={busy}>
              {busy ? 'Connecting…' : 'Connect'}
            </button>
            <button type="button" className="link" onClick={() => setManual(false)}>
              Back to MetaMask
            </button>
            <p className="fine">
              The key stays in this browser: it signs the login and your orders here and is never sent anywhere. Test funds: Sepolia ETH from a faucet,
              then Mint USDC and deposit at{' '}
              <a href="https://testnet.app.derive.xyz/developers" target="_blank" rel="noreferrer">
                testnet.app.derive.xyz
              </a>
              .
            </p>
          </form>
        ) : (
          <AccountDetails account={account} onDisconnect={onDisconnect} onSelectSubaccount={onSelectSubaccount} />
        )}
      </div>
    </div>
  );
}

function AccountDetails({ account, onDisconnect, onSelectSubaccount }: { account: AccountState; onDisconnect: () => void; onSelectSubaccount: (id: number) => void }) {
  const p = account.portfolio;
  const upnl = p ? p.positions.reduce((a, x) => a + x.unrealizedPnl, 0) + p.otherPositions.reduce((a, x) => a + x.unrealizedPnl, 0) : 0;
  return (
    <div className="acct-details">
      <dl className="kv">
        <div>
          <dt>Wallet</dt>
          <dd className="num" title={account.owner}>
            {short(account.owner)}
          </dd>
        </div>
        <div>
          <dt>Session key</dt>
          <dd className="num" title={account.signer}>
            {short(account.signer)}
          </dd>
        </div>
        <div>
          <dt>Can trade</dt>
          <dd>
            {account.canTrade === null ? (
              <span className="muted">Unknown</span>
            ) : account.canTrade ? (
              <span className="up">Yes</span>
            ) : (
              <span className="down" title={`Scopes: ${account.scopes?.join(', ') || 'none'}`}>
                No: read-only key
              </span>
            )}
          </dd>
        </div>
        <div>
          <dt>Subaccount</dt>
          <dd>
            {account.subaccountIds.length > 1 ? (
              <select value={account.subaccountId ?? ''} onChange={(e) => onSelectSubaccount(Number(e.target.value))}>
                {account.subaccountIds.map((id) => (
                  <option key={id} value={id}>
                    #{id}
                  </option>
                ))}
              </select>
            ) : account.subaccountId !== null ? (
              <span className="num">#{account.subaccountId}</span>
            ) : (
              <span className="muted">None yet</span>
            )}
          </dd>
        </div>
      </dl>

      {account.subaccountId === null ? (
        <div className="empty">
          <p>This wallet has no Derive subaccount yet. Deposit test USDC at testnet.app.derive.xyz to create one; it appears here a minute or two later.</p>
        </div>
      ) : !p ? (
        <p className="fine">{account.error ?? 'Loading portfolio…'}</p>
      ) : (
        <>
          <dl className="summary">
            <div>
              <dt>Account value</dt>
              <dd className="num">{usd(p.value)}</dd>
            </div>
            <div>
              <dt>Unrealized P&amp;L</dt>
              <dd className={`num ${upnl > 0.005 ? 'up' : upnl < -0.005 ? 'down' : ''}`}>{signedUsd(upnl)}</dd>
            </div>
            <div>
              <dt>Initial margin</dt>
              <dd className="num">{usd(p.initialMargin)}</dd>
            </div>
            <div>
              <dt>Maintenance</dt>
              <dd className="num">{usd(p.maintenanceMargin)}</dd>
            </div>
          </dl>
          <div>
            <div className="eyebrow">Collateral</div>
            {p.collateral.length ? (
              <ul className="acct-list">
                {p.collateral.map((c) => (
                  <li key={c.asset}>
                    <span>{c.asset}</span>
                    <span className="num">{c.amount.toLocaleString(undefined, { maximumFractionDigits: 4 })}</span>
                    <span className="num muted">{usd(c.value)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="fine">None. Deposit test USDC to trade.</p>
            )}
          </div>
          {account.error && <p className="form-error">{account.error}</p>}
        </>
      )}
      <button className="ghost" onClick={onDisconnect}>
        Disconnect and forget key
      </button>
    </div>
  );
}

function MetaMaskIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M21.3 2.5 13.2 8.5l1.5-3.5z" fill="#e2761b" />
      <path d="m2.7 2.5 8 6.1-1.4-3.6zM18.4 16.4l-2.2 3.3 4.6 1.3 1.3-4.5zM1.9 16.5l1.3 4.5 4.6-1.3-2.1-3.3z" fill="#e4761b" />
      <path d="m7.5 10.8-1.3 1.9 4.6.2-.2-4.9zM16.5 10.8l-3.2-2.9-.1 5 4.6-.2zM7.8 19.7l2.8-1.3-2.4-1.9zM13.4 18.4l2.8 1.3-.4-3.2z" fill="#e4761b" />
      <path d="m16.2 19.7-2.8-1.3.2 1.8v.8zM7.8 19.7l2.6 1.3v-.8l.2-1.8z" fill="#d7c1b3" />
      <path d="m10.4 15.3-2.3-.7 1.6-.7zM13.6 15.3l.7-1.4 1.6.7z" fill="#233447" />
      <path d="m7.8 19.7.4-3.3-2.5.1zM15.8 16.4l.4 3.3 2.2-3.2zM17.7 12.7l-4.6.2.4 2.4.7-1.4 1.6.7zM8.1 14.6l1.6-.7.7 1.4.4-2.4-4.6-.2z" fill="#cd6116" />
    </svg>
  );
}

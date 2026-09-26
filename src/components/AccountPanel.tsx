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
  onDisconnect: () => void;
  onSelectSubaccount: (id: number) => void;
  onClose: () => void;
}

export function AccountPanel({ account, initial, onConnect, onDisconnect, onSelectSubaccount, onClose }: Props) {
  const [owner, setOwner] = useState(initial?.creds.owner ?? '');
  const [sessionKey, setSessionKey] = useState('');
  const [remember, setRemember] = useState(initial?.remember ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

        {!account ? (
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

import { useEffect, useRef, useState } from 'react';
import { depositTarget, depositUsdc, pendingDeposits, txUrl, walletFunds, type DepositTarget, type PendingDeposit, type WalletFunds } from '../account/deposit';
import { metaMaskEthers } from '../account/metamask';
import type { NetInfo } from '../account/network';
import { usd } from '../lib/format';

/** How often, and for how long, to look for Derive picking up a deposit. */
const POLL_MS = 5000;
const POLL_FOR_MS = 15 * 60_000;

/**
 * Deposit USDC from the wallet into Derive, in two wallet transactions (approve, deposit).
 * `subaccountId` null creates the account (a new subaccount owned by the wallet).
 */
export function DepositForm({
  info,
  subaccountId,
  owner,
  onCredited,
}: {
  info: NetInfo;
  subaccountId: number | null;
  /** The account's owner, when connected: the wallet must be the same one. */
  owner?: string;
  /** Called once Derive has picked the deposit up (or stopped showing it as pending). */
  onCredited?: () => void;
}) {
  const [target, setTarget] = useState<DepositTarget | null>(null);
  const [signer, setSigner] = useState<import('ethers').JsonRpcSigner | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [funds, setFunds] = useState<WalletFunds | null>(null);
  const [amount, setAmount] = useState('');
  const [step, setStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingDeposit[] | null>(null);
  const [credited, setCredited] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    depositTarget(info.net)
      .then((t) => alive.current && setTarget(t))
      .catch((e) => alive.current && setError(`Couldn’t load Derive’s deposit details: ${(e as Error).message}`));
    return () => {
      alive.current = false;
    };
  }, [info.net]);

  const connectWallet = async () => {
    if (!target) return;
    setError(null);
    setStep('Connecting to MetaMask…');
    try {
      const s = await metaMaskEthers(info.net);
      const a = await s.getAddress();
      if (owner && a.toLowerCase() !== owner.toLowerCase()) {
        throw new Error(`MetaMask is on ${a.slice(0, 6)}…${a.slice(-4)}, but this Derive account belongs to ${owner.slice(0, 6)}…${owner.slice(-4)}. Switch accounts in MetaMask.`);
      }
      const f = await walletFunds(s, target);
      setSigner(s);
      setAddress(a);
      setFunds(f);
      if (!amount) setAmount(String(Math.floor(f.usdc * 100) / 100 || ''));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setStep(null);
    }
  };

  const value = Number(amount);
  const invalid = !target || !funds ? null : !(value > 0) ? 'Enter an amount.' : value < target.minUsd ? `Derive’s minimum deposit is ${usd(target.minUsd, 0)}.` : value > funds.usdc + 1e-9 ? `The wallet has ${usd(funds.usdc)} USDC.` : null;
  const noGas = funds !== null && funds.eth <= 0;

  const send = async () => {
    if (!signer || !target || invalid) return;
    setError(null);
    try {
      const { txHash } = await depositUsdc(info.net, signer, target, value, subaccountId, setStep);
      setTxHash(txHash);
      setStep(null);
      void watch(address!);
    } catch (e) {
      setError((e as Error).message);
      setStep(null);
    }
  };

  // Derive lists a deposit as pending once it sees the transaction, then drops it when credited.
  const watch = async (wallet: string) => {
    const end = Date.now() + POLL_FOR_MS;
    let seen = false;
    while (alive.current && Date.now() < end) {
      try {
        const p = await pendingDeposits(info.net, wallet);
        if (!alive.current) return;
        setPending(p);
        if (p.length) seen = true;
        else if (seen) {
          setCredited(true);
          onCredited?.();
          return;
        }
      } catch {
        /* try again next round */
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  };

  if (txHash) {
    return (
      <div className="deposit">
        <p>
          {credited ? 'Deposit credited.' : 'Deposit sent.'}{' '}
          <a href={txUrl(info.net, txHash)} target="_blank" rel="noreferrer">
            View transaction
          </a>
        </p>
        {!credited && (
          <p className="fine">
            {pending?.length
              ? `Derive has seen it (${pending.map((p) => `${usd(p.amount)} ${p.status}`).join(', ')}) and will credit it shortly.`
              : 'Waiting for Derive to see it on-chain. This usually takes a few minutes.'}
            {subaccountId === null ? ' Your Derive account is created when it’s credited.' : ''}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="deposit">
      {!target ? (
        <p className="fine">{error ?? 'Loading Derive’s deposit details…'}</p>
      ) : !funds ? (
        <>
          <button className="primary" onClick={connectWallet} disabled={!!step}>
            {step ?? 'Check wallet balance'}
          </button>
          {error && <p className="form-error">{error}</p>}
        </>
      ) : (
        <>
          <div className="deposit-row">
            <span className="fine">
              Wallet {address!.slice(0, 6)}…{address!.slice(-4)} · {usd(funds.usdc)} USDC · {funds.eth.toFixed(4)} ETH for gas
            </span>
          </div>
          <label className="deposit-amount">
            <span>Amount (USDC)</span>
            <div className="stake-input">
              <span>$</span>
              <input type="number" min={target.minUsd} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
              <button className="link" onClick={() => setAmount(String(Math.floor(funds.usdc * 100) / 100))}>
                Max
              </button>
            </div>
          </label>
          {invalid && amount !== '' && <p className="form-error">{invalid}</p>}
          {noGas && <p className="form-error">No ETH in this wallet for the network fee. Add a little ETH on {info.chain.name} first.</p>}
          {info.real && !invalid && (
            <p className="real-note">
              Deposits {usd(value)} of real USDC into {subaccountId === null ? 'a new Derive account' : `Derive subaccount #${subaccountId}`}. You’ll confirm two Ethereum
              transactions in MetaMask (approve, then deposit) and pay their gas in ETH.
            </p>
          )}
          <button className="primary" onClick={send} disabled={!!invalid || noGas || !!step}>
            {step ?? `Deposit ${invalid ? '' : usd(value)}`}
          </button>
          {error && <p className="form-error">{error}</p>}
        </>
      )}
      <p className="fine">
        Minimum {target ? usd(target.minUsd, 0) : '–'}. Funds go to Derive’s contracts on {info.chain.name}, credited to {subaccountId === null ? 'a new account owned by your wallet' : 'your account'}.
        {info.real ? '' : ' Need test USDC? Mint it at testnet.app.derive.xyz/developers.'}
      </p>
    </div>
  );
}

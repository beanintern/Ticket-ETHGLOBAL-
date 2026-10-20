// Depositing USDC into Derive from the wallet, without leaving the app.
//
// A deposit is two on-chain transactions the wallet signs and pays gas for, on the network's
// chain (Ethereum for mainnet, Sepolia for the testnet):
//   1. approve: let Derive's ActionManager pull the USDC (skipped if already allowed);
//   2. deposit: into an existing subaccount, or into a new one (which creates the Derive account,
//      under the margin manager for ETH and BTC options).
// Derive credits it a little later, once it sees the transaction; `pendingDeposits` shows it in the
// meantime. Which token, protocol asset, manager and minimum to use all come from Derive's own
// risk-universe listing, not constants here.
import type { DeriveNet } from './network';

export interface DepositTarget {
  /** The margin manager that trades ETH and BTC options (standard margin). */
  managerId: number;
  /** Derive's protocol asset the deposit credits (USDC collateral). */
  asset: string;
  /** The USDC ERC-20 on the network's chain, approved and pulled from the wallet. */
  erc20: string;
  decimals: number;
  /** Derive's minimum deposit, in USD. */
  minUsd: number;
}

export interface WalletFunds {
  /** USDC in the wallet. */
  usdc: number;
  /** Native ETH in the wallet, for gas. */
  eth: number;
}

export interface PendingDeposit {
  amount: number;
  status: string;
  subaccountId: number;
  txHash: string | null;
}

/** Block explorer link for a transaction. */
export const txUrl = (net: DeriveNet, hash: string) => `https://${net === 'mainnet' ? '' : 'sepolia.'}etherscan.io/tx/${hash}`;

async function publicClient(net: DeriveNet) {
  const { DeriveClient } = await import('@derivexyz/derive-ts');
  const client = new DeriveClient({ network: net });
  await client.connect();
  return client;
}

/** Where a USDC deposit for ETH/BTC options goes, read from Derive's risk universes. */
export async function depositTarget(net: DeriveNet): Promise<DepositTarget> {
  const client = await publicClient(net);
  try {
    const universes = await client.marketData.getRiskUniverses();
    const managers = universes.flatMap((u) => u.managers);
    // Standard margin over ETH and BTC options; portfolio margin is for larger, hedged books.
    const m =
      managers.find((x) => x.margin_type === 'SM' && x.instruments.includes('ETH-OPTION') && x.instruments.includes('BTC-OPTION')) ??
      managers.find((x) => x.instruments.includes('ETH-OPTION') && x.instruments.includes('BTC-OPTION'));
    const usdc = m?.collaterals.find((c) => c.name === 'USDC');
    if (!m || !usdc?.erc20?.underlying_erc20) throw new Error('Derive didn’t list a USDC deposit for ETH and BTC options.');
    return {
      managerId: m.manager_id,
      asset: usdc.address,
      erc20: usdc.erc20.underlying_erc20,
      decimals: usdc.erc20.decimals,
      minUsd: Number(usdc.min_deposit_usd) || 0,
    };
  } finally {
    await client.close().catch(() => {});
  }
}

/** USDC and ETH (for gas) held by the wallet the signer controls. */
export async function walletFunds(signer: import('ethers').Signer, target: DepositTarget): Promise<WalletFunds> {
  const { Contract, formatUnits } = await import('ethers');
  const address = await signer.getAddress();
  const token = new Contract(target.erc20, ['function balanceOf(address) view returns (uint256)'], signer);
  const [raw, wei] = await Promise.all([token.getFunction('balanceOf')(address) as Promise<bigint>, signer.provider!.getBalance(address)]);
  return { usdc: Number(formatUnits(raw, target.decimals)), eth: Number(formatUnits(wei, 18)) };
}

/**
 * Approves (if needed) and deposits `amount` USDC: into `subaccountId`, or into a new subaccount
 * owned by the signer when there isn't one yet. Resolves once the deposit transaction is mined.
 */
export async function depositUsdc(
  net: DeriveNet,
  signer: import('ethers').Signer,
  target: DepositTarget,
  amount: number,
  subaccountId: number | null,
  onStep: (s: string) => void = () => {},
): Promise<{ txHash: string }> {
  if (!(amount >= target.minUsd)) throw new Error(`Derive’s minimum deposit is $${target.minUsd}.`);
  const { DeriveClient } = await import('@derivexyz/derive-ts');
  const owner = await signer.getAddress();
  // The deposit calls are plain on-chain transactions: no Derive login needed.
  const client = new DeriveClient({ network: net, ownerAddress: owner });
  const base = { signer, asset: target.asset, erc20: target.erc20, amount: amount.toFixed(target.decimals) };
  onStep('Approve USDC, then confirm the deposit in your wallet…');
  try {
    return subaccountId === null
      ? await client.deposits.contractCall.depositToNewSubaccount({ ...base, managerId: target.managerId, owner })
      : await client.deposits.contractCall.deposit({ ...base, subaccountId, fallbackRecipient: owner });
  } catch (e) {
    throw new Error(walletError(e));
  }
}

/** Deposits Derive has seen on-chain but not yet credited. */
export async function pendingDeposits(net: DeriveNet, wallet: string): Promise<PendingDeposit[]> {
  const client = await publicClient(net);
  try {
    const res = await client.send('public/get_pending_deposits', { wallet });
    return res.pending_deposits.map((p) => ({ amount: Number(p.amount ?? 0), status: p.status, subaccountId: p.subaccount_id, txHash: p.tx_hash ?? null }));
  } finally {
    await client.close().catch(() => {});
  }
}

function walletError(e: unknown): string {
  const err = e as { code?: number | string; shortMessage?: string; message?: string; info?: { error?: { code?: number } } };
  const code = err.info?.error?.code ?? err.code;
  if (code === 4001 || code === 'ACTION_REJECTED') return 'Cancelled in your wallet.';
  if (code === 'INSUFFICIENT_FUNDS') return 'Not enough ETH in the wallet to pay the network fee (gas).';
  if (code === 'CALL_EXCEPTION') return `The deposit was reverted on-chain${err.shortMessage ? `: ${err.shortMessage}` : ''}.`;
  return err.shortMessage ?? err.message ?? String(e);
}

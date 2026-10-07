// Connecting a Derive account (mainnet or testnet) with MetaMask.
//
// The wallet signs two messages and never shares its key:
//   1. a login (EIP-191 personal_sign over a timestamp) so the app can talk to Derive as the wallet;
//   2. a set_session_key action (EIP-712 typed data) registering a fresh key the app generated here,
//      scoped to trading and expiring after SESSION_DAYS.
// From then on the session key signs logins and orders without popups. It's saved in this
// browser per wallet and reused until it's close to expiry.
import type { Credentials } from './derive';
import { NETS, type DeriveNet } from './network';

const SESSION_DAYS = 7;
/** Reuse a saved key only while it has at least this long left. */
const MIN_LEFT_SEC = 3600;
/** Saved trading keys per network (the testnet name predates mainnet support). */
const keysStore = (net: DeriveNet) => `ticket.derive.${net}.keys`;
/** Derive's EIP-712 domain: the Matching contract, the same address on every deployment. */
const MATCHING = '0xeB8d770ec18DB98Db922E9D83260A585b9F0DeAD';
const ACTION_TYPES = {
  Action: [
    { name: 'subaccountId', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'module', type: 'address' },
    { name: 'data', type: 'bytes' },
    { name: 'expiry', type: 'uint256' },
    { name: 'owner', type: 'address' },
    { name: 'signer', type: 'address' },
  ],
};

/** What the flow needs from a wallet: MetaMask via ethers in the browser, any ethers signer in tests. */
export interface OwnerSigner {
  address: string;
  signMessage(message: string): Promise<string>;
  signTypedData(domain: Record<string, unknown>, types: typeof ACTION_TYPES, value: Record<string, unknown>): Promise<string>;
}

interface SavedKey {
  sessionKey: string;
  expirySec: number;
}

type Eip1193 = { request(args: { method: string; params?: unknown[] }): Promise<unknown> };

function savedKeys(net: DeriveNet): Record<string, SavedKey> {
  try {
    return JSON.parse(globalThis.localStorage?.getItem(keysStore(net)) ?? '{}') as Record<string, SavedKey>;
  } catch {
    return {};
  }
}

function saveKey(net: DeriveNet, owner: string, key: SavedKey | null) {
  try {
    const all = savedKeys(net);
    if (key) all[owner.toLowerCase()] = key;
    else delete all[owner.toLowerCase()];
    globalThis.localStorage?.setItem(keysStore(net), JSON.stringify(all));
  } catch {
    /* storage unavailable: a new key is registered next time */
  }
}

/** A still-valid session key this browser registered for the wallet earlier, if any. */
export function savedSessionKey(net: DeriveNet, owner: string): string | null {
  const k = savedKeys(net)[owner.toLowerCase()];
  return k && k.expirySec - Date.now() / 1000 > MIN_LEFT_SEC ? k.sessionKey : null;
}

export const forgetSessionKey = (net: DeriveNet, owner: string) => saveKey(net, owner, null);

export const hasMetaMask = () => typeof window !== 'undefined' && !!(window as unknown as { ethereum?: Eip1193 }).ethereum;

/** Asks MetaMask for the account and puts it on the network's chain (Ethereum or Sepolia), which EIP-712 signing checks. */
export async function metaMaskSigner(net: DeriveNet): Promise<OwnerSigner> {
  const chain = NETS[net].chain;
  const eth = (window as unknown as { ethereum?: Eip1193 }).ethereum;
  if (!eth) throw new Error('MetaMask isn’t installed in this browser. Install it from metamask.io, or connect with a session key instead.');
  const { BrowserProvider } = await import('ethers');
  const accounts = (await eth.request({ method: 'eth_requestAccounts' }).catch(rethrowWallet)) as string[];
  if (!accounts?.length) throw new Error('MetaMask didn’t share an account.');
  const current = (await eth.request({ method: 'eth_chainId' })) as string;
  if (parseInt(current, 16) !== chain.id) {
    try {
      await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chain.hex }] });
    } catch (e) {
      // Only Sepolia might be missing from the wallet; every wallet has Ethereum mainnet.
      if ((e as { code?: number }).code !== 4902 || net !== 'testnet') rethrowWallet(e);
      await eth
        .request({
          method: 'wallet_addEthereumChain',
          params: [
            {
              chainId: chain.hex,
              chainName: 'Sepolia',
              nativeCurrency: { name: 'Sepolia ETH', symbol: 'ETH', decimals: 18 },
              rpcUrls: ['https://ethereum-sepolia-rpc.publicnode.com'],
              blockExplorerUrls: ['https://sepolia.etherscan.io'],
            },
          ],
        })
        .catch(rethrowWallet);
    }
  }
  const signer = await new BrowserProvider(eth as never).getSigner(accounts[0]);
  return {
    address: await signer.getAddress(),
    signMessage: (m) => signer.signMessage(m).catch(rethrowWallet),
    signTypedData: (d, t, v) => signer.signTypedData(d, t, v).catch(rethrowWallet),
  };
}

function rethrowWallet(e: unknown): never {
  const err = e as { code?: number | string; info?: { error?: { code?: number } }; message?: string };
  const code = err.info?.error?.code ?? err.code;
  if (code === 4001 || code === 'ACTION_REJECTED') throw new Error('Cancelled in MetaMask.');
  if (code === -32002) throw new Error('MetaMask already has a request open: check the MetaMask window.');
  throw e instanceof Error ? e : new Error(String(err.message ?? e));
}

/**
 * Logs in to Derive as the wallet and registers a new trading session key for it.
 * `onStep` reports progress for the UI ("Sign in…", "Authorise trading key…").
 */
export async function registerSessionKey(net: DeriveNet, owner: OwnerSigner, onStep: (s: string) => void = () => {}): Promise<Credentials> {
  const [{ DeriveClient, NETWORKS, SignedAction, domainSeparator, randomNonce, expiresIn, ProtocolScopeCode, ProtocolScopeWireString }, { encodeSetSessionKeyActionData }, { Wallet, TypedDataEncoder, getAddress }] =
    await Promise.all([import('@derivexyz/derive-ts'), import('@derivexyz/derive-ts/codecs'), import('ethers')]);
  const network = NETWORKS[net];
  const ownerAddress = getAddress(owner.address);

  // 1. Log in as the wallet itself. Derive checks this timestamp is fresh, hence signing right before.
  onStep('Sign in to Derive in MetaMask…');
  const client = new DeriveClient({ network: net, ownerAddress, wallet: owner as never });
  await client.connect();
  try {
    const timestamp = Date.now();
    const signature = await owner.signMessage(String(timestamp));
    const noAccount =
      net === 'mainnet'
        ? 'This wallet has no Derive account yet. Deposit USDC at app.derive.xyz to create one, then connect again.'
        : 'This wallet has no Derive testnet account yet. Deposit test USDC at testnet.app.derive.xyz/developers to create one, then connect again.';
    let ids: number[];
    try {
      ids = (await client.send('public/login', { wallet: ownerAddress, timestamp, signature } as never)) as number[];
    } catch (e) {
      const msg = (e as Error).message;
      if (/14000|Account not found/i.test(msg)) throw new Error(noAccount);
      throw new Error(`Derive rejected the sign-in: ${msg.replace(/^public\/login: /, '')}`);
    }
    if (!ids.length) throw new Error(noAccount);

    // 2. Authorise a new key generated here: trade on the orderbook and by RFQ, nothing else.
    onStep('Authorise the trading key in MetaMask…');
    const key = Wallet.createRandom();
    const expirySec = expiresIn(SESSION_DAYS * 86400);
    const scopes = [ProtocolScopeCode.TradeOrderbookAll, ProtocolScopeCode.TradeRfqAll];
    const fields = {
      subaccountId: 0,
      nonce: randomNonce(),
      module: network.modules.setSessionKey,
      data: encodeSetSessionKeyActionData({ sessionKey: key.address, expirySec, scopes, subaccountIds: [] }),
      expirySec: expiresIn(600),
      owner: ownerAddress,
      signer: ownerAddress,
    };
    // The action is standard EIP-712 typed data, so MetaMask can show and sign it. Check our typed
    // data hashes to exactly what Derive verifies before asking for the signature.
    const domain = { name: 'Matching', version: '1.0', chainId: network.chainId, verifyingContract: MATCHING };
    const message = { subaccountId: 0, nonce: fields.nonce, module: fields.module, data: fields.data, expiry: fields.expirySec, owner: ownerAddress, signer: ownerAddress };
    if (TypedDataEncoder.hash(domain, ACTION_TYPES, message) !== new SignedAction(fields, domainSeparator(network)).digest()) {
      throw new Error('Internal error: the session-key message doesn’t match Derive’s signing scheme.');
    }
    const actionSig = await owner.signTypedData(domain, ACTION_TYPES, message);
    try {
      await client.send('private/set_session_key', {
        wallet: ownerAddress,
        public_session_key: key.address,
        expiry_sec: expirySec,
        subaccount_ids: null,
        nonce: fields.nonce,
        signer: ownerAddress,
        signature: actionSig,
        signature_expiry_sec: fields.expirySec,
        protocol_scopes: scopes.map((c) => ProtocolScopeWireString[c]),
        offchain_scopes: ['account_info'],
        label: 'Ticket',
      } as never);
    } catch (e) {
      throw new Error(`Derive didn’t accept the trading key: ${(e as Error).message.replace(/^private\/set_session_key: /, '')}`);
    }
    saveKey(net, ownerAddress, { sessionKey: key.privateKey, expirySec });
    return { owner: ownerAddress, sessionKey: key.privateKey };
  } finally {
    await client.close().catch(() => {});
  }
}

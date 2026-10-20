// Checks the in-app deposit (src/account/deposit.ts) against Derive's real contracts, without
// sending anything:
//   npm run check:deposit                  (Ethereum mainnet)
//   NETWORK=testnet npm run check:deposit  (Sepolia)
// The app's deposit code drives the SDK with a wallet that records transactions instead of
// sending them. Each recorded deposit is then replayed with eth_call on the real chain, with the
// throwaway wallet's USDC balance and allowance set by state override, and must succeed; without
// the allowance it must revert. Also checks Derive's minimum is enforced.
import { createServer } from 'vite';
import { JsonRpcProvider, AbstractSigner, Wallet, AbiCoder, keccak256, toBeHex, Interface, TransactionResponse, ContractTransactionResponse } from 'ethers';
// Recorded transactions are never mined: treat them as mined at once.
TransactionResponse.prototype.wait = async function () { return { status: 1, hash: this.hash }; };
ContractTransactionResponse.prototype.wait = async function () { return { status: 1, hash: this.hash }; };
const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
const { depositTarget, depositUsdc } = await vite.ssrLoadModule('/src/account/deposit.ts');
const net = process.env.NETWORK === 'testnet' ? 'testnet' : 'mainnet';
let failed = 0;
const rpc = net === 'mainnet' ? 'https://ethereum-rpc.publicnode.com' : 'https://ethereum-sepolia-rpc.publicnode.com';
const provider = new JsonRpcProvider(rpc);
const target = await depositTarget(net);
console.log(net, 'target', target);
const ab = AbiCoder.defaultAbiCoder();
const slot = (k, s) => keccak256(ab.encode(['address', 'uint256'], [k, BigInt(s)]));

class Recorder extends AbstractSigner {
  constructor(address, provider) { super(provider); this.address = address; this.sent = []; }
  async getAddress() { return this.address; }
  connect(p) { return new Recorder(this.address, p); }
  async signTransaction() { throw new Error('no'); }
  async signMessage() { throw new Error('no'); }
  async signTypedData() { throw new Error('no'); }
  async sendTransaction(tx) {
    
    const t = await this.populateCall(tx);
    this.sent.push(t);
    return new TransactionResponse({ hash: '0x' + String(this.sent.length).padStart(64, '0'), to: t.to, from: this.address, data: t.data, value: 0n, nonce: 0, gasLimit: 0n, gasPrice: 0n, chainId: 1n, blockNumber: null, blockHash: null, index: 0, type: 2, signature: null, accessList: [], maxFeePerGas: 0n, maxPriorityFeePerGas: 0n, maxFeePerBlobGas: null, blobVersionedHashes: null, authorizationList: null }, this.provider);
  }
}
const am = new Interface(['function deposit(address,uint256,uint64,address)', 'function depositToNewSubaccount(address,uint256,uint32,address)', 'function approve(address,uint256)']);
for (const [label, sub] of [['new account', null], ['existing subaccount', 1]]) {
  const me = Wallet.createRandom().address;
  const r = new Recorder(me, provider);
  const amount = 25;
  await depositUsdc(net, r, target, amount, sub);
  console.log(`\n${label}: ${r.sent.length} transactions`);
  const raw = BigInt(amount * 10 ** target.decimals);
  // Give the wallet the USDC and the allowance it would have after the approve, then replay the deposit.
  const usdcBal = toBeHex(raw * 10n, 32);
  const actionManager = r.sent.at(-1).to;
  // Find the token's balance and allowance mappings by probing candidate base slots.
  const NS = BigInt('0x52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace00'); // OZ v5 upgradeable ERC20
  const bases = [...Array(12).keys()].map(BigInt).concat([NS, NS + 1n]);
  const tok = new Interface(['function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)']);
  let balBase, allowBase;
  for (const b of bases) {
    const v = await provider.send('eth_call', [{ to: target.erc20, data: tok.encodeFunctionData('balanceOf', [me]) }, 'latest', { [target.erc20]: { stateDiff: { [slot(me, b)]: toBeHex(777n, 32) } } }]);
    if (BigInt(v) === 777n) { balBase = b; break; }
  }
  for (const b of bases) {
    const k = keccak256(ab.encode(['address', 'bytes32'], [actionManager, slot(me, b)]));
    const v = await provider.send('eth_call', [{ to: target.erc20, data: tok.encodeFunctionData('allowance', [me, actionManager]) }, 'latest', { [target.erc20]: { stateDiff: { [k]: toBeHex(777n, 32) } } }]);
    if (BigInt(v) === 777n) { allowBase = b; break; }
  }
  console.log('  token slots: balances', balBase, 'allowances', allowBase);
  const allowanceSlot = keccak256(ab.encode(['address', 'bytes32'], [actionManager, slot(me, allowBase)]));
  for (const tx of r.sent) {
    const d = am.parseTransaction({ data: tx.data });
    console.log(`  ${d.name}(${d.args.map(String).join(', ')}) → ${tx.to}`);
  }
  const overrides = { [target.erc20]: { stateDiff: { [slot(me, balBase)]: usdcBal, [allowanceSlot]: toBeHex(raw, 32) } }, [me]: { balance: toBeHex(10n ** 18n) } };
  const dep = r.sent.at(-1);
  try {
    const out = await provider.send('eth_call', [{ from: me, to: dep.to, data: dep.data }, 'latest', overrides]);
    console.log('  simulated deposit: OK, actionId', BigInt(out));
  } catch (e) {
    console.log('  simulated deposit: REVERTED', e.shortMessage ?? e.message, e.info?.error?.data ?? '');
    failed++;
  }
  // And with no allowance it must revert (proves the simulation really checks the transfer).
  try {
    await provider.send('eth_call', [{ from: me, to: dep.to, data: dep.data }, 'latest', { [target.erc20]: { stateDiff: { [slot(me, balBase)]: usdcBal } } }]);
    console.log('  control without approval: unexpectedly OK');
    failed++;
  } catch (e) { console.log('  control without approval: reverts as it should'); }
  // Below the minimum
  try { await depositUsdc(net, new Recorder(me, provider), target, target.minUsd - 1, sub); console.log('  below minimum: accepted?!'); failed++; }
  catch (e) { console.log('  below minimum:', e.message); }
}
console.log(failed ? `\n${failed} deposit check(s) failed (a public-RPC hiccup shows as "missing revert data": run again)` : '\nAll deposit checks passed.');
process.exit(failed ? 1 : 0);

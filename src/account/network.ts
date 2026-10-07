// Which Derive deployment an account trades on: mainnet (real USDC on Ethereum) or the testnet
// (test funds on Sepolia). Everything network-specific for accounts lives here.
export type DeriveNet = 'mainnet' | 'testnet';

export interface NetInfo {
  net: DeriveNet;
  /** How the UI names it: "Derive" or "Derive testnet". */
  name: string;
  /** Real money: orders get an extra confirmation step. */
  real: boolean;
  /** The chain EIP-712 signatures are made for (MetaMask must be on it to sign). */
  chain: { id: number; hex: string; name: string };
  /** Where to deposit and create an account. */
  app: string;
  /** Tag stored on positions traded here. */
  venue: 'derive-mainnet' | 'derive-testnet';
}

export const NETS: Record<DeriveNet, NetInfo> = {
  mainnet: {
    net: 'mainnet',
    name: 'Derive',
    real: true,
    chain: { id: 1, hex: '0x1', name: 'Ethereum' },
    app: 'https://app.derive.xyz',
    venue: 'derive-mainnet',
  },
  testnet: {
    net: 'testnet',
    name: 'Derive testnet',
    real: false,
    chain: { id: 11155111, hex: '0xaa36a7', name: 'Sepolia' },
    app: 'https://testnet.app.derive.xyz/developers',
    venue: 'derive-testnet',
  },
};

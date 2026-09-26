import { DERIVE_MAINNET, DERIVE_TESTNET, createDeriveSource } from './derive';
import { createMockSource } from './mock';
import type { MarketSource, SourceKind } from './types';

/**
 * Which market data to use:
 * 1. `?source=live` / `?source=testnet` / `?source=mock` in the URL, if present;
 * 2. otherwise VITE_SOURCE at build time;
 * 3. otherwise live Derive data, except the single-file preview build, which can't open network
 *    connections and always uses the simulator.
 */
export function pickSourceKind(): SourceKind {
  const q = new URLSearchParams(location.search).get('source');
  const valid = (v: unknown): v is SourceKind => v === 'live' || v === 'testnet' || v === 'mock';
  if (valid(q)) return q;
  const env = import.meta.env.VITE_SOURCE;
  if (valid(env)) return env;
  return import.meta.env.MODE === 'artifact' ? 'mock' : 'live';
}

export function createSource(kind: SourceKind): MarketSource {
  if (kind === 'live') return createDeriveSource(DERIVE_MAINNET);
  if (kind === 'testnet') return createDeriveSource(DERIVE_TESTNET);
  return createMockSource();
}

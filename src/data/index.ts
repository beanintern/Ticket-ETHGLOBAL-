import { createDeriveSource } from './derive';
import { createMockSource } from './mock';
import type { MarketSource, SourceKind } from './types';

/**
 * Which market data to use:
 * 1. `?source=live` / `?source=mock` in the URL, if present;
 * 2. otherwise VITE_SOURCE at build time;
 * 3. otherwise live Derive data, except the single-file preview build, which can't open network
 *    connections and always uses the simulator.
 */
export function pickSourceKind(): SourceKind {
  const q = new URLSearchParams(location.search).get('source');
  if (q === 'live' || q === 'mock') return q;
  const env = import.meta.env.VITE_SOURCE;
  if (env === 'live' || env === 'mock') return env;
  return import.meta.env.MODE === 'artifact' ? 'mock' : 'live';
}

export function createSource(kind: SourceKind): MarketSource {
  return kind === 'live' ? createDeriveSource() : createMockSource();
}

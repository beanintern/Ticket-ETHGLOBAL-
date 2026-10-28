// Easy-mode bets held on Derive, read back from the account's option positions.
//
// A bet is a vertical spread: +q calls at lo and −q calls at hi ("above"), or +q puts at hi and
// −q puts at lo ("below"). Reading bets from the account, rather than from this browser's records,
// means they show on any device, disappear once sold anywhere, and match what's really held.
// Bets this browser bought add what the account can't tell: the price paid with fees, and when.
import type { HeldOption } from '../account/derive';
import { betLegs, betQuestion, type BetDir } from './binary';
import { expiryLabel, type Asset } from './market';
import type { Position } from './strategy';

/** A bet bought here shows (as pending) until the account has been read this long after it. */
export const CONFIRM_GRACE_MS = 60_000;
const EPS = 1e-9;

export interface HeldBets {
  bets: Position[];
  /** Option positions (in contracts) that aren't part of a bet: traded in Pro, or elsewhere. */
  otherLegs: number;
  /** This browser's records of bets the account no longer holds (sold or closed elsewhere). */
  stale: string[];
}

const betKey = (asset: Asset, expiry: number, dir: BetDir, lo: number, hi: number) => `${asset}|${expiry}|${dir}|${lo}|${hi}`;
const keyOf = (p: Position) => (p.bet ? betKey(p.asset, p.bet.expiry, p.bet.dir, p.bet.lo, p.bet.hi) : '');

/**
 * The bets in the account's option positions, pairing each bought option with the nearest sold
 * one of the same subaccount, asset, expiry and type on the paying side (a higher call, a lower
 * put). `local` are this browser's records of bets on the same venue: they lend a matching bet its
 * price paid and time, and a bet just bought shows until the account catches up. `heldAt` is when
 * `held` was read: a record is only taken as gone once a read well after it doesn't have it.
 */
export function betsFromHeld(
  held: HeldOption[],
  heldAt: number,
  venue: NonNullable<Position['venue']>,
  local: Position[],
  now: number,
  expiryOf: (asset: Asset, ymd: string) => number,
  spotAt: (asset: Asset, t: number) => number,
): HeldBets {
  const groups = new Map<string, HeldOption[]>();
  for (const h of held) {
    const k = `${h.subaccountId}|${h.asset}|${h.expiryYmd}|${h.type}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(h);
  }
  const mine = local.filter((p) => p.bet && p.venue === venue);
  const bets: Position[] = [];
  let otherLegs = 0;
  for (const g of groups.values()) {
    const call = g[0].type === 'C';
    const longs = g.filter((h) => h.amount > 0).map((h) => ({ h, left: h.amount }));
    const shorts = g.filter((h) => h.amount < 0).map((h) => ({ h, left: -h.amount }));
    // Calls from the lowest bought strike up, puts from the highest down: each takes the nearest
    // sold strike on its paying side.
    longs.sort((a, b) => (call ? a.h.strike - b.h.strike : b.h.strike - a.h.strike));
    for (const long of longs) {
      const side = shorts.filter((s) => (call ? s.h.strike > long.h.strike : s.h.strike < long.h.strike));
      side.sort((a, b) => Math.abs(a.h.strike - long.h.strike) - Math.abs(b.h.strike - long.h.strike));
      for (const short of side) {
        if (long.left <= EPS) break;
        const q = Math.min(long.left, short.left);
        if (q <= EPS) continue;
        long.left -= q;
        short.left -= q;
        bets.push(heldBet(long.h, short.h, q));
      }
    }
    otherLegs += [...longs, ...shorts].reduce((a, x) => a + (x.left > EPS ? x.left : 0), 0);
  }

  function heldBet(long: HeldOption, short: HeldOption, qty: number): Position {
    const asset = long.asset;
    const lo = Math.min(long.strike, short.strike);
    const hi = Math.max(long.strike, short.strike);
    const dir: BetDir = long.type === 'C' ? 'above' : 'below';
    const expiry = expiryOf(asset, long.expiryYmd);
    const shares = qty * (hi - lo);
    // This browser's records of the same bet: the price paid with fees, and when.
    const k = betKey(asset, expiry, dir, lo, hi);
    const ours = mine.filter((p) => keyOf(p) === k);
    const ourShares = ours.reduce((a, p) => a + p.bet!.shares, 0);
    const entry = ourShares > 0 ? ours.reduce((a, p) => a + p.bet!.entry * p.bet!.shares, 0) / ourShares : Math.min(1, Math.max(0, (long.averagePrice - short.averagePrice) / (hi - lo)));
    const openedAt = ours.length ? Math.min(...ours.map((p) => p.openedAt)) : Math.max(long.openedAt, short.openedAt);
    const id = `derive-bet-${long.subaccountId}-${long.instrument}-${short.instrument}`;
    const level = (lo + hi) / 2;
    const legs = betLegs({ asset, expiry, dir, lo, hi }, shares).map((l) => ({ ...l, id: `${id}-${l.strike}`, entry: l.side > 0 ? long.averagePrice : short.averagePrice }));
    return {
      id,
      asset,
      name: `${betQuestion(asset, dir, level)} · ${expiryLabel(expiry)}`,
      legs,
      openedAt,
      openSpot: ours[0]?.openSpot || spotAt(asset, openedAt),
      venue,
      subaccountId: long.subaccountId,
      bet: { dir, level, lo, hi, expiry, shares, entry },
    };
  }

  // Bought here but not in the account yet (it updates every few seconds): show it meanwhile.
  // Settled ones stay too: once expired, the account no longer lists them.
  const found = new Set(bets.map(keyOf));
  const missing = mine.filter((p) => !found.has(keyOf(p)));
  const pending = missing.filter((p) => heldAt - p.openedAt < CONFIRM_GRACE_MS || p.bet!.expiry <= now);
  const stale = missing.filter((p) => !pending.includes(p)).map((p) => p.id);
  return { bets: [...bets, ...pending], otherLegs, stale };
}

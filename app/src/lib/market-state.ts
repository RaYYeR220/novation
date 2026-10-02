import { MAX_VOL_SYNC_STEPS } from '@novation/sdk';
import type { Session, Vault } from './client/types';
import { baseSession, etParts, eveningTs, fmtEt, isTradingDay } from './nyse';

/** A session that closes the vaults: a weekend, or an NYSE holiday. */
export type ClosedSession = 'WEEKEND' | 'HOLIDAY';

export function closedSession(session: Session | undefined): ClosedSession | undefined {
  return session === 'WEEKEND' || session === 'HOLIDAY' ? session : undefined;
}

/** What the vault is closed for: "the weekend" or "the holiday". */
export function closedFor(s: ClosedSession): string {
  return s === 'WEEKEND' ? 'the weekend' : 'the holiday';
}

/**
 * When the market reopens: 20:00 ET on the eve of the next trading day, where the extended session
 * starts. Undefined unless the calendar has the market closed at `now`.
 */
export function reopensAt(now: number): number | undefined {
  const s = baseSession(now);
  if (s !== 'WEEKEND' && s !== 'HOLIDAY') return undefined;
  let { day } = etParts(now);
  for (let i = 0; i < 14; i++, day++) {
    const t = eveningTs(day);
    if (t > now && isTradingDay(day + 1)) return t;
  }
  return undefined;
}

/** "until Sun, Oct 4, 20:00 ET", or "until the market reopens" when the calendar can't say. */
export function untilReopen(now: number | undefined): string {
  const at = now !== undefined ? reopensAt(now) : undefined;
  return at !== undefined ? `until ${fmtEt(at)}` : 'until the market reopens';
}

/** What a closed vault holds back, and what still works. */
export function vaultClosedText(now: number | undefined): string {
  return `No quotes, sales, buy-backs, deposits, exits or roll payouts ${untilReopen(now)}. A redemption request still queues.`;
}

/** Feed rounds one syncVol folds in (a withdrawal or trade syncs this much itself), and what a liquidation folds. */
export const VOL_SYNC_ROUNDS = 64;
export const LIQUIDATION_VOL_ROUNDS = 8;

/**
 * Where a vol estimate stands against its feed (`behind`: rounds not folded in, null after an
 * aggregator migration). `ok` is false once that refuses a liquidation with VolNotCurrent.
 */
export function volStatus(symbol: string, behind: number | null): { ok: boolean; text: string } {
  if (behind === null)
    return {
      ok: false,
      text: `${symbol}'s feed moved to a new aggregator: its vol waits for syncAndRebaseVol, and withdrawals, opening trades and liquidations are refused (VolNotCurrent) until someone sends it`,
    };
  if (behind > VOL_SYNC_ROUNDS)
    return {
      ok: false,
      text: `Vol estimate ${behind} rounds behind its feed, more than one sync folds: withdrawals, opening trades and liquidations are refused (VolNotCurrent) until someone syncs it`,
    };
  if (behind > LIQUIDATION_VOL_ROUNDS)
    return {
      ok: false,
      text: `Vol estimate ${behind} rounds behind its feed: trades and withdrawals fold them in, but a liquidation folds ${LIQUIDATION_VOL_ROUNDS} at most and is refused (VolNotCurrent) until someone syncs it`,
    };
  return {
    ok: true,
    text: behind === 0 ? 'Vol estimate current with its feed' : `Vol estimate ${behind} round${behind === 1 ? '' : 's'} behind its feed: the next trade, withdrawal or bid folds ${behind === 1 ? 'it' : 'them'} in`,
  };
}

/**
 * A vault that can't quote only because its vol is behind: the market is open, but the vol is more
 * than one sync behind its feed or waits for syncAndRebaseVol after a feed migration. Anyone can
 * catch it up. Never for a weekend, a holiday or a halt, and never in the demo (no vol state there).
 */
export function vaultNeedsVolSync(v: Pick<Vault, 'live' | 'session' | 'volBehind'>): boolean {
  if (v.live || (v.session !== 'REGULAR' && v.session !== 'EXTENDED') || v.volBehind === undefined) return false;
  return v.volBehind === null || v.volBehind > VOL_SYNC_ROUNDS;
}

/** "up to 4 transactions": what a vol catch-up may ask the wallet to sign. */
export const VOL_SYNC_TXS = `up to ${MAX_VOL_SYNC_STEPS} transactions`;

/** The message for a write refused while a vol estimate catches up with its feed. */
export function volSyncText(symbol: string | undefined): string {
  return symbol ? `Syncing the vol of ${symbol}: retry in a moment.` : 'Syncing a vol estimate: retry in a moment.';
}

/** An RFQ fill held back after its vol was synced: the quote is checked again at the new mark. */
export function volSyncedText(symbol: string): string {
  return `Vol of ${symbol} synced: check the updated quote and sign again.`;
}

/** Why a vault whose vol lags its feed can't quote (`behind`: rounds, null after a feed migration). */
export function vaultVolText(symbol: string, behind: number | null | undefined): string {
  return typeof behind === 'number'
    ? `The ${symbol} vol is ${behind} rounds behind its feed, more than one sync folds.`
    : `The ${symbol} feed moved to a new aggregator, and its vol waits for syncAndRebaseVol.`;
}

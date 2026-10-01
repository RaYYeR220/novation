/**
 * Finds the settlement hint for one (feed, weekly expiry): the feed's last round printed at or
 * before the close, and which of MarketDataHub's proofs makes it acceptable. Pure over a round
 * reader, so the same code runs against a live feed, a fork and a fake one in tests.
 *
 * The rules mirrored here (MarketDataHub.settlementPrice and settlementPriceFallback):
 *  - the hint printed at or before the expiry, with a positive answer, no older than
 *    maxSettlementLag before it, and its price inside the plausibility band;
 *  - and one of: (i) the next round in the same phase exists and printed after the expiry;
 *    (ii) the hint is still the latest round and now is strictly after the expiry; (iii) the
 *    hint is the last round of its phase and round 1 of the next phase printed after the expiry;
 *  - otherwise, 72 hours after the expiry, the fallback: the first round printed after the expiry,
 *    accepted when its predecessor is stale or outside the band.
 */
export interface Round {
  id: bigint;
  answer: bigint;
  /** 0 when the round does not exist. */
  updatedAt: number;
}

export interface RoundReader {
  latest(): Promise<Round>;
  /** A round that doesn't exist (or reverts) reads as answer 0, updatedAt 0. */
  round(id: bigint): Promise<Round>;
}

export type Proof = 'nextRound' | 'latestRound' | 'phaseChange' | 'fallback';

export type HintResult =
  | {
      kind: 'ready';
      method: 'settleExpiry' | 'settleExpiryFallback';
      /** The round id to pass: the pre-close round, or for the fallback the first post-close one. */
      hint: bigint;
      proof: Proof;
      round: Round;
      /** The first round printed after the expiry, if one exists yet. */
      next?: Round;
      /** Rounds read to decide. */
      reads: number;
    }
  | { kind: 'wait'; reason: string; until?: number; round?: Round; reads: number }
  | { kind: 'stuck'; reason: string; round?: Round; reads: number };

export interface HintOptions {
  /** RiskParams.globals().maxSettlementLag, seconds. */
  maxSettlementLag: number;
  /** Plausibility band, WAD; skipped when absent. */
  minPrice?: bigint;
  maxPrice?: bigint;
  /** Feed decimals (default 8). */
  decimals?: number;
  /** MarketDataHub's FALLBACK_DELAY (72 h). */
  fallbackDelay?: number;
}

const MASK = (1n << 64n) - 1n;
const MAX_ROUND_SEARCH = 1n << 40n;
export const FALLBACK_DELAY = 72 * 3600;

export const phaseOf = (id: bigint) => id >> 64n;
export const numberOf = (id: bigint) => id & MASK;
export const packRound = (phase: bigint, n: bigint) => (phase << 64n) | n;

/** Caches rounds (they never change once printed) and counts reads. */
class Counting implements RoundReader {
  reads = 0;
  private cache = new Map<bigint, Round>();
  constructor(private r: RoundReader) {}
  async latest() {
    this.reads++;
    return this.r.latest();
  }
  async round(id: bigint) {
    const hit = this.cache.get(id);
    if (hit) return hit;
    this.reads++;
    const x = await this.r.round(id);
    if (x.updatedAt !== 0) this.cache.set(id, x);
    return x;
  }
}

/** Highest existing round number in a phase (0 if none), by doubling then bisecting, as the hub does. */
export async function lastRoundOfPhase(r: RoundReader, phase: bigint): Promise<bigint> {
  const exists = async (n: bigint) => (await r.round(packRound(phase, n))).updatedAt !== 0;
  if (!(await exists(1n))) return 0n;
  let lo = 1n;
  let hi = 2n;
  while (hi <= MAX_ROUND_SEARCH && (await exists(hi))) {
    lo = hi;
    hi <<= 1n;
  }
  while (hi - lo > 1n) {
    const mid = lo + (hi - lo) / 2n;
    if (await exists(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * A round number k in [1, top] of `phase` with 0 < updatedAt(k) <= expiry < updatedAt(k + 1), given
 * that updatedAt(top) > expiry: exactly what proof (i) checks. Bisection keeps updatedAt(lo) <=
 * expiry and updatedAt(hi) > expiry (or missing), so it ends on such a pair in log2(top) reads; on a
 * feed that prints in time order (every real one) that is the last pre-close round. 0 if round 1
 * already printed after the expiry.
 */
async function lastAtOrBefore(r: RoundReader, phase: bigint, top: bigint, expiry: number): Promise<bigint> {
  const at = async (n: bigint) => (await r.round(packRound(phase, n))).updatedAt;
  const first = await at(1n);
  if (first === 0 || first > expiry) return 0n;
  let lo = 1n;
  let hi = top;
  while (hi - lo > 1n) {
    const mid = lo + (hi - lo) / 2n;
    const t = await at(mid);
    if (t !== 0 && t <= expiry) lo = mid;
    else hi = mid;
  }
  return lo;
}

function inBand(answer: bigint, o: HintOptions): boolean {
  if (answer <= 0n) return false;
  const wad = answer * 10n ** BigInt(18 - (o.decimals ?? 8));
  if (o.minPrice !== undefined && wad < o.minPrice) return false;
  if (o.maxPrice !== undefined && wad > o.maxPrice) return false;
  return true;
}

export async function findHint(reader: RoundReader, expiry: number, now: number, o: HintOptions): Promise<HintResult> {
  const r = new Counting(reader);
  if (now <= expiry) return { kind: 'wait', reason: 'expiry not passed (the proof needs now strictly after it)', until: expiry + 1, reads: r.reads };

  const latest = await r.latest();
  if (latest.updatedAt === 0) return { kind: 'stuck', reason: 'feed has no rounds', reads: r.reads };

  let found: Round | undefined;
  let next: Round | undefined;
  let proof: Proof | undefined;

  if (latest.updatedAt <= expiry) {
    found = latest;
    proof = 'latestRound';
  } else {
    next = latest;
    for (let p = phaseOf(latest.id); p >= 1n; p--) {
      const top = p === phaseOf(latest.id) ? numberOf(latest.id) : await lastRoundOfPhase(r, p);
      if (top === 0n) continue;
      const topRound = await r.round(packRound(p, top));
      if (topRound.updatedAt !== 0 && topRound.updatedAt <= expiry) {
        // every round of the later phase printed after the expiry: the phase-change proof
        found = topRound;
        proof = 'phaseChange';
        break;
      }
      const k = await lastAtOrBefore(r, p, top, expiry);
      if (k === 0n) {
        next = await r.round(packRound(p, 1n));
        continue;
      }
      found = await r.round(packRound(p, k));
      next = await r.round(packRound(p, k + 1n));
      proof = 'nextRound';
      break;
    }
  }

  if (!found || !proof) return { kind: 'stuck', reason: 'no round printed at or before the expiry', reads: r.reads };

  const lagOk = expiry - found.updatedAt <= o.maxSettlementLag;
  if (found.answer > 0n && lagOk && inBand(found.answer, o)) {
    return { kind: 'ready', method: 'settleExpiry', hint: found.id, proof, round: found, ...(next ? { next } : {}), reads: r.reads };
  }

  // the pre-close print is stale or implausible: only the fallback, 72 h after the close
  const reason = !lagOk ? 'last pre-close round is older than maxSettlementLag' : 'last pre-close round is outside the band';
  if (!next) return { kind: 'wait', reason: `${reason}; the fallback needs a round printed after the expiry`, round: found, reads: r.reads };
  const opensAt = expiry + (o.fallbackDelay ?? FALLBACK_DELAY);
  if (now < opensAt) return { kind: 'wait', reason: `${reason}; the fallback opens 72 h after the expiry`, until: opensAt, round: found, reads: r.reads };
  if (!inBand(next.answer, o)) return { kind: 'stuck', reason: `${reason}, and the first post-close round is outside the band too`, round: found, reads: r.reads };
  return { kind: 'ready', method: 'settleExpiryFallback', hint: next.id, proof: 'fallback', round: next, next, reads: r.reads };
}

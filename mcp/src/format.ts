import { fromWad, symbolOf, toWad, type Deployment, type Refusal, type SeriesInfo } from '@novation/sdk';
import type { Address } from 'viem';

/** WAD into a number rounded to `dp` decimals (display and agent reasoning, never on-chain maths). */
export function num(wad: bigint, dp = 6): number {
  const f = 10 ** dp;
  return Math.round(fromWad(wad) * f) / f;
}

/** A decimal amount from a tool argument (number or decimal string) into WAD. */
export function wadOf(v: number | string, what: string): bigint {
  const s = typeof v === 'number' ? v : v.trim();
  if (typeof s === 'number' && !Number.isFinite(s)) throw new ToolInputError(`${what} must be a finite number`);
  if (typeof s === 'string' && !/^-?\d+(\.\d+)?$/.test(s)) throw new ToolInputError(`${what} must be a decimal number, got "${v}"`);
  try {
    return toWad(s);
  } catch {
    throw new ToolInputError(`${what} is not a valid amount: ${v}`);
  }
}

/** A bad tool argument: reported to the agent as a tool error, never sent anywhere. */
export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolInputError';
  }
}

export function isoDate(unix: number): string {
  return new Date(unix * 1000).toISOString().slice(0, 10);
}

export function isoTime(unix: number): string {
  return new Date(unix * 1000).toISOString().replace('.000Z', 'Z');
}

export function symbolFor(d: Deployment, token: Address): string {
  return symbolOf(d, token) ?? token;
}

/** "NVDA 2026-10-02 240 C": underlying, expiry date (UTC), strike, call or put. */
export function seriesLabel(d: Deployment, s: SeriesInfo): string {
  return `${symbolFor(d, s.underlying)} ${isoDate(s.expiry)} ${num(s.strike, 4)} ${s.isCall ? 'C' : 'P'}`;
}

export function seriesView(d: Deployment, s: SeriesInfo) {
  return {
    seriesId: s.id,
    label: seriesLabel(d, s),
    underlying: symbolFor(d, s.underlying),
    type: s.isCall ? ('call' as const) : ('put' as const),
    strike: num(s.strike, 4),
    expiry: isoTime(s.expiry),
    expiryUnix: s.expiry,
  };
}

/** The agent-facing refusal: the contract's error name, its numbers, and the rule in one sentence. */
export interface RefusalView {
  code: string;
  message: string;
  numbers: Record<string, number>;
}

export function refusalView(r: Refusal): RefusalView {
  const numbers: Record<string, number> = {};
  for (const [k, v] of Object.entries(r.numbers)) numbers[k] = Number.isInteger(v) ? v : Math.round(v * 1e6) / 1e6;
  const addr = Object.entries(r.args).filter(([, v]) => typeof v === 'string');
  const message = addr.length ? `${r.message} (${addr.map(([k, v]) => `${k} ${v}`).join(', ')})` : r.message;
  return { code: String(r.code), message, numbers };
}

/** A one-line reading of a refusal with its numbers, e.g. "worst-case loss 12.1 USDG > budget 9 USDG". */
export function refusalLine(r: RefusalView): string {
  const n = r.numbers;
  switch (r.code) {
    case 'AgentRiskBudgetExceeded':
      return `AgentRiskBudgetExceeded: worst-case loss after the trade ${n.worstLoss} USDG > the agent's budget ${n.budget} USDG`;
    case 'AgentValueDrainExceeded':
      return `AgentValueDrainExceeded: the trade gives up ${n.loss} USDG of equity > the cap ${n.cap} USDG`;
    case 'InsufficientMargin':
      return `InsufficientMargin: equity ${n.equity} USDG < initial margin ${n.im} USDG after the trade`;
    case 'InsufficientCash':
      return `InsufficientCash: cash ${n.cash} USDG does not cover ${n.wad} USDG`;
    case 'PremiumAboveMax':
      return `PremiumAboveMax: premium ${n.premium} USDG > your maximum ${n.maxPremium} USDG`;
    case 'PremiumBelowMin':
      return `PremiumBelowMin: premium ${n.premium} USDG < your minimum ${n.minPremium} USDG`;
    default:
      return `${r.code}: ${r.message}`;
  }
}

/** JSON with bigints as decimal strings: the shape every tool result goes out in. */
export function toJson(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x), 2);
}

/** Scenario index -> its price move (fraction of the shock range, -1..1) and vol level. */
export const VOL_LEVELS = ['vol down', 'base vol', 'vol up'] as const;
export function scenarioOf(index: number): { priceMoveOfRange: number; vol: (typeof VOL_LEVELS)[number] } {
  const v = Math.floor(index / 13);
  const j = index % 13;
  return { priceMoveOfRange: Math.round(((j - 6) / 6) * 1e4) / 1e4, vol: VOL_LEVELS[v] ?? 'base vol' };
}

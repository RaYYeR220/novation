import type { GasRow } from './client/types';

/** Arbitrum's per-transaction gas limit, ArbGasInfo.getMaxTxGasLimit() on Robinhood Chain. */
export const TX_GAS_CAP = 32_000_000;

/** A trade checks margin on both sides, so it runs the kernel twice. */
export const CHECKS_PER_TRADE = 2;

/** "46.5M", "2.65M", "110k": three significant figures. */
export function fmtGas(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e6) return `${Number((v / 1e6).toPrecision(3))}M`;
  if (a >= 1e3) return `${Math.round(v / 1e3)}k`;
  return String(Math.round(v));
}

/** Gas axis tick: "0", "10M", "20M". */
export function fmtGasTick(v: number): string {
  return v === 0 ? '0' : `${Math.round(v / 1e6)}M`;
}

export interface TradeGas {
  positions: number;
  solidity: number;
  stylus: number;
  /** True when the Solidity trade does not fit in one transaction. */
  solidityOverCap: boolean;
  stylusOverCap: boolean;
  /** Solidity gas over Stylus gas. */
  ratio: number;
}

/** Gas for one trade (two margin checks) at a measured book size. */
export function tradeGas(rows: readonly GasRow[], positions: number): TradeGas {
  const row = rows.find((r) => r.positions === positions);
  if (!row) throw new RangeError(`no gas measurement at ${positions} positions`);
  const solidity = row.solidityOptimized * CHECKS_PER_TRADE;
  const stylus = row.stylus * CHECKS_PER_TRADE;
  return {
    positions,
    solidity,
    stylus,
    solidityOverCap: solidity > TX_GAS_CAP,
    stylusOverCap: stylus > TX_GAS_CAP,
    ratio: solidity / stylus,
  };
}

/** "16.9×". */
export function fmtRatio(r: number): string {
  return `${r.toFixed(1)}×`;
}

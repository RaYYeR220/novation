import { decodeRefusal } from '@novation/sdk';

/**
 * JSON-lines logging: one object per line on stdout, bigints as decimal strings. Every sent
 * transaction is logged with `msg: "tx"`, its hash, status, gas and explorer link.
 */
export type Level = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  (level: Level, job: string, msg: string, fields?: Record<string, unknown>): void;
}

function replacer(_k: string, v: unknown): unknown {
  return typeof v === 'bigint' ? v.toString() : v;
}

export function line(level: Level, job: string, msg: string, fields: Record<string, unknown> = {}): string {
  return JSON.stringify({ t: new Date().toISOString(), level, job, msg, ...fields }, replacer);
}

/** Writes to stdout (or `sink`, e.g. an array in tests). `quiet` drops debug lines. */
export function createLogger(opts: { sink?: (s: string) => void; debug?: boolean } = {}): Logger {
  const sink = opts.sink ?? ((s: string) => process.stdout.write(`${s}\n`));
  return (level, job, msg, fields) => {
    if (level === 'debug' && !opts.debug) return;
    sink(line(level, job, msg, fields));
  };
}

/** Short reason for an error, for a log field: the decoded refusal code when there is one. */
export function why(e: unknown): string {
  const r = (e as { refusal?: { code?: string } })?.refusal ?? decodeRefusal(e);
  if (r?.code) return r.code;
  const m = (e as { shortMessage?: string; message?: string })?.shortMessage ?? (e as Error)?.message ?? String(e);
  return m.split('\n')[0]!.slice(0, 300);
}

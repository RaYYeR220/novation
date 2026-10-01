import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repository root (keeper/src -> ..). */
export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Loads KEY=VALUE lines from the repo's .env into process.env without overriding what is already
 * set. Values are never printed.
 */
export function loadDotEnv(path = join(REPO_ROOT, '.env')): void {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const l = raw.trim();
    if (!l || l.startsWith('#') || !l.includes('=')) continue;
    const i = l.indexOf('=');
    const k = l.slice(0, i).trim();
    const v = l.slice(i + 1).trim().replace(/^"(.*)"$/, '$1');
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

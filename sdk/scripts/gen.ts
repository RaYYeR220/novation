/**
 * Writes the SDK's derived sources:
 *  - src/abi/*.ts: const-asserted ABIs read from the forge artifacts in contracts/out;
 *  - src/abi/errors.ts: every custom error any Novation contract (or library) can revert with;
 *  - src/data/deployments.ts: the deployed addresses from contracts/deployments/<chainId>.json,
 *    plus the refused proof transactions recorded in tools/e2e/out/<chainId>.json.
 *
 *   node scripts/gen.ts           regenerate (needs `forge build` for the ABIs)
 *   node scripts/gen.ts --check   exit 1 if any derived file is out of date
 *
 * Without contracts/out the ABIs are left as they are and only the deployments are refreshed.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const SDK = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = join(SDK, '..');
const OUT = join(ROOT, 'contracts', 'out');
const SRC = join(ROOT, 'contracts', 'src');
const DEPLOYMENTS = join(ROOT, 'contracts', 'deployments');
const E2E_OUT = join(ROOT, 'tools', 'e2e', 'out');
/** Local anvil deployments are written by the integration tests and never shipped. */
const LOCAL_CHAINS = new Set(['31337']);

const check = process.argv.includes('--check');
const HEADER = '// Written by sdk/scripts/gen.ts from the contracts build. Do not edit by hand.\n';

/** export name -> forge artifact (contracts/out/<file>.sol/<contract>.json). */
const ABIS: Record<string, { file: string; contract: string; module: string }> = {
  clearinghouseAbi: { file: 'Clearinghouse', contract: 'Clearinghouse', module: 'clearinghouse' },
  marketDataHubAbi: { file: 'MarketDataHub', contract: 'MarketDataHub', module: 'marketDataHub' },
  seriesRegistryAbi: { file: 'SeriesRegistry', contract: 'SeriesRegistry', module: 'seriesRegistry' },
  riskParamsAbi: { file: 'RiskParams', contract: 'RiskParams', module: 'riskParams' },
  insuranceFundAbi: { file: 'InsuranceFund', contract: 'InsuranceFund', module: 'insuranceFund' },
  auctionHouseAbi: { file: 'AuctionHouse', contract: 'AuctionHouse', module: 'auctionHouse' },
  rfqVenueAbi: { file: 'RfqVenue', contract: 'RfqVenue', module: 'rfqVenue' },
  optionVaultAbi: { file: 'OptionVaultBase', contract: 'OptionVaultBase', module: 'optionVault' },
  riskKernelAbi: { file: 'IRiskKernel', contract: 'IRiskKernel', module: 'riskKernel' },
  aggregatorAbi: { file: 'IAggregatorV3', contract: 'IAggregatorV3', module: 'aggregator' },
  mockAggregatorAbi: { file: 'MockAggregator', contract: 'MockAggregator', module: 'mockAggregator' },
  mockUsdgAbi: { file: 'MockUSDG', contract: 'MockUSDG', module: 'mockUsdg' },
  mockStockTokenAbi: { file: 'MockStockToken', contract: 'MockStockToken', module: 'mockStockToken' },
  erc20Abi: { file: 'IERC20Metadata', contract: 'IERC20Metadata', module: 'erc20' },
};

/** Read helpers that are never deployed: run as deployless eth_calls, so their creation code ships too. */
const LENSES: Record<string, { file: string; contract: string; module: string }> = {
  vaultQuoteLens: { file: 'VaultQuoteLens', contract: 'VaultQuoteLens', module: 'vaultQuoteLens' },
};

type AbiItem = { type: string; name?: string; inputs?: { type: string; name: string; components?: unknown[] }[] };

const pending: { path: string; text: string }[] = [];
function emit(path: string, text: string) {
  pending.push({ path, text });
}

function readArtifact(file: string, contract: string): AbiItem[] {
  const p = join(OUT, `${file}.sol`, `${contract}.json`);
  return JSON.parse(readFileSync(p, 'utf8')).abi as AbiItem[];
}

function sig(e: AbiItem): string {
  const t = (i: { type: string; components?: unknown[] }): string =>
    i.type.startsWith('tuple') ? `(${(i.components as { type: string }[]).map(t).join(',')})${i.type.slice(5)}` : i.type;
  return `${e.name}(${(e.inputs ?? []).map(t).join(',')})`;
}

function srcFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? srcFiles(join(dir, d.name)) : d.name.endsWith('.sol') ? [d.name] : [],
  );
}

if (existsSync(OUT)) {
  for (const [name, a] of Object.entries(ABIS)) {
    const abi = readArtifact(a.file, a.contract);
    emit(join(SDK, 'src', 'abi', `${a.module}.ts`), `${HEADER}export const ${name} = ${JSON.stringify(abi, null, 2)} as const;\n`);
  }

  for (const [name, a] of Object.entries(LENSES)) {
    const art = JSON.parse(readFileSync(join(OUT, `${a.file}.sol`, `${a.contract}.json`), 'utf8')) as { abi: AbiItem[]; bytecode: { object: string } };
    emit(
      join(SDK, 'src', 'abi', `${a.module}.ts`),
      `${HEADER}export const ${name}Abi = ${JSON.stringify(art.abi, null, 2)} as const;\n\nexport const ${name}Bytecode = '${art.bytecode.object}' as const;\n`,
    );
  }

  // Every error declared or inherited by a contract or library under contracts/src, by signature.
  const errors = new Map<string, AbiItem>();
  for (const f of srcFiles(SRC).sort()) {
    const dir = join(OUT, f);
    if (!existsSync(dir)) continue;
    for (const j of readdirSync(dir).sort()) {
      if (!j.endsWith('.json')) continue;
      for (const item of readArtifact(basename(f, '.sol'), basename(j, '.json'))) {
        if (item.type === 'error' && !errors.has(sig(item))) errors.set(sig(item), item);
      }
    }
  }
  const sorted = [...errors.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, e]) => e);
  emit(
    join(SDK, 'src', 'abi', 'errors.ts'),
    `${HEADER}/** Every custom error a Novation contract or linked library can revert with (OpenZeppelin's included). */\nexport const novationErrorsAbi = ${JSON.stringify(sorted, null, 2)} as const;\n`,
  );

  const names = [
    ...Object.entries(ABIS).map(([n, a]) => `export { ${n} } from './${a.module}';`),
    ...Object.entries(LENSES).map(([n, a]) => `export { ${n}Abi, ${n}Bytecode } from './${a.module}';`),
  ];
  emit(join(SDK, 'src', 'abi', 'index.ts'), `${HEADER}${names.join('\n')}\nexport { novationErrorsAbi } from './errors';\n`);
} else if (!check) {
  console.warn('contracts/out not found: run `forge build` in contracts/ to refresh the ABIs. Deployments only.');
}

// ---- deployments
const deployments: Record<string, unknown> = {};
const proofs: Record<string, unknown> = {};
for (const f of readdirSync(DEPLOYMENTS).sort()) {
  const id = basename(f, '.json');
  if (!f.endsWith('.json') || LOCAL_CHAINS.has(id)) continue;
  const d = JSON.parse(readFileSync(join(DEPLOYMENTS, f), 'utf8')) as Record<string, unknown>;
  delete d.superseded;
  delete d.kernelPrevious;
  deployments[id] = d;
  const e2e = join(E2E_OUT, f);
  if (existsSync(e2e)) {
    const out = JSON.parse(readFileSync(e2e, 'utf8')) as { txs?: { label: string; tx: string; status: string; block: number; expectedError?: string }[] };
    proofs[id] = {
      refusals: (out.txs ?? [])
        .filter((t) => t.status === 'reverted')
        .map((t) => ({ label: t.label, tx: t.tx, block: t.block, expectedError: t.expectedError ?? null })),
    };
  }
}
emit(
  join(SDK, 'src', 'data', 'deployments.ts'),
  `${HEADER}/** contracts/deployments/<chainId>.json, as deployed. */\nexport const deploymentsJson = ${JSON.stringify(deployments, null, 2)} as const;\n\n` +
    `/** Refused transactions sent by tools/e2e/scenario.py, per chain: real reverts anyone can replay. */\nexport const proofTxsJson = ${JSON.stringify(proofs, null, 2)} as const;\n`,
);

let stale = 0;
for (const { path, text } of pending) {
  // A checkout with core.autocrlf has CRLF endings; the content is what counts.
  const cur = existsSync(path) ? readFileSync(path, 'utf8').replace(/\r\n/g, '\n') : '';
  if (cur === text) continue;
  if (check) {
    console.error(`out of date: ${path}`);
    stale++;
  } else {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    console.log(`wrote ${path}`);
  }
}
if (check && stale) process.exit(1);

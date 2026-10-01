/**
 * Renders the social card, public/og.png (1200×630), from the landing hero.
 *
 *   pnpm build && pnpm og            (starts `next start` itself if nothing answers)
 *   OG_BASE_URL=http://localhost:3100 pnpm og
 *
 * The hero is laid out at 1600×840 and captured at a device scale of 0.75, so the card shows the
 * desktop composition (claim, CTA, the live crown with its session switch) at the card's size.
 */
import { chromium } from '@playwright/test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.OG_PORT ?? 3108);
const BASE = process.env.OG_BASE_URL ?? `http://localhost:${PORT}`;
const LAYOUT = { width: 1600, height: 840 };
const SCALE = 0.75;

async function reachable(url: string): Promise<boolean> {
  try {
    return (await fetch(url)).ok;
  } catch {
    return false;
  }
}

async function startServer(): Promise<ChildProcess | null> {
  if (await reachable(`${BASE}/`)) return null;
  if (process.env.OG_BASE_URL) throw new Error(`${BASE} is not answering`);
  if (!existsSync(join(APP, '.next', 'BUILD_ID'))) {
    console.log('no production build, running next build');
    const b = spawnSync('pnpm', ['build'], { cwd: APP, stdio: 'inherit', shell: true });
    if (b.status !== 0) throw new Error('next build failed');
  }
  const server = spawn('pnpm', ['exec', 'next', 'start', '-p', String(PORT)], { cwd: APP, stdio: 'ignore', shell: true, detached: process.platform !== 'win32' });
  for (let k = 0; k < 120; k++) {
    if (await reachable(`${BASE}/`)) return server;
    await new Promise((r) => setTimeout(r, 500));
  }
  stopServer(server);
  throw new Error('next start did not come up');
}

function stopServer(server: ChildProcess | null) {
  if (!server?.pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(server.pid), '/T', '/F'], { stdio: 'ignore' });
  else process.kill(-server.pid, 'SIGTERM');
}

async function main() {
  const server = await startServer();
  const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
  try {
    const page = await browser.newPage({ viewport: LAYOUT, deviceScaleFactor: SCALE });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    // the hero loads its 3D view on the first sign of a visitor; a pointer move in the corner is one
    await page.mouse.move(4, 4);
    await page.waitForSelector('[data-crown-phase="live"]', { timeout: 60_000 });
    await page.evaluate(() => document.fonts.ready);
    // let the crossfade from the poster finish and the idle turn settle into a frame
    await page.waitForTimeout(1500);
    const png = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, ...LAYOUT } });
    if (errors.length) throw new Error(`page errors while rendering:\n${errors.join('\n')}`);
    await writeFile(join(APP, 'public', 'og.png'), png);
    console.log(`og.png: ${Math.round(LAYOUT.width * SCALE)}x${Math.round(LAYOUT.height * SCALE)}, ${(png.length / 1024).toFixed(1)} KB`);
  } finally {
    await browser.close();
    stopServer(server);
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});

/**
 * Renders the crown stills used before WebGL is ready and where it never loads.
 *
 *   pnpm build && pnpm poster        (starts `next start` itself if nothing answers)
 *   CROWN_BASE_URL=http://localhost:3217 pnpm poster
 *
 * Captures /crown-lab?view=poster (the rest pose on a transparent background) for each session,
 * converts the PNG to WebP inside the page, and writes public/crown-poster*.webp plus the size
 * metadata the Crown uses to place its tooltip over the still.
 */
import { chromium } from '@playwright/test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.CROWN_POSTER_PORT ?? 3107);
const BASE = process.env.CROWN_BASE_URL ?? `http://localhost:${PORT}`;
const DPR = 1.6;
const QUALITY = 0.82;
const SESSIONS = [
  { session: 'REGULAR', file: 'crown-poster.webp' },
  { session: 'WEEKEND', file: 'crown-poster-weekend.webp' },
] as const;

async function reachable(url: string): Promise<boolean> {
  try {
    return (await fetch(url)).ok;
  } catch {
    return false;
  }
}

async function startServer(): Promise<ChildProcess | null> {
  if (await reachable(`${BASE}/crown-lab?view=poster`)) return null;
  if (process.env.CROWN_BASE_URL) throw new Error(`${BASE} is not answering`);
  if (!existsSync(join(APP, '.next', 'BUILD_ID'))) {
    console.log('no production build, running next build');
    const b = spawnSync('pnpm', ['build'], { cwd: APP, stdio: 'inherit', shell: true });
    if (b.status !== 0) throw new Error('next build failed');
  }
  const server = spawn('pnpm', ['exec', 'next', 'start', '-p', String(PORT)], { cwd: APP, stdio: 'ignore', shell: true, detached: process.platform !== 'win32' });
  for (let k = 0; k < 120; k++) {
    if (await reachable(`${BASE}/crown-lab?view=poster`)) return server;
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
  // New headless mode keeps the GPU (ANGLE picks D3D11/Metal/Vulkan); software GL is only a fallback.
  const extra = process.env.CROWN_GPU_ARGS?.split(' ').filter(Boolean) ?? [];
  const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', ...extra] });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 }, deviceScaleFactor: DPR });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('response', (r) => {
      if (r.status() >= 400 && !r.url().endsWith('/favicon.ico')) errors.push(`${r.status()} ${r.url()}`);
    });
    let size = { width: 0, height: 0 };
    for (const { session, file } of SESSIONS) {
      await page.goto(`${BASE}/crown-lab?view=poster&session=${session}`, { waitUntil: 'networkidle' });
      if (session === 'REGULAR') {
        const renderer = await page.evaluate(() => {
          const gl = document.createElement('canvas').getContext('webgl2');
          const ext = gl?.getExtension('WEBGL_debug_renderer_info');
          return gl && ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'unknown';
        });
        console.log(`renderer: ${renderer}`);
      }
      await page.waitForSelector('[data-poster-frame][data-crown-ready="true"]', { timeout: 60_000 });
      const frame = page.locator('[data-poster-frame]');
      const png = await frame.screenshot({ omitBackground: true, type: 'png' });
      const webp = await page.evaluate(
        async ({ b64, q }) => {
          const img = new Image();
          img.src = `data:image/png;base64,${b64}`;
          await img.decode();
          const c = document.createElement('canvas');
          c.width = img.naturalWidth;
          c.height = img.naturalHeight;
          c.getContext('2d')?.drawImage(img, 0, 0);
          return { data: c.toDataURL('image/webp', q).split(',')[1] ?? '', width: c.width, height: c.height };
        },
        { b64: png.toString('base64'), q: QUALITY },
      );
      const bytes = Buffer.from(webp.data, 'base64');
      await writeFile(join(APP, 'public', file), bytes);
      size = { width: webp.width, height: webp.height };
      console.log(`${file}: ${webp.width}x${webp.height}, ${(bytes.length / 1024).toFixed(1)} KB`);
    }
    if (errors.length) throw new Error(`page errors while rendering:\n${errors.join('\n')}`);
    const meta = {
      width: size.width,
      height: size.height,
      sessions: Object.fromEntries(SESSIONS.map((s) => [s.session, `/${s.file}`])),
    };
    await writeFile(join(APP, 'src', 'components', 'crown', 'poster-meta.json'), JSON.stringify(meta, null, 2) + '\n');
  } finally {
    await browser.close();
    stopServer(server);
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});

/*
* Makes the picture in the README.
*
*     node tools/screenshot.mjs [docs/screenshot.png]
*
* It drives the same page as the browser test - a real FTUI page against the
* fake FHEM of test/harness - and photographs one tile of it. Needs the FTUI
* checkout (test/get-ftui.sh) and Playwright.
*/

import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startFakeFhem } from '../test/harness/fake-fhem.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoDir = join(here, '..');
const ftuiDir = process.env.FTUI_DIR || join(repoDir, '.ftui');
const out = process.argv[2] || join(repoDir, 'docs/screenshot.png');

const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright');

const dataDir = await mkdtemp(join(tmpdir(), 'neato-shot-'));
const reference = await readFile(join(repoDir, 'test/fixtures/reference-track-botvac-d6.jsonl'), 'utf8');
const lines = reference.split('\n').filter(line => line.trim() && !line.startsWith('#'));

for (const [name, summary] of [
  ['Staubsauger-2026-09-20_11-59-11.jsonl', { points: 549, scans: 50, distance: 137.8, seconds: 1500 }],
  ['Staubsauger-2026-09-19_09-30-00.jsonl', { points: 512, scans: 46, distance: 121.4, seconds: 1380 }],
  ['Staubsauger-2026-09-18_14-05-00.jsonl', { points: 210, scans: 4, distance: 42.5, seconds: 640 }],
]) {
  await writeFile(join(dataDir, name), lines.concat(JSON.stringify({ summary })).join('\n') + '\n');
}

const fhem = await startFakeFhem({
  ftuiDir,
  repoDir,
  dataDir,
  pageDir: join(repoDir, 'test/harness'),
  readings: { state: 'docked', trackFile: './www/neato/Staubsauger-2026-09-20_11-59-11.jsonl' },
});

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1000, height: 760 }, deviceScaleFactor: 2 });
await page.goto(`${fhem.url}/fhem/ftui/page/page.html`);
await page.waitForFunction(() => !!document.querySelector('#map-bound')
  ?.shadowRoot?.querySelector('.stage svg'), null, { timeout: 15000 });
await page.waitForTimeout(500);

await mkdir(dirname(out), { recursive: true });
await page.locator('#bound').screenshot({ path: out });
console.log(out);

await browser.close();
await fhem.close();
await rm(dataDir, { recursive: true, force: true });

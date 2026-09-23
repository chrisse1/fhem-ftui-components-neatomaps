/*
* Makes the pictures in the README.
*
*     node tools/screenshot.mjs                        # aus den Fixtures
*     node tools/screenshot.mjs /opt/fhem/www/neato Staubsauger
*
* It drives a real FTUI page against the fake FHEM of test/harness and
* photographs it, so the pictures show the component as it actually draws -
* not a mock-up. Needs the FTUI checkout (test/get-ftui.sh) and Playwright.
*
* With a folder of recordings it uses those; the pictures in the repository
* were made that way, from four hour-long runs of one flat. Without one it
* falls back to the thinned reference recording in test/fixtures, which is
* enough for the wall styles but not for the cleaned area - twenty seconds
* between two poses say nothing about where the brush went, and the component
* rightly leaves the number out.
*
* Under MIT License (http://www.opensource.org/licenses/mit-license.php)
*/

import { mkdtemp, readFile, writeFile, rm, mkdir, readdir, copyFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startFakeFhem } from '../test/harness/fake-fhem.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoDir = join(here, '..');
const ftuiDir = process.env.FTUI_DIR || join(repoDir, '.ftui');
const [from, device = 'Staubsauger'] = process.argv.slice(2);

const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright');

const dataDir = await mkdtemp(join(tmpdir(), 'neato-shot-'));
const pageDir = await mkdtemp(join(tmpdir(), 'neato-page-'));
let newest = '';

if (from) {
  for (const name of (await readdir(from)).filter(n => n.endsWith('.jsonl')).sort()) {
    await copyFile(join(from, name), join(dataDir, name));
    newest = name;
  }
} else {
  // Three copies of the reference, so there is something to page through.
  const reference = await readFile(join(repoDir, 'test/fixtures/reference-track-botvac-d6.jsonl'), 'utf8');
  const lines = reference.split('\n').filter(line => line.trim() && !line.startsWith('#'));
  for (const [name, summary] of [
    ['Staubsauger-2026-09-18_14-05-00.jsonl', { points: 210, scans: 10, distance: 42.5, seconds: 640 }],
    ['Staubsauger-2026-09-19_09-30-00.jsonl', { points: 549, scans: 50, distance: 137.8, seconds: 1500 }],
    ['Staubsauger-2026-09-20_11-59-11.jsonl', { points: 549, scans: 50, distance: 137.8, seconds: 1500 }],
  ]) {
    await writeFile(join(dataDir, name), [...lines, JSON.stringify({ summary })].join('\n') + '\n');
    newest = name;
  }
}

if (!newest) {
  process.stderr.write(`Keine .jsonl in ${from || 'test/fixtures'}.\n`);
  process.exit(1);
}

execFileSync(process.execPath, [join(here, 'make-plan.mjs'), dataDir, device], { stdio: 'pipe' });

const fhem = await startFakeFhem({
  ftuiDir,
  repoDir,
  dataDir,
  pageDir,
  readings: { state: 'docked', trackFile: '', planFile: `./www/neato/plan-${device}.json` },
});

const browser = await chromium.launch();
await mkdir(join(repoDir, 'docs'), { recursive: true });

/** One page, one photograph. */
async function shoot(file, body, width, height) {
  const name = file.replace('.png', '');
  await writeFile(join(pageDir, `${name}.html`), `<!DOCTYPE html><html lang="de">
<head><base href="../" /><script src="ftui.js"></script>
<link href="ftui.css" rel="stylesheet"><link href="themes/ftui-theme.css" rel="stylesheet">
<meta name="fhemweb_url" content="fhem"><meta name="toast" content="0"><title>${name}</title>
<style>body{margin:0;background:#1b1e24;font-family:system-ui}
.row{display:flex;gap:10px;padding:10px;height:calc(100vh - 20px)}
.box{background:#2b2f36;border-radius:10px;display:flex;flex-direction:column;overflow:hidden;flex:1;padding:8px}
.cap{color:#aeb7c2;font-size:13px;padding:1px 4px 7px}</style></head><body>${body}</body></html>`);

  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 });
  page.on('pageerror', error => process.stderr.write(`${name}: ${error}\n`));
  await page.goto(`${fhem.url}/fhem/ftui/page/${name}.html`);
  await page.waitForFunction(() => [...document.querySelectorAll('ftui-neato-map')]
    .every(map => map.shadowRoot && map.shadowRoot.querySelector('.stage svg')), null, { timeout: 60000 });
  await page.waitForTimeout(1400);
  await page.screenshot({ path: join(repoDir, 'docs', file) });
  await page.close();
  process.stdout.write(`docs/${file}\n`);
}

const styles = ['dots', 'lines', 'cells'].map(walls =>
  `<div class="box"><div class="cap">walls="${walls}"${walls === 'dots' ? ' – Standard' : ''}</div>
  <ftui-neato-map walls="${walls}" show-info="false" show-controls="false"
    file="${newest}"></ftui-neato-map></div>`).join('');

await shoot('screenshot.png', `<ftui-grid resize margin="8" shape="round">
  <ftui-grid-tile row="1" col="1" width="6" height="6">
    <ftui-grid-header>${device}</ftui-grid-header>
    <ftui-neato-map device="${device}" show-cleaned show-toggle
      plan-file="plan-${device}.json"></ftui-neato-map>
  </ftui-grid-tile>
</ftui-grid>`, 620, 660);

await shoot('wall-styles.png', `<div class="row">${styles}</div>`, 1250, 620);

await shoot('plan.png', `<div class="row">
  <div class="box"><div class="cap">ein Lauf</div>
  <ftui-neato-map show-controls="false" show-info="false" file="${newest}"></ftui-neato-map></div>
  <div class="box"><div class="cap">view="plan" – mehrere Läufe übereinander</div>
  <ftui-neato-map device="${device}" view="plan" plan-file="plan-${device}.json"
    show-controls="false"></ftui-neato-map></div>
</div>`, 1100, 640);

await shoot('cleaned.png', `<div class="row">
  <div class="box"><div class="cap">show-cleaned – die Zahl in der Zeile</div>
  <ftui-neato-map show-cleaned show-controls="false" file="${newest}"></ftui-neato-map></div>
  <div class="box"><div class="cap">show-missed – dazu der ausgelassene Boden</div>
  <ftui-neato-map show-missed show-cleaned show-controls="false" file="${newest}"></ftui-neato-map></div>
</div>`, 1100, 640);

await browser.close();
await fhem.close();
await rm(dataDir, { recursive: true, force: true });
await rm(pageDir, { recursive: true, force: true });

/*
* Writes a finished floor plan from a folder of recordings.
*
*     node tools/make-plan.mjs /opt/fhem/www/neato Staubsauger
*     node tools/make-plan.mjs /opt/fhem/www/neato Staubsauger --runs 10
*
* Why this exists at all: the component can compute the plan itself, and for
* three or four runs that is fine. Beyond that it stops being fine, and the
* numbers say so rather than a feeling -
*
*   ten runs of an hour at mapInterval 15   about 5.5 MB to download
*   the same ten runs as a finished plan    7 kB gzipped
*   computing it, measured in Chromium      1.2 s for three runs, 5.2 s on a
*                                           tablet-speed CPU, and it grows
*
* - so a panel that shows the plan should load the answer, not the question.
* This writes the answer, as plan-<device>.json next to the recordings:
*
*     { "cell": 0.1, "runs": 3, "built": "...", "cells": [[ix, iy, walls, seen], ...] }
*
* Cell indices, not metres: that is what they are, and it keeps the file small.
* `walls` is how many runs call the cell a wall, `seen` how many looked at it
* at all - the component needs both to tell a wall nobody has contradicted
* from one everybody confirms.
*
* Run it after a cleaning run, from FHEM or from cron. The component is then
* pointed at the file with plan-file="plan-Staubsauger.json" and does nothing
* but draw it.
*
* Under MIT License (http://www.opensource.org/licenses/mit-license.php)
*/

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { parseSession } from '../www/ftui/components/neato/neato-track.js';
import { survey, mergePlan } from '../www/ftui/components/neato/neato-plan.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf('--' + name);
  return at >= 0 && args[at + 1] !== undefined ? args[at + 1] : fallback;
};
const [dir, device] = args.filter((value, i) =>
  !value.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));

if (!dir) {
  process.stderr.write('node tools/make-plan.mjs <verzeichnis> [geraet] [--runs 8] [--cell 0.10] [--out datei]\n');
  process.exit(2);
}

const runs = Number(flag('runs', 8));
const cell = Number(flag('cell', 0.10));
const out = flag('out', join(dir, `plan-${device || 'neato'}.json`));

const names = readdirSync(dir)
  .filter(name => name.endsWith('.jsonl') && (!device || name.startsWith(device + '-')))
  .sort()
  .reverse()
  .slice(0, Math.max(1, runs));

if (!names.length) {
  process.stderr.write(`Keine Aufzeichnungen in ${dir}${device ? ` fuer ${device}` : ''}.\n`);
  process.exit(1);
}

const surveys = [];
for (const name of names) {
  const started = performance.now();
  const session = parseSession(readFileSync(join(dir, name), 'utf8'));
  if (!session.scans.length) {
    process.stdout.write(`${name}: keine Scans, uebersprungen\n`);
    continue;
  }
  surveys.push(survey(session, { cell }));
  process.stdout.write(`${name}: ${session.scans.length} Scans,`
    + ` ${(performance.now() - started).toFixed(0)} ms\n`);
}

const started = performance.now();
const plan = mergePlan(surveys, { cell });
process.stdout.write(`\nZusammengelegt in ${(performance.now() - started).toFixed(0)} ms:`
  + ` ${plan.runs} von ${surveys.length} Laeufen, ${plan.cells.length} Zellen\n`);

for (const rejected of plan.rejected) {
  process.stdout.write(`  abgelehnt: ${names[rejected.index]} (Guete ${(rejected.score * 100).toFixed(0)} %)\n`);
}

const body = JSON.stringify({
  cell,
  runs: plan.runs,
  built: new Date().toISOString(),
  files: plan.placements.map(placement => names[placement.index]),
  cells: plan.cells.map(spot => [
    Math.round(spot.x / cell), Math.round(spot.y / cell), spot.walls, spot.seen,
  ]),
});

writeFileSync(out, body);
process.stdout.write(`${out}: ${(body.length / 1024).toFixed(0)} kB\n`);

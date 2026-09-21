/*
* Holds a recording against the settings the walls are simplified with.
*
*     node tools/tune-walls.mjs <session.jsonl> [out.svg]
*
* The defaults in neato-walls.js were measured against one recording: the
* thinned reference of the module repository, ten revolutions of a flat. A run
* with mapInterval 5 has three hundred of them and a much denser point cloud,
* and what is a good setting there is a question for the data, not for an
* opinion. This prints the two numbers that answer it:
*
*   Segmente    how calm the picture is - fewer is calmer
*   Abdeckung   how much of what the grid calls wall the lines actually cover,
*               exactly and with one cell of slack - lower means walls are
*               missing from the drawing
*
* A setting that lowers the first without lowering the second is better. With
* an output file it also writes the map as SVG, which is the other half of the
* answer: numbers do not show a line drawn through a room.
*/

import { readFileSync, writeFileSync } from 'node:fs';

import { parseSession, occupancy, classify, allPoints } from '../www/ftui/components/neato/neato-track.js';
import { wallLines, wallTest } from '../www/ftui/components/neato/neato-walls.js';
import { alignScans, agreement } from '../www/ftui/components/neato/neato-align.js';

const [, , path, out] = process.argv;

if (!path) {
  process.stderr.write('node tools/tune-walls.mjs <session.jsonl> [out.svg]\n');
  process.exit(2);
}

const session = parseSession(readFileSync(path, 'utf8'));
const { poses } = session;
const recorded = session.scans;

if (!recorded.length) {
  process.stderr.write(`${path} has no scans - nothing to simplify.\n`
    + 'Lidar scans need "attr <device> mapInterval <seconds>".\n');
  process.exit(1);
}

// Wie die Komponente: erst die Umdrehungen aufeinanderlegen, dann zeichnen.
const before = agreement(recorded);
const aligned = performance.now();
const scans = alignScans(recorded).scans;
const alignMs = performance.now() - aligned;
const points = allPoints(scans);
process.stdout.write(`${path}\n${scans.length} Scans, ${points.length / 2} Punkte, `
  + `${poses.length} Posen${session.summary ? '' : ', noch ohne Abschlusszeile (laeuft?)'}\n`);
process.stdout.write(`Ausrichten: Schaerfe ${before.toFixed(4)} -> ${agreement(scans).toFixed(4)} `
  + `in ${alignMs.toFixed(0)} ms (kleiner ist schaerfer)\n\n`);

/** How much of the grid's wall cells the lines cover, in percent. */
function coverage(walls, grid, cells, slack) {
  const wallCells = [];
  for (const [ix, iy, run] of cells.walls) {
    for (let i = 0; i < run; i++) {
      wallCells.push(`${ix + i},${iy}`);
    }
  }

  const covered = new Set();
  for (const wall of walls) {
    const steps = Math.ceil(wall.length / (grid.cell / 2)) + 1;
    for (let i = 0; i <= steps; i++) {
      const x = wall.x0 + (wall.x1 - wall.x0) * (i / steps);
      const y = wall.y0 + (wall.y1 - wall.y0) * (i / steps);
      const ix = Math.floor(x / grid.cell) - grid.x0;
      const iy = Math.floor(y / grid.cell) - grid.y0;
      for (let dx = -slack; dx <= slack; dx++) {
        for (let dy = -slack; dy <= slack; dy++) {
          covered.add(`${ix + dx},${iy + dy}`);
        }
      }
    }
  }

  const hit = wallCells.filter(key => covered.has(key)).length;
  return wallCells.length ? (100 * hit / wallCells.length) : 0;
}

const runs = [
  { name: 'Standard', options: {} },
  { name: 'cell 0.05', cell: 0.05, options: {} },
  { name: 'cell 0.20', cell: 0.20, options: {} },
  { name: 'tolerance 0.02', options: { tolerance: 0.02 } },
  { name: 'tolerance 0.08', options: { tolerance: 0.08 } },
  { name: 'step 0.20', options: { step: 0.20 } },
  { name: 'step 0.50', options: { step: 0.50 } },
  { name: 'gap 0.30', options: { gap: 0.30 } },
  { name: 'gap 1.50', options: { gap: 1.50 } },
  { name: 'min-wall 0.25', options: { minLength: 0.25 } },
  { name: 'min-wall 0.60', options: { minLength: 0.60 } },
  { name: 'ohne Einrasten', options: { snapDegrees: 0 } },
  { name: 'alle Scans', options: { maxScans: 0 } },
  { name: 'ohne Ausrichten', scans: recorded, options: {} },
  { name: 'ohne Ecken', options: { cornerReach: 0 } },
  { name: 'ohne Fahrweg-Regel', options: { clearance: -1 } },
];

process.stdout.write('                    Segmente   Abdeckung    Laenge     Zeit\n');

let reference = null;
for (const run of runs) {
  const cell = run.cell || 0.10;
  const use = run.scans || scans;
  const started = performance.now();
  const grid = occupancy(use, cell);
  const cells = classify(grid, 0.25, 2);
  const { walls, direction } = wallLines(use, grid, wallTest(grid, 0.25, 2),
    { poses, ...run.options });
  const took = performance.now() - started;

  const exact = coverage(walls, grid, cells, 0);
  const slack = coverage(walls, grid, cells, 1);
  const metres = walls.reduce((sum, wall) => sum + wall.length, 0);

  process.stdout.write(`${run.name.padEnd(20)}${String(walls.length).padStart(6)}`
    + `${`${exact.toFixed(0)} / ${slack.toFixed(0)} %`.padStart(14)}`
    + `${`${metres.toFixed(1)} m`.padStart(10)}`
    + `${`${took.toFixed(0)} ms`.padStart(9)}\n`);

  if (!reference) {
    reference = { grid, cells, walls, direction };
  }
}

process.stdout.write(`\nvorherrschende Richtung: ${(reference.direction * 180 / Math.PI).toFixed(1)} Grad\n`);

if (out) {
  writeFileSync(out, draw(reference));
  process.stdout.write(`${out} geschrieben\n`);
}

/** The map with the default settings, as an SVG to look at. */
function draw({ grid, cells, walls }) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < points.length; i += 2) {
    minX = Math.min(minX, points[i]); maxX = Math.max(maxX, points[i]);
    minY = Math.min(minY, points[i + 1]); maxY = Math.max(maxY, points[i + 1]);
  }
  for (const pose of poses) {
    minX = Math.min(minX, pose.x); maxX = Math.max(maxX, pose.x);
    minY = Math.min(minY, pose.y); maxY = Math.max(maxY, pose.y);
  }

  const pad = 0.4;
  const width = (maxX - minX) + 2 * pad;
  const height = (maxY - minY) + 2 * pad;
  const scale = 900 / Math.max(width, height);
  const sx = (x) => ((x - minX + pad) * scale).toFixed(1);
  const sy = (y) => ((maxY - y + pad) * scale).toFixed(1);

  const free = cells.free.map(([ix, iy, run]) =>
    `<rect x="${sx((ix + grid.x0) * grid.cell)}" y="${sy((iy + grid.y0 + 1) * grid.cell)}"`
    + ` width="${(run * grid.cell * scale + 0.5).toFixed(1)}"`
    + ` height="${(grid.cell * scale + 0.5).toFixed(1)}" fill="#3b4048"/>`).join('');

  const lines = walls.map(wall =>
    `<line x1="${sx(wall.x0)}" y1="${sy(wall.y0)}" x2="${sx(wall.x1)}" y2="${sy(wall.y1)}"`
    + ' stroke="#9ec9f0" stroke-width="3.5" stroke-linecap="round"/>').join('');

  const track = poses.map(pose => `${sx(pose.x)},${sy(pose.y)}`).join(' ');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${(width * scale).toFixed(0)}"`
    + ` height="${(height * scale).toFixed(0)}">`
    + '<rect width="100%" height="100%" fill="#2b2f36"/>'
    + `${free}${lines}`
    + `<polyline points="${track}" fill="none" stroke="#ffb454" stroke-width="2" opacity="0.85"/>`
    + `<text x="12" y="24" fill="#cfd6df" font-family="system-ui" font-size="15">`
    + `${walls.length} Segmente aus ${scans.length} Scans, ${width.toFixed(1)} x ${height.toFixed(1)} m</text>`
    + '</svg>\n';
}

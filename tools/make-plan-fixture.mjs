/*
* Writes test/fixtures/plan/, the reference case for a floor plan.
*
*     node tools/make-plan-fixture.mjs
*
* Three recordings of the same made-up flat, each in its own frame - because
* that is the situation a plan has to cope with, and because a port of this
* needs something whose answer is known rather than a flat somebody lives in.
*
*   room-a.jsonl   the frame everything else is matched against
*   room-b.jsonl   the same flat, turned 90 degrees and moved
*   room-c.jsonl   turned 200 degrees, moved, and only half of it driven
*   moves.json     the turns and shifts that were applied, to the centimetre
*   plan.json      what this repository's code makes of the three
*
* An implementation in another language will not land on exactly the same
* optimum - a hill climb in Perl finds a slightly different hilltop than one
* in JavaScript. tools/check-plan.mjs says how close is close enough.
*
* Under MIT License (http://www.opensource.org/licenses/mit-license.php)
*/

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parseSession } from '../www/ftui/components/neato/neato-track.js';
import { survey, mergePlan } from '../www/ftui/components/neato/neato-plan.js';

// An L, on purpose: a rectangle with a divider looks the same upside down,
// and then there is no single right answer to find.
const FLAT = [
  [0, 0, 9, 0], [9, 0, 9, 6], [9, 6, 5.5, 6],
  [5.5, 6, 5.5, 4], [5.5, 4, 0, 4], [0, 4, 0, 0],
  [3.5, 0, 3.5, 1.6], [3.5, 2.6, 3.5, 4],          // divider with a door
  [6.5, 1, 8, 1], [8, 1, 8, 2.2], [8, 2.2, 6.5, 2.2], [6.5, 2.2, 6.5, 1],
];

const MOVES = [
  { name: 'room-a', degrees: 0, x: 0, y: 0, half: false },
  { name: 'room-b', degrees: 90, x: 3.5, y: -2, half: false },
  { name: 'room-c', degrees: 200, x: -1.5, y: 4.25, half: true },
];

/** The flat as a robot that set off in a turned frame would have measured it. */
function inFrame(segments, degrees, dx, dy) {
  const radians = degrees * Math.PI / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const at = (x, y) => [cos * x - sin * y + dx, sin * x + cos * y + dy];
  return segments.map(([ax, ay, bx, by]) => [...at(ax, ay), ...at(bx, by)]);
}

function recording(segments, stops) {
  const out = [{ device: 'Testwohnung', started: '2026-01-03_08-00-00', module: '0.19.0', unit: 'm' }];
  let t = 500;

  for (const [x, y] of stops) {
    const pts = [];
    for (let degrees = 0; degrees < 360; degrees += 2) {
      const radians = degrees * Math.PI / 180;
      const dx = Math.cos(radians);
      const dy = Math.sin(radians);

      let nearest = Infinity;
      for (const [ax, ay, bx, by] of segments) {
        const ex = bx - ax;
        const ey = by - ay;
        const denominator = dx * ey - dy * ex;
        if (Math.abs(denominator) < 1e-12) {
          continue;
        }
        const along = ((ax - x) * ey - (ay - y) * ex) / denominator;
        const across = ((ax - x) * dy - (ay - y) * dx) / denominator;
        if (along > 0.05 && across >= 0 && across <= 1 && along < nearest) {
          nearest = along;
        }
      }
      if (nearest < Infinity) {
        // A centimetre of noise, so the grid has something to decide and the
        // match is not a lucky exact hit.
        pts.push([degrees, Math.round(nearest * 1000 + ((degrees * 7) % 13) - 6)]);
      }
    }

    out.push({ t, x: Number(x.toFixed(3)), y: Number(y.toFixed(3)), th: 0 });
    out.push({ scan: { x: Number(x.toFixed(3)), y: Number(y.toFixed(3)), th: 0, speed: 5, pose: 'Smooth', pts } });
    t += 4;
  }

  out.push({ summary: { points: stops.length, scans: stops.length, distance: stops.length * 1.5, rotation: 3600, seconds: stops.length * 4 } });
  return out.map(line => JSON.stringify(line)).join('\n') + '\n';
}

const dir = fileURLToPath(new URL('../test/fixtures/plan/', import.meta.url));
mkdirSync(dir, { recursive: true });

const surveys = [];
for (const move of MOVES) {
  const stops = [];
  for (let x = 0.8; x <= 8.4; x += 0.9) {
    for (let y = 0.8; y <= 5.4; y += 0.9) {
      if (y > 3.6 && x < 5.9) {
        continue;                              // outside the L
      }
      if (move.half && x > 5) {
        continue;                              // this one gave up early
      }
      const radians = move.degrees * Math.PI / 180;
      stops.push([
        Math.cos(radians) * x - Math.sin(radians) * y + move.x,
        Math.sin(radians) * x + Math.cos(radians) * y + move.y,
      ]);
    }
  }

  const text = recording(inFrame(FLAT, move.degrees, move.x, move.y), stops);
  writeFileSync(`${dir}${move.name}.jsonl`, text);
  surveys.push(survey(parseSession(text)));
  process.stdout.write(`${move.name}.jsonl: ${stops.length} Scans, ${(text.length / 1024).toFixed(0)} kB\n`);
}

writeFileSync(`${dir}moves.json`, JSON.stringify({ flat: FLAT, moves: MOVES }, null, 1));

const plan = mergePlan(surveys);
process.stdout.write(`\n${plan.runs} Laeufe zusammengelegt, ${plan.cells.length} Zellen\n`);
for (const placement of plan.placements) {
  process.stdout.write(`  ${MOVES[placement.index].name}:`
    + ` ${((placement.angle * 180 / Math.PI) % 360 + 360) % 360}`.slice(0, 20)
    + ` Grad, ${placement.x.toFixed(2)}/${placement.y.toFixed(2)}, Guete ${(placement.score * 100).toFixed(0)} %\n`);
}
for (const bad of plan.rejected) {
  process.stdout.write(`  ABGELEHNT ${MOVES[bad.index].name} (${(bad.score * 100).toFixed(0)} %)\n`);
}

writeFileSync(`${dir}plan.json`, JSON.stringify({
  cell: plan.cell,
  runs: plan.runs,
  files: plan.placements.map(placement => `${MOVES[placement.index].name}.jsonl`),
  scores: [...plan.placements.map(p => ({ ...p, used: true })),
    ...plan.rejected.map(p => ({ ...p, used: false }))]
    .map(entry => ({
      file: `${MOVES[entry.index].name}.jsonl`,
      score: Number(entry.score.toFixed(3)),
      used: entry.used,
    }))
    .sort((a, b) => b.score - a.score),
  cells: plan.cells.map(spot => [
    Math.round(spot.x / plan.cell), Math.round(spot.y / plan.cell), spot.walls, spot.seen,
  ]),
}));
process.stdout.write(`${dir}plan.json geschrieben\n`);

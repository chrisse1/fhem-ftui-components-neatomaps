/*
* The map maths, held against the Python reference.
*
*     node --test test/
*
* The fixture in test/fixtures/expected-grid.json was written by
* tools/expected_from_python.py from tools/track_map.py of chrisse1/neato-FHEM.
* Cell counts alone would not catch much - a mirrored convention yields about
* as many cells - so the checksums cover which cells they are.
*/

import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  parseSession, worldPoints, allPoints, occupancy, classify, countCells,
  stats, parseFileName,
} from '../www/ftui/components/neato/neato-track.js';

const here = (name) => fileURLToPath(new URL(name, import.meta.url));

const text = readFileSync(here('fixtures/reference-track-botvac-d6.jsonl'), 'utf8');
const expected = JSON.parse(readFileSync(here('fixtures/expected-grid.json'), 'utf8'));
const session = parseSession(text);

function digest(cells) {
  // Ordered as Python orders its tuples: by x, then by y, both as numbers.
  const joined = cells
    .slice()
    .sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]))
    .map(([x, y]) => `${x},${y}`)
    .join(';');
  return createHash('sha1').update(joined).digest('hex');
}

/** Row runs back to single cells, in the grid's own coordinates. */
function cells(runs, grid) {
  const out = [];
  for (const [ix, iy, len] of runs) {
    for (let i = 0; i < len; i++) {
      out.push([ix + i + grid.x0, iy + grid.y0]);
    }
  }
  return out;
}

test('parses the four kinds of record and skips comments', () => {
  assert.equal(session.head.device, expected.device);
  assert.equal(session.head.unit, 'm');
  assert.equal(session.poses.length, expected.poses);
  assert.equal(session.scans.length, expected.scans);
  // The reference excerpt is a run cut short - no summary line.
  assert.equal(session.summary, null);
});

test('a half written last line does not lose the rest of the file', () => {
  const truncated = parseSession(text + '\n{"scan":{"x":1.0,"y":2.0,"th":9');
  assert.equal(truncated.scans.length, expected.scans);
  assert.equal(truncated.poses.length, expected.poses);
});

test('points land where the Python reference puts them', () => {
  const points = allPoints(session.scans);
  assert.equal(points.length / 2, expected.points);

  expected.firstPoints.forEach(([x, y], i) => {
    assert.ok(Math.abs(points[i * 2] - x) < 1e-9, `x of point ${i}: ${points[i * 2]} != ${x}`);
    assert.ok(Math.abs(points[i * 2 + 1] - y) < 1e-9, `y of point ${i}: ${points[i * 2 + 1]} != ${y}`);
  });

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < points.length; i += 2) {
    minX = Math.min(minX, points[i]);
    maxX = Math.max(maxX, points[i]);
    minY = Math.min(minY, points[i + 1]);
    maxY = Math.max(maxY, points[i + 1]);
  }
  assert.ok(Math.abs(minX - expected.bounds.minX) < 1e-9);
  assert.ok(Math.abs(maxX - expected.bounds.maxX) < 1e-9);
  assert.ok(Math.abs(minY - expected.bounds.minY) < 1e-9);
  assert.ok(Math.abs(maxY - expected.bounds.maxY) < 1e-9);
});

test('the mirrored convention is a different map', () => {
  // The second best of the 96 conventions tried against real data: theta and
  // the lidar angle both negated, turned by 180 degrees. It looks nearly as
  // tidy, which is why this test exists rather than an eye on a picture.
  const mirrored = session.scans.map(scan => ({
    x: scan.x,
    y: scan.y,
    th: -scan.th + 180,
    pts: scan.pts.map(([angle, distance]) => [-angle, distance]),
  }));

  const grid = occupancy(mirrored, expected.cell);
  const { walls } = classify(grid, expected.threshold, expected.seen);
  assert.notEqual(digest(cells(walls, grid)), expected.wallsSha1);
});

test('the occupancy grid is the one the reference computes', () => {
  const grid = occupancy(session.scans, expected.cell);
  const { walls, free } = classify(grid, expected.threshold, expected.seen);

  assert.equal(countCells(walls), expected.walls);
  assert.equal(countCells(free), expected.free);
  assert.equal(countCells(walls) + countCells(free) <= expected.observed, true);

  assert.equal(digest(cells(walls, grid)), expected.wallsSha1);
  assert.equal(digest(cells(free, grid)), expected.freeSha1);
});

test('row runs cover each row once and stay inside the grid', () => {
  const grid = occupancy(session.scans, expected.cell);
  const { walls, free } = classify(grid, expected.threshold, expected.seen);

  for (const [ix, iy, len] of [...walls, ...free]) {
    assert.ok(len > 0);
    assert.ok(ix >= 0 && ix + len <= grid.width, `run ${ix}+${len} outside ${grid.width}`);
    assert.ok(iy >= 0 && iy < grid.height);
  }

  const seen = new Set();
  for (const [ix, iy, len] of [...walls, ...free]) {
    for (let i = 0; i < len; i++) {
      const key = `${ix + i},${iy}`;
      assert.ok(!seen.has(key), `cell ${key} in two runs`);
      seen.add(key);
    }
  }
});

test('a scan of a single beam marks the way free and the end a wall', () => {
  // Three metres due east from the origin, seen twice so it counts.
  const scan = { x: 0, y: 0, th: 0, pts: [[0, 3000]] };
  const grid = occupancy([scan, scan], 0.05);
  const { walls, free } = classify(grid, 0.25, 2);

  assert.equal(countCells(walls), 1);
  assert.equal(walls[0][0] + grid.x0, 60);           // 3.00 m / 0.05 m
  assert.equal(countCells(free), 60);                // everything up to it
  assert.equal(free[0][0] + grid.x0, 0);
  assert.equal(free[0][2], 60);                      // one rectangle, not 60 squares
});

test('nothing is claimed behind the endpoint', () => {
  const scan = { x: 0, y: 0, th: 0, pts: [[0, 1000]] };
  const grid = occupancy([scan, scan], 0.05);
  assert.equal(grid.width, 21);                      // 0 .. 20, and no further
});

test('a run in progress reports its numbers from the poses', () => {
  const running = stats(session);
  assert.equal(running.running, true);
  assert.equal(running.poses, expected.poses);
  assert.ok(running.distance > 0);
  assert.ok(running.seconds > 0);

  const finished = stats({
    poses: session.poses,
    scans: session.scans,
    summary: { points: 549, scans: 50, distance: 137.8, seconds: 1500 },
  });
  assert.equal(finished.running, false);
  assert.equal(finished.distance, 137.8);
  assert.equal(finished.seconds, 1500);
  assert.equal(finished.scans, 50);
});

test('the file name says device and start time', () => {
  const parsed = parseFileName('/opt/fhem/www/neato/Staubsauger-2026-09-20_11-59-11.jsonl');
  assert.equal(parsed.name, 'Staubsauger-2026-09-20_11-59-11.jsonl');
  assert.equal(parsed.device, 'Staubsauger');
  assert.equal(parsed.date.getFullYear(), 2026);
  assert.equal(parsed.date.getMonth(), 8);
  assert.equal(parsed.date.getDate(), 20);
  assert.equal(parsed.date.getHours(), 11);
  assert.equal(parsed.date.getMinutes(), 59);

  const foreign = parseFileName('whatever.jsonl');
  assert.equal(foreign.date, null);
  assert.equal(foreign.name, 'whatever.jsonl');
});

test('worldPoints fills a shared buffer at an offset', () => {
  const scan = session.scans[0];
  const buffer = new Float64Array(scan.pts.length * 2 + 4);
  worldPoints(scan, buffer, 4);
  const single = worldPoints(scan);
  assert.equal(buffer[4], single[0]);
  assert.equal(buffer[5], single[1]);
});

/*
* How the run went: the floor that was left out, and where he stood still.
*
* Both numbers are easy to produce and easy to produce wrongly, and a wrong one
* is worse than none - "74 % gereinigt" under a map is believed. So these tests
* hold the two things that make them trustworthy: the arithmetic has to match a
* room whose answer is known by hand, and a recording that cannot answer has to
* say so instead of guessing.
*/

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parseSession, occupancy, classify } from '../www/ftui/components/neato/neato-track.js';
import { countMissed, trackIsDense, standstills } from '../www/ftui/components/neato/neato-run.js';

const here = (name) => fileURLToPath(new URL(name, import.meta.url));
const read = (name) => parseSession(readFileSync(here(name), 'utf8'));

/** Grid and cells of a session, as the component builds them. */
function mapOf(session, cell = 0.10) {
  const grid = occupancy(session.scans, cell);
  return { grid, cells: classify(grid, 0.25, 2) };
}

// A made-up room of 5 x 4 m, driven in lanes up to x = 3.6 and then stopped
// dead. tools/make-room-fixture.mjs builds it; what it leaves out is known.
const room = read('fixtures/room-run.jsonl');

test('the strip he never drove over is the one that is counted', () => {
  const { grid, cells } = mapOf(room);
  const missed = countMissed(grid, cells, room.poses);

  // The lanes end at x = 3.6 and the brush reaches 16 cm beyond that, so
  // everything right of about 3.76 m is left - roughly 1.2 m of a 4 m wide
  // room, and nothing of the rest.
  assert.ok(missed.area > 4 && missed.area < 6, `${missed.area.toFixed(1)} m2 left out`);
  assert.ok(missed.covered > 0.68 && missed.covered < 0.80,
    `covered ${(missed.covered * 100).toFixed(0)} %`);

  // Nothing may be counted in the middle of the room he did drive over. What
  // may is the hand's width along each wall: a disc of 32 cm cannot put its
  // centre closer than 16 cm to one, so that band really does stay dirty.
  for (const [ix, iy, run] of missed.runs) {
    const y = (iy + grid.y0) * grid.cell;
    for (let i = 0; i < run; i++) {
      const x = (ix + i + grid.x0) * grid.cell;
      assert.ok(!(x > 0.5 && x < 3.4 && y > 0.5 && y < 3.5),
        `the cell at ${x.toFixed(2)} / ${y.toFixed(2)} counts as left out, but he drove there`);
    }
  }
});

test('a wider brush leaves less behind', () => {
  const { grid, cells } = mapOf(room);
  const narrow = countMissed(grid, cells, room.poses, { width: 0.20 });
  const wide = countMissed(grid, cells, room.poses, { width: 0.50 });

  assert.ok(wide.area < narrow.area,
    `${wide.area.toFixed(1)} m2 with the wide brush, ${narrow.area.toFixed(1)} with the narrow one`);
  assert.equal(wide.free, narrow.free, 'the free floor itself does not depend on the brush');
});

test('what is left out is free floor and nothing else', () => {
  const { grid, cells } = mapOf(room);
  const missed = countMissed(grid, cells, room.poses);

  const free = new Set();
  for (const [ix, iy, run] of cells.free) {
    for (let i = 0; i < run; i++) {
      free.add(`${ix + i},${iy}`);
    }
  }

  let counted = 0;
  for (const [ix, iy, run] of missed.runs) {
    for (let i = 0; i < run; i++) {
      assert.ok(free.has(`${ix + i},${iy}`), 'a cell that is not free floor was counted as left out');
      counted++;
    }
  }
  assert.equal(counted, missed.cells);
  assert.equal(missed.free, free.size);
});

test('a thinned recording says it cannot answer', () => {
  // Twenty seconds between two poses: the robot could have been anywhere in
  // between, and a straight line through the flat would be an invention.
  const thin = read('fixtures/reference-track-botvac-d6.jsonl');
  const { grid, cells } = mapOf(thin);
  const missed = countMissed(grid, cells, thin.poses);

  assert.ok(missed.skipped > missed.steps * 0.05,
    `only ${missed.skipped} of ${missed.steps} steps were too long to bridge`);
  assert.equal(trackIsDense(missed), false);
  assert.equal(trackIsDense(countMissed(mapOf(room).grid, mapOf(room).cells, room.poses)), true);
});

test('a track that goes nowhere leaves everything behind', () => {
  const { grid, cells } = mapOf(room);
  const nothing = countMissed(grid, cells, []);

  assert.equal(nothing.cells, nothing.free);
  assert.equal(nothing.covered, 0);
  assert.equal(nothing.steps, 0);
  assert.equal(trackIsDense(nothing), false, 'no track at all is not a dense track');
});

test('standing still away from the base is found, docking is not', () => {
  const stops = standstills(room);

  assert.equal(stops.length, 1, `${stops.length} standstills, expected the one at the end`);
  assert.ok(Math.abs(stops[0].x - 3.0) < 0.01 && Math.abs(stops[0].y - 3.5) < 0.01);
  assert.ok(stops[0].seconds >= 35, `${stops[0].seconds} s`);
  assert.equal(stops[0].ended, true, 'the recording ends there - he did not carry on');
});

test('standing where he set off is docking, whatever the settings', () => {
  const docked = {
    poses: [
      { t: 0, x: 0, y: 0, th: 0 },
      { t: 2, x: 1, y: 0, th: 0 },
      { t: 4, x: 0, y: 0, th: 0 },
      { t: 60, x: 0, y: 0, th: 0 },
      { t: 120, x: 0.02, y: 0.01, th: 0 },
    ],
  };
  assert.deepEqual(standstills(docked), []);
  assert.deepEqual(standstills(docked, { seconds: 1 }), []);

  // How wide the base is counted is settable: half a metre away is still the
  // base by default, and is not once one says so.
  const nearby = {
    poses: [
      { t: 0, x: 0, y: 0, th: 0 },
      { t: 2, x: 0.5, y: 0, th: 0 },
      { t: 30, x: 0.5, y: 0, th: 0 },
      { t: 60, x: 0.5, y: 0, th: 0 },
    ],
  };
  assert.deepEqual(standstills(nearby), []);
  assert.equal(standstills(nearby, { home: 0.2 }).length, 1);
});

test('two poses that happen to be close are not an episode', () => {
  // A thinned recording puts minutes between two poses; two of them landing
  // within five centimetres of each other is a coincidence, not a standstill.
  const thinned = {
    poses: [
      { t: 0, x: 0, y: 0, th: 0 },
      { t: 60, x: 4, y: 4, th: 0 },
      { t: 120, x: 4.01, y: 4.02, th: 0 },
      { t: 180, x: 1, y: 1, th: 0 },
    ],
  };
  assert.deepEqual(standstills(thinned), []);
});

test('how long counts as standing is settable, and 0 poses do not throw', () => {
  const slow = {
    poses: [
      { t: 0, x: 0, y: 0, th: 0 },
      { t: 2, x: 3, y: 3, th: 0 },
      { t: 4, x: 3, y: 3, th: 10 },
      { t: 6, x: 3, y: 3, th: 20 },
      { t: 8, x: 3, y: 3, th: 30 },
      { t: 10, x: 2, y: 2, th: 0 },
    ],
  };
  assert.deepEqual(standstills(slow), [], 'six seconds is not yet a standstill');
  assert.equal(standstills(slow, { seconds: 5 }).length, 1);
  assert.equal(standstills(slow, { seconds: 5 })[0].ended, false, 'he drove on afterwards');

  assert.deepEqual(standstills({ poses: [] }), []);
  assert.deepEqual(standstills({}), []);
  assert.deepEqual(standstills(null), []);
});

test('turning on the spot is still standing still', () => {
  // The one recording that ended stuck turned 39 degrees over those seconds:
  // it was trying to get free. Requiring a still heading would miss exactly
  // the case this is for.
  const stops = standstills(room);
  const poses = room.poses;
  const last = poses.slice(-20);
  const turned = last.some((pose, i) => i > 0 && pose.th !== last[i - 1].th);

  assert.ok(turned, 'the fixture is supposed to turn while it stands');
  assert.equal(stops.length, 1);
});

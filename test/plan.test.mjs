/*
* Several runs as one floor plan.
*
* Two runs of the same flat are two drawings of the same thing in two
* coordinate systems nobody wrote down. Finding the turn and the shift between
* them is a search, and a search that lands on the wrong answer produces a
* picture that looks plausible and is wrong - two flats laid across each other
* at an angle still look like a floor plan. So these tests build rooms whose
* answer is known to the centimetre and insist on getting it back, and they
* insist that a run which does not belong is left out rather than forced in.
*/

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parseSession } from '../www/ftui/components/neato/neato-track.js';
import { survey, mergePlan, confident, disputed, frameOf, registerTo }
  from '../www/ftui/components/neato/neato-plan.js';

const here = (name) => fileURLToPath(new URL(name, import.meta.url));

/**
 * A recording of a room, as the robot in that room would have written it.
 *
 * `walls` are the segments of the room in the run's own frame, `stops` the
 * places the robot looked from. Everything else - the beams, the poses, the
 * summary - is what the module would have put in the file.
 */
function recording(walls, stops) {
  const scans = [];
  const poses = [];
  let t = 0;

  for (const [x, y] of stops) {
    const pts = [];
    for (let degrees = 0; degrees < 360; degrees += 2) {
      const radians = degrees * Math.PI / 180;
      const dx = Math.cos(radians);
      const dy = Math.sin(radians);

      let nearest = Infinity;
      for (const [ax, ay, bx, by] of walls) {
        // Where the beam crosses the segment, if it does.
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
        pts.push([degrees, Math.round(nearest * 1000)]);
      }
    }

    scans.push({ x, y, th: 0, pts });
    poses.push({ t, x, y, th: 0 });
    t += 2;
  }

  return { scans, poses, summary: { scans: scans.length } };
}

/** The same segments, seen from a frame turned by `degrees` and moved. */
function moved(walls, degrees, dx, dy) {
  const radians = degrees * Math.PI / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const turn = (x, y) => [cos * x - sin * y + dx, sin * x + cos * y + dy];
  return walls.map(([ax, ay, bx, by]) => [...turn(ax, ay), ...turn(bx, by)]);
}

/**
 * A flat of two rooms with a doorway - and an L, on purpose.
 *
 * A rectangle with a divider down the middle looks the same upside down, and
 * then there is no right answer to find: two placements a half turn apart fit
 * equally well, and the search is entitled to either. Real flats are rarely
 * that symmetric, but a test room easily is, and a test that sometimes fails
 * for a good reason is worse than no test. Hence the corner cut out of it.
 */
const FLAT = [
  [0, 0, 8, 0], [8, 0, 8, 5], [8, 5, 5, 5],                 // outer walls, an L
  [5, 5, 5, 3.5], [5, 3.5, 0, 3.5], [0, 3.5, 0, 0],
  [3, 0, 3, 1.5], [3, 2.5, 3, 3.5],                         // divider with a door
];

const STOPS = [];
for (let x = 1; x <= 7; x += 1.5) {
  for (let y = 1; y <= 4; y += 1.5) {
    if (y <= 3.2 || x >= 5.4) {
      STOPS.push([x, y]);
    }
  }
}

test('a run recorded in another frame is put back where it belongs', () => {
  // The second robot set off facing the other way, two metres further along.
  const first = survey(recording(FLAT, STOPS));
  const second = survey(recording(moved(FLAT, -90, 2, -1), STOPS.map(([x, y]) => {
    const radians = -90 * Math.PI / 180;
    return [Math.cos(radians) * x - Math.sin(radians) * y + 2,
      Math.sin(radians) * x + Math.cos(radians) * y - 1];
  })));

  const plan = mergePlan([first, second]);

  assert.equal(plan.runs, 2, `a run was rejected: ${JSON.stringify(plan.rejected)}`);
  assert.equal(plan.rejected.length, 0);

  const placed = plan.placements.find(p => p.index === 1);
  const degrees = ((placed.angle * 180 / Math.PI) % 360 + 360) % 360;

  // Turning the world by -90 degrees and moving it by (2, -1) is undone by
  // turning by +90 and moving by -R(90)(2, -1) = (-1, -2).
  assert.ok(Math.abs(degrees - 90) < 2, `turned by ${degrees.toFixed(1)} degrees, expected 90`);
  assert.ok(Math.hypot(placed.x + 1, placed.y + 2) < 0.25,
    `moved to ${placed.x.toFixed(2)}/${placed.y.toFixed(2)}, expected about -1.00/-2.00`);
  assert.ok(placed.score > 0.7, `only ${(placed.score * 100).toFixed(0)} % of it fits`);
});

test('the same run twice comes out unturned and unmoved', () => {
  const once = survey(recording(FLAT, STOPS));
  const plan = mergePlan([once, survey(recording(FLAT, STOPS))]);

  const placed = plan.placements.find(p => p.index === 1);
  const degrees = ((placed.angle * 180 / Math.PI) % 360 + 360) % 360;

  assert.ok(degrees < 1 || degrees > 359, `turned by ${degrees.toFixed(1)} degrees`);
  assert.ok(Math.hypot(placed.x, placed.y) < 0.12,
    `moved by ${Math.hypot(placed.x, placed.y).toFixed(2)} m`);
});

test('a run from somewhere else is left out, not forced in', () => {
  // A corridor has nothing in common with the flat above. Bending it into
  // the plan would put walls through rooms - better to say it does not fit.
  const corridor = [[0, 0, 12, 0], [12, 0, 12, 1.2], [12, 1.2, 0, 1.2], [0, 1.2, 0, 0]];
  const stops = [];
  for (let x = 1; x <= 11; x += 1) {
    stops.push([x, 0.6]);
  }

  const plan = mergePlan([survey(recording(FLAT, STOPS)), survey(recording(corridor, stops))]);

  assert.equal(plan.runs, 1, 'the corridor was taken into the flat');
  assert.equal(plan.rejected.length, 1);
  assert.ok(plan.rejected[0].score < 0.45, `it scored ${plan.rejected[0].score.toFixed(2)}`);
});

test('what one run sees and the others contradict is disputed', () => {
  // The same flat, once with a cupboard in the middle of the left room.
  const cupboard = [[1.5, 1.5, 2.5, 1.5], [2.5, 1.5, 2.5, 2.5],
    [2.5, 2.5, 1.5, 2.5], [1.5, 2.5, 1.5, 1.5]];

  const plain = survey(recording(FLAT, STOPS));
  const furnished = survey(recording([...FLAT, ...cupboard], STOPS));
  const plan = mergePlan([plain, furnished, survey(recording(FLAT, STOPS))]);

  assert.equal(plan.runs, 3);

  const near = (cell, x, y, reach = 0.7) => Math.hypot(cell.x - x, cell.y - y) < reach;
  const quarrel = disputed(plan);
  assert.ok(quarrel.length > 5, `only ${quarrel.length} cells are disputed`);
  assert.ok(quarrel.every(cell => near(cell, 2, 2, 1.5)),
    'something outside the cupboard is disputed');

  // And the walls of the flat itself are not in doubt.
  const sure = confident(plan);
  assert.ok(sure.length > 200, `only ${sure.length} confident cells`);
  assert.ok(!sure.some(cell => near(cell, 2, 2, 0.4)),
    'the cupboard was taken into the plan although two runs saw floor there');
});

test('a corner only one run ever saw stays in the plan', () => {
  // Nobody contradicts it - the others were never there. Dropping it would
  // throw away exactly what several runs are for.
  const half = STOPS.filter(([x]) => x < 4);
  const whole = survey(recording(FLAT, STOPS));
  const left = survey(recording(FLAT, half));
  const plan = mergePlan([whole, left]);

  const right = plan.cells.filter(cell => cell.x > 6);
  assert.ok(right.length > 50, `${right.length} cells on the far side`);
  assert.ok(right.filter(cell => cell.seen === 1).length > right.length / 2,
    'the run that stayed on the left is counted as having looked at the right');

  // What matters is the outcome: nothing over there is thrown out for lack of
  // a second opinion that nobody was in a position to give.
  assert.equal(disputed(plan).filter(cell => cell.x > 6).length, 0);
  assert.ok(confident(plan).filter(cell => cell.x > 7.5).length > 20,
    'the far wall fell out of the plan');
});

test('the plan is made of measured cells, not of the slack around them', () => {
  const one = survey(recording(FLAT, STOPS));
  const plan = mergePlan([one, survey(recording(FLAT, STOPS))]);

  // Two recordings of the same room measure the same cells. If the tolerance
  // leaked into the cell count, the plan would have several times as many.
  assert.ok(plan.cells.length < one.walls.length / 2 * 1.3,
    `${plan.cells.length} cells out of ${one.walls.length / 2} measured ones`);
  assert.ok(plan.cells.length >= one.walls.length / 2 * 0.9);
  assert.ok(plan.cells.every(cell => cell.seen >= cell.walls && cell.walls >= 1));
});

test('the dominant direction is an optimisation, not a crutch', () => {
  // Four candidate rotations instead of a hundred and twenty is worth having,
  // but a flat whose walls do not agree on a direction would get four wrong
  // candidates. Told nothing at all, the search has to find the same answer -
  // that is what the fallback is for, and what a port may implement instead.
  const first = survey(recording(FLAT, STOPS));
  const second = survey(recording(moved(FLAT, -90, 2, -1), STOPS.map(([x, y]) => {
    const radians = -90 * Math.PI / 180;
    return [Math.cos(radians) * x - Math.sin(radians) * y + 2,
      Math.sin(radians) * x + Math.cos(radians) * y - 1];
  })));

  const frame = frameOf(first.walls);
  const guided = registerTo(frame, second, first.direction);
  const blind = registerTo(frame, second, null);

  const degrees = (fit) => ((fit.angle * 180 / Math.PI) % 360 + 360) % 360;
  assert.ok(Math.abs(degrees(blind) - degrees(guided)) < 1.5,
    `${degrees(blind).toFixed(1)} without the direction against ${degrees(guided).toFixed(1)} with it`);
  assert.ok(Math.hypot(blind.x - guided.x, blind.y - guided.y) < 0.2,
    `${blind.x.toFixed(2)}/${blind.y.toFixed(2)} against ${guided.x.toFixed(2)}/${guided.y.toFixed(2)}`);
  assert.ok(blind.score > 0.7);

  // And a direction that is nonsense does not wreck the match: the four
  // candidates come out poor, and the search looks everywhere after all.
  const misled = registerTo(frame, { ...second, direction: second.direction + 0.7 },
    first.direction);
  assert.ok(Math.abs(degrees(misled) - degrees(guided)) < 1.5,
    `a wrong direction gave ${degrees(misled).toFixed(1)}`);
});

test('nothing, one run, and a run without walls do not throw', () => {
  assert.deepEqual(mergePlan([]).cells, []);
  assert.equal(mergePlan([]).runs, 0);

  const one = survey(recording(FLAT, STOPS));
  const alone = mergePlan([one]);
  assert.equal(alone.runs, 1);
  assert.ok(alone.cells.length > 100);
  assert.ok(alone.cells.every(cell => cell.walls === 1 && cell.seen === 1));

  const empty = { walls: new Float64Array(0), free: new Float64Array(0), direction: 0, cell: 0.1 };
  const frame = frameOf(empty.walls);
  assert.deepEqual(frame.bounds, { minX: 0, maxX: 0, minY: 0, maxY: 0 });
  assert.equal(registerTo(frame, empty, 0).score, 0);
  assert.equal(mergePlan([one, empty]).runs, 1, 'a run without walls was placed');
});

test('the reference case in test/fixtures/plan still is what it says it is', () => {
  // The fixtures are what another implementation checks itself against, so a
  // change here that nobody noticed would mislead somebody else. This is the
  // same comparison tools/check-plan.mjs makes, at its own thresholds.
  const dir = here('fixtures/plan/');
  const stored = JSON.parse(readFileSync(`${dir}plan.json`, 'utf8'));
  const names = readdirSync(dir).filter(name => name.endsWith('.jsonl')).sort().reverse();

  assert.equal(names.length, 3, 'the three recordings of the reference case');
  assert.equal(stored.cell, 0.1);
  assert.equal(stored.runs, 3, 'a run of the reference case is no longer placed');

  const built = mergePlan(names.map(name =>
    survey(parseSession(readFileSync(`${dir}${name}`, 'utf8')))));

  assert.equal(built.runs, 3);
  assert.ok(Math.abs(built.cells.length / stored.cells.length - 1) < 0.15,
    `${built.cells.length} cells now, ${stored.cells.length} in the file`
    + ' - run tools/make-plan-fixture.mjs if that is meant');

  const known = new Set(stored.cells.map(cell => `${cell[0]},${cell[1]}`));
  const near = (x, y) => {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (known.has(`${Math.round(x / built.cell) + dx},${Math.round(y / built.cell) + dy}`)) {
          return true;
        }
      }
    }
    return false;
  };
  const found = built.cells.filter(cell => near(cell.x, cell.y)).length;
  assert.ok(found / built.cells.length > 0.95,
    `only ${(100 * found / built.cells.length).toFixed(1)} % of the cells are where the file says`);

  // The scores of every run, which is what the threshold question needs.
  assert.equal(stored.scores.length, 3, 'a run lost its score');
  for (const entry of stored.scores) {
    assert.ok(names.includes(entry.file), `${entry.file} is not one of the recordings`);
    assert.ok(entry.score > 0 && entry.score <= 1, `score ${entry.score}`);
    assert.equal(typeof entry.used, 'boolean');
  }
  assert.equal(stored.scores.filter(entry => entry.used).length, stored.runs);
  assert.equal(Math.max(...stored.scores.map(entry => entry.score)), 1,
    'the frame run scores 1 by definition');

  // And every cell in the file obeys the format the other side implements.
  for (const [ix, iy, walls, seen] of stored.cells) {
    assert.ok(Number.isInteger(ix) && Number.isInteger(iy), 'cells are indices, not metres');
    assert.ok(walls >= 1 && seen >= walls && seen <= stored.runs,
      `walls ${walls}, seen ${seen}, runs ${stored.runs}`);
  }
});

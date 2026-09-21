/*
* Walls as lines: what the simplification may do, and what it may not.
*
* The map is allowed to look calmer than the measurements - that is the point
* of drawing lines. It is not allowed to invent a room. These tests are the
* line between the two: a straight wall becomes one segment, a round pillar
* stays round, a wall nobody measured does not appear, and somebody walking
* through a scan is not turned into furniture.
*/

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parseSession, occupancy, classify } from '../www/ftui/components/neato/neato-track.js';
import {
  wallLines, wallTest, mainDirection, clearOfTrack, closeCorners,
} from '../www/ftui/components/neato/neato-walls.js';

const here = (name) => fileURLToPath(new URL(name, import.meta.url));

/**
 * A lidar revolution from (x, y): what a robot standing there would see.
 *
 * With noise it is what a real one sees: the distances of a Neato scatter by
 * a couple of centimetres, and that scatter is not a detail. It is what turns
 * a straight wall into pieces at slightly different angles - and those are
 * what a too generous join glues into lines across the room.
 */
function look(x, y, world, { noise = 0, seed = 1 } = {}) {
  const points = [];
  let random = seed;
  const jitter = () => {
    // A small deterministic generator: a test that fails every other run is
    // worse than no test.
    random = (random * 1103515245 + 12345) % 2147483648;
    return (random / 2147483648 - 0.5) * 2 * noise;
  };

  for (let degrees = 0; degrees < 360; degrees += 1) {
    const radians = degrees * Math.PI / 180;
    const dx = Math.cos(radians);
    const dy = Math.sin(radians);
    let nearest = Infinity;

    // Walk the beam until it meets something - crude, but it is exactly what
    // a lidar does, and it keeps the fixtures readable.
    for (let distance = 0.05; distance < 8; distance += 0.01) {
      const px = x + dx * distance;
      const py = y + dy * distance;
      if (world(px, py)) {
        nearest = distance;
        break;
      }
    }

    if (nearest < Infinity) {
      points.push([degrees, Math.round((nearest + (noise ? jitter() : 0)) * 1000)]);
    }
  }

  return { x, y, th: 0, pts: points };
}

/** The rectangular room the fixtures live in: 6 x 4 m, walls 6 cm thick. */
function room(px, py) {
  const inside = px > 0.06 && px < 5.94 && py > 0.06 && py < 3.94;
  const outside = px < 0 || px > 6 || py < 0 || py > 4;
  return !inside && !outside;
}

function build(scans, options = {}) {
  const cell = options.cell || 0.10;
  const grid = occupancy(scans, cell);
  const cells = classify(grid, 0.25, 2);
  return {
    grid,
    cells,
    ...wallLines(scans, grid, wallTest(grid, 0.25, 2), options),
  };
}

const distance = (wall) => Math.hypot(wall.x1 - wall.x0, wall.y1 - wall.y0);

/** How far a point lies off a segment's line, and whether it is beside it. */
function offLine(wall, x, y) {
  const dx = wall.x1 - wall.x0;
  const dy = wall.y1 - wall.y0;
  const length = Math.hypot(dx, dy);
  return Math.abs(dy * (x - wall.x0) - dx * (y - wall.y0)) / length;
}

test('four walls of a room become four lines', () => {
  const scans = [look(3, 2, room), look(1.5, 1, room), look(4.5, 3, room)];
  const { walls } = build(scans);

  const long = walls.filter(wall => distance(wall) > 2);
  assert.equal(long.length, 4, `expected four walls, got ${walls.length} pieces `
    + long.map(w => distance(w).toFixed(2)).join(', '));

  // Two of them run along x, two along y, and they are as long as the room.
  const horizontal = long.filter(w => Math.abs(w.y1 - w.y0) < 0.05);
  const vertical = long.filter(w => Math.abs(w.x1 - w.x0) < 0.05);
  assert.equal(horizontal.length, 2);
  assert.equal(vertical.length, 2);
  assert.ok(horizontal.every(w => distance(w) > 5), 'the long walls are 6 m');
  assert.ok(vertical.every(w => distance(w) > 3), 'the short walls are 4 m');
});

test('the corners stay where the room ends', () => {
  const scans = [look(3, 2, room), look(1.5, 1, room), look(4.5, 3, room)];
  const { walls } = build(scans);

  for (const wall of walls) {
    for (const [x, y] of [[wall.x0, wall.y0], [wall.x1, wall.y1]]) {
      assert.ok(x > -0.2 && x < 6.2 && y > -0.2 && y < 4.2,
        `a wall ends at ${x.toFixed(2)}, ${y.toFixed(2)}, outside the room`);
    }
  }
});

test('somebody walking through one scan is not drawn as a wall', () => {
  // Three revolutions of the same room. In the second one a person stands in
  // the middle; in the others the beams pass through where they stood.
  const person = (px, py) => Math.hypot(px - 3, py - 2) < 0.22;
  const scans = [
    look(1.5, 1, room),
    look(1.6, 1.1, (px, py) => room(px, py) || person(px, py)),
    look(1.4, 0.9, room),
    look(4.5, 3, room),
  ];

  const { walls, grid, cells } = build(scans);

  const nearPerson = walls.filter(wall => {
    const mx = (wall.x0 + wall.x1) / 2;
    const my = (wall.y0 + wall.y1) / 2;
    return Math.hypot(mx - 3, my - 2) < 0.6;
  });
  assert.equal(nearPerson.length, 0,
    'the person was drawn as a wall: ' + JSON.stringify(nearPerson));

  // The room itself is still there - the filter did not take it with it.
  assert.ok(walls.filter(wall => distance(wall) > 2).length >= 4);
  assert.ok(cells.walls.length > 0 && grid.width > 0);
});

test('a person standing still in every scan is a wall, and stays', () => {
  // The other side of the same coin: what does not move is furniture, and
  // furniture belongs on the map.
  const box = (px, py) => px > 2.8 && px < 3.6 && py > 1.8 && py < 2.6;
  const world = (px, py) => room(px, py) || box(px, py);
  const scans = [look(1.5, 1, world), look(1.6, 1.1, world), look(1.4, 0.9, world)];

  const { walls } = build(scans);
  const atBox = walls.filter(wall => {
    const mx = (wall.x0 + wall.x1) / 2;
    const my = (wall.y0 + wall.y1) / 2;
    return mx > 2.5 && mx < 3.9 && my > 1.5 && my < 2.9;
  });

  assert.ok(atBox.length > 0, 'the box in the middle of the room disappeared');
});

test('a round pillar does not become a straight wall', () => {
  const pillar = (px, py) => {
    const r = Math.hypot(px - 3, py - 2);
    return r > 0.55 && r < 0.62;
  };
  const world = (px, py) => room(px, py) || pillar(px, py);
  const scans = [look(1.5, 1, world), look(1.6, 1.1, world), look(1.4, 0.9, world)];

  const { walls } = build(scans);
  const atPillar = walls.filter(wall => {
    const mx = (wall.x0 + wall.x1) / 2;
    const my = (wall.y0 + wall.y1) / 2;
    return Math.hypot(mx - 3, my - 2) < 1;
  });

  // Nothing longer than the pillar is wide may come out of it: a chord of a
  // 1.2 m circle that is 1 m long would be a line through the pillar.
  for (const wall of atPillar) {
    assert.ok(distance(wall) < 0.9,
      `the pillar became a ${distance(wall).toFixed(2)} m wall`);
  }
});

test('nothing is drawn where no beam has been, except a closed corner', () => {
  // The rule and its one exception. Without corner closing nothing goes
  // beyond what was measured; with it, a corner is concluded - but only as
  // far as corner-reach allows, and that is checked below.
  //
  // Two walls of a corner, with the corner itself never measured.
  const wallPoints = [];
  for (let t = 1.0; t <= 2.5; t += 0.02) { wallPoints.push([t, 3.0]); }
  for (let t = 1.0; t <= 2.5; t += 0.02) { wallPoints.push([3.0, t]); }

  const scan = (x, y) => ({
    x, y, th: 0,
    pts: wallPoints.map(([px, py]) => {
      const angle = Math.atan2(py - y, px - x) * 180 / Math.PI;
      return [((angle % 360) + 360) % 360, Math.round(Math.hypot(px - x, py - y) * 1000)];
    }).sort((a, b) => a[0] - b[0]),
  });

  const scans = [scan(1.6, 1.6), scan(1.5, 1.5), scan(1.7, 1.7)];

  const measured = build(scans, { cornerReach: 0 }).walls;
  for (const wall of measured) {
    for (const [x, y] of [[wall.x0, wall.y0], [wall.x1, wall.y1]]) {
      // The corner at (3.0, 3.0) was never seen; without corner closing no
      // line may reach into it.
      assert.ok(!(x > 2.7 && y > 2.7),
        `a line runs into the corner nobody measured: ${x.toFixed(2)}, ${y.toFixed(2)}`);
    }
  }

  // With corner closing the lines may meet there - and nowhere further. Every
  // end has to stay within reach of an end that was measured.
  const reach = 0.8;
  const closed = build(scans, { cornerReach: reach }).walls;
  for (const wall of closed) {
    for (const [x, y] of [[wall.x0, wall.y0], [wall.x1, wall.y1]]) {
      const nearest = Math.min(...measured.flatMap(m => [
        Math.hypot(x - m.x0, y - m.y0),
        Math.hypot(x - m.x1, y - m.y1),
      ]));
      assert.ok(nearest <= reach + 0.01,
        `an end sits ${nearest.toFixed(2)} m from anything measured, reach is ${reach}`);
    }
  }
});

test('two walls a hand apart do not become one', () => {
  // The join closes gaps along a wall. It may not pull two walls together
  // that run side by side - the offset between them is what tells them apart,
  // and a flat has plenty of nearly parallel pairs: wall and skirting board,
  // wall and cupboard in front of it.
  const near = (px, py) => (py > 2.98 && py < 3.04 && px > 1 && px < 3)      // wall
    || (py > 3.28 && py < 3.34 && px > 3.4 && px < 5);                       // and the next one, 30 cm off
  const scans = [];
  for (let i = 0; i < 6; i++) {
    scans.push(look(2.5 + i * 0.2, 1.5, (px, py) => room(px, py) || near(px, py)));
  }

  const { walls } = build(scans);

  for (const wall of walls) {
    const runsAlong = Math.abs(wall.y1 - wall.y0) < 0.1 && (wall.y0 > 2.8 && wall.y0 < 3.5);
    // A segment spanning both pieces would be longer than either of them and
    // would sit between the two offsets.
    assert.ok(!(runsAlong && distance(wall) > 2.6),
      `a ${distance(wall).toFixed(2)} m line was drawn through two walls 30 cm apart`);
  }
});

test('many revolutions of a furnished room draw no line across it', () => {
  // Holds the property that an hour-long run over a whole flat broke: with
  // hundreds of revolutions of a furnished home the joins used to wander
  // diagonally through rooms, because they were allowed to be far looser
  // (ten degrees, sixteen centimetres) than the pieces they joined.
  //
  // Be warned that this fixture does NOT reproduce that: a room of six by
  // four metres with a handful of boxes stays clean even under the old,
  // loose settings. It took ten by sixteen metres and 595 revolutions. What
  // this test does is keep the property once it has been established
  // elsewhere - by measuring against a real recording.
  const clutter = (px, py) => {
    const box = (x0, y0, x1, y1) => px > x0 && px < x1 && py > y0 && py < y1
      && !(px > x0 + 0.04 && px < x1 - 0.04 && py > y0 + 0.04 && py < y1 - 0.04);
    // Everything in here is square to the room on purpose: then a diagonal
    // line in the result can only be one the join invented.
    return box(1.2, 2.6, 2.0, 3.2) || box(4.2, 0.5, 5.4, 1.3) || box(2.6, 1.4, 3.0, 1.8)
      || box(0.4, 1.9, 0.8, 2.6) || box(3.4, 2.9, 5.2, 3.3) || box(1.0, 0.6, 1.9, 1.0);
  };
  const world = (px, py) => room(px, py) || clutter(px, py);

  const scans = [];
  for (let i = 0; i < 60; i++) {
    const x = 1 + (i % 9) * 0.5;
    const y = 1 + Math.floor(i / 9) * 0.35;
    scans.push(look(x, y, world, { noise: 0.02, seed: i + 1 }));
  }

  const { walls } = build(scans);
  const diagonal = walls.filter(wall =>
    Math.abs(wall.x1 - wall.x0) > 0.6 && Math.abs(wall.y1 - wall.y0) > 0.6);

  assert.deepEqual(diagonal.map(w => `${w.x0.toFixed(1)},${w.y0.toFixed(1)} -> ${w.x1.toFixed(1)},${w.y1.toFixed(1)}`),
    [], 'lines run diagonally through the room');

  // The room is still a room: its four walls are there, and nothing is longer
  // than the room itself.
  const long = walls.filter(wall => distance(wall) > 2);
  assert.ok(long.length >= 4, `${long.length} long walls instead of at least four`);
  for (const wall of walls) {
    assert.ok(distance(wall) < 6.5, `a ${distance(wall).toFixed(2)} m wall in a 6 m room`);
  }
});

test('no wall is drawn where the robot drove', () => {
  // The robot is a disc of some thirty centimetres, not a ghost: a line
  // across its track cannot be a wall. A stray sighting puts one there.
  const scans = [look(3, 2, room), look(1.5, 1, room), look(4.5, 3, room)];
  const poses = [];
  for (let t = 0.6; t < 5.4; t += 0.15) {
    poses.push({ x: t, y: 2.0 });                // straight through the room
  }

  // A wall right across that track, seen once - the kind of line a badly
  // placed scan leaves behind.
  const strays = [{
    x0: 3.0, y0: 0.5, x1: 3.0, y1: 3.5,
    angle: Math.PI / 2, length: 3.0,
  }];

  const kept = clearOfTrack(strays, poses, { clearance: 0.1, minLength: 0.3 });
  const crosses = kept.some(wall => Math.min(wall.y0, wall.y1) < 2.0
    && Math.max(wall.y0, wall.y1) > 2.0);

  assert.equal(crosses, false, 'a wall still runs across the track');
  // What is left of it on either side is kept - only the crossing goes.
  assert.equal(kept.length, 2);
  assert.ok(kept.every(wall => wall.length > 1.2));

  // And the real walls of the room, which the track never touches, survive.
  const { walls } = build(scans, { poses });
  assert.ok(walls.filter(wall => distance(wall) > 2).length >= 4);
});

test('a corner the lidar never saw is closed', () => {
  // Two walls of a corner, the corner itself missing - the lidar looks along
  // one wall, then along the other.
  const open = [
    { x0: 1.0, y0: 3.0, x1: 2.6, y1: 3.0, angle: 0, length: 1.6 },
    { x0: 3.0, y0: 1.0, x1: 3.0, y1: 2.6, angle: Math.PI / 2, length: 1.6 },
  ];

  const closed = closeCorners(open.map(w => ({ ...w })), [], { cornerReach: 0.8, clearance: 0.1 });
  const corner = closed.some(wall =>
    Math.abs(wall.x1 - 3.0) < 0.01 && Math.abs(wall.y1 - 3.0) < 0.01
    || Math.abs(wall.x0 - 3.0) < 0.01 && Math.abs(wall.y0 - 3.0) < 0.01);

  assert.ok(corner, 'the corner at 3.0, 3.0 was not closed: '
    + JSON.stringify(closed.map(w => [w.x0.toFixed(2), w.y0.toFixed(2), w.x1.toFixed(2), w.y1.toFixed(2)])));
});

test('a doorway the robot drove through stays open', () => {
  // The same shape, but this time the robot drove through the gap. Then it is
  // not a corner, it is a door, and walling it up would be a lie.
  const open = [
    { x0: 1.0, y0: 3.0, x1: 2.6, y1: 3.0, angle: 0, length: 1.6 },
    { x0: 3.0, y0: 1.0, x1: 3.0, y1: 2.6, angle: Math.PI / 2, length: 1.6 },
  ];
  const poses = [];
  for (let t = 0; t < 1.4; t += 0.1) {
    poses.push({ x: 2.4 + t * 0.5, y: 2.4 + t * 0.5 });       // out through the gap
  }

  const closed = closeCorners(open.map(w => ({ ...w })), poses, { cornerReach: 0.8, clearance: 0.1 });

  assert.ok(closed.every(wall => Math.hypot(wall.x1 - 3.0, wall.y1 - 3.0) > 0.05
    && Math.hypot(wall.x0 - 3.0, wall.y0 - 3.0) > 0.05),
  'the doorway was walled up');
});

test('a corner too far away is left open', () => {
  const far = [
    { x0: 1.0, y0: 3.0, x1: 2.0, y1: 3.0, angle: 0, length: 1.0 },
    { x0: 3.0, y0: 1.0, x1: 3.0, y1: 2.0, angle: Math.PI / 2, length: 1.0 },
  ];
  const closed = closeCorners(far.map(w => ({ ...w })), [], { cornerReach: 0.5, clearance: 0.1 });

  assert.deepEqual(closed.map(w => w.length.toFixed(2)), ['1.00', '1.00'],
    'walls were stretched more than a metre to meet');
});

test('the main direction is measured, not assumed', () => {
  // The same room, turned by 20 degrees - the dock does not stand square to
  // the flat, and the map has to follow the flat.
  const turn = 20 * Math.PI / 180;
  const rotated = (px, py) => {
    const x = px * Math.cos(-turn) - py * Math.sin(-turn);
    const y = px * Math.sin(-turn) + py * Math.cos(-turn);
    return room(x, y);
  };
  const at = (x, y) => [x * Math.cos(turn) - y * Math.sin(turn), x * Math.sin(turn) + y * Math.cos(turn)];

  const scans = [look(...at(3, 2), rotated), look(...at(1.5, 1), rotated), look(...at(4.5, 3), rotated)];
  const { walls, direction } = build(scans);

  const degrees = (direction * 180 / Math.PI) % 90;
  assert.ok(Math.min(Math.abs(degrees - 20), Math.abs(degrees - 20 + 90)) < 3,
    `main direction ${degrees.toFixed(1)} degrees, expected 20`);

  // And the walls still meet at right angles, just not at 0 and 90.
  const long = walls.filter(wall => distance(wall) > 2);
  assert.equal(long.length, 4);
});

test('the pieces carry their points, within the tolerance', () => {
  const text = readFileSync(here('fixtures/reference-track-botvac-d6.jsonl'), 'utf8');
  const { scans } = parseSession(text);
  const tolerance = 0.04;
  const support = 0.35;
  const { walls, grid, cells } = build(scans, { tolerance, support });

  assert.ok(walls.length > 10, `only ${walls.length} segments`);
  assert.ok(walls.length < 80, `${walls.length} segments is not simpler than cells`);

  // Fewer pieces than the grid needs cells, and every one of them sits on
  // cells the grid calls wall - that is what supported() promises.
  const wallCells = cells.walls.reduce((sum, [, , run]) => sum + run, 0);
  assert.ok(walls.length < wallCells / 4,
    `${walls.length} segments for ${wallCells} wall cells`);

  for (const wall of walls) {
    const steps = Math.max(2, Math.ceil(distance(wall) / (grid.cell / 2)));
    let backed = 0;
    const test = wallTest(grid, 0.25, 2);
    for (let i = 0; i <= steps; i++) {
      const x = wall.x0 + (wall.x1 - wall.x0) * (i / steps);
      const y = wall.y0 + (wall.y1 - wall.y0) * (i / steps);
      const ix = Math.floor(x / grid.cell) - grid.x0;
      const iy = Math.floor(y / grid.cell) - grid.y0;
      if (ix >= 0 && iy >= 0 && ix < grid.width && iy < grid.height && test.isWall(ix, iy)) {
        backed++;
      }
    }
    assert.ok(backed / (steps + 1) >= support,
      `a segment of ${distance(wall).toFixed(2)} m runs over cells the grid calls free`);
  }
});

test('turning the simplification off gives the cells back', () => {
  const scans = [look(3, 2, room), look(1.5, 1, room)];
  const grid = occupancy(scans, 0.10);
  const cells = classify(grid, 0.25, 2);

  assert.ok(cells.walls.length > 0);
  // classify() is untouched by any of this - the cells are still the
  // evidence, and the lines are drawn on top of them.
  const { walls } = wallLines(scans, grid, wallTest(grid, 0.25, 2), { snapDegrees: 0 });
  assert.ok(walls.length > 0);
});

test('a run without scans has no walls and does not throw', () => {
  const grid = occupancy([], 0.10);
  const { walls, direction } = wallLines([], grid, wallTest(grid), {});
  assert.deepEqual(walls, []);
  assert.equal(Number.isFinite(direction), true);
});

test('mainDirection weighs by length', () => {
  const piece = (angle, length) => ({ angle: angle * Math.PI / 180, length });
  // One long wall at 30 degrees, three short ones scattered.
  const direction = mainDirection([piece(30, 6), piece(70, 0.4), piece(12, 0.3), piece(51, 0.2)]);
  assert.equal(Math.round(direction * 180 / Math.PI), 30);
});

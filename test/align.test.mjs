/*
* Laying the revolutions on top of each other.
*
* The robot knows where it is to within a few centimetres. Over an hour those
* centimetres turn one wall into a bundle of parallel strokes, and no way of
* drawing them fixes that - the strokes really are in different places. These
* tests hold the two things the alignment has to do: bring scans whose poses
* are off back together, and leave scans whose poses are right alone.
*/

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parseSession } from '../www/ftui/components/neato/neato-track.js';
import { alignScans, agreement } from '../www/ftui/components/neato/neato-align.js';

const here = (name) => fileURLToPath(new URL(name, import.meta.url));

/** A revolution from (x, y) of a 6 x 4 m room, as the robot would see it. */
function look(x, y) {
  const points = [];

  for (let degrees = 0; degrees < 360; degrees += 2) {
    const radians = degrees * Math.PI / 180;
    const dx = Math.cos(radians);
    const dy = Math.sin(radians);

    // Distance to the nearest of the four walls, along this beam.
    let nearest = Infinity;
    for (const [px, py, nx, ny] of [[0, 0, 1, 0], [6, 0, -1, 0], [0, 0, 0, 1], [0, 4, 0, -1]]) {
      const denominator = dx * nx + dy * ny;
      if (denominator >= -1e-9) {
        continue;
      }
      const t = ((px - x) * nx + (py - y) * ny) / denominator;
      if (t > 0.05 && t < nearest) {
        const hx = x + dx * t;
        const hy = y + dy * t;
        if (hx > -0.01 && hx < 6.01 && hy > -0.01 && hy < 4.01) {
          nearest = t;
        }
      }
    }

    if (nearest < Infinity) {
      points.push([degrees, Math.round(nearest * 1000)]);
    }
  }

  return { x, y, th: 0, pts: points };
}

/** The same revolutions, with the poses knocked off by a few centimetres. */
function shake(scans, amount, seed = 7) {
  let random = seed;
  const next = () => {
    random = (random * 1103515245 + 12345) % 2147483648;
    return random / 2147483648 - 0.5;
  };
  return scans.map(scan => ({
    ...scan,
    x: scan.x + next() * 2 * amount,
    y: scan.y + next() * 2 * amount,
    th: scan.th + next() * 2 * amount * 20,
  }));
}

const room = [];
for (let i = 0; i < 12; i++) {
  room.push(look(1.5 + (i % 4) * 1.0, 1.0 + Math.floor(i / 4) * 0.8));
}

test('scans whose poses are off are brought back together', () => {
  const shaken = shake(room, 0.09);
  const before = agreement(shaken);
  const { scans: aligned, moved } = alignScans(shaken);
  const after = agreement(aligned);

  assert.ok(after < before * 0.9,
    `agreement ${before.toFixed(4)} -> ${after.toFixed(4)}, expected a clear improvement`);
  assert.ok(moved >= 0, 'nothing moved at all');

  // And they end up near where they belong, not just near each other: the
  // spread of the error against the true poses has to shrink.
  const error = (list) => {
    const offsets = list.map((scan, i) => ({
      dx: scan.x - room[i].x,
      dy: scan.y - room[i].y,
    }));
    const mx = offsets.reduce((sum, o) => sum + o.dx, 0) / offsets.length;
    const my = offsets.reduce((sum, o) => sum + o.dy, 0) / offsets.length;
    // Against the common shift, which nobody can know and which does not
    // matter: a map is only ever relative to itself.
    return Math.sqrt(offsets.reduce((sum, o) =>
      sum + (o.dx - mx) ** 2 + (o.dy - my) ** 2, 0) / offsets.length);
  };

  assert.ok(error(aligned) < error(shaken),
    `error against the true poses ${error(shaken).toFixed(3)} -> ${error(aligned).toFixed(3)}`);
});

test('scans whose poses are right are left alone', () => {
  const before = agreement(room);
  const { scans: aligned } = alignScans(room);
  const after = agreement(aligned);

  assert.ok(after <= before * 1.02,
    `agreement got worse: ${before.toFixed(4)} -> ${after.toFixed(4)}`);

  for (let i = 0; i < room.length; i++) {
    assert.ok(Math.hypot(aligned[i].x - room[i].x, aligned[i].y - room[i].y) < 0.12,
      `a correct pose was moved by ${Math.hypot(aligned[i].x - room[i].x, aligned[i].y - room[i].y).toFixed(2)} m`);
  }
});

test('a pose is never moved further than it is allowed to be', () => {
  const shaken = shake(room, 0.09);
  const { scans: aligned } = alignScans(shaken, { reach: 0.2 });

  for (let i = 0; i < shaken.length; i++) {
    assert.ok(Math.hypot(aligned[i].x - shaken[i].x, aligned[i].y - shaken[i].y) <= 0.2 + 1e-9,
      'a scan was moved beyond its reach');
  }
});

test('the recording itself is not changed', () => {
  const shaken = shake(room, 0.09);
  const copy = shaken.map(scan => ({ ...scan }));
  alignScans(shaken);

  shaken.forEach((scan, i) => {
    assert.equal(scan.x, copy[i].x);
    assert.equal(scan.y, copy[i].y);
    assert.equal(scan.th, copy[i].th);
  });
});

test('too few scans are handed back untouched', () => {
  const two = room.slice(0, 2);
  const { scans, moved } = alignScans(two);
  assert.equal(scans, two);
  assert.equal(moved, 0);
  assert.deepEqual(alignScans([]).scans, []);
});

test('the reference recording does not get worse', () => {
  // Ten revolutions of a thinned excerpt: there is little to gain here, and
  // the point is that there is nothing to lose either.
  const { scans } = parseSession(readFileSync(here('fixtures/reference-track-botvac-d6.jsonl'), 'utf8'));
  const before = agreement(scans);
  const after = agreement(alignScans(scans).scans);

  assert.ok(after <= before,
    `agreement ${before.toFixed(4)} -> ${after.toFixed(4)}`);
});

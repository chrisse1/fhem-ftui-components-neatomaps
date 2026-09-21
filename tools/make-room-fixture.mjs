/*
* Writes test/fixtures/room-run.jsonl, a made-up recording with a dense track.
*
*     node tools/make-room-fixture.mjs
*
* The reference recording of the module repository is thinned: its poses are
* twenty seconds apart, and between two of them the robot could have been
* anywhere. That is fine for the map, which only needs the lidar, but it says
* nothing about which floor the brush went over - so countMissed refuses to
* answer for it, and the tests for the left-out floor need a file whose poses
* follow each other the way a real recording's do.
*
* Rather than put a real flat into the repository, this builds one: a room of
* 5 x 4 m, cleaned in lanes but only up to x = 3.6, and a robot that stops at
* the end and does not carry on. So the file has, on purpose:
*
*   - a strip on the right that was never driven over, about 5 m2
*   - a standstill of 40 s at (3.0, 3.5), away from where it set off
*   - poses two seconds apart, as the module writes them
*
* Under MIT License (http://www.opensource.org/licenses/mit-license.php)
*/

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOM = { x: 5, y: 4 };
const CLEAN_TO = 3.6;                          // the lanes stop here
const out = [];

out.push({ device: 'Testraum', started: '2026-01-02_09-00-00', module: '0.19.0', unit: 'm' });

/** What the lidar sees of the four walls from (x, y). */
function revolution(x, y, th) {
  const pts = [];
  for (let degrees = 0; degrees < 360; degrees += 2) {
    const radians = (degrees + th) * Math.PI / 180;
    const dx = Math.cos(radians);
    const dy = Math.sin(radians);
    let nearest = Infinity;
    for (const [px, py, nx, ny] of [[0, 0, 1, 0], [ROOM.x, 0, -1, 0], [0, 0, 0, 1], [0, ROOM.y, 0, -1]]) {
      const denominator = dx * nx + dy * ny;
      if (denominator >= -1e-9) {
        continue;
      }
      const d = ((px - x) * nx + (py - y) * ny) / denominator;
      if (d > 0.05 && d < nearest) {
        nearest = d;
      }
    }
    if (nearest < Infinity) {
      // A centimetre of noise, so the grid has something to decide.
      pts.push([degrees, Math.round(nearest * 1000 + (degrees % 7 - 3))]);
    }
  }
  return { scan: { x: Number(x.toFixed(3)), y: Number(y.toFixed(3)), th, speed: 5.0, pose: 'Smooth', pts } };
}

// The lanes: up and down between y = 0.3 and y = 3.7, stepping right by 26 cm.
const track = [];
let up = true;
for (let x = 0.3; x <= CLEAN_TO; x += 0.26) {
  const from = up ? 0.3 : 3.7;
  const to = up ? 3.7 : 0.3;
  const steps = Math.round(Math.abs(to - from) / 0.15);
  for (let i = 0; i <= steps; i++) {
    track.push([x, from + (to - from) * (i / steps), up ? 90 : 270]);
  }
  up = !up;
}
// And then it stops, out in the room, and stays there.
for (let i = 0; i < 20; i++) {
  track.push([3.0, 3.5, 200 + (i % 3)]);
}

let t = 1000;
for (let i = 0; i < track.length; i++) {
  const [x, y, th] = track[i];
  out.push({ t: Number(t.toFixed(2)), x: Number(x.toFixed(3)), y: Number(y.toFixed(3)), th });
  if (i % 12 === 0) {
    out.push(revolution(x, y, th, t));
  }
  t += 2;
}

const scans = out.filter(o => o.scan).length;
out.push({
  summary: {
    points: track.length,
    scans,
    distance: Number((track.length * 0.15).toFixed(1)),
    rotation: 3600,
    seconds: track.length * 2,
  },
});

const path = fileURLToPath(new URL('../test/fixtures/room-run.jsonl', import.meta.url));
writeFileSync(path, out.map(o => JSON.stringify(o)).join('\n') + '\n');
process.stdout.write(`${path}: ${track.length} Posen, ${scans} Scans\n`);

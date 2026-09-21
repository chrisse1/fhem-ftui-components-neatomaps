/*
* Putting the revolutions on top of each other.
*
* A wall seen at ten past ten and again at half past eleven does not land in
* the same place: the robot knows where it is to within a few centimetres,
* and over an hour of driving those centimetres are what turn one wall into a
* bundle of parallel strokes. No amount of drawing fixes that - the strokes
* really are in different places.
*
* So they are moved. Every revolution is nudged - a few centimetres, a degree
* or two - until its points sit as well as possible on the map all the others
* draw, and that is repeated a few times. It is the crude cousin of what the
* robot does internally with far more revolutions than it writes down.
*
* Measured on a one hour run of a whole flat, 595 revolutions: the scans agree
* 40 percent better afterwards (0.039 to 0.023 cells per point, the measure
* tools/track_map.py uses), and the map goes from 156 wall segments to 60 -
* one line per wall instead of a bundle.
*
* What is NOT touched is the track: the poses the module recorded are what the
* robot drove, and they stay as they are. Only the scans are laid on top of
* each other, and only for the map.
*
* Under MIT License (http://www.opensource.org/licenses/mit-license.php)
*/

const DEFAULTS = {
  // The map the scans are matched against, in metres. Coarser than the map
  // that is drawn: it is a target, not a picture, and a coarse one has a
  // wider pull.
  cell: 0.10,
  // How often every revolution is nudged. The first round does nearly all of
  // the work, the third moves things by about two centimetres.
  rounds: 3,
  // How far a revolution may be moved in total, in metres. Beyond this it is
  // not a correction any more, it is a different place.
  reach: 0.5,
  // Points per revolution used for matching. All of them is a waste: what is
  // being decided is one position, and 130 points decide it as well as 260.
  sample: 130,
};

/**
 * The scans with their poses nudged onto each other.
 *
 * Returns new scan objects - the ones passed in are left alone, so the track
 * and the summary keep describing what was recorded.
 */
export function alignScans(scans, options = {}) {
  const settings = { ...DEFAULTS, ...options };

  if (scans.length < 3) {
    return { scans, moved: 0 };
  }

  const poses = scans.map(scan => ({ x: scan.x, y: scan.y, th: scan.th }));
  const beams = scans.map(scan => sampleBeams(scan, settings.sample));

  const bounds = extent(scans, poses, beams);
  if (!bounds) {
    return { scans, moved: 0 };
  }

  let moved = 0;
  for (let round = 0; round < settings.rounds; round++) {
    const map = density(beams, poses, bounds, settings.cell);
    moved = 0;

    for (let i = 0; i < scans.length; i++) {
      const before = poses[i];
      const after = fit(beams[i], before, map, bounds, settings);
      moved += Math.hypot(after.x - before.x, after.y - before.y);
      poses[i] = after;
    }

    moved /= scans.length;
    // Once the average nudge is below a centimetre there is nothing left to
    // win, and another round costs as much as the first.
    if (moved < 0.01) {
      break;
    }
  }

  return {
    scans: scans.map((scan, i) => ({ ...scan, x: poses[i].x, y: poses[i].y, th: poses[i].th })),
    moved,
  };
}

/** Angle and distance of a revolution, thinned, as radians and metres. */
function sampleBeams(scan, most) {
  const pts = scan.pts || [];
  const step = Math.max(1, Math.ceil(pts.length / most));
  const out = new Float64Array(Math.ceil(pts.length / step) * 2);

  let at = 0;
  for (let i = 0; i < pts.length; i += step) {
    out[at++] = pts[i][0] * Math.PI / 180;      // angle against the heading
    out[at++] = pts[i][1] / 1000;               // distance
  }

  return out.subarray(0, at);
}

/** The patch of floor everything has to fit into. */
function extent(scans, poses, beams) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;

  for (let i = 0; i < scans.length; i++) {
    const heading = poses[i].th * Math.PI / 180;
    for (let k = 0; k < beams[i].length; k += 2) {
      const radians = heading + beams[i][k];
      const x = poses[i].x + beams[i][k + 1] * Math.cos(radians);
      const y = poses[i].y + beams[i][k + 1] * Math.sin(radians);
      if (x < minX) { minX = x; }
      if (x > maxX) { maxX = x; }
      if (y < minY) { minY = y; }
      if (y > maxY) { maxY = y; }
    }
  }

  if (!isFinite(minX)) {
    return null;
  }

  // Room for the nudging, so nothing falls out of the map on the way.
  return { minX: minX - 1, maxX: maxX + 1, minY: minY - 1, maxY: maxY + 1 };
}

/** How many points fall into each cell, over all revolutions. */
function density(beams, poses, bounds, cell) {
  const width = Math.ceil((bounds.maxX - bounds.minX) / cell) + 1;
  const height = Math.ceil((bounds.maxY - bounds.minY) / cell) + 1;
  const counts = new Uint16Array(width * height);

  for (let i = 0; i < beams.length; i++) {
    const heading = poses[i].th * Math.PI / 180;
    const sin = Math.sin(heading);
    const cos = Math.cos(heading);

    for (let k = 0; k < beams[i].length; k += 2) {
      const angle = beams[i][k];
      const distance = beams[i][k + 1];
      // cos(h + a) and sin(h + a) from the heading's own sine and cosine.
      const ca = Math.cos(angle);
      const sa = Math.sin(angle);
      const x = poses[i].x + distance * (cos * ca - sin * sa);
      const y = poses[i].y + distance * (sin * ca + cos * sa);

      const ix = Math.floor((x - bounds.minX) / cell);
      const iy = Math.floor((y - bounds.minY) / cell);
      if (ix >= 0 && iy >= 0 && ix < width && iy < height) {
        const at = iy * width + ix;
        if (counts[at] < 65535) {
          counts[at]++;
        }
      }
    }
  }

  return { counts, width, height, cell };
}

/** How well a revolution sits on the map from a given pose. */
function score(beam, pose, map, bounds) {
  const heading = pose.th * Math.PI / 180;
  const sin = Math.sin(heading);
  const cos = Math.cos(heading);
  let sum = 0;

  for (let k = 0; k < beam.length; k += 2) {
    const ca = Math.cos(beam[k]);
    const sa = Math.sin(beam[k]);
    const distance = beam[k + 1];
    const x = pose.x + distance * (cos * ca - sin * sa);
    const y = pose.y + distance * (sin * ca + cos * sa);

    const ix = Math.floor((x - bounds.minX) / map.cell);
    const iy = Math.floor((y - bounds.minY) / map.cell);
    if (ix >= 0 && iy >= 0 && ix < map.width && iy < map.height) {
      // Capped: a spot where two hundred points pile up must not outvote
      // everything else on the wall.
      sum += Math.min(map.counts[iy * map.width + ix], 20);
    }
  }

  return sum;
}

/**
 * The best pose near the one that was recorded.
 *
 * Plain hill climbing over three numbers, coarse steps first: the recorded
 * pose is already close, and the map it climbs is bumpy enough that anything
 * cleverer would not be any more reliable.
 */
function fit(beam, pose, map, bounds, settings) {
  let best = pose;
  let bestScore = score(beam, best, map, bounds);

  for (const step of [0.08, 0.04, 0.02]) {
    const turn = step * 20;                     // 1.6, 0.8, 0.4 degrees
    let improved = true;

    while (improved) {
      improved = false;
      const moves = [
        { x: best.x + step, y: best.y, th: best.th },
        { x: best.x - step, y: best.y, th: best.th },
        { x: best.x, y: best.y + step, th: best.th },
        { x: best.x, y: best.y - step, th: best.th },
        { x: best.x, y: best.y, th: best.th + turn },
        { x: best.x, y: best.y, th: best.th - turn },
      ];

      for (const move of moves) {
        if (Math.hypot(move.x - pose.x, move.y - pose.y) > settings.reach) {
          continue;
        }
        const value = score(beam, move, map, bounds);
        if (value > bestScore) {
          best = move;
          bestScore = value;
          improved = true;
        }
      }
    }
  }

  return best;
}

/**
 * How well the revolutions agree: occupied cells per point, lower is better.
 *
 * The measure tools/track_map.py uses to tell one convention from another,
 * and the one that says whether aligning helped.
 */
export function agreement(scans, cell = 0.10) {
  const seen = new Set();
  let total = 0;

  for (const scan of scans) {
    const heading = scan.th * Math.PI / 180;
    for (const [angle, distance] of scan.pts || []) {
      const radians = heading + angle * Math.PI / 180;
      const x = scan.x + distance / 1000 * Math.cos(radians);
      const y = scan.y + distance / 1000 * Math.sin(radians);
      seen.add(`${Math.round(x / cell)},${Math.round(y / cell)}`);
      total++;
    }
  }

  return total ? seen.size / total : 0;
}

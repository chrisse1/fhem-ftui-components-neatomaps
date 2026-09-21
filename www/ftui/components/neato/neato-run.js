/*
* What happened during the run, beyond the picture.
*
* The map answers "what does the flat look like". These two answer "how did it
* go": which floor the brush never went over, and where the robot stood still
* long enough that something was wrong.
*
* Both read the track, not the lidar - the poses are what the module recorded,
* and nothing here changes them. Both also refuse to make something up: a
* thinned recording, whose poses are half a minute apart, says nothing about
* where the robot drove in between, and countMissed reports that instead of
* drawing a straight line through the flat and calling it cleaned.
*
* Under MIT License (http://www.opensource.org/licenses/mit-license.php)
*/

/**
 * Free cells the brush never went over.
 *
 * The robot is a disc of about 32 cm, so everything within 16 cm of its centre
 * is swept. That disc is stamped along the track; whatever the occupancy grid
 * calls free and the stamp did not reach was not cleaned - the far side of a
 * doorway he only looked through, the corner behind the chair, the room he
 * never entered.
 *
 * Two poses are joined by a straight line only if they are close enough that a
 * straight line is a fair guess. A Botvac does about 0.3 m/s and the module
 * writes a pose every couple of seconds, so half a metre of travel between two
 * of them is normal and six metres means the recording was thinned. Those
 * steps are counted in `skipped` rather than invented, and a caller that finds
 * `skipped` anything but small should not show the number at all.
 *
 * Returns the left-out cells as row runs [firstX, y, length], like
 * classify() does, so they draw the same way.
 */
export function countMissed(grid, cells, poses, options = {}) {
  const width = options.width > 0 ? options.width : 0.32;
  const bridge = options.bridge > 0 ? options.bridge : 1.0;
  const { x0, y0, width: w, height: h, cell } = grid;

  const free = new Uint8Array(w * h);
  let freeCount = 0;
  for (const [ix, iy, run] of cells.free) {
    for (let i = 0; i < run; i++) {
      free[iy * w + ix + i] = 1;
      freeCount++;
    }
  }

  const half = Math.max(cell / 2, width / 2);
  const reach = Math.ceil(half / cell);
  const disc = [];
  for (let dx = -reach; dx <= reach; dx++) {
    for (let dy = -reach; dy <= reach; dy++) {
      if (Math.sqrt(dx * dx + dy * dy) * cell <= half) {
        disc.push([dx, dy]);
      }
    }
  }

  const stamp = (x, y) => {
    const cx = Math.floor(x / cell) - x0;
    const cy = Math.floor(y / cell) - y0;
    for (const [dx, dy] of disc) {
      const ix = cx + dx;
      const iy = cy + dy;
      if (ix >= 0 && ix < w && iy >= 0 && iy < h) {
        free[iy * w + ix] = 0;
      }
    }
  };

  let skipped = 0;
  for (let i = 0; i < poses.length; i++) {
    stamp(poses[i].x, poses[i].y);
    if (i === 0) {
      continue;
    }
    const step = Math.hypot(poses[i].x - poses[i - 1].x, poses[i].y - poses[i - 1].y);
    if (step > bridge) {
      skipped++;                               // no idea what happened between
      continue;
    }
    const steps = Math.ceil(step / (cell / 2));
    for (let k = 1; k < steps; k++) {
      stamp(poses[i - 1].x + (poses[i].x - poses[i - 1].x) * k / steps,
        poses[i - 1].y + (poses[i].y - poses[i - 1].y) * k / steps);
    }
  }

  // What is left standing in `free` is what the brush never reached.
  const runs = [];
  let missed = 0;
  for (let iy = 0; iy < h; iy++) {
    let start = -1;
    for (let ix = 0; ix <= w; ix++) {
      if (ix < w && free[iy * w + ix]) {
        if (start < 0) { start = ix; }
        missed++;
      } else if (start >= 0) {
        runs.push([start, iy, ix - start]);
        start = -1;
      }
    }
  }

  return {
    runs,
    cells: missed,
    free: freeCount,
    area: missed * cell * cell,
    freeArea: freeCount * cell * cell,
    covered: freeCount ? (freeCount - missed) / freeCount : 0,
    skipped,
    steps: Math.max(0, poses.length - 1),
  };
}

/**
 * Whether the track is dense enough for countMissed to mean anything.
 *
 * One skipped step is a gap in the recording, a fifth of them is a recording
 * that was thinned on purpose - and then "never went over it" only says that
 * the poses in the file are far apart.
 */
export function trackIsDense(missed) {
  return missed.steps > 0 && missed.skipped <= missed.steps * 0.05;
}

/**
 * Places where the robot stood still.
 *
 * Standing where it set off is docking, and that is what the end of every
 * finished run looks like. Standing anywhere else for twenty seconds is not
 * something a vacuum does on purpose: it is caught on a rug edge, wedged under
 * a cupboard, or waiting for a wheel that no longer turns. In the one
 * recording here that ended that way the robot turned 39 degrees on the spot
 * over those seconds, so turning is not a sign of health and is not required
 * to stay still.
 *
 * `ended` marks a standstill that runs to the last pose of the file - the run
 * did not finish, it stopped there.
 */
export function standstills(session, options = {}) {
  const seconds = options.seconds > 0 ? options.seconds : 20;
  const radius = options.radius > 0 ? options.radius : 0.05;
  const home = options.home >= 0 ? options.home : 1.0;
  const poses = (session && session.poses) || [];
  const out = [];

  let i = 0;
  while (i < poses.length) {
    let j = i;
    while (j + 1 < poses.length
      && Math.hypot(poses[j + 1].x - poses[i].x, poses[j + 1].y - poses[i].y) <= radius) {
      j++;
    }

    const held = poses[j].t - poses[i].t;
    // Three poses at least: in a thinned recording two of them happen to be
    // close often enough, and two points are not an episode.
    if (j - i >= 2 && held >= seconds
      && Math.hypot(poses[i].x - poses[0].x, poses[i].y - poses[0].y) > home) {
      out.push({
        x: poses[i].x,
        y: poses[i].y,
        at: poses[i].t - poses[0].t,
        seconds: held,
        ended: j === poses.length - 1,
      });
    }

    i = j + 1;
  }

  return out;
}

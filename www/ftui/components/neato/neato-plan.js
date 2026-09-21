/*
* One floor plan out of several runs.
*
* A single run is a map of that run, not of the flat: it has its own origin,
* its own north, and it only knows the rooms the robot got into that day. Put
* several of them on top of each other and two things happen that no single run
* can do - the walls that were missing get filled in, and every cell can be
* voted on. What eight runs out of ten call a wall is a wall; what one run
* calls a wall while the others looked at the same spot and saw floor was the
* laundry rack.
*
* Laying them on top is the same problem neato-align.js solves inside one run,
* one floor up: there a revolution is nudged by centimetres against the others,
* here a whole run is turned against the rest. The difference is that nothing
* is known beforehand - not the rotation, not the offset - so the rotation has
* to be found rather than refined.
*
* What makes that affordable is the dominant wall direction. A flat has one,
* every run measures it, and two runs of the same flat can only differ by that
* difference plus a multiple of a right angle. Four candidates instead of a
* hundred and twenty, measured on three real runs: about a fifth of a second
* each instead of eight seconds.
*
* Two things this does NOT claim:
*
*   - that the runs share an origin. They do in the recordings here - the base
*     is the same piece of furniture - but the search does not rely on it.
*   - that more runs are always better. Runs from the same afternoon see the
*     same furniture in the same place and agree for the wrong reason. The
*     vote is only as independent as the runs are.
*
* Under MIT License (http://www.opensource.org/licenses/mit-license.php)
*/

import { occupancy, classify } from './neato-track.js';
import { wallLines, wallTest } from './neato-walls.js';
import { alignScans } from './neato-align.js';

const DEFAULTS = {
  cell: 0.10,
  threshold: 0.25,
  minSeen: 2,
  // How far apart two cells may be and still mean the same wall. One cell:
  // a wall ten centimetres over is the same wall, and insisting otherwise is
  // what makes a good match look like a bad one.
  slack: 1,
  // The translation sweep, in metres, and how far around the frame it looks.
  step: 0.4,
  margin: 5,
  // Refinement, from coarse to fine: degrees and metres per stage.
  stages: [[1.2, 0.15], [0.3, 0.05], [0.1, 0.02]],
  // The step of the full sweep, in degrees. Only used when the dominant
  // directions are no help - see registerTo.
  sweepDegrees: 3,
  // A match below this is not a match. Measured: the three runs here score
  // 0.63 and 0.68, a deliberate mismatch stays under 0.3.
  accept: 0.45,
};

const KEY = (ix, iy) => ix * 100000 + iy;

/**
 * What one recording contributes: its wall cells, its free cells, and the
 * direction its walls run in.
 *
 * The revolutions are laid on top of each other first, exactly as the map
 * does it - a run whose own walls are a bundle of strokes cannot be matched
 * against anything.
 */
export function survey(session, options = {}) {
  const settings = { ...DEFAULTS, ...options };
  const scans = session.scans.length > 2 ? alignScans(session.scans).scans : session.scans;
  const grid = occupancy(scans, settings.cell);
  const cells = classify(grid, settings.threshold, settings.minSeen);

  const spread = (runs) => {
    const out = new Float64Array(2 * runs.reduce((sum, run) => sum + run[2], 0));
    let at = 0;
    for (const [ix, iy, run] of runs) {
      for (let i = 0; i < run; i++) {
        out[at++] = (ix + i + grid.x0 + 0.5) * settings.cell;
        out[at++] = (iy + grid.y0 + 0.5) * settings.cell;
      }
    }
    return out;
  };

  const { direction } = wallLines(scans, grid, wallTest(grid, settings.threshold, settings.minSeen),
    { poses: session.poses });

  return {
    walls: spread(cells.walls),
    free: spread(cells.free),
    direction,
    cell: settings.cell,
    scans: scans.length,
  };
}

/**
 * The frame a run is matched against: its wall cells, smeared a little.
 *
 * Without the smear the score would be a cliff - a run half a cell off scores
 * zero and the search has nothing to climb. With it, getting closer pays.
 */
export function frameOf(walls, options = {}) {
  const settings = { ...DEFAULTS, ...options };
  const weights = new Map();
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const reach = settings.slack + 1;

  for (let i = 0; i < walls.length; i += 2) {
    const x = walls[i];
    const y = walls[i + 1];
    if (x < minX) { minX = x; }
    if (x > maxX) { maxX = x; }
    if (y < minY) { minY = y; }
    if (y > maxY) { maxY = y; }

    const ix = Math.round(x / settings.cell);
    const iy = Math.round(y / settings.cell);
    for (let dx = -reach; dx <= reach; dx++) {
      for (let dy = -reach; dy <= reach; dy++) {
        const away = Math.sqrt(dx * dx + dy * dy);
        if (away > reach + 0.2) {
          continue;
        }
        const key = KEY(ix + dx, iy + dy);
        const weight = 1 / (1 + away);
        if (!(weights.get(key) >= weight)) {
          weights.set(key, weight);
        }
      }
    }
  }

  return {
    weights,
    cell: settings.cell,
    bounds: isFinite(minX) ? { minX, maxX, minY, maxY } : { minX: 0, maxX: 0, minY: 0, maxY: 0 },
  };
}

/**
 * The cells of a run, turned once.
 *
 * The sweep tries the same rotation against several hundred shifts, and a
 * shift is an addition while a rotation is four multiplications. Doing the
 * turn once per angle instead of once per angle and shift is the same
 * arithmetic in a different order - on the module side, which searches every
 * rotation rather than four, it took a run from 82 to 50 seconds.
 */
function turnedOnce(walls, angle, every = 1) {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const stride = 2 * every;
  const out = new Float64Array(2 * Math.ceil(walls.length / stride));
  let at = 0;

  for (let i = 0; i < walls.length; i += stride) {
    out[at++] = cos * walls[i] - sin * walls[i + 1];
    out[at++] = sin * walls[i] + cos * walls[i + 1];
  }

  return out;
}

/** How well already turned cells sit in a frame when shifted. 0 to 1. */
function fitsTurned(frame, turned, x, y) {
  let sum = 0;

  for (let i = 0; i < turned.length; i += 2) {
    sum += frame.weights.get(KEY(Math.round((turned[i] + x) / frame.cell),
      Math.round((turned[i + 1] + y) / frame.cell))) || 0;
  }

  return turned.length ? 2 * sum / turned.length : 0;
}

/** How well a run sits in a frame, turned and shifted. Between 0 and 1. */
function fits(frame, walls, angle, x, y, every = 1) {
  return fitsTurned(frame, turnedOnce(walls, angle, every), x, y);
}

/**
 * Where a run belongs in a frame: turned by `angle`, moved by `x`, `y`.
 *
 * The four candidate rotations come from the two dominant directions, which
 * are only known modulo a right angle - so all four are tried, each with a
 * sweep over the frame, and the best one is refined. `score` says how well it
 * ended up sitting; below `accept` the run is better left out than forced in.
 */
export function registerTo(frame, run, target, options = {}) {
  const settings = { ...DEFAULTS, ...options };
  const { minX, maxX, minY, maxY } = frame.bounds;
  const margin = settings.margin;

  // Every fifth cell for the sweep: the sweep only has to find the right
  // neighbourhood, and the refinement below uses all of them.
  const sparse = Math.max(1, Math.round(run.walls.length / 2 / 400));

  const sweep = (angles) => {
    let best = { angle: angles[0], x: 0, y: 0, score: -1 };
    for (const angle of angles) {
      const turned = turnedOnce(run.walls, angle, sparse);
      for (let x = minX - margin; x <= maxX + margin; x += settings.step) {
        for (let y = minY - margin; y <= maxY + margin; y += settings.step) {
          const score = fitsTurned(frame, turned, x, y);
          if (score > best.score) {
            best = { angle, x, y, score };
          }
        }
      }
    }
    return best;
  };

  // Modulo a right angle, and both ways round: a flat's walls run along two
  // directions at once and nothing says which of them either run measured.
  const quarter = Math.PI / 2;
  const whole = [];
  for (let degrees = 0; degrees < 360; degrees += settings.sweepDegrees) {
    whole.push(degrees * Math.PI / 180);
  }

  let best;
  if (target === null || target === undefined || !isFinite(run.direction)) {
    best = sweep(whole);
  } else {
    const turn = ((((target - run.direction) % quarter) + quarter) % quarter);
    best = sweep([0, 1, 2, 3].map(k => turn + k * quarter));

    // The four candidates are an optimisation, and an optimisation has to be
    // allowed to fail. A flat with round walls, or one where the two runs
    // measured different walls as the dominant ones, gets four wrong
    // candidates - and then the honest thing is to look everywhere. It costs
    // thirty times as much and happens almost never.
    if (best.score < settings.accept) {
      const everywhere = sweep(whole);
      if (everywhere.score > best.score) {
        best = everywhere;
      }
    }
  }

  for (const [degrees, metres] of settings.stages) {
    const radians = degrees * Math.PI / 180;
    let local = { ...best, score: fits(frame, run.walls, best.angle, best.x, best.y) };
    for (let a = -3; a <= 3; a++) {
      for (let dx = -3; dx <= 3; dx++) {
        for (let dy = -3; dy <= 3; dy++) {
          const angle = best.angle + a * radians;
          const x = best.x + dx * metres;
          const y = best.y + dy * metres;
          const score = fits(frame, run.walls, angle, x, y);
          if (score > local.score) {
            local = { angle, x, y, score };
          }
        }
      }
    }
    best = local;
  }

  return best;
}

/**
 * Several runs as one plan.
 *
 * The run with the most wall cells is the frame - it knows the flat best - and
 * the others are matched against it. Every cell then carries two numbers:
 * `seen`, how many runs looked at that spot at all, and `walls`, how many of
 * those call it a wall. A run that never got into the room does not get to
 * vote about it.
 *
 * Runs that do not fit are dropped, and named in `rejected`. Forcing a run
 * that shares no walls with the others - a different floor, a different flat -
 * into the picture would ruin the plan it is added to.
 */
export function mergePlan(surveys, options = {}) {
  const settings = { ...DEFAULTS, ...options };

  if (!surveys.length) {
    return { cells: [], placements: [], rejected: [], cell: settings.cell, runs: 0 };
  }

  const order = surveys
    .map((survey, index) => ({ survey, index }))
    .sort((a, b) => b.survey.walls.length - a.survey.walls.length);

  const first = order[0];
  const frame = frameOf(first.survey.walls, settings);
  const placements = [{ index: first.index, angle: 0, x: 0, y: 0, score: 1 }];
  const rejected = [];

  for (const { survey, index } of order.slice(1)) {
    const fit = registerTo(frame, survey, first.survey.direction, settings);
    if (fit.score >= settings.accept) {
      placements.push({ index, ...fit });
    } else {
      rejected.push({ index, score: fit.score });
    }
  }

  // The vote. The cells of the plan are the cells that were measured - the
  // slack belongs in who confirms them, not in how many there are. Counting
  // the widened sets instead would turn 1800 wall cells into 5000 and make a
  // flat look like it was built of metre-thick walls.
  const measured = new Set();
  const looked = [];

  for (const placement of placements) {
    const survey = surveys[placement.index];
    const cos = Math.cos(placement.angle);
    const sin = Math.sin(placement.angle);

    const keys = (points, reach) => {
      const out = new Set();
      for (let i = 0; i < points.length; i += 2) {
        const px = cos * points[i] - sin * points[i + 1] + placement.x;
        const py = sin * points[i] + cos * points[i + 1] + placement.y;
        const ix = Math.round(px / settings.cell);
        const iy = Math.round(py / settings.cell);
        for (let dx = -reach; dx <= reach; dx++) {
          for (let dy = -reach; dy <= reach; dy++) {
            out.add(KEY(ix + dx, iy + dy));
          }
        }
      }
      return out;
    };

    const raw = keys(survey.walls, 0);
    for (const key of raw) {
      measured.add(key);
    }
    looked.push({ near: keys(survey.walls, settings.slack), free: keys(survey.free, 0) });
  }

  const cells = [];
  for (const key of measured) {
    let walls = 0;
    let seen = 0;
    for (const run of looked) {
      const saysWall = run.near.has(key);
      if (saysWall) { walls++; }
      // A run has looked at a cell if it knows it as floor or as wall. One it
      // never came near says nothing, and is not counted as a vote against.
      if (saysWall || run.free.has(key)) { seen++; }
    }
    const ix = Math.round(key / 100000);
    cells.push({ x: ix * settings.cell, y: (key - ix * 100000) * settings.cell, walls, seen });
  }

  return { cells, placements, rejected, cell: settings.cell, runs: placements.length };
}

/**
 * The cells a plan is willing to call a wall.
 *
 * `agree` is the share of the runs that looked which have to agree. Half of
 * them is a sensible default: a wall two of three runs see is a wall, and
 * something only one of three sees, while the other two looked at the same
 * spot and saw floor, is furniture.
 */
export function confident(plan, agree = 0.5) {
  return plan.cells.filter(cell => cell.seen > 0 && cell.walls / cell.seen >= agree);
}

/** The other side of the same coin: seen by several, called a wall by one. */
export function disputed(plan, agree = 0.5) {
  return plan.cells.filter(cell => cell.seen > 1 && cell.walls / cell.seen < agree);
}

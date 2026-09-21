/*
* Walls as lines instead of pixels.
*
* A flat is built of straight walls, mostly at right angles to each other, and
* a lidar that sees such a wall from four positions puts four slightly
* different rows of dots on it. Drawn as cells that is a fuzzy band; drawn as
* one line it is a wall.
*
* The way there is the classic one from robotics, in four steps:
*
*   1. Split a revolution into runs of neighbouring points - a jump in
*      distance means the beam went past an edge and hit something else.
*   2. Split each run where it bends: the farthest point from the chord
*      between its ends, as long as it is farther off than the tolerance
*      (iterative end point fit).
*   3. Join pieces that lie on the same straight line, across the gaps that
*      furniture and doorways leave - but only while the joint line still
*      carries every point it claims.
*   4. Turn the pieces that are nearly parallel to the flat's main direction
*      exactly parallel to it. The direction is measured, not assumed: it is
*      the one the walls agree on.
*
* What this does NOT do is decide what is a wall. That is the occupancy grid's
* job and stays its job: a person walking through a scan is one row of dots
* nobody else confirms, and the grid says so, because the beams of the other
* revolutions went straight through where they stood. A line is only drawn
* where the grid backs it - see supported().
*
* Under MIT License (http://www.opensource.org/licenses/mit-license.php)
*/

import { worldPoints } from './neato-track.js';

const DEFAULTS = {
  // How far a point may sit off a line before the line is split in two. It
  // is also the measure for joining two pieces: how far apart their lines
  // may lie, and how far the angle between them may open up.
  tolerance: 0.04,
  // The angle two pieces may differ by and still be the same wall. Wide open
  // and a flat full of furniture always has a partner that fits by accident,
  // and the joins wander off diagonally across rooms.
  joinDegrees: 4,
  // How far apart their lines may lie across the direction. A wall is seen
  // from several places over an hour and lands a few centimetres apart each
  // time; too strict and one wall stays a bundle of parallel strokes, too
  // loose and two walls become one.
  joinOffset: 0.12,
  // A jump this size in a revolution ends a run of points. A wall met at a
  // sharp angle spreads its points out, so this is wider than it looks like
  // it should be - and a run that is not straight is cut up again right
  // afterwards anyway.
  step: 0.30,
  // Gaps up to this length are closed while joining - a doorway is not.
  gap: 0.80,
  // Shorter pieces are left out: crumbs, chair legs, the corner of a box.
  // Measured against two recordings - a thinned excerpt of ten revolutions
  // and a full hour over a whole flat - this is where the scribble between
  // the walls goes without the walls going with it.
  minLength: 0.60,
  // Pieces off the main direction by less than this are turned onto it.
  snapDegrees: 8,
  // How much of a line the occupancy grid has to call a wall. Not all of it:
  // a line laid straight through a slightly crooked wall leaves its cells
  // here and there, and turning it onto the main direction moves it again.
  support: 0.35,
  // Below this length a piece has to run along the flat to be drawn at all.
  // A flat is built square; a short piece at some angle of its own is a chair
  // leg, a pot plant, a door standing open - true, but not a wall, and it is
  // what makes a map look like a scribble. 0 keeps everything.
  squareBelow: 1.2,
  // A piece this close to a much longer parallel one is the same wall seen
  // again, or its skirting board, or the cupboard in front of it. The longer
  // one is drawn, this one is not.
  shadow: 0.35,
  // How much longer the other one has to be for that.
  shadowFactor: 2.5,
  // How far across its direction a wall's sightings may scatter and still be
  // gathered into one line. An hour of driving puts the same wall down a
  // hand's width apart; two walls that far apart are rare, and where the
  // sightings really do form two heaps, two lines come out - the gathering
  // follows where they are dense, it does not average everything in reach.
  flight: 0.12,
  // At most this many revolutions are taken apart into lines. A long run has
  // three hundred of them and sees every wall a dozen times over; the
  // geometry does not get better from the rest, only slower. Which cells are
  // wall is still decided by every single beam - that is the grid's job.
  maxScans: 120,
};

/**
 * The walls of a session as line segments, in metres.
 *
 * Returns [{ x0, y0, x1, y1, angle, length }], the longest first, plus the
 * main direction that was measured, in radians.
 */
export function wallLines(scans, grid, cells, options = {}) {
  const settings = { ...DEFAULTS, ...options };

  let pieces = [];
  for (const scan of sample(scans, settings.maxScans)) {
    pieces = pieces.concat(scanPieces(scan, settings));
  }

  pieces = join(worthwhile(gather(pieces, settings), settings), settings);

  const direction = mainDirection(pieces);
  if (settings.snapDegrees > 0) {
    const turned = snap(pieces, direction, settings.snapDegrees * Math.PI / 180);
    pieces = join(worthwhile(gather(turned, settings), settings), settings);
  }

  // Gathering and tidying move lines around, so the grid has the last word,
  // not the first: what is drawn in the end is what the grid backs in the
  // end.
  let walls = tidy(flights(pieces, settings), direction, settings);

  walls = walls
    .map(wall => supported(wall, grid, cells, settings))
    .filter(wall => wall && wall.length >= settings.minLength)
    .sort((a, b) => b.length - a.length);

  return { walls, direction };
}

/**
 * Gathers the sightings of one wall into one line.
 *
 * After the pieces have been turned onto the flat's direction, a wall is a
 * row of parallel lines a few centimetres apart: the same wall, seen from
 * another place an hour later. Joining them in pairs does not help - they are
 * all about equally long, so none of them is the one that swallows the
 * others.
 *
 * So they are treated as what they are: a heap. Every line is pulled towards
 * the weighted middle of the lines near it, again and again, until it stops
 * moving (mean shift, weighted by length so a long wall pulls harder than a
 * short shelf). Lines that end up in the same place were the same wall.
 * Where the sightings really form two heaps - a wall and a cupboard a good
 * step in front of it - the two survive as two.
 */
function flights(walls, settings) {
  if (!(settings.flight > 0) || walls.length < 2) {
    return walls;
  }

  const groups = new Map();
  // Lines within the joining tolerance of each other count as parallel. A
  // tenth of a degree would give every line a heap of its own, and nothing
  // would ever be gathered.
  const step = Math.max(settings.joinDegrees, 1) * Math.PI / 180;

  for (const wall of walls) {
    const angle = ((wall.angle % Math.PI) + Math.PI) % Math.PI;
    const key = Math.round(angle / step);
    const ux = Math.cos(angle);
    const uy = Math.sin(angle);
    const mx = (wall.x0 + wall.x1) / 2;
    const my = (wall.y0 + wall.y1) / 2;
    const entry = { wall, angle, ux, uy, offset: -uy * mx + ux * my };

    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(entry);
  }

  const out = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      out.push(group[0].wall);
      continue;
    }
    out.push(...gatherFlight(group, settings));
  }

  return out;
}

/** One direction: which lines sit at the same distance, and what comes of it. */
function gatherFlight(group, settings) {
  const window = settings.flight;

  // One direction for the whole heap, weighted by length, and every offset
  // measured against it - otherwise lines a degree apart never land on the
  // same distance and the heap falls apart again.
  let sumX = 0;
  let sumY = 0;
  for (const entry of group) {
    sumX += Math.cos(2 * entry.angle) * entry.wall.length;
    sumY += Math.sin(2 * entry.angle) * entry.wall.length;
  }
  const angle = 0.5 * Math.atan2(sumY, sumX);
  const ux = Math.cos(angle);
  const uy = Math.sin(angle);
  for (const entry of group) {
    const mx = (entry.wall.x0 + entry.wall.x1) / 2;
    const my = (entry.wall.y0 + entry.wall.y1) / 2;
    entry.angle = angle;
    entry.ux = ux;
    entry.uy = uy;
    entry.offset = -uy * mx + ux * my;
  }

  // Mean shift, a handful of rounds - the heaps of a flat are far enough
  // apart that it settles quickly.
  const at = group.map(entry => entry.offset);
  for (let round = 0; round < 12; round++) {
    let moved = 0;
    for (let i = 0; i < at.length; i++) {
      let sum = 0;
      let weight = 0;
      for (let k = 0; k < group.length; k++) {
        const distance = Math.abs(group[k].offset - at[i]);
        if (distance > window) {
          continue;
        }
        // Nearer sightings count more, and a long wall more than a short one.
        const w = group[k].wall.length * (1 - distance / window);
        sum += group[k].offset * w;
        weight += w;
      }
      if (weight > 0) {
        const next = sum / weight;
        moved = Math.max(moved, Math.abs(next - at[i]));
        at[i] = next;
      }
    }
    if (moved < 0.002) {
      break;
    }
  }

  // Lines that settled within a centimetre of each other are one wall.
  const order = at.map((offset, i) => i).sort((a, b) => at[a] - at[b]);
  const heaps = [];
  for (const i of order) {
    const last = heaps[heaps.length - 1];
    if (last && at[i] - at[last[last.length - 1]] < 0.01) {
      last.push(i);
    } else {
      heaps.push([i]);
    }
  }

  const out = [];
  for (const heap of heaps) {
    if (heap.length === 1) {
      out.push(group[heap[0]].wall);
      continue;
    }
    out.push(...mergeFlight(heap.map(i => group[i]), at[heap[0]], settings));
  }

  return out;
}

/** The lines of one wall, laid onto their common line and cut at real gaps. */
function mergeFlight(entries, offset, settings) {
  const { ux, uy } = entries[0];
  // The wall sits where its sightings agree; along it, it reaches as far as
  // they reach - and no further.
  const spans = entries.map(entry => {
    const t0 = entry.wall.x0 * ux + entry.wall.y0 * uy;
    const t1 = entry.wall.x1 * ux + entry.wall.y1 * uy;
    return { from: Math.min(t0, t1), to: Math.max(t0, t1), length: entry.wall.length };
  }).sort((a, b) => a.from - b.from);

  const out = [];
  let from = spans[0].from;
  let to = spans[0].to;

  const flush = () => {
    const length = to - from;
    if (length <= 0) {
      return;
    }
    out.push({
      x0: from * ux - offset * uy,
      y0: from * uy + offset * ux,
      x1: to * ux - offset * uy,
      y1: to * uy + offset * ux,
      angle: Math.atan2(uy, ux),
      length,
    });
  };

  for (const span of spans.slice(1)) {
    if (span.from - to > settings.gap) {
      flush();
      from = span.from;
      to = span.to;
    } else {
      to = Math.max(to, span.to);
    }
  }
  flush();

  return out;
}

/**
 * Takes out what makes a flat look like a scribble.
 *
 * Two rules, both from what a flat is: it is built square, and a wall is one
 * wall however often it was seen.
 *
 *   - A short piece that runs neither along the flat nor across it is not a
 *     wall. It is furniture, a door left open, a pot plant. Longer pieces are
 *     kept whatever their angle - a slanted wall exists, a slanted chair leg
 *     of two metres does not.
 *   - A piece lying close to and parallel with a much longer one is that same
 *     wall again: seen from another spot an hour later, or its skirting
 *     board, or the cupboard standing against it. The longer one is the wall.
 */
function tidy(walls, direction, settings) {
  const square = [];

  for (const wall of walls) {
    if (settings.squareBelow > 0 && wall.length < settings.squareBelow) {
      let off = ((wall.angle - direction) % Math.PI + Math.PI) % Math.PI;
      off = Math.min(off, Math.PI - off, Math.abs(off - Math.PI / 2));
      if (off > (settings.snapDegrees || 8) * Math.PI / 180) {
        continue;
      }
    }
    square.push(wall);
  }

  // Longest first, so the wall is always found before its echoes.
  square.sort((a, b) => b.length - a.length);
  const kept = [];

  for (const wall of square) {
    const shadowed = kept.some(other => {
      if (other.length < wall.length * settings.shadowFactor) {
        return false;
      }
      let delta = Math.abs(other.angle - wall.angle) % Math.PI;
      delta = Math.min(delta, Math.PI - delta);
      if (delta > (settings.joinDegrees || 4) * Math.PI / 180) {
        return false;
      }

      // Across the longer one: how far away does the short one lie?
      const ux = Math.cos(other.angle);
      const uy = Math.sin(other.angle);
      const mx = (other.x0 + other.x1) / 2;
      const my = (other.y0 + other.y1) / 2;
      const across = (x, y) => Math.abs(-(y - my) * ux + (x - mx) * uy);
      if (Math.max(across(wall.x0, wall.y0), across(wall.x1, wall.y1)) > settings.shadow) {
        return false;
      }

      // And does it lie beside it at all, or somewhere else entirely?
      const along = (x, y) => (x - mx) * ux + (y - my) * uy;
      const half = other.length / 2;
      const a0 = along(wall.x0, wall.y0);
      const a1 = along(wall.x1, wall.y1);
      return Math.min(a0, a1) < half && Math.max(a0, a1) > -half;
    });

    if (!shadowed) {
      kept.push(wall);
    }
  }

  return kept;
}

/** Every nth revolution, evenly spread over the run. */
function sample(scans, most) {
  if (!(most > 0) || scans.length <= most) {
    return scans;
  }
  const out = [];
  const step = scans.length / most;
  for (let i = 0; i < most; i++) {
    out.push(scans[Math.floor(i * step)]);
  }
  return out;
}

/**
 * One revolution, cut into straight pieces.
 *
 * The points of a scan come in the order the lidar measured them, so
 * neighbours in the list are neighbours in the room - until a jump says
 * otherwise.
 */
function scanPieces(scan, settings) {
  const points = worldPoints(scan);
  const count = points.length / 2;
  const pieces = [];

  let start = 0;
  for (let i = 1; i <= count; i++) {
    const jumped = i === count
      || Math.hypot(points[i * 2] - points[(i - 1) * 2],
        points[i * 2 + 1] - points[(i - 1) * 2 + 1]) > settings.step;

    if (jumped) {
      if (i - start >= 2) {
        split(points, start, i - 1, settings.tolerance, pieces);
      }
      start = i;
    }
  }

  return pieces;
}

/**
 * Iterative end point fit: keep cutting a run where it bends most.
 *
 * Written with an explicit stack rather than recursion - a revolution can be
 * 360 points long and this runs for every scan of every session.
 */
function split(points, from, to, tolerance, out) {
  const stack = [[from, to]];

  while (stack.length) {
    const [a, b] = stack.pop();
    if (b - a < 1) {
      continue;
    }

    const ax = points[a * 2], ay = points[a * 2 + 1];
    const bx = points[b * 2], by = points[b * 2 + 1];
    const dx = bx - ax, dy = by - ay;
    const length = Math.hypot(dx, dy);

    let worst = 0;
    let at = -1;
    if (length > 1e-9) {
      for (let i = a + 1; i < b; i++) {
        const off = Math.abs(dy * (points[i * 2] - ax) - dx * (points[i * 2 + 1] - ay)) / length;
        if (off > worst) {
          worst = off;
          at = i;
        }
      }
    }

    if (worst > tolerance && at > a && at < b) {
      stack.push([a, at], [at, b]);
    } else if (b - a >= 1) {
      out.push(moments(points, a, b));
    }
  }
}

/**
 * A piece of line, kept as the sums its line can be computed from.
 *
 * Carrying the sums instead of the points makes joining two pieces a handful
 * of additions instead of a new fit over everything they have seen, and the
 * error of the joint line falls out of the same numbers.
 */
function moments(points, from, to) {
  const piece = { n: 0, sx: 0, sy: 0, sxx: 0, syy: 0, sxy: 0, ends: [] };

  for (let i = from; i <= to; i++) {
    const x = points[i * 2];
    const y = points[i * 2 + 1];
    piece.n++;
    piece.sx += x;
    piece.sy += y;
    piece.sxx += x * x;
    piece.syy += y * y;
    piece.sxy += x * y;
  }

  piece.ends = [points[from * 2], points[from * 2 + 1], points[to * 2], points[to * 2 + 1]];
  return line(piece);
}

/** The straight line through a piece: direction, spread, and its two ends. */
function line(piece) {
  const { n, sx, sy, sxx, syy, sxy } = piece;
  const mx = sx / n;
  const my = sy / n;
  const cxx = sxx - n * mx * mx;
  const cyy = syy - n * my * my;
  const cxy = sxy - n * mx * my;

  const angle = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
  const ux = Math.cos(angle);
  const uy = Math.sin(angle);

  // The smaller principal value is the spread across the line: how far the
  // points scatter off it, which is what says whether it is a line at all.
  const sum = cxx + cyy;
  const diff = Math.sqrt((cxx - cyy) * (cxx - cyy) + 4 * cxy * cxy);
  const across = Math.max(0, (sum - diff) / 2);
  const spread = Math.sqrt(across / n);

  // The ends are the outermost of the ends collected so far, projected onto
  // the line - the piece never grows beyond what was measured. On the way,
  // the farthest any of them sits off the line: the spread above is a mean
  // and a mean drowns a few stray ends in a thousand well behaved points,
  // which is how a chain of joins can wander off across a flat.
  let min = Infinity;
  let max = -Infinity;
  let reach = 0;
  for (let i = 0; i < piece.ends.length; i += 2) {
    const dx = piece.ends[i] - mx;
    const dy = piece.ends[i + 1] - my;
    const t = dx * ux + dy * uy;
    const off = Math.abs(-dy * ux + dx * uy);
    if (t < min) { min = t; }
    if (t > max) { max = t; }
    if (off > reach) { reach = off; }
  }

  piece.angle = angle;
  piece.spread = spread;
  piece.reach = reach;
  piece.x0 = mx + min * ux;
  piece.y0 = my + min * uy;
  piece.x1 = mx + max * ux;
  piece.y1 = my + max * uy;
  piece.length = max - min;
  return piece;
}

/**
 * Drops the crumbs.
 *
 * After the pieces of one bin have been added up, what is left below a third
 * of the shortest wall is a chair leg, a cable, the corner of a shoe - things
 * that cannot reach the minimum length even if every one of them joined the
 * same line, and that otherwise carry most of the cost of joining.
 */
function worthwhile(pieces, settings) {
  const least = settings.minLength / 3;
  return pieces.filter(piece => piece.length >= least);
}

/**
 * A first, cheap pass: pieces that land in the same narrow bin of direction
 * and distance are the same wall seen again, so they are added up in one go.
 *
 * A long run produces some three thousand pieces, and comparing those in
 * pairs is millions of comparisons. This brings them down to a few hundred in
 * one sweep, and what the bins cut apart at their edges the pairwise join
 * below puts back together.
 */
function gather(pieces, settings) {
  const angleStep = 3 * Math.PI / 180;
  const offsetStep = Math.max(settings.tolerance * 2, 0.05);
  const groups = new Map();

  for (const piece of pieces) {
    const angle = ((piece.angle % Math.PI) + Math.PI) % Math.PI;
    const mx = (piece.x0 + piece.x1) / 2;
    const my = (piece.y0 + piece.y1) / 2;
    const offset = -Math.sin(angle) * mx + Math.cos(angle) * my;
    const key = Math.round(angle / angleStep) * 100000 + Math.round(offset / offsetStep);

    const group = groups.get(key);
    if (group) {
      group.push(piece);
    } else {
      groups.set(key, [piece]);
    }
  }

  const out = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      out.push(group[0]);
      continue;
    }
    // Along the common line the pieces may still be far apart - two walls of
    // the same room in the same flight. Chains are cut where the hole is
    // bigger than a wall's.
    out.push(...chains(group, settings));
  }

  return out;
}

/** Pieces of one bin, added up along their line and cut at the real gaps. */
function chains(group, settings) {
  let ux = 0;
  let uy = 0;
  let weight = 0;
  for (const piece of group) {
    // Doubling the angle keeps opposite directions from cancelling out.
    ux += Math.cos(2 * piece.angle) * piece.length;
    uy += Math.sin(2 * piece.angle) * piece.length;
    weight += piece.length;
  }
  const angle = weight > 0 ? 0.5 * Math.atan2(uy, ux) : group[0].angle;
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);

  const spans = group.map(piece => {
    const t0 = piece.x0 * dx + piece.y0 * dy;
    const t1 = piece.x1 * dx + piece.y1 * dy;
    return { piece, from: Math.min(t0, t1), to: Math.max(t0, t1) };
  }).sort((a, b) => a.from - b.from);

  const out = [];
  let chain = [];
  let reach = -Infinity;

  const flush = () => {
    if (!chain.length) {
      return;
    }
    const sums = { n: 0, sx: 0, sy: 0, sxx: 0, syy: 0, sxy: 0, ends: [] };
    for (const piece of chain) {
      sums.n += piece.n;
      sums.sx += piece.sx;
      sums.sy += piece.sy;
      sums.sxx += piece.sxx;
      sums.syy += piece.syy;
      sums.sxy += piece.sxy;
      sums.ends.push(piece.x0, piece.y0, piece.x1, piece.y1);
    }
    const joint = line(sums);
    // Same rule as for a pairwise join: a line that no longer carries its
    // points is not one, and then the pieces stay as they were.
    if (joint.spread <= settings.tolerance && joint.reach <= settings.joinOffset * 1.5) {
      out.push(joint);
    } else {
      out.push(...chain);
    }
    chain = [];
  };

  for (const span of spans) {
    if (chain.length && span.from - reach > settings.gap) {
      flush();
      reach = -Infinity;
    }
    chain.push(span.piece);
    reach = Math.max(reach, span.to);
  }
  flush();

  return out;
}

/**
 * Joins pieces that lie on the same line, again and again until nothing
 * changes any more.
 *
 * Pieces are looked up by direction and distance from the origin, so a long
 * run does not compare every piece with every other one: the candidates for a
 * piece are the ones in its own bucket and the neighbouring ones.
 */
function join(pieces, settings) {
  const angleStep = Math.max(settings.joinDegrees, 1) * Math.PI / 180;
  // How far apart two lines may lie across their direction - not how far
  // along it, which is what the gap is for. Wide bins here would put every
  // piece of a whole wall flight into one list and turn the lookup back into
  // comparing everything with everything.
  const offsetStep = Math.max(settings.joinOffset, 0.02);

  let current = pieces.slice().sort((a, b) => b.length - a.length);

  for (let round = 0; round < 3; round++) {
    const buckets = new Map();
    const result = [];
    let changed = false;

    for (const piece of current) {
      let merged = null;

      for (const key of bucketKeys(piece, angleStep, offsetStep)) {
        const bucket = buckets.get(key);
        if (!bucket) {
          continue;
        }
        for (const other of bucket) {
          if (other.dropped) {
            continue;
          }
          const candidate = mergePieces(other, piece, settings);
          if (candidate) {
            merged = candidate;
            other.dropped = true;
            break;
          }
        }
        if (merged) {
          break;
        }
      }

      const kept = merged || piece;
      if (merged) {
        changed = true;
      }
      result.push(kept);
      for (const key of bucketKeys(kept, angleStep, offsetStep)) {
        if (!buckets.has(key)) {
          buckets.set(key, []);
        }
        buckets.get(key).push(kept);
      }
    }

    current = result.filter(piece => !piece.dropped).sort((a, b) => b.length - a.length);
    current.forEach(piece => { piece.dropped = false; });

    if (!changed) {
      break;
    }
  }

  return current;
}

/** Which buckets a piece can be found in - its own and the neighbouring ones. */
function bucketKeys(piece, angleStep, offsetStep) {
  // Direction counts modulo 180 degrees: a wall seen from the other side is
  // the same wall.
  const angle = ((piece.angle % Math.PI) + Math.PI) % Math.PI;
  const mx = (piece.x0 + piece.x1) / 2;
  const my = (piece.y0 + piece.y1) / 2;
  const offset = -Math.sin(angle) * mx + Math.cos(angle) * my;

  const a = Math.round(angle / angleStep);
  const o = Math.round(offset / offsetStep);
  const steps = Math.round(Math.PI / angleStep);
  const keys = [];

  for (let da = -1; da <= 1; da++) {
    for (let db = -1; db <= 1; db++) {
      keys.push(`${(((a + da) % steps) + steps) % steps},${o + db}`);
    }
  }
  return keys;
}

/** Two pieces as one, or nothing if they are not the same wall. */
function mergePieces(a, b, settings) {
  let delta = Math.abs(a.angle - b.angle) % Math.PI;
  delta = Math.min(delta, Math.PI - delta);
  if (delta > Math.max(settings.joinDegrees, 1) * Math.PI / 180) {
    return null;
  }

  const ux = Math.cos(a.angle);
  const uy = Math.sin(a.angle);
  const mx = (a.x0 + a.x1) / 2;
  const my = (a.y0 + a.y1) / 2;
  const off = (x, y) => Math.abs(-(y - my) * ux + (x - mx) * uy);

  // Both ends of the candidate have to lie on the same line - measured
  // against how far a wall moves between two sightings, not against how wide
  // the gap is.
  if (Math.max(off(b.x0, b.y0), off(b.x1, b.y1)) > settings.joinOffset) {
    return null;
  }

  // ... and the hole between the two pieces has to be one a wall could have.
  const at = (x, y) => (x - mx) * ux + (y - my) * uy;
  const [a0, a1] = [at(a.x0, a.y0), at(a.x1, a.y1)].sort((p, q) => p - q);
  const [b0, b1] = [at(b.x0, b.y0), at(b.x1, b.y1)].sort((p, q) => p - q);
  const hole = Math.max(b0 - a1, a0 - b1, 0);
  if (hole > settings.gap) {
    return null;
  }

  const joint = line({
    n: a.n + b.n,
    sx: a.sx + b.sx,
    sy: a.sy + b.sy,
    sxx: a.sxx + b.sxx,
    syy: a.syy + b.syy,
    sxy: a.sxy + b.sxy,
    ends: a.ends.concat(b.ends),
  });

  // A joint line that no longer carries its points is not a wall but a
  // compromise between two of them - measured both as the average distance
  // of the points and as the worst of the ends.
  if (joint.spread > settings.tolerance || joint.reach > settings.joinOffset * 1.5) {
    return null;
  }

  return joint;
}

/**
 * The direction the walls agree on, modulo 90 degrees.
 *
 * Every piece votes with its length, and the vote is spread over a few degrees
 * so that a wall a degree off still counts towards its neighbours.
 */
export function mainDirection(pieces) {
  const bins = new Float64Array(90);

  for (const piece of pieces) {
    const degrees = ((Math.round(piece.angle * 180 / Math.PI) % 90) + 90) % 90;
    for (let d = -2; d <= 2; d++) {
      bins[(degrees + d + 90) % 90] += piece.length * (3 - Math.abs(d));
    }
  }

  let best = 0;
  for (let i = 1; i < 90; i++) {
    if (bins[i] > bins[best]) {
      best = i;
    }
  }

  return best * Math.PI / 180;
}

/** Turns nearly parallel pieces onto the main direction, around their middle. */
function snap(pieces, direction, tolerance) {
  return pieces.map(piece => {
    let angle = piece.angle;
    let best = tolerance;

    for (let k = 0; k < 4; k++) {
      const candidate = direction + k * Math.PI / 2;
      let delta = Math.abs(piece.angle - candidate) % (2 * Math.PI);
      delta = Math.min(delta, 2 * Math.PI - delta);
      delta = Math.min(delta, Math.abs(Math.PI - delta));
      if (delta <= best) {
        best = delta;
        angle = candidate;
      }
    }

    if (angle === piece.angle) {
      return piece;
    }

    const mx = (piece.x0 + piece.x1) / 2;
    const my = (piece.y0 + piece.y1) / 2;
    const half = piece.length / 2;
    const ux = Math.cos(angle);
    const uy = Math.sin(angle);

    return {
      ...piece,
      angle,
      x0: mx - half * ux,
      y0: my - half * uy,
      x1: mx + half * ux,
      y1: my + half * uy,
    };
  });
}

/**
 * The part of a piece the occupancy grid calls a wall.
 *
 * This is where somebody walking through the scan drops out: their outline is
 * a line like any other, but the beams of the other revolutions went through
 * the place they stood, so the grid counts the cells as free.
 *
 * Returns the piece trimmed to its supported part, or null if the grid does
 * not back it.
 */
function supported(piece, grid, cells, settings) {
  if (!grid || !grid.width) {
    return { ...piece };
  }

  const step = grid.cell / 2;
  const count = Math.max(2, Math.ceil(piece.length / step) + 1);
  const ux = (piece.x1 - piece.x0) / (piece.length || 1);
  const uy = (piece.y1 - piece.y0) / (piece.length || 1);

  let backed = 0;
  let first = -1;
  let last = -1;

  for (let i = 0; i < count; i++) {
    const t = (i / (count - 1)) * piece.length;
    const ix = Math.floor((piece.x0 + t * ux) / grid.cell) - grid.x0;
    const iy = Math.floor((piece.y0 + t * uy) / grid.cell) - grid.y0;

    if (ix < 0 || iy < 0 || ix >= grid.width || iy >= grid.height) {
      continue;
    }
    if (cells.isWall(ix, iy)) {
      backed++;
      if (first < 0) { first = i; }
      last = i;
    }
  }

  if (first < 0 || backed / count < settings.support) {
    return null;
  }

  const t0 = (first / (count - 1)) * piece.length;
  const t1 = (last / (count - 1)) * piece.length;

  return {
    x0: piece.x0 + t0 * ux,
    y0: piece.y0 + t0 * uy,
    x1: piece.x0 + t1 * ux,
    y1: piece.y0 + t1 * uy,
    angle: piece.angle,
    length: t1 - t0,
    points: piece.n,
  };
}

/** Wall lookup for a grid, the same rule classify() uses. */
export function wallTest(grid, threshold = 0.25, seen = 2) {
  return {
    isWall(ix, iy) {
      const at = iy * grid.width + ix;
      const hits = grid.hits[at];
      const total = hits + grid.misses[at];
      return total >= seen && hits / total >= threshold;
    },
  };
}

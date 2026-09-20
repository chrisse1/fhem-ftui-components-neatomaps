/*
* Reading a session recorded by 74_NeatoLocal: the track, and the map the
* lidar points make.
*
* This module knows nothing about FTUI or the DOM. It is the JavaScript twin of
* tools/track_map.py in the neato-FHEM repository and is meant to stay one:
* test/session.test.mjs compares cell for cell against numbers taken from the
* Python reference.
*
* Under MIT License (http://www.opensource.org/licenses/mit-license.php)
*/

const DEG = Math.PI / 180;

/**
 * Header, poses, scans and summary of a session file.
 *
 * JSON Lines, one record per line, four kinds. Lines starting with '#' are
 * comments (the fixtures in the module repository have them, real recordings
 * do not). A record with 'device' is the header, one with 'scan' a lidar
 * revolution, one with 'summary' the closing line of a finished run, anything
 * else a pose sample.
 */
export function parseSession(text) {
  const head = { };
  const poses = [];
  const scans = [];
  let summary = null;

  const lines = String(text).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.length || line.charAt(0) === '#') {
      continue;
    }
    let record;
    try {
      record = JSON.parse(line);
    } catch (err) {
      // A run in progress can be caught mid-write: the last line is then half
      // a record. Everything before it is still good.
      continue;
    }
    if (record === null || typeof record !== 'object') {
      continue;
    }
    if (record.device !== undefined) {
      Object.assign(head, record);
    } else if (record.scan !== undefined) {
      scans.push(record.scan);
    } else if (record.summary !== undefined) {
      summary = record.summary;
    } else if (record.x !== undefined && record.y !== undefined) {
      poses.push(record);
    }
  }

  return { head, poses, scans, summary };
}

/**
 * A scan's points in the coordinates of the run, in metres.
 *
 * The robot's heading and the lidar's angle both count counter-clockwise in
 * degrees, and the lidar's zero looks where the robot looks:
 *
 *     x = pose.x + distance * cos(heading + angle)
 *     y = pose.y + distance * sin(heading + angle)
 *
 * Measured against real recordings, not derived - and its mirror image
 * (th -> -th, a -> -a, +180 degrees) looks nearly as tidy in a symmetric flat.
 * Do not "clean up" a sign here without running test/session.test.mjs.
 *
 * Returns a flat array [x0, y0, x1, y1, ...] - one allocation instead of one
 * object per point, of which a long run has some 80 000.
 */
export function worldPoints(scan, out, at = 0) {
  const pts = scan.pts || [];
  const target = out || new Float64Array(pts.length * 2);
  let n = at;

  for (let i = 0; i < pts.length; i++) {
    const radians = (scan.th + pts[i][0]) * DEG;
    target[n++] = scan.x + pts[i][1] / 1000.0 * Math.cos(radians);
    target[n++] = scan.y + pts[i][1] / 1000.0 * Math.sin(radians);
  }

  return target;
}

/** Every scan's points, end to end, as [x0, y0, x1, y1, ...]. */
export function allPoints(scans) {
  let total = 0;
  for (let i = 0; i < scans.length; i++) {
    total += (scans[i].pts || []).length;
  }

  const points = new Float64Array(total * 2);
  let at = 0;
  for (let i = 0; i < scans.length; i++) {
    worldPoints(scans[i], points, at);
    at += (scans[i].pts || []).length * 2;
  }

  return points;
}

/**
 * Hits and misses per grid cell, from the endpoints and the rays to them.
 *
 * Drawing the endpoints alone throws away most of what a lidar says: a beam
 * that stops at 3 m has also established that everything on the way there was
 * empty. Every cell a beam crosses counts as a pass, the cell it ends in as a
 * hit; behind the endpoint nothing is claimed.
 *
 * The grid is bounded by the flat, not by the number of points, so it is kept
 * in two flat arrays rather than a map: 13 x 10 m at 5 cm is some 52 000 cells
 * whether 14 000 or 400 000 points fall into it.
 *
 * Returns { x0, y0, width, height, cell, hits, misses } with x0/y0 the cell
 * index of the lower left corner and the arrays in row-major order.
 */
export function occupancy(scans, cell = 0.05, points = null) {
  const pts = points || allPoints(scans);

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < pts.length; i += 2) {
    if (pts[i] < minX) { minX = pts[i]; }
    if (pts[i] > maxX) { maxX = pts[i]; }
    if (pts[i + 1] < minY) { minY = pts[i + 1]; }
    if (pts[i + 1] > maxY) { maxY = pts[i + 1]; }
  }
  for (let i = 0; i < scans.length; i++) {
    if (scans[i].x < minX) { minX = scans[i].x; }
    if (scans[i].x > maxX) { maxX = scans[i].x; }
    if (scans[i].y < minY) { minY = scans[i].y; }
    if (scans[i].y > maxY) { maxY = scans[i].y; }
  }

  if (!isFinite(minX)) {
    return { x0: 0, y0: 0, width: 0, height: 0, cell, hits: new Int32Array(0), misses: new Int32Array(0) };
  }

  const x0 = Math.floor(minX / cell);
  const y0 = Math.floor(minY / cell);
  const width = Math.floor(maxX / cell) - x0 + 1;
  const height = Math.floor(maxY / cell) - y0 + 1;

  const hits = new Int32Array(width * height);
  const misses = new Int32Array(width * height);

  let at = 0;
  for (let s = 0; s < scans.length; s++) {
    const scan = scans[s];
    const count = (scan.pts || []).length;
    const ox = Math.floor(scan.x / cell) - x0;
    const oy = Math.floor(scan.y / cell) - y0;

    for (let p = 0; p < count; p++) {
      const tx = Math.floor(pts[at] / cell) - x0;
      const ty = Math.floor(pts[at + 1] / cell) - y0;
      at += 2;

      // Bresenham from the sensor to the endpoint. The endpoint itself is the
      // hit, every other cell on the way a pass.
      let ix = ox;
      let iy = oy;
      const dx = Math.abs(tx - ix);
      const dy = -Math.abs(ty - iy);
      const sx = ix < tx ? 1 : -1;
      const sy = iy < ty ? 1 : -1;
      let err = dx + dy;

      for (;;) {
        if (ix !== tx || iy !== ty) {
          misses[iy * width + ix]++;
        } else {
          break;
        }
        const doubled = 2 * err;
        if (doubled >= dy) { err += dy; ix += sx; }
        if (doubled <= dx) { err += dx; iy += sy; }
      }

      hits[ty * width + tx]++;
    }
  }

  return { x0, y0, width, height, cell, hits, misses };
}

/**
 * Cells the evidence calls a wall, and the ones it calls free.
 *
 * A cell hit in a quarter of its observations is a wall, below that free.
 * Fewer than two observations decide nothing and stay unknown.
 *
 * Both sets come back as row runs [firstX, y, length] in grid coordinates:
 * neighbouring cells in a row are one rectangle, because an SVG with 50 000
 * single squares is a slow page for no gain.
 */
export function classify(grid, threshold = 0.25, seen = 2) {
  const walls = [];
  const free = [];
  const { width, height, hits, misses } = grid;

  for (let iy = 0; iy < height; iy++) {
    const row = iy * width;
    let wallStart = -1;
    let freeStart = -1;

    for (let ix = 0; ix <= width; ix++) {
      let isWall = false;
      let isFree = false;

      if (ix < width) {
        const hit = hits[row + ix];
        const total = hit + misses[row + ix];
        if (total >= seen) {
          isWall = hit / total >= threshold;
          isFree = !isWall;
        }
      }

      if (isWall) {
        if (wallStart < 0) { wallStart = ix; }
      } else if (wallStart >= 0) {
        walls.push([wallStart, iy, ix - wallStart]);
        wallStart = -1;
      }

      if (isFree) {
        if (freeStart < 0) { freeStart = ix; }
      } else if (freeStart >= 0) {
        free.push([freeStart, iy, ix - freeStart]);
        freeStart = -1;
      }
    }
  }

  return { walls, free };
}

/** How many cells the runs of classify() cover - one number per kind. */
export function countCells(runs) {
  let total = 0;
  for (let i = 0; i < runs.length; i++) {
    total += runs[i][2];
  }
  return total;
}

/**
 * What the run looks like from the outside: distance, duration and extent.
 *
 * A finished session says so itself in its summary line; while it is still
 * running the same numbers come from the poses, which is also the fallback for
 * a file that was cut short.
 */
export function stats(session) {
  const { poses, scans, summary } = session;
  let distance = 0;

  for (let i = 1; i < poses.length; i++) {
    const dx = poses[i].x - poses[i - 1].x;
    const dy = poses[i].y - poses[i - 1].y;
    distance += Math.sqrt(dx * dx + dy * dy);
  }

  const seconds = poses.length > 1
    ? Math.max(0, poses[poses.length - 1].t - poses[0].t)
    : 0;

  return {
    running: !summary,
    points: summary && summary.points !== undefined ? summary.points : poses.length,
    scans: summary && summary.scans !== undefined ? summary.scans : scans.length,
    // The summary counts the whole run; the poses only what is in the file,
    // which for a thinned or truncated one is less.
    distance: summary && summary.distance !== undefined ? summary.distance : distance,
    seconds: summary && summary.seconds !== undefined ? summary.seconds : seconds,
    poses: poses.length,
  };
}

/**
 * The name of a session file, taken apart: device and start time.
 *
 * '<device>-<YYYY-MM-DD_hh-mm-ss>.jsonl' is what the module writes. Anything
 * else comes back with a date of null, which is not an error - the file is
 * still readable, it just cannot be labelled.
 */
export function parseFileName(name) {
  const base = String(name || '').split('/').pop();
  const match = base.match(/^(.*)-(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})\.jsonl$/);

  if (!match) {
    return { name: base, device: '', date: null };
  }

  return {
    name: base,
    device: match[1],
    date: new Date(Number(match[2]), Number(match[3]) - 1, Number(match[4]),
      Number(match[5]), Number(match[6]), Number(match[7])),
  };
}

/*
* Checks a floor plan file - shape first, then whether it says the same thing
* as this repository's own.
*
*     node tools/check-plan.mjs plan.json
*     node tools/check-plan.mjs plan.json --against test/fixtures/plan/plan.json
*     node tools/check-plan.mjs plan.json --runs /opt/fhem/www/neato
*
* This exists so that a second implementation - in Perl inside the module, in
* Python next to track_map.py, anywhere - can answer "does mine agree?" with a
* command instead of an opinion.
*
* What it does NOT demand is equality to the last cell. Laying runs on top of
* each other is a hill climb, and a hill climb in another language finds a
* slightly different hilltop: half a cell here, a tenth of a degree there. So
* the test is agreement within one cell, in both directions, plus agreement
* about which cells are settled and which are disputed. Everything it measures
* is printed, so a near miss can be read rather than guessed at.
*
* Exit code 0 means it passed, 1 means it did not, 2 means it could not tell.
*
* Under MIT License (http://www.opensource.org/licenses/mit-license.php)
*/

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { parseSession } from '../www/ftui/components/neato/neato-track.js';
import { survey, mergePlan, frameOf, registerTo } from '../www/ftui/components/neato/neato-plan.js';

const LIMITS = {
  // Share of the other plan's cells that have to be found within one cell,
  // and the other way round.
  found: 0.95,
  // Share of cells the two plans have to classify the same way - settled
  // wall, or disputed.
  agree: 0.95,
  // How far the sheer number of cells may differ. Without this, dropping a
  // third of the walls passes: every missing cell has a neighbour that is
  // still there, and one cell of slack then covers for it.
  size: 0.15,
};

const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf('--' + name);
  return at >= 0 ? args[at + 1] : null;
};
const path = args.find((value, i) => !value.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));

if (!path) {
  process.stderr.write('node tools/check-plan.mjs <plan.json> [--against <plan.json>] [--runs <verzeichnis>]\n');
  process.exit(2);
}

// Piping into head closes the pipe under us; that is the reader's business,
// not an error worth a stack trace.
process.stdout.on('error', () => {});

const problems = [];
const notes = [];

/** Everything the format asks for. A plan that fails here is not readable. */
function inspect(raw, what) {
  const say = (line) => problems.push(`${what}: ${line}`);

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    say('is not an object');
    return null;
  }
  if (!(Number(raw.cell) > 0)) {
    say(`cell is ${JSON.stringify(raw.cell)}, expected a size in metres`);
    return null;
  }
  if (!Array.isArray(raw.cells)) {
    say('cells is not an array');
    return null;
  }

  const runs = Number(raw.runs);
  if (!Number.isInteger(runs) || runs < 1) {
    say(`runs is ${JSON.stringify(raw.runs)}, expected how many recordings went in`);
  }
  if (Math.abs(Number(raw.cell) - 0.10) > 1e-9) {
    notes.push(`${what}: cell is ${raw.cell} m, not the usual 0.10 - the other side has to match`);
  }

  const seen = new Set();
  const cells = [];
  let complaints = 0;

  for (const [at, entry] of raw.cells.entries()) {
    const blame = (line) => {
      if (complaints++ < 5) {
        say(`cell ${at} ${line}`);
      }
    };

    if (!Array.isArray(entry) || entry.length < 3) {
      blame('is not [ix, iy, walls, seen]');
      continue;
    }
    const [ix, iy, walls] = entry;
    const looked = entry.length > 3 ? entry[3] : walls;

    if (!Number.isInteger(ix) || !Number.isInteger(iy)) {
      blame(`has non-integer indices ${ix}, ${iy} - these are cells, not metres`);
      continue;
    }
    if (!Number.isInteger(walls) || walls < 1) {
      blame(`has walls = ${walls}; a cell nobody calls a wall does not belong in the plan`);
      continue;
    }
    if (!Number.isInteger(looked) || looked < walls) {
      blame(`has seen = ${looked} against walls = ${walls} - more runs called it a wall than looked at it`);
      continue;
    }
    if (Number.isInteger(runs) && looked > runs) {
      blame(`has seen = ${looked}, but the plan says it is made of ${runs} runs`);
      continue;
    }

    const key = `${ix},${iy}`;
    if (seen.has(key)) {
      blame(`repeats ${key}`);
      continue;
    }
    seen.add(key);
    cells.push({ ix, iy, walls, seen: looked });
  }

  if (complaints > 5) {
    say(`and ${complaints - 5} more like that`);
  }
  if (!cells.length) {
    say('has no usable cells');
    return null;
  }

  // Optional, and only as good as whoever wrote it - so it is read leniently
  // and never used to reject a file.
  const scores = (Array.isArray(raw.scores) ? raw.scores : [])
    .filter(entry => entry && Number.isFinite(Number(entry.score)))
    .map(entry => ({
      file: String(entry.file || '?'),
      score: Number(entry.score),
      used: entry.used !== false,
    }));

  return { cell: Number(raw.cell), runs, cells, scores };
}

const mine = inspect(JSON.parse(readFileSync(path, 'utf8')), path);

/** The plan this repository makes of a folder of recordings. */
function build(dir) {
  const names = readdirSync(dir).filter(name => name.endsWith('.jsonl')).sort().reverse();
  if (!names.length) {
    process.stderr.write(`Keine Aufzeichnungen in ${dir}.\n`);
    process.exit(2);
  }
  const surveys = names
    .map(name => parseSession(readFileSync(join(dir, name), 'utf8')))
    .filter(session => session.scans.length)
    .map(session => survey(session));
  const plan = mergePlan(surveys);
  return {
    cell: plan.cell,
    runs: plan.runs,
    scores: [],
    cells: plan.cells.map(spot => ({
      ix: Math.round(spot.x / plan.cell),
      iy: Math.round(spot.y / plan.cell),
      walls: spot.walls,
      seen: spot.seen,
    })),
  };
}

let theirs = null;
if (flag('against')) {
  theirs = inspect(JSON.parse(readFileSync(flag('against'), 'utf8')), flag('against'));
} else if (flag('runs')) {
  theirs = build(flag('runs'));
}

for (const line of problems) {
  process.stdout.write(`FEHLER  ${line}\n`);
}
for (const line of notes) {
  process.stdout.write(`Hinweis ${line}\n`);
}

if (!mine) {
  process.stdout.write('\nDie Datei ist nicht lesbar.\n');
  process.exit(1);
}

process.stdout.write(`\n${path}: ${mine.cells.length} Zellen, ${mine.runs} Laeufe,`
  + ` Zelle ${mine.cell} m, ${(mine.cells.length * mine.cell * mine.cell).toFixed(1)} m2 Wand\n`);

// The optional scores: the evidence for where the threshold belongs. Printed
// rather than judged - two data points pointing opposite ways are not a rule.
if (mine.scores.length) {
  process.stdout.write('\nGuete je Lauf:\n');
  for (const entry of mine.scores) {
    process.stdout.write(`  ${entry.score.toFixed(2)}  ${entry.used ? 'dabei   ' : 'abgelehnt'}`
      + `  ${entry.file}\n`);
  }
  const lowest = mine.scores.filter(entry => entry.used).map(entry => entry.score);
  const highest = mine.scores.filter(entry => !entry.used).map(entry => entry.score);
  if (lowest.length && highest.length) {
    process.stdout.write(`  schlechtester dabei ${Math.min(...lowest).toFixed(2)},`
      + ` bester abgelehnt ${Math.max(...highest).toFixed(2)}`
      + `${Math.max(...highest) > Math.min(...lowest) ? ' - die Schwelle trennt nicht' : ''}\n`);
  }
}

if (!theirs) {
  process.stdout.write(problems.length ? '\nForm fehlerhaft.\n' : '\nForm in Ordnung. Zum Vergleichen --against oder --runs angeben.\n');
  process.exit(problems.length ? 1 : 0);
}

// ---------------------------------------------------------------- comparison

const key = (ix, iy) => `${ix},${iy}`;
const index = (plan) => {
  const map = new Map();
  for (const cell of plan.cells) {
    map.set(key(cell.ix, cell.iy), cell);
  }
  return map;
};

/** How much of `wanted` turns up in `have`, allowing one cell of slack. */
function overlap(wanted, have) {
  const lookup = index(have);
  let exact = 0;
  let near = 0;
  let sameKind = 0;

  const settled = (cell) => cell.seen > 1 && cell.walls / cell.seen >= 0.5;

  for (const cell of wanted.cells) {
    const straight = lookup.get(key(cell.ix, cell.iy));
    if (straight) {
      exact++;
    }
    let match = straight || null;
    for (let dx = -1; dx <= 1 && !match; dx++) {
      for (let dy = -1; dy <= 1 && !match; dy++) {
        match = lookup.get(key(cell.ix + dx, cell.iy + dy)) || null;
      }
    }
    if (match) {
      near++;
      if (settled(match) === settled(cell)) {
        sameKind++;
      }
    }
  }

  return {
    exact: exact / wanted.cells.length,
    near: near / wanted.cells.length,
    kind: near ? sameKind / near : 0,
  };
}

let against = theirs;
let shifted = '';

// If the two plans disagree wildly, it may be that the port chose another run
// as its frame - then everything is right but expressed in another coordinate
// system. That is worth saying, rather than just failing.
if (overlap(theirs, mine).near < 0.5) {
  const asPoints = (plan) => {
    const out = new Float64Array(plan.cells.length * 2);
    plan.cells.forEach((cell, i) => {
      out[2 * i] = cell.ix * plan.cell;
      out[2 * i + 1] = cell.iy * plan.cell;
    });
    return out;
  };
  const fit = registerTo(frameOf(asPoints(mine), { cell: mine.cell }),
    { walls: asPoints(theirs), direction: 0 }, null, { cell: mine.cell });

  if (fit.score > 0.5) {
    const cos = Math.cos(fit.angle);
    const sin = Math.sin(fit.angle);
    against = {
      ...theirs,
      cells: theirs.cells.map(cell => {
        const x = cell.ix * theirs.cell;
        const y = cell.iy * theirs.cell;
        return {
          ...cell,
          ix: Math.round((cos * x - sin * y + fit.x) / mine.cell),
          iy: Math.round((sin * x + cos * y + fit.y) / mine.cell),
        };
      }),
    };
    shifted = `\nHinweis: gedreht um ${(fit.angle * 180 / Math.PI).toFixed(1)} Grad und `
      + `verschoben um ${fit.x.toFixed(2)}/${fit.y.toFixed(2)} m passen die beiden `
      + 'aufeinander, und so wird unten verglichen. Das ist kein Fehler: ein Grundriss hat'
      + ' keinen absoluten Nullpunkt, er ist nur relativ zu sich selbst. Meist heisst es,'
      + ' dass ein anderer Lauf als Rahmen gewaehlt wurde.\n';
  }
}

const found = overlap(against, mine);        // theirs, looked up in mine
const back = overlap(mine, against);         // mine, looked up in theirs

process.stdout.write(shifted);
process.stdout.write(`Vergleich mit ${flag('against') || flag('runs')}: ${against.cells.length} Zellen\n\n`);
process.stdout.write('                                     genau    +/-1 Zelle\n');
process.stdout.write(`  von der Referenz wiedergefunden  ${`${(100 * found.exact).toFixed(1)} %`.padStart(8)}`
  + `${`${(100 * found.near).toFixed(1)} %`.padStart(14)}\n`);
process.stdout.write(`  umgekehrt, keine erfunden        ${`${(100 * back.exact).toFixed(1)} %`.padStart(8)}`
  + `${`${(100 * back.near).toFixed(1)} %`.padStart(14)}\n`);
process.stdout.write(`  gleich eingeordnet (sicher/strittig)        ${(100 * found.kind).toFixed(1)} %\n`);

const ratio = mine.cells.length / against.cells.length;
process.stdout.write(`  Zellen gegenueber der Referenz             ${(100 * ratio).toFixed(1)} %\n`);

const failed = [];
if (Math.abs(ratio - 1) > LIMITS.size) {
  failed.push(`${mine.cells.length} Zellen gegen ${against.cells.length} in der Referenz`
    + ` - das sind ${(100 * ratio).toFixed(0)} %, erlaubt sind ${100 * (1 - LIMITS.size)}`
    + ` bis ${100 * (1 + LIMITS.size)} %`);
}
if (found.near < LIMITS.found) {
  failed.push(`nur ${(100 * found.near).toFixed(1)} % der Referenzzellen wiedergefunden, verlangt ${100 * LIMITS.found} %`);
}
if (back.near < LIMITS.found) {
  failed.push(`${(100 * (1 - back.near)).toFixed(1)} % der eigenen Zellen kennt die Referenz nicht, erlaubt ${(100 * (1 - LIMITS.found)).toFixed(0)} %`);
}
if (found.kind < LIMITS.agree) {
  failed.push(`nur ${(100 * found.kind).toFixed(1)} % gleich eingeordnet, verlangt ${100 * LIMITS.agree} %`);
}

if (failed.length || problems.length) {
  process.stdout.write('\n');
  for (const line of failed) {
    process.stdout.write(`FEHLER  ${line}\n`);
  }
  process.stdout.write('\nDie beiden Plaene sagen nicht dasselbe.\n');
  process.exit(1);
}

process.stdout.write('\nStimmt ueberein.\n');

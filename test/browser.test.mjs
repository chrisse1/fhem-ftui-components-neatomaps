/*
* The component in a real FTUI page, in a real browser.
*
*     npm run test:browser          (or: node --test test/browser.test.mjs)
*
* Needs two things that are not part of this repository:
*
*   - a checkout of knowthelist/ftui, in ./.ftui or wherever FTUI_DIR points
*     (test/get-ftui.sh fetches one)
*   - Playwright with a Chromium
*
* Without them the tests skip rather than fail: the map maths in
* test/session.test.mjs is what CI can check anywhere.
*/

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startFakeFhem } from './harness/fake-fhem.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoDir = join(here, '..');
const ftuiDir = process.env.FTUI_DIR || join(repoDir, '.ftui');
const shotDir = process.env.SHOT_DIR || '';

const SESSIONS = {
  // Newest first, as the names sort. The newest one has no summary line: that
  // is what a run still in progress looks like.
  'Staubsauger-2026-09-20_11-59-11.jsonl': { summary: null },
  'Staubsauger-2026-09-19_09-30-00.jsonl': {
    summary: { points: 549, scans: 50, distance: 137.8, rotation: 20500, seconds: 1500 },
  },
  'Staubsauger-2026-09-18_14-05-00.jsonl': {
    summary: { points: 210, scans: 4, distance: 42.5, rotation: 8100, seconds: 640 },
    scans: 4,
  },
};

let chromium = null;
try {
  ({ chromium } = await import('playwright'));
} catch (err) {
  try {
    ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs'));
  } catch (also) {
    chromium = null;
  }
}

const missing = [];
if (!chromium) { missing.push('playwright'); }
if (!existsSync(join(ftuiDir, 'www/ftui/ftui.js'))) { missing.push(`FTUI in ${ftuiDir} (run test/get-ftui.sh)`); }

/** Three recordings out of the one reference, so there is something to page. */
async function makeData() {
  const dir = await mkdtemp(join(tmpdir(), 'neato-maps-'));
  const reference = await readFile(join(here, 'fixtures/reference-track-botvac-d6.jsonl'), 'utf8');
  const lines = reference.split('\n').filter(line => line.trim() && !line.startsWith('#'));

  for (const [name, recipe] of Object.entries(SESSIONS)) {
    let body = lines;
    if (recipe.scans) {
      let scans = 0;
      body = lines.filter(line => !line.includes('"scan"') || ++scans <= recipe.scans);
    }
    const out = body.slice();
    if (recipe.summary) {
      out.push(JSON.stringify({ summary: recipe.summary }));
    }
    await writeFile(join(dir, name), out.join('\n') + '\n');
  }

  // And, under another device name so it stays out of the Staubsauger list,
  // the made-up room with a dense track: the only one of these that can say
  // anything about which floor the brush went over.
  await writeFile(join(dir, 'Testraum-2026-01-02_09-00-00.jsonl'),
    await readFile(join(here, 'fixtures/room-run.jsonl'), 'utf8'));

  // The finished floor plan, written by the tool that would write it on a
  // real installation - not by a copy of its logic living in this test.
  execFileSync(process.execPath, [join(repoDir, 'tools/make-plan.mjs'), dir, 'Staubsauger'],
    { stdio: 'pipe' });

  return dir;
}

async function open(options = {}) {
  const dataDir = await makeData();
  const fhem = await startFakeFhem({
    ftuiDir,
    repoDir,
    dataDir,
    pageDir: join(here, 'harness'),
    readings: {
      state: options.state || 'docked',
      trackFile: options.trackFile !== undefined
        ? options.trackFile
        : './www/neato/Staubsauger-2026-09-20_11-59-11.jsonl',
      // As the module publishes it: a path, not a bare name.
      planFile: options.planFile !== undefined
        ? options.planFile
        : './www/neato/plan-Staubsauger.json',
    },
    refusePerl: options.refusePerl,
  });

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: options.viewport || { width: 1100, height: 900 } });
  const problems = [];
  page.on('pageerror', error => problems.push(String(error)));
  page.on('console', message => {
    // FTUI looks for an optional config.local.js on every page; a real
    // installation answers that with a 404 as well.
    const from = message.location().url || '';
    if (message.type() === 'error' && !from.includes('config.local.js')) {
      problems.push(`${message.text()} (${from})`);
    }
  });

  await page.goto(`${fhem.url}/fhem/ftui/page/page.html`);
  await settled(page);

  return {
    page,
    fhem,
    problems,
    shot: async (name) => {
      if (shotDir) {
        await page.screenshot({ path: join(shotDir, name) });
      }
    },
    close: async () => {
      await browser.close();
      await fhem.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

/**
 * Waits until every map on the page has something to show - a drawing or a
 * message. The chevrons of the buttons are SVGs too, hence '.stage svg'.
 */
function settled(page) {
  return page.waitForFunction(() => {
    const maps = [...document.querySelectorAll('ftui-neato-map')];
    return maps.length > 0 && maps.every(map => {
      const root = map.shadowRoot;
      if (!root) { return false; }
      const note = root.querySelector('.note').textContent;
      return !!root.querySelector('.stage svg') || (note.length > 0 && !note.includes('…'));
    });
  }, null, { timeout: 15000 });
}

/** What a map shows, read out of its shadow root. */
function probe(page, id) {
  return page.evaluate((elementId) => {
    const element = document.querySelector('#' + elementId);
    const root = element.shadowRoot;
    const svg = root.querySelector('.stage svg');
    const box = element.getBoundingClientRect();
    const parent = element.closest('ftui-grid-tile')
      || element.closest('ftui-popup')?.shadowRoot.querySelector('.window');
    const tile = parent.getBoundingClientRect();
    const svgBox = svg ? svg.getBoundingClientRect() : null;
    return {
      index: element.index,
      sessions: element.sessions.length,
      title: root.querySelector('.title').textContent,
      sub: root.querySelector('.sub').textContent,
      live: !!root.querySelector('.live'),
      note: root.querySelector('.note').textContent,
      walls: svg ? svg.querySelectorAll('g.wall rect').length : 0,
      wallLines: svg ? svg.querySelectorAll('g.walls line').length : 0,
      dots: svg ? svg.querySelectorAll('g.dots rect').length : 0,
      planSure: svg ? svg.querySelectorAll('g.plan-sure rect').length : 0,
      planAlone: svg ? svg.querySelectorAll('g.plan-alone rect').length : 0,
      planQuarrel: svg ? svg.querySelectorAll('g.plan-quarrel rect').length : 0,
      free: svg ? svg.querySelectorAll('g.free rect').length : 0,
      points: svg ? svg.querySelectorAll('g.points rect').length : 0,
      missed: svg ? svg.querySelectorAll('g.missed rect').length : 0,
      hatch: svg ? svg.querySelectorAll('pattern#neato-missed line').length : 0,
      stuck: svg ? svg.querySelectorAll('circle.stuck').length : 0,
      track: svg ? svg.querySelectorAll('polyline.track').length : 0,
      viewBox: svg ? svg.getAttribute('viewBox') : '',
      newerDisabled: root.querySelector('.newer').disabled,
      olderDisabled: root.querySelector('.older').disabled,
      // Which arrow sits where, in page coordinates.
      olderLeft: root.querySelector('.older').getBoundingClientRect().left,
      newerLeft: root.querySelector('.newer').getBoundingClientRect().left,
      box: { width: box.width, height: box.height, top: box.top, left: box.left },
      tile: { width: tile.width, height: tile.height, top: tile.top, left: tile.left, bottom: tile.bottom },
      svgBox: svgBox ? { width: svgBox.width, height: svgBox.height } : null,
      headerHeight: parent.querySelector('ftui-grid-header, header, ftui-popup-header')
        ? parent.querySelector('ftui-grid-header, header, ftui-popup-header').getBoundingClientRect().height
        : (element.closest('ftui-popup')?.querySelector('ftui-popup-header')?.getBoundingClientRect().height || 0),
      headerTop: (parent.querySelector('ftui-grid-header, header')
        || element.closest('ftui-popup')?.querySelector('ftui-popup-header'))?.getBoundingClientRect().top ?? 0,
      parentTop: tile.top,
      parentBottom: tile.bottom,
      bottom: box.bottom,
      fontSize: parseFloat(getComputedStyle(element).fontSize),
      arrowBox: root.querySelector('.newer').getBoundingClientRect().width,
      // The chevron inside the button, which must stay inside it.
      arrowIcon: (() => {
        const icon = root.querySelector('.newer svg').getBoundingClientRect();
        const button = root.querySelector('.newer').getBoundingClientRect();
        return {
          width: icon.width,
          height: icon.height,
          inside: icon.left >= button.left - 1 && icon.right <= button.right + 1
            && icon.top >= button.top - 1 && icon.bottom <= button.bottom + 1,
        };
      })(),
      subSize: parseFloat(getComputedStyle(root.querySelector('.sub')).fontSize),
    };
  }, id);
}

test('the map fills its grid tile and draws the run', { skip: missing.join(', ') || false }, async () => {
  const context = await open();

  try {
    const listed = await probe(context.page, 'map-listed');

    // The tile keeps its header; the map has the rest of it.
    assert.ok(listed.box.width > listed.tile.width - 8, `${listed.box.width} vs tile ${listed.tile.width}`);
    assert.ok(listed.box.height > listed.tile.height - listed.headerHeight - 8,
      `${listed.box.height} of a tile of ${listed.tile.height} minus a header of ${listed.headerHeight}`);
    assert.ok(listed.box.height + listed.headerHeight <= listed.tile.height + 1,
      'the map pushes the header out of the tile');
    assert.ok(listed.box.left >= listed.tile.left - 1);
    assert.ok(listed.box.top >= listed.tile.top - 1);

    // The drawing fills the width of the component and stays inside it.
    assert.ok(listed.svgBox.width > listed.box.width - 2);
    assert.ok(listed.svgBox.height <= listed.box.height + 1);

    // One square per measured cell, which is what the default does.
    assert.ok(listed.dots > 100, `dots: ${listed.dots}`);
    assert.equal(listed.wallLines, 0, 'lines were drawn although dots are the default');
    assert.equal(listed.walls, 0, 'filled cells were drawn although dots are the default');
    assert.ok(listed.free > 50, `free rectangles: ${listed.free}`);
    assert.equal(listed.track, 1);
    assert.equal(listed.note, '');

    // The arrow is an icon in its button, not a shape across the map.
    assert.ok(listed.arrowIcon.inside, 'the chevron sticks out of its button');
    assert.ok(listed.arrowIcon.width < listed.arrowBox,
      `chevron ${listed.arrowIcon.width} in a button of ${listed.arrowBox}`);
    assert.ok(listed.arrowIcon.width < listed.box.width / 4,
      `the chevron covers the map: ${listed.arrowIcon.width} of ${listed.box.width}`);

    await context.shot('tile.png');
    assert.deepEqual(context.problems, []);
  } finally {
    await context.close();
  }
});

test('the tile size decides the map size', { skip: missing.join(', ') || false }, async () => {
  const context = await open();

  try {
    const before = await probe(context.page, 'map-listed');

    // A tile of another size, laid out by FTUI itself.
    await context.page.evaluate(() => {
      const tile = document.querySelector('#listed');
      tile.setAttribute('width', '2');
      tile.setAttribute('height', '5');
      document.querySelector('ftui-grid').configureGrid();
    });
    await context.page.waitForTimeout(300);
    const after = await probe(context.page, 'map-listed');

    assert.notEqual(before.tile.width, after.tile.width, 'the tile did not change');
    assert.ok(after.box.width > after.tile.width - 8, `${after.box.width} in a tile of ${after.tile.width}`);
    assert.ok(after.box.height > 0.7 * after.tile.height);
    assert.ok(after.svgBox.width > after.box.width - 2);
    assert.ok(after.svgBox.height <= after.box.height + 1);
    // Same map, same extent - only the box around it changed, and with
    // rotate="auto" possibly the quarter it is turned to, which swaps the two
    // sides of the view box.
    const sides = (viewBox) => viewBox.split(' ').slice(2).sort();
    assert.deepEqual(sides(after.viewBox), sides(before.viewBox));
    await context.shot('resized.png');
  } finally {
    await context.close();
  }
});

test('the map turns to fill the tile', { skip: missing.join(', ') || false }, async () => {
  const context = await open();

  try {
    const tall = await context.page.evaluate(() => {
      const tile = document.querySelector('#listed');
      tile.setAttribute('width', '2');
      tile.setAttribute('height', '6');
      document.querySelector('ftui-grid').configureGrid();
      return null;
    });
    await context.page.waitForTimeout(400);
    const upright = (await probe(context.page, 'map-listed')).viewBox.split(' ');

    await context.page.evaluate(() => {
      const tile = document.querySelector('#listed');
      tile.setAttribute('width', '8');
      tile.setAttribute('height', '2');
      document.querySelector('ftui-grid').configureGrid();
    });
    await context.page.waitForTimeout(500);
    const wide = (await probe(context.page, 'map-listed')).viewBox.split(' ');

    // The same map, the same two numbers - but the tall tile gets the upright
    // view box and the wide one the lying box.
    assert.deepEqual([...upright].sort(), [...wide].sort());
    assert.ok(Number(upright[3]) > Number(upright[2]), `upright: ${upright.join(' ')}`);
    assert.ok(Number(wide[2]) > Number(wide[3]), `wide: ${wide.join(' ')}`);
    assert.equal(tall, null);
  } finally {
    await context.close();
  }
});

test('a fixed rotation is obeyed', { skip: missing.join(', ') || false }, async () => {
  const context = await open();

  try {
    const boxes = await context.page.evaluate(async () => {
      const map = document.querySelector('#map-listed');
      const read = () => map.shadowRoot.querySelector('.stage svg').getAttribute('viewBox');
      map.setAttribute('rotate', '0');
      await new Promise(done => setTimeout(done, 300));
      const zero = read();
      map.setAttribute('rotate', '90');
      await new Promise(done => setTimeout(done, 300));
      const ninety = read();
      return { zero, ninety };
    });

    const zero = boxes.zero.split(' ');
    const ninety = boxes.ninety.split(' ');
    assert.deepEqual([zero[2], zero[3]], [ninety[3], ninety[2]],
      'a quarter turn has to swap the sides of the view box');
  } finally {
    await context.close();
  }
});

test('the floor he left out is hatched, and counted in the line', { skip: missing.join(', ') || false }, async () => {
  const context = await open();

  try {
    const room = await probe(context.page, 'map-room');

    assert.ok(room.missed > 0, 'nothing is marked as left out');
    assert.equal(room.hatch, 1, 'the hatching pattern is missing');
    assert.ok(/7[0-9] %/.test(room.sub), `the line says "${room.sub}", expected a coverage in the seventies`);

    // The thinned recordings cannot say anything about it, and say nothing:
    // a straight line between two poses twenty seconds apart is an invention.
    const thin = await probe(context.page, 'map-listed');
    assert.equal(thin.missed, 0);
    assert.ok(!thin.sub.includes('%'), `the line says "${thin.sub}"`);

    // And off is off.
    const off = await context.page.evaluate(async () => {
      const map = document.querySelector('#map-room');
      map.setAttribute('show-missed', 'false');
      await new Promise(done => setTimeout(done, 400));
      return {
        missed: map.shadowRoot.querySelectorAll('.stage svg g.missed rect').length,
        sub: map.shadowRoot.querySelector('.sub').textContent,
      };
    });
    assert.equal(off.missed, 0);
    assert.ok(!off.sub.includes('%'), off.sub);
  } finally {
    await context.close();
  }
});

test('where he stood still and did not go on is marked', { skip: missing.join(', ') || false }, async () => {
  const context = await open();

  try {
    const room = await probe(context.page, 'map-room');
    assert.equal(room.stuck, 1, 'the standstill at the end of the made-up run is not marked');

    // The other recordings end at the base, which is not a standstill worth
    // a ring - otherwise every finished run would wear one.
    for (const id of ['map-listed', 'map-celled', 'map-painted']) {
      assert.equal((await probe(context.page, id)).stuck, 0, `${id} has a ring it should not have`);
    }

    const off = await context.page.evaluate(async () => {
      const map = document.querySelector('#map-room');
      map.setAttribute('show-stuck', 'false');
      await new Promise(done => setTimeout(done, 400));
      const rings = map.shadowRoot.querySelectorAll('.stage svg circle.stuck').length;
      map.setAttribute('show-stuck', 'true');
      map.setAttribute('stuck-seconds', '300');
      await new Promise(done => setTimeout(done, 400));
      return { rings, tooShort: map.shadowRoot.querySelectorAll('.stage svg circle.stuck').length };
    });
    assert.equal(off.rings, 0, 'show-stuck="false" still draws a ring');
    assert.equal(off.tooShort, 0, 'a 40 s standstill counts against a 300 s limit');
  } finally {
    await context.close();
  }
});

test('the recordings can be paged through', { skip: missing.join(', ') || false }, async () => {
  const context = await open();
  const { page } = context;

  try {
    const click = async (which) => {
      await page.evaluate((selector) => document.querySelector('#map-listed')
        .shadowRoot.querySelector(selector).click(), which);
      await settled(page);
      await page.waitForTimeout(200);
      return probe(page, 'map-listed');
    };

    let map = await probe(page, 'map-listed');
    assert.equal(map.sessions, 3);
    assert.equal(map.index, 0);
    assert.ok(map.sub.includes('1/3'), map.sub);
    assert.equal(map.live, true, 'the newest recording has no summary: still running');

    // Time runs to the right: the newest run is on display, so the arrow to
    // the right has nowhere to go and the one to the left leads into the past.
    assert.ok(map.olderLeft < map.newerLeft, 'the arrows are the wrong way round');
    assert.equal(map.newerDisabled, true, 'there is nothing newer than the newest run');
    assert.equal(map.olderDisabled, false);

    const first = map.viewBox;
    map = await click('.older');
    assert.equal(map.index, 1);
    assert.ok(map.sub.includes('2/3'), map.sub);
    assert.ok(map.sub.includes('137,8') || map.sub.includes('137.8'), map.sub);
    assert.equal(map.live, false, 'a finished recording has its summary');
    assert.equal(map.newerDisabled, false);

    map = await click('.older');
    assert.equal(map.index, 2);
    assert.equal(map.olderDisabled, true, 'there is nothing older than the oldest run');
    assert.ok(map.sub.includes('42,5') || map.sub.includes('42.5'), map.sub);
    // Four scans instead of ten is a smaller map.
    assert.notEqual(map.viewBox, first);
    await context.shot('paged.png');

    map = await click('.newer');
    assert.equal(map.index, 1);

    // The arrow keys follow the arrows: right towards the newest run.
    await page.evaluate(() => document.querySelector('#map-listed')
      .shadowRoot.querySelector('.stage').focus());
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(400);
    assert.equal((await probe(page, 'map-listed')).index, 0, 'ArrowRight should show a newer run');

    await page.keyboard.press('ArrowLeft');
    await page.waitForTimeout(400);
    assert.equal((await probe(page, 'map-listed')).index, 1, 'ArrowLeft should show an older run');

    // And so does the swipe: dragging to the right pulls an older run in.
    const stage = await page.evaluateHandle(() => document.querySelector('#map-listed')
      .shadowRoot.querySelector('.stage'));
    const area = await stage.boundingBox();
    const swipe = async (from, to) => {
      await page.mouse.move(area.x + area.width * from, area.y + area.height / 2);
      await page.mouse.down();
      await page.mouse.move(area.x + area.width * to, area.y + area.height / 2, { steps: 8 });
      await page.mouse.up();
      await page.waitForTimeout(400);
      return (await probe(page, 'map-listed')).index;
    };

    assert.equal(await swipe(0.25, 0.75), 2, 'swiping right shows the older run');
    assert.equal(await swipe(0.75, 0.25), 1, 'swiping left shows the newer run');

    assert.deepEqual(context.problems, []);
  } finally {
    await context.close();
  }
});

test('the sessions of a device come from FHEM', { skip: missing.join(', ') || false }, async () => {
  const context = await open();

  try {
    const bound = await probe(context.page, 'map-bound');
    assert.equal(bound.sessions, 3);
    assert.ok(bound.wallLines > 5);

    const perl = context.fhem.state.commands.find(command => command.startsWith('{'));
    assert.ok(perl, 'no listing command was sent');
    assert.ok(!perl.includes(';'), 'a semicolon would cut the command in half: ' + perl);
    assert.ok(perl.includes('Staubsauger-*.jsonl'), perl);
    assert.ok(perl.includes('./www/neato/'), perl);

    // Three maps on the page, one question.
    const listings = context.fhem.state.commands.filter(command => command.startsWith('{'));
    assert.equal(listings.length, 1, 'the maps did not share the listing: ' + listings.length);

    // www/neato is served by FHEMWEB as <fhemweb>/neato - and that is where
    // the recording was read from, whatever directory the page lies in.
    assert.ok(context.fhem.state.requests.some(url => url.startsWith('/fhem/neato/Staubsauger-')),
      'the recording was not read from /fhem/neato/');

    // The folder follows track-dir, since that is the one FHEM writes to.
    const elsewhere = await context.page.evaluate(async () => {
      const map = document.querySelector('#map-bound');
      map.setAttribute('track-dir', './www/staubsauger');
      return map.url('a.jsonl', false);
    });
    assert.ok(elsewhere.endsWith('/fhem/staubsauger/a.jsonl'), elsewhere);
  } finally {
    await context.close();
  }
});

test('a refused Perl command still shows the running session', { skip: missing.join(', ') || false }, async () => {
  const context = await open({ refusePerl: true, state: 'cleaning' });

  try {
    await context.page.waitForFunction(() => !!document.querySelector('#map-bound')
      ?.shadowRoot?.querySelector('.stage svg'), null, { timeout: 15000 });
    const bound = await probe(context.page, 'map-bound');

    // Only the file the reading names, but a map all the same.
    assert.equal(bound.sessions, 1);
    assert.ok(bound.wallLines > 5);
    assert.equal(bound.note, '');
    // One recording: neither arrow leads anywhere.
    assert.equal(bound.olderDisabled, true);
    assert.equal(bound.newerDisabled, true);
  } finally {
    await context.close();
  }
});

test('a device without recordings says so instead of staying empty',
  { skip: missing.join(', ') || false }, async () => {
    const context = await open({ refusePerl: true, trackFile: '' });

    try {
      await context.page.waitForFunction(() => {
        const note = document.querySelector('#map-bound')?.shadowRoot?.querySelector('.note');
        return note && note.textContent.length > 0 && !note.textContent.includes('…');
      }, null, { timeout: 15000 });

      const bound = await probe(context.page, 'map-bound');
      assert.equal(bound.sessions, 0);
      assert.ok(bound.note.length > 0, 'no message');
      assert.equal(bound.walls, 0);
      assert.equal(bound.wallLines, 0);
      assert.equal(bound.dots, 0);
    } finally {
      await context.close();
    }
  });

test('in a popup the map fills the window and the sizes are settable',
  { skip: missing.join(', ') || false }, async () => {
    const context = await open();

    try {
      await context.page.evaluate(() => document.querySelector('#popup').open());
      await context.page.waitForTimeout(300);

      const popup = await probe(context.page, 'map-popup');
      const tile = await probe(context.page, 'map-listed');

      // The popup window is the box now - the map has it, minus the header,
      // and the header stays inside the window instead of being cut off.
      assert.ok(popup.box.width > popup.tile.width - 8,
        `${popup.box.width} in a popup of ${popup.tile.width}`);
      assert.ok(popup.box.height > popup.tile.height - popup.headerHeight - 8,
        `${popup.box.height} of a window of ${popup.tile.height}`);
      assert.ok(popup.headerTop >= popup.parentTop - 1,
        `the header at ${popup.headerTop} is above the window at ${popup.parentTop}`);
      assert.ok(popup.bottom <= popup.parentBottom + 1,
        `the map ends at ${popup.bottom}, the window at ${popup.parentBottom}`);
      assert.ok(popup.svgBox.width > popup.box.width - 2);
      assert.ok(popup.svgBox.height <= popup.box.height + 1);
      assert.ok(popup.dots > 100, `dots: ${popup.dots}`);

      // text-size="1.4" and arrow-size="3" against the defaults of the tile.
      assert.ok(popup.fontSize > tile.fontSize * 1.5,
        `text ${popup.fontSize} vs ${tile.fontSize}`);
      assert.ok(popup.subSize > tile.subSize, `line ${popup.subSize} vs ${tile.subSize}`);
      assert.ok(popup.arrowBox > tile.arrowBox * 1.5,
        `arrow ${popup.arrowBox} vs ${tile.arrowBox}`);
      // The arrow keeps its shape: the button is square, the chevron inside it.
      assert.ok(Math.abs(popup.arrowBox - 3 * popup.fontSize) < 1.5,
        `arrow ${popup.arrowBox} is not 3 em of ${popup.fontSize}`);
      assert.ok(popup.arrowIcon.inside, 'the chevron sticks out of its button');
      assert.ok(popup.arrowIcon.width < popup.arrowBox,
        `chevron ${popup.arrowIcon.width} in a button of ${popup.arrowBox}`);

      // Blättern geht im Popup wie in der Kachel.
      await context.page.evaluate(() => document.querySelector('#map-popup')
        .shadowRoot.querySelector('.older').click());
      await settled(context.page);
      assert.equal((await probe(context.page, 'map-popup')).index, 1);

      await context.shot('popup.png');
    } finally {
      await context.close();
    }
  });

test('the colours of the map can be set from the markup',
  { skip: missing.join(', ') || false }, async () => {
    const context = await open();

    try {
      const colours = await context.page.evaluate(async () => {
        const map = document.querySelector('#map-listed');
        const root = map.shadowRoot;
        const read = () => ({
          // Walls are dots by default, so their colour is a fill. The same
          // custom property feeds the stroke of walls="lines".
          wall: getComputedStyle(root.querySelector('g.dots rect')).fill,
          track: getComputedStyle(root.querySelector('polyline.track')).stroke,
          free: getComputedStyle(root.querySelector('g.free')).opacity,
          text: getComputedStyle(map).color,
        });

        const before = read();

        // A plain CSS colour, a name from FTUI's theme, and a number.
        map.setAttribute('wall-color', '#ff0000');
        // 'primary', because the track is 'warning' by default and a test
        // that passes either way is no test.
        map.setAttribute('track-color', 'primary');
        map.setAttribute('free-opacity', '0.5');
        map.setAttribute('text-color', 'rgb(1, 2, 3)');
        const set = read();

        map.setAttribute('wall-color', '');
        map.setAttribute('track-color', '');
        map.setAttribute('free-opacity', '');
        map.setAttribute('text-color', '');
        const cleared = read();

        return {
          before, set, cleared,
          themePrimary: getComputedStyle(document.body).getPropertyValue('--primary-color').trim(),
        };
      });

      assert.equal(colours.set.wall, 'rgb(255, 0, 0)');
      assert.equal(colours.set.free, '0.5');
      assert.equal(colours.set.text, 'rgb(1, 2, 3)');
      // 'primary' means what it means everywhere else in FTUI.
      assert.ok(colours.themePrimary.length > 0, 'the theme has no --primary-color');
      assert.notEqual(colours.set.track, colours.before.track);
      assert.equal(colours.set.track, await context.page.evaluate((value) => {
        const probeElement = document.createElement('span');
        probeElement.style.color = value;
        document.body.appendChild(probeElement);
        const resolved = getComputedStyle(probeElement).color;
        probeElement.remove();
        return resolved;
      }, colours.themePrimary));

      // Empty is back to the stylesheet's defaults.
      assert.deepEqual(colours.cleared, colours.before);
    } finally {
      await context.close();
    }
  });

test('a size can also be given in any CSS length',
  { skip: missing.join(', ') || false }, async () => {
    const context = await open();

    try {
      const sizes = await context.page.evaluate(async () => {
        const map = document.querySelector('#map-listed');
        const read = () => ({
          font: parseFloat(getComputedStyle(map).fontSize),
          arrow: map.shadowRoot.querySelector('.newer').getBoundingClientRect().width,
        });
        map.setAttribute('text-size', '22px');
        map.setAttribute('arrow-size', '44px');
        const explicit = read();
        map.setAttribute('text-size', '');
        map.setAttribute('arrow-size', '');
        return { explicit, cleared: read() };
      });

      assert.equal(sizes.explicit.font, 22);
      assert.ok(Math.abs(sizes.explicit.arrow - 44) < 0.5, String(sizes.explicit.arrow));
      // Empty hands it back to the stylesheet.
      assert.notEqual(sizes.cleared.font, 22);
      assert.ok(sizes.cleared.arrow < 44);
    } finally {
      await context.close();
    }
  });

test('walls="cells" draws the evidence itself',
  { skip: missing.join(', ') || false }, async () => {
    const context = await open();

    try {
      const celled = await probe(context.page, 'map-celled');
      // map-bound asks for lines; the default is dots.
      const lined = await probe(context.page, 'map-bound');

      assert.ok(celled.walls > 50, `wall rectangles: ${celled.walls}`);
      assert.equal(celled.wallLines, 0);
      assert.equal(celled.dots, 0);
      // The same recording, and the simplification is the simpler picture.
      assert.ok(lined.wallLines > 5 && lined.wallLines < 80,
        `${lined.wallLines} segments is not a simplification`);
      assert.ok(lined.wallLines < celled.walls / 3,
        `${lined.wallLines} segments against ${celled.walls} rectangles`);
      await context.shot('cells-vs-lines.png');
    } finally {
      await context.close();
    }
  });

test('walls="dots" draws one square per measured cell', { skip: missing.join(', ') || false }, async () => {
  const context = await open();

  try {
    const seen = await context.page.evaluate(async () => {
      const map = document.querySelector('#map-celled');
      const read = () => {
        const svg = map.shadowRoot.querySelector('.stage svg');
        const dot = svg.querySelector('g.dots rect');
        return {
          dots: svg.querySelectorAll('g.dots rect').length,
          cells: svg.querySelectorAll('g.wall rect').length,
          lines: svg.querySelectorAll('g.walls line').length,
          side: dot ? Number(dot.getAttribute('width')) : 0,
        };
      };

      map.setAttribute('walls', 'cells');
      await new Promise(done => setTimeout(done, 400));
      const cells = read();

      map.setAttribute('walls', 'dots');
      await new Promise(done => setTimeout(done, 400));
      const dots = read();

      map.setAttribute('dot-size', '0.4');
      await new Promise(done => setTimeout(done, 400));
      const small = read();

      return { cells, dots, small, cell: Number(map.cell) };
    });

    assert.ok(seen.cells.cells > 0 && seen.cells.dots === 0, 'walls="cells" drew dots');
    assert.ok(seen.dots.dots > 0, 'walls="dots" drew nothing');
    assert.equal(seen.dots.cells, 0, 'walls="dots" also drew the filled cells');
    assert.equal(seen.dots.lines, 0, 'walls="dots" also drew the lines');

    // One square per cell, not per run: dots cannot be fewer than the
    // rectangles the runs of the same cells make.
    assert.ok(seen.dots.dots >= seen.cells.cells,
      `${seen.dots.dots} dots against ${seen.cells.cells} runs`);

    // Smaller than its cell, so a gap stays between two neighbours - that gap
    // is what makes the wall read as measured instead of as a block.
    assert.ok(seen.dots.side > 0 && seen.dots.side < seen.cell,
      `a dot of ${seen.dots.side} m in a cell of ${seen.cell} m`);
    assert.ok(Math.abs(seen.small.side - seen.cell * 0.4) < 1e-6,
      `dot-size="0.4" gave ${seen.small.side} m`);
    assert.equal(seen.small.dots, seen.dots.dots, 'the size changed the count');
  } finally {
    await context.close();
  }
});

test('view="plan" shows what several runs agree on', { skip: missing.join(', ') || false }, async () => {
  const context = await open();

  try {
    const plan = await probe(context.page, 'map-plan');
    const single = await probe(context.page, 'map-listed');

    assert.equal(plan.note, '', `the plan says: ${plan.note}`);
    assert.ok(plan.planSure + plan.planAlone > 100,
      `${plan.planSure} agreed and ${plan.planAlone} lone cells`);
    assert.equal(plan.dots, 0, 'the plan drew a single run as well');
    assert.equal(plan.track, 0, 'a plan has no track - it is several runs');

    // It says what it is and what it is made of, and there is nothing to page
    // through: the plan is not one of the recordings.
    assert.equal(plan.title, 'Grundriss');
    assert.match(plan.sub, /Läufe|Lauf/);
    assert.equal(plan.olderDisabled, true);
    assert.equal(plan.newerDisabled, true);

    // The single run next to it is untouched by any of this.
    assert.ok(single.dots > 100);
    assert.equal(single.planSure, 0);
  } finally {
    await context.close();
  }
});

test('a prepared plan file draws the same picture as computing it',
  { skip: missing.join(', ') || false }, async () => {
    const context = await open();

    try {
      const computed = await probe(context.page, 'map-plan');
      const fromFile = await probe(context.page, 'map-planfile');

      // This is the seam: whoever computes the plan - this component, the
      // tool, or one day the module - the picture has to come out the same.
      assert.equal(fromFile.planSure, computed.planSure);
      assert.equal(fromFile.planAlone, computed.planAlone);
      assert.equal(fromFile.planQuarrel, computed.planQuarrel);
      assert.deepEqual(fromFile.viewBox.split(' ').slice(2).sort(),
        computed.viewBox.split(' ').slice(2).sort());
      assert.ok(computed.planSure > 0, 'nothing was drawn at all');

      // And the file really was the source - it does not fetch the runs.
      const asked = context.fhem.state.requests.filter(path => path.includes('plan-Staubsauger.json'));
      assert.ok(asked.length > 0, 'the plan file was never fetched');
    } finally {
      await context.close();
    }
  });

test('the disputed cells can be turned off', { skip: missing.join(', ') || false }, async () => {
  const context = await open();

  try {
    const seen = await context.page.evaluate(async () => {
      const map = document.querySelector('#map-plan');
      const count = () => ({
        quarrel: map.shadowRoot.querySelectorAll('.stage svg g.plan-quarrel rect').length,
        sure: map.shadowRoot.querySelectorAll('.stage svg g.plan-sure rect').length,
      });
      const before = count();
      map.setAttribute('show-disputed', 'false');
      await new Promise(done => setTimeout(done, 400));
      return { before, after: count() };
    });

    assert.equal(seen.after.quarrel, 0);
    assert.equal(seen.after.sure, seen.before.sure, 'turning them off changed the walls');
  } finally {
    await context.close();
  }
});

test('the plan file can come from a reading, path and all',
  { skip: missing.join(', ') || false }, async () => {
    const context = await open();

    try {
      // The bound tile has nothing to draw until the reading has arrived, so
      // it shows the "not computed yet" message first and the map after.
      await context.page.waitForFunction(() =>
        document.querySelector('#map-planbound').shadowRoot.querySelector('.stage svg'),
      null, { timeout: 15000 });

      const bound = await probe(context.page, 'map-planbound');
      const written = await probe(context.page, 'map-planfile');

      // The reading carries './www/neato/plan-Staubsauger.json'; only the last
      // part of that is a file the recordings' folder can be asked for.
      assert.equal(bound.note, '', `the bound plan says: ${bound.note}`);
      assert.equal(bound.planSure, written.planSure);
      assert.equal(bound.planAlone, written.planAlone);
      assert.equal(bound.planQuarrel, written.planQuarrel);

      const asked = context.fhem.state.requests.filter(path => path.includes('plan-Staubsauger'));
      assert.ok(asked.length > 0, 'the plan file was never fetched');
      assert.ok(asked.every(path => !path.includes('%2F')),
        `a path was escaped into the file name: ${asked.find(path => path.includes('%2F'))}`);

      // A bare name has to keep working - the attribute may be written by hand.
      const plain = await context.page.evaluate(async () => {
        const map = document.querySelector('#map-planbound');
        map.setAttribute('plan-file', 'plan-Staubsauger.json');
        await new Promise(done => setTimeout(done, 500));
        return {
          note: map.shadowRoot.querySelector('.note').textContent,
          sure: map.shadowRoot.querySelectorAll('.stage svg g.plan-sure rect').length,
        };
      });
      assert.equal(plain.note, '');
      assert.equal(plain.sure, written.planSure);
    } finally {
      await context.close();
    }
  });

test('a plan that has not been computed yet is a message, not a wreck',
  { skip: missing.join(', ') || false }, async () => {
    // Two states the module brings with it: the reading is still empty
    // because nobody has pressed buildPlan, and it names a file that is not
    // there yet because the run it belongs to is still going.
    const context = await open({ planFile: '' });

    try {
      const empty = await probe(context.page, 'map-planbound');
      assert.ok(empty.note.length > 0, 'an empty reading drew something');
      assert.equal(empty.planSure, 0);
      assert.equal(empty.dots, 0, 'it fell back to drawing a single run');

      // And it did not quietly load four recordings to work it out itself -
      // that is what binding the reading is for.
      const fetched = context.fhem.state.requests.filter(path => path.endsWith('.jsonl'));
      const mine = fetched.filter(path => path.includes('11-27-11'));
      assert.equal(mine.length, 0,
        'the bound plan computed itself from the recordings although the module owns it');

      const gone = await context.page.evaluate(async () => {
        const map = document.querySelector('#map-planbound');
        map.setAttribute('plan-file', './www/neato/plan-Gibtsnicht.json');
        await new Promise(done => setTimeout(done, 600));
        return {
          note: map.shadowRoot.querySelector('.note').textContent,
          svg: !!map.shadowRoot.querySelector('.stage svg'),
        };
      });
      assert.ok(gone.note.length > 0, 'a missing file drew a map out of nowhere');
      assert.equal(gone.svg, false);

      // Nothing threw. The browser logs the 404 this test asked for; what
      // must not be there is an exception.
      const unexpected = context.problems.filter(line => !line.includes('plan-Gibtsnicht.json'));
      assert.deepEqual(unexpected, []);
      assert.ok((await probe(context.page, 'map-listed')).dots > 100);
    } finally {
      await context.close();
    }
  });

test('a run that did not fit is said out loud, not just left out',
  { skip: missing.join(', ') || false }, async () => {
    const context = await open();

    try {
      // A plan whose file says one of four runs was dropped. The picture is
      // the same; what changes is that the line admits it.
      const seen = await context.page.evaluate(async () => {
        const map = document.querySelector('#map-planfile');
        const read = () => ({
          sub: map.shadowRoot.querySelector('.sub').textContent,
          title: map.shadowRoot.querySelector('.sub').title,
          sure: map.shadowRoot.querySelectorAll('.stage svg g.plan-sure rect').length,
        });

        map.setAttribute('show-info', 'true');
        await new Promise(done => setTimeout(done, 400));
        const before = read();

        const plan = await (await fetch('/fhem/neato/plan-Staubsauger.json')).json();
        plan.scores = [
          { file: 'a.jsonl', score: 1, used: true },
          { file: 'b.jsonl', score: 0.71, used: true },
          { file: 'c.jsonl', score: 0.64, used: true },
          { file: 'd.jsonl', score: 0.33, used: false },
        ];
        // Served back to the component through a URL of its own.
        const url = URL.createObjectURL(new Blob([JSON.stringify(plan)], { type: 'application/json' }));
        map.setAttribute('dir', url.slice(0, url.lastIndexOf('/') + 1));
        map.setAttribute('plan-file', url.slice(url.lastIndexOf('/') + 1));
        await new Promise(done => setTimeout(done, 600));
        return { before, after: read() };
      });

      assert.match(seen.before.sub, /3 Läufe|3 runs/);
      // The line says how large the flat is, not how much area the wall cells
      // cover - "30 m²" of ten centimetre squares reads as the size of the
      // flat and is nothing of the sort.
      assert.match(seen.before.sub, /\d+([.,]\d)? × \d+([.,]\d)? m/,
        `the line says "${seen.before.sub}", expected an extent in metres`);
      // The tooltip breaks the cells down the way the drawing colours them.
      assert.match(seen.before.title, /bestätigt|confirmed/);
      assert.match(seen.before.title, /einem Lauf|one run/);
      assert.ok(!seen.before.title.includes('Passte nicht'),
        'nothing was dropped, so nothing to say about it');

      assert.match(seen.after.sub, /3 von 4|3 of 4/);
      assert.match(seen.after.title, /Passte nicht|Did not fit/);
      assert.match(seen.after.title, /d\.jsonl \(0\.33\)/);
      assert.ok(!seen.after.title.includes('b.jsonl'), 'a run that did fit is in the tooltip');
      assert.equal(seen.after.sure, seen.before.sure, 'the picture changed as well');
    } finally {
      await context.close();
    }
  });

test('one tile can switch between the plan and the runs',
  { skip: missing.join(', ') || false }, async () => {
    const context = await open();

    try {
      const seen = await context.page.evaluate(async () => {
        const map = document.querySelector('#map-switch');
        const root = map.shadowRoot;
        const press = async () => {
          root.querySelector('.toggle').click();
          await new Promise(done => setTimeout(done, 500));
        };
        const read = () => ({
          view: map.view,
          title: root.querySelector('.title').textContent,
          plan: root.querySelectorAll('.stage svg g.plan-sure rect').length,
          run: root.querySelectorAll('.stage svg g.dots rect').length,
          track: root.querySelectorAll('.stage svg polyline.track').length,
          hint: root.querySelector('.toggle').title,
          older: root.querySelector('.older').disabled,
        });

        const events = [];
        map.addEventListener('viewChange', event => events.push(event.detail));

        const runs = read();
        await press();
        const plan = read();
        await press();
        const back = read();
        return { runs, plan, back, events };
      });

      // Runs first, because that is what view="" means.
      assert.equal(seen.runs.view, '');
      assert.ok(seen.runs.run > 100, `${seen.runs.run} cells of the run`);
      assert.equal(seen.runs.track, 1);
      assert.equal(seen.runs.plan, 0);

      assert.equal(seen.plan.view, 'plan');
      assert.equal(seen.plan.title, 'Grundriss');
      assert.ok(seen.plan.plan > 100, `${seen.plan.plan} cells of the plan`);
      assert.equal(seen.plan.run, 0);
      assert.equal(seen.plan.track, 0, 'a plan has no track');
      assert.equal(seen.plan.older, true, 'a plan has no pages to turn');

      // And back, to the same run it started on.
      assert.equal(seen.back.view, 'run');
      assert.equal(seen.back.run, seen.runs.run);
      assert.equal(seen.back.plan, 0);

      // The hint names where the press leads, not where it is.
      assert.notEqual(seen.runs.hint, seen.plan.hint);

      // And the change goes out, so an output binding can follow it.
      assert.deepEqual(seen.events, ['plan', 'run']);
    } finally {
      await context.close();
    }
  });

test('without show-toggle there is no switch', { skip: missing.join(', ') || false }, async () => {
  const context = await open();

  try {
    const hidden = await context.page.evaluate(() => {
      const maps = ['map-listed', 'map-plan', 'map-bound'];
      return maps.map(id => {
        const button = document.querySelector('#' + id).shadowRoot.querySelector('.toggle');
        return getComputedStyle(button).display;
      });
    });
    assert.deepEqual(hidden, ['none', 'none', 'none']);
  } finally {
    await context.close();
  }
});

test('the raw endpoints can be drawn instead of the grid',
  { skip: missing.join(', ') || false }, async () => {
    const context = await open();

    try {
      const points = await probe(context.page, 'map-points');
      assert.ok(points.points > 1000, `points drawn: ${points.points}`);
      assert.equal(points.walls, 0);
      assert.equal(points.wallLines, 0);
      assert.equal(points.dots, 0);
      assert.equal(points.free, 0);
      assert.equal(points.track, 1);
      // show-info="false" hides the line, the map keeps the whole tile.
      assert.ok(points.box.height > 0.8 * points.tile.height);
      await context.shot('points.png');
    } finally {
      await context.close();
    }
  });

test('the running session is re-read while the robot cleans',
  { skip: missing.join(', ') || false }, async () => {
    const context = await open({ state: 'cleaning' });

    try {
      await context.page.waitForFunction(() => !!document.querySelector('#map-bound')
        ?.shadowRoot?.querySelector('.stage svg'), null, { timeout: 15000 });

      // The interval is in seconds; a test does not wait half a minute for it.
      await context.page.evaluate(() => {
        document.querySelector('#map-bound').setAttribute('refresh-interval', '1');
      });
      const before = context.fhem.state.requests.filter(url => url.includes('nocache')).length;
      await context.page.waitForTimeout(2500);
      const after = context.fhem.state.requests.filter(url => url.includes('nocache')).length;

      assert.ok(after > before, `no reload: ${before} -> ${after}`);
      assert.ok((await probe(context.page, 'map-bound')).live, 'no sign that it is running');
    } finally {
      await context.close();
    }
  });

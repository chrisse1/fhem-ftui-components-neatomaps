/*
* The index FHEM's update mechanism reads.
*
* FHEM downloads every file listed in controls_neatomaps.txt and throws it
* away again if its size does not match the line to the byte - a stale index
* means a broken install, and nothing says so until someone tries. These tests
* are the warning: run tools/make_controls.sh when one of them fails.
*/

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, statSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = (name) => fileURLToPath(new URL(name, import.meta.url));
const root = here('../');

const text = readFileSync(here('../controls_neatomaps.txt'), 'utf8');
const lines = text.split('\n').filter(line => line.trim().length);

/** A line is '<CMD> <YYYY-MM-DD_hh:mm:ss> <bytes> <path>'. */
const entries = lines.map(line => {
  const [command, stamp, size, ...rest] = line.split(' ');
  return { command, stamp, size: Number(size), path: rest.join(' '), line };
});

test('every line has the shape FHEM parses', () => {
  assert.ok(entries.length > 0, 'the index is empty');

  for (const entry of entries) {
    assert.ok(['UPD', 'CRE'].includes(entry.command),
      `unknown command in: ${entry.line}`);
    assert.match(entry.stamp, /^\d{4}-\d{2}-\d{2}_\d{2}:\d{2}:\d{2}$/,
      `not a timestamp: ${entry.line}`);
    assert.ok(Number.isInteger(entry.size) && entry.size > 0,
      `not a size: ${entry.line}`);
    // Relative to the FHEM directory, and nothing that climbs out of it:
    // update refuses a line containing '..'.
    assert.ok(!entry.path.startsWith('/'), `absolute path: ${entry.line}`);
    assert.ok(!entry.path.includes('..'), `update would refuse: ${entry.line}`);
  }
});

test('the sizes are the sizes of the files', () => {
  for (const entry of entries) {
    const path = here('../' + entry.path);
    assert.ok(existsSync(path), `${entry.path} is listed but not in the repository`);
    assert.equal(statSync(path).size, entry.size,
      `${entry.path} is ${statSync(path).size} bytes, the index says ${entry.size}`
      + ' - run tools/make_controls.sh');
  }
});

test('the component is listed completely', () => {
  const listed = new Set(entries.map(entry => entry.path));
  const directory = 'www/ftui/components/neato';

  for (const name of readdirSync(here('../' + directory))) {
    const path = `${directory}/${name}`;
    assert.ok(listed.has(path), `${path} is in the repository but not in the index`
      + ' - run tools/make_controls.sh');
  }

  // Without the component's own file FTUI cannot load the tag at all.
  assert.ok(listed.has(`${directory}/neato-map.component.js`));
});

test('the paths are where an installation wants them', () => {
  // FHEM writes <modpath>/<path>, so the path in the index is at the same time
  // the place in the repository and the place in the installation. The
  // component has to land next to FTUI's own components.
  for (const entry of entries) {
    assert.ok(entry.path.startsWith('www/ftui/'),
      `${entry.path} would be written outside the FTUI directory`);
  }

  // The example page carries a device name that people edit - it is created
  // once and never overwritten.
  const example = entries.find(entry => entry.path.endsWith('examples/neato-map.html'));
  assert.ok(example, 'the example page is not in the index');
  assert.equal(example.command, 'CRE');
});

test('the CHANGED file is one FHEM can show', () => {
  // update fetches CHANGED from the same place as the index and prints every
  // line up to the first empty one. Without the file it prints whatever the
  // server answers a 404 with - which is how this test came about.
  const changed = readFileSync(here('../CHANGED'), 'utf8').split('\n');
  const body = changed.filter(line => !line.startsWith('#'));

  assert.ok(body[0].trim().length > 0, 'the newest block has to come first');
  const end = body.findIndex(line => line === '');
  assert.ok(end > 0, 'the newest block is not closed by an empty line');
  assert.ok(end <= 26, 'update cuts the block off after 25 lines');
});

test('the index sits where the raw URL of the files agrees with it', () => {
  // 'update add' takes the URL of this file, cuts off the name and fetches
  // every listed path against the rest. That only works while the index is in
  // the root of the repository, the paths being relative to it.
  assert.ok(existsSync(root + 'controls_neatomaps.txt'));
  assert.match('controls_neatomaps.txt', /^controls_.*\.txt$/,
    'update only accepts a file named controls_<something>.txt');
});

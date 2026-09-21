/*
* A FHEMWEB stand-in, just large enough for the component.
*
* It answers the three things <ftui-neato-map> asks a FHEM installation for:
*
*   GET /fhem?XHR=1                 the CSRF token FTUI fetches first
*   GET /fhem?cmd=jsonlist2 ...     the readings behind the bindings
*   GET /fhem?cmd={ ... jsonl ...}  the list of recorded sessions
*   GET /fhem/neato/<name>.jsonl    a recording, as FHEMWEB serves www/neato
*
* The FTUI framework itself is served from a checkout (FTUI_DIR), with this
* repository's components/neato/ laid over it - which is exactly how the
* component ends up on a real installation.
*/

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jsonl': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/**
 * @param {object} options
 * @param {string} options.ftuiDir   a checkout of knowthelist/ftui
 * @param {string} options.repoDir   this repository
 * @param {string} options.dataDir   the session files, as www/neato
 * @param {string} options.pageDir   where the test page lives
 * @param {object} options.readings  { state, trackFile } of the device
 * @param {boolean} options.refusePerl  answer the listing command with a refusal
 */
export async function startFakeFhem(options) {
  const state = {
    readings: Object.assign({ state: 'docked', trackFile: '', planFile: '' }, options.readings),
    refusePerl: Boolean(options.refusePerl),
    commands: [],
    requests: [],
  };

  const serveFile = async (response, path) => {
    try {
      const info = await stat(path);
      if (!info.isFile()) {
        throw new Error('not a file');
      }
      response.writeHead(200, {
        'Content-Type': TYPES[extname(path)] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      createReadStream(path).pipe(response);
    } catch (err) {
      response.writeHead(404, { 'Content-Type': 'text/plain' });
      response.end('not found: ' + path);
    }
  };

  const send = (response, body, type = 'text/plain; charset=utf-8') => {
    response.writeHead(200, { 'Content-Type': type, 'X-FHEM-csrfToken': 'csrf_fake' });
    response.end(body);
  };

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const path = normalize(decodeURIComponent(url.pathname));
    state.requests.push(request.url);

    // The command channel
    if (path === '/fhem' || path === '/fhem/') {
      const command = url.searchParams.get('cmd') || '';
      state.commands.push(command);

      if (!command) {
        return send(response, '');                       // CSRF handshake
      }
      if (command.startsWith('jsonlist2')) {
        return send(response, JSON.stringify({
          Arg: command,
          Results: [{
            Name: 'Staubsauger',
            Internals: { NAME: 'Staubsauger', TYPE: 'NeatoLocal' },
            Attributes: {},
            // Whatever the test set up - the component binds to state and
            // trackFile, and since the module also publishes planFile, to
            // anything else a page may ask for.
            Readings: Object.fromEntries(Object.entries(state.readings).map(
              ([name, value]) => [name, { Value: value, Time: '2026-09-20 12:00:00' }])),
          }],
          totalResultsReturned: 1,
        }), 'application/json; charset=utf-8');
      }
      if (command.startsWith('{')) {
        if (state.refusePerl) {
          return send(response, 'Forbidden: Perl commands are not allowed');
        }
        const names = await listSessions(options.dataDir, command);
        return send(response, names.join('\n'));
      }
      return send(response, '');
    }

    // The recordings, where FHEMWEB serves www/neato
    if (path.startsWith('/fhem/neato/')) {
      return serveFile(response, join(options.dataDir, path.slice('/fhem/neato/'.length)));
    }

    // This repository's component, laid over the framework
    if (path.startsWith('/fhem/ftui/components/neato/')) {
      return serveFile(response, join(options.repoDir, 'www/ftui/components/neato',
        path.slice('/fhem/ftui/components/neato/'.length)));
    }

    if (path.startsWith('/fhem/ftui/page/')) {
      return serveFile(response, join(options.pageDir, path.slice('/fhem/ftui/page/'.length)));
    }

    if (path.startsWith('/fhem/ftui/')) {
      return serveFile(response, join(options.ftuiDir, 'www/ftui', path.slice('/fhem/ftui/'.length)));
    }

    response.writeHead(404, { 'Content-Type': 'text/plain' });
    response.end('not found');
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    state,
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

/**
 * The recordings the Perl one-liner would list.
 *
 * The command carries a glob - <./www/neato/Staubsauger-*.jsonl> - and a real
 * FHEM honours the device prefix in it. So does this, otherwise a file put
 * into the directory for another test would show up in every device's list.
 */
async function listSessions(dir, command = '') {
  const { readdir } = await import('node:fs/promises');
  const names = await readdir(dir);
  const glob = (String(command).match(/<([^>]+)>/) || [])[1] || '*.jsonl';
  const pattern = new RegExp('^' + glob.split('/').pop()
    .replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');

  return names.filter(name => pattern.test(name)).sort().reverse();
}

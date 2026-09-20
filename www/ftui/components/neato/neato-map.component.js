/*
* Neato cleaning map component for FTUI version 3
*
* Shows a cleaning run recorded by the FHEM module 74_NeatoLocal: the lidar as
* an occupancy grid, the pose samples as the track the robot drove. The
* recorded sessions of a device can be paged through.
*
*   <ftui-grid-tile row="1" col="1" width="3" height="3">
*     <ftui-grid-header>Staubsauger</ftui-grid-header>
*     <ftui-neato-map device="Staubsauger"
*                     [track-file]="Staubsauger:trackFile"
*                     [state]="Staubsauger:state"></ftui-neato-map>
*   </ftui-grid-tile>
*
* The module writes the data and draws nothing; everything here is the display
* deciding how it looks. What the files contain and how the map is computed is
* docs/ftui3-map.md of chrisse1/neato-FHEM - and neato-track.js next door.
*
* Under MIT License (http://www.opensource.org/licenses/mit-license.php)
*/

import { FtuiElement } from '../element.component.js';
import * as track from './neato-track.js';

const TEXTS = {
  de: {
    loading: 'Karte wird geladen …',
    none: 'Keine Aufzeichnung gefunden',
    empty: 'Aufzeichnung ohne Punkte',
    failed: 'Aufzeichnung nicht lesbar',
    noList: 'Aufzeichnungen nicht auflistbar',
    running: 'läuft',
    minutes: 'min',
    metres: 'm',
  },
  en: {
    loading: 'Loading map …',
    none: 'No recording found',
    empty: 'Recording without points',
    failed: 'Recording not readable',
    noList: 'Cannot list the recordings',
    running: 'running',
    minutes: 'min',
    metres: 'm',
  },
};

// Several maps of the same device on one page ask the same question at the
// same moment. They share the answer for as long as it takes the page to come
// up; a moment later a new run would be listed again.
const LIST_CACHE_MS = 3000;
const listCache = new Map();

// Drawing every one of 80 000 endpoints as its own rectangle is a slow page,
// and at tile size nobody sees the difference. The occupancy grid is not
// thinned out this way - it counts all of them.
const MAX_DRAWN_POINTS = 20000;

export class FtuiNeatoMap extends FtuiElement {

  constructor(properties) {
    super(Object.assign(FtuiNeatoMap.properties, properties));

    this.sessions = [];          // file names, newest first
    this.loadedName = '';        // what this.session was read from
    this.session = null;         // the parsed session on display
    this.view = null;            // points and grid of that session, cached
    this.note = '';              // shown instead of a map
    this.listFailed = false;
    this.derivedDir = '';      // where the files are served, once worked out
    this.pending = null;
    this.busy = false;
    this.pollTimer = null;
    this.swipeStart = null;

    this.stage = this.shadowRoot.querySelector('.stage');
    this.noteElement = this.shadowRoot.querySelector('.note');
    this.titleElement = this.shadowRoot.querySelector('.title');
    this.subElement = this.shadowRoot.querySelector('.sub');
    this.previousButton = this.shadowRoot.querySelector('.previous');
    this.nextButton = this.shadowRoot.querySelector('.next');

    this.onVisibilityChanged = () => {
      this.startPolling();
      if (!this.session) {
        // A tile on a tab that has just been opened for the first time.
        this.requestUpdate({});
      }
    };
    this.previousButton.addEventListener('click', () => this.step(-1));
    this.nextButton.addEventListener('click', () => this.step(1));
    this.stage.addEventListener('pointerdown', (event) => this.onPointerDown(event));
    this.stage.addEventListener('pointerup', (event) => this.onPointerUp(event));
    this.stage.addEventListener('keydown', (event) => this.onKeyDown(event));
  }

  static get properties() {
    return {
      // what to show
      device: '',
      file: '',
      files: '',
      index: 0,
      limit: 20,
      // where the recordings are. An empty dir is derived from track-dir and
      // the address of FHEMWEB, which holds wherever the page itself lies.
      dir: '',
      trackDir: './www/neato',
      listCommand: '',
      // bindable readings of the device
      trackFile: '',
      state: '',
      // how the map is computed - see docs/ftui3-map.md
      cell: 0.05,
      threshold: 0.25,
      minSeen: 2,
      pad: 0.4,
      // how it looks
      showTrack: true,
      showPoints: false,
      showInfo: true,
      showControls: true,
      locale: '',
      // a run in progress is re-read this often, in seconds; 0 turns that off
      refreshInterval: 30,
    };
  }

  static get observedAttributes() {
    return [...this.convertToAttributes(FtuiNeatoMap.properties), ...super.observedAttributes];
  }

  template() {
    return `<style> @import "components/neato/neato-map.component.css"; </style>
    <div class="stage" tabindex="0">
      <div class="note"></div>
    </div>
    <div class="bar">
      <button class="previous" type="button" title="neuer">
        <svg viewBox="0 0 24 24"><polyline points="15,5 8,12 15,19"/></svg>
      </button>
      <div class="info">
        <span class="title"></span>
        <span class="sub"></span>
      </div>
      <button class="next" type="button" title="älter">
        <svg viewBox="0 0 24 24"><polyline points="9,5 16,12 9,19"/></svg>
      </button>
    </div>`;
  }

  onConnected() {
    document.addEventListener('ftuiVisibilityChanged', this.onVisibilityChanged, false);
    this.note = this.texts.loading;
    this.render();
    this.requestUpdate({ list: true });
  }

  onDisconnected() {
    document.removeEventListener('ftuiVisibilityChanged', this.onVisibilityChanged, false);
    this.stopPolling();
  }

  onAttributeChanged(name, value, oldValue) {
    if (value === oldValue) {
      return;
    }
    switch (name) {
      case 'dir':
        this.derivedDir = '';
        this.requestUpdate({ list: true });
        break;
      case 'device':
      case 'file':
      case 'files':
      case 'limit':
      case 'list-command':
        this.requestUpdate({ list: true });
        break;
      case 'track-dir':
        this.derivedDir = '';
        this.requestUpdate({ list: true });
        break;
      case 'track-file': {
        // A new file name means a new run has started: list again and follow
        // it, unless the user is looking at an older session on purpose. A
        // name that is already in the list is no news and costs no command.
        const known = this.sessions.includes(track.parseFileName(value).name);
        this.requestUpdate({ list: !known, follow: !known && (!oldValue || this.index === 0) });
        break;
      }
      case 'state':
        this.startPolling();
        this.requestUpdate({ reload: this.isRunning });
        break;
      case 'refresh-interval':
        this.startPolling();
        break;
      case 'index':
        this.requestUpdate({});
        break;
      case 'cell':
      case 'threshold':
      case 'min-seen':
        this.view = null;
        this.requestUpdate({});
        break;
      case 'pad':
      case 'show-track':
      case 'show-points':
      case 'show-info':
      case 'show-controls':
        this.requestUpdate({});
        break;
    }
  }

  get texts() {
    const locale = this.locale || document.documentElement.lang || navigator.language || 'de';
    return TEXTS[locale.slice(0, 2).toLowerCase()] || TEXTS.en;
  }

  get isRunning() {
    // 'cleaning' is what the module reports while it records; 'spot' and
    // 'exploring' are runs as well.
    return /clean|spot|explor/i.test(this.state || '');
  }

  /** The FHEM command that lists the recordings of this device. */
  get listCmd() {
    if (this.listCommand) {
      return this.listCommand;
    }
    const dir = (this.trackDir || './www/neato').replace(/\/+$/, '');
    const prefix = this.device ? this.device + '-' : '';
    // One Perl expression without a single semicolon: FHEM splits a command
    // line at ';' before it ever looks at the braces. The backslash-n is meant
    // for Perl, not for JavaScript - the command has to stay one line.
    return `{ join("\\n", reverse sort map { (split m,/,)[-1] } <${dir}/${prefix}*.jsonl>) }`;
  }

  // ---------------------------------------------------------------- updating

  /**
   * Collects what has to happen and does it once, after the attributes have
   * settled. A binding that sets three readings in a row would otherwise load
   * the same file three times.
   */
  requestUpdate(what) {
    this.pending = Object.assign(this.pending || {}, what);
    if (this.updateTimer) {
      return;
    }
    this.updateTimer = setTimeout(() => {
      this.updateTimer = null;
      const todo = this.pending || {};
      this.pending = null;
      this.update(todo);
    }, 50);
  }

  async update(todo) {
    if (this.busy) {
      // Whatever is still open is merged into the run that comes after.
      this.requestUpdate(todo);
      return;
    }
    this.busy = true;

    try {
      if (todo.list || !this.sessions.length) {
        this.sessions = await this.collectSessions();
        if (todo.follow) {
          this.index = 0;
        }
      }

      const count = this.sessions.length;
      const index = Math.min(Math.max(this.index, 0), Math.max(count - 1, 0));
      if (index !== this.index) {
        this.index = index;
      }

      const name = count ? this.sessions[index] : '';
      if (name && (name !== this.loadedName || todo.reload)) {
        await this.loadSession(name);
      } else if (!name) {
        this.session = null;
        this.loadedName = '';
        this.note = this.listFailed ? this.texts.noList : this.texts.none;
      }
    } catch (err) {
      this.note = this.texts.failed;
      this.session = null;
      // eslint-disable-next-line no-console
      console.error('[ftui-neato-map] ' + err);
    } finally {
      this.busy = false;
      this.render();
      this.startPolling();
    }
  }

  /** The recordings to page through, newest first. */
  async collectSessions() {
    this.listFailed = false;
    const current = track.parseFileName(this.trackFile).name;

    if (this.file) {
      return [track.parseFileName(this.file).name];
    }

    let names = [];
    if (this.files) {
      // A list given by hand is taken as it stands - whatever the files are
      // called, the user means them.
      names = this.files.split(/[\r\n,]+/);
    } else {
      try {
        names = (await this.sharedList(this.listCmd)).split(/[\r\n,]+/);
        // The glob already asks for this device only; a hand written
        // list-command may be less careful.
        names = names.filter(name => !this.device || name.includes(this.device + '-'));
      } catch (err) {
        // No listing - a run in progress is still known from the reading, and
        // that is better than an empty tile.
        this.listFailed = true;
        names = [];
      }
    }

    names = names
      .map(name => track.parseFileName(name).name)
      .filter(name => /^[^\s/\\]+\.jsonl$/.test(name));

    if (current && !names.includes(current)) {
      names.push(current);
    }

    // The file names carry the start time in a sortable form, so the newest
    // recording is simply the last name.
    return [...new Set(names)].sort().reverse().slice(0, Math.max(this.limit, 1));
  }

  async loadSession(name) {
    const live = this.isRunning && this.index === 0;
    const url = await this.url(name, live);
    const response = await fetch(url, { cache: live ? 'no-store' : 'default', credentials: 'same-origin' });

    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText} for ${url}`);
    }

    this.session = track.parseSession(await response.text());
    this.loadedName = name;
    this.view = null;
    this.note = (this.session.scans.length || this.session.poses.length) ? '' : this.texts.empty;
    this.emitEvent('sessionLoaded', { name, session: this.session });
  }

  async url(name, noCache) {
    // FHEMWEB strips a query from the file name and serves it uncached when it
    // sees 'nocache' - which is what a run in progress needs.
    return (await this.baseUrl()) + encodeURIComponent(name)
      + (noCache ? '?nocache=' + Date.now() : '');
  }

  /**
   * The URL the recordings are served under.
   *
   * FHEMWEB hands out everything below www/: the sessions in www/neato end up
   * at <fhemweb>/neato/. Taking that address from FTUI rather than writing a
   * relative path keeps it right for a page in a sub-directory, too. Without
   * FTUI - or without an address to ask for - it falls back to a path relative
   * to the page, which is what a plain FTUI installation needs.
   */
  async baseUrl() {
    if (this.dir) {
      return this.dir.replace(/\/*$/, '/');
    }
    if (this.derivedDir) {
      return this.derivedDir;
    }

    const folder = (this.trackDir || './www/neato').replace(/\/+$/, '').split('/').pop();
    let base = '../' + folder + '/';

    try {
      const { fhemService } = await import('../../modules/ftui/fhem.service.js');
      const fhemDir = fhemService.config && fhemService.config.fhemDir;
      if (fhemDir) {
        base = fhemDir.replace(/\/*$/, '/') + folder + '/';
      }
    } catch (err) {
      // No FTUI around: the relative path is the best guess there is.
    }

    this.derivedDir = base;
    return base;
  }

  /** The listing, asked once per command and shared with the other maps. */
  sharedList(command) {
    const cached = listCache.get(command);
    if (cached && Date.now() - cached.at < LIST_CACHE_MS) {
      return cached.answer;
    }

    const answer = this.askFhem(command);
    listCache.set(command, { at: Date.now(), answer });
    // A failed listing is not worth keeping: the next attempt should really
    // ask again.
    answer.catch(() => listCache.delete(command));
    return answer;
  }

  /** Sends a command to FHEM through FTUI's backend, if there is one. */
  async askFhem(command) {
    const module = await import('../../modules/ftui/backend.service.js');
    const response = await module.backendService.sendCommand(command);

    if (!response || response.status < 200 || response.status > 299) {
      throw new Error('FHEM: ' + (response ? response.statusText : 'no answer'));
    }

    const text = await response.text();
    if (/Forbidden|not allowed|Unknown command/i.test(text)) {
      throw new Error('FHEM: ' + text.split('\n')[0]);
    }
    return text;
  }

  // ------------------------------------------------------------------ paging

  step(direction) {
    const next = Math.min(Math.max(this.index + direction, 0), Math.max(this.sessions.length - 1, 0));
    if (next !== this.index) {
      this.submitChange('index', next);
    }
  }

  onPointerDown(event) {
    this.swipeStart = { x: event.clientX, y: event.clientY, time: Date.now() };
  }

  onPointerUp(event) {
    if (!this.swipeStart) {
      return;
    }
    const dx = event.clientX - this.swipeStart.x;
    const dy = event.clientY - this.swipeStart.y;
    const swipe = Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.5
      && Date.now() - this.swipeStart.time < 800;
    this.swipeStart = null;

    if (swipe) {
      // Dragging to the left pulls the next, older recording into view.
      this.step(dx < 0 ? 1 : -1);
    }
  }

  onKeyDown(event) {
    if (event.key === 'ArrowLeft') {
      this.step(-1);
      event.preventDefault();
    } else if (event.key === 'ArrowRight') {
      this.step(1);
      event.preventDefault();
    }
  }

  // ----------------------------------------------------------------- polling

  startPolling() {
    this.stopPolling();
    const seconds = Number(this.refreshInterval);
    if (!this.isRunning || !(seconds > 0) || this.hidden || !this.isConnected) {
      return;
    }
    this.pollTimer = setInterval(() => {
      // Only the newest recording grows; an older one is done with.
      if (this.index === 0 && document.visibilityState !== 'hidden') {
        this.requestUpdate({ reload: true });
      }
    }, seconds * 1000);
  }

  stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  // --------------------------------------------------------------- rendering

  render() {
    this.renderBar();

    // Only the map, not the chevrons of the buttons.
    const map = this.stage.querySelector('svg');
    if (map) {
      map.remove();
    }
    this.noteElement.textContent = this.note;

    if (!this.session || this.note) {
      return;
    }

    this.stage.insertAdjacentHTML('beforeend', this.svg());
  }

  renderBar() {
    const count = this.sessions.length;
    const parsed = track.parseFileName(this.loadedName);
    const info = this.session ? track.stats(this.session) : null;
    const texts = this.texts;
    const locale = this.locale || document.documentElement.lang || undefined;

    this.previousButton.disabled = this.index <= 0;
    this.nextButton.disabled = this.index >= count - 1;

    this.titleElement.textContent = parsed.date
      ? parsed.date.toLocaleString(locale, {
        weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
      })
      : parsed.name;

    const parts = [];
    if (info) {
      parts.push(`${info.distance.toLocaleString(locale, { maximumFractionDigits: 1 })} ${texts.metres}`);
      parts.push(`${Math.round(info.seconds / 60)} ${texts.minutes}`);
    }
    if (count > 1) {
      parts.push(`${this.index + 1}/${count}`);
    }

    this.subElement.innerHTML = (info && info.running ? `<i class="live" title="${texts.running}"></i>` : '')
      + parts.join(' · ').replace(/[<>&]/g, '');
  }

  /**
   * The session as an SVG that scales with the tile.
   *
   * Everything is drawn in metres and the view box is the extent of the run, so
   * the browser does the scaling - and does it again, for free, when the tile
   * changes size.
   */
  svg() {
    const view = this.prepare();
    const { minX, maxX, minY, maxY } = view.bounds;
    const pad = Number(this.pad) || 0;
    const width = (maxX - minX) + 2 * pad;
    const height = (maxY - minY) + 2 * pad;
    const radius = Math.max(width, height) * 0.012;

    // In the data y grows upwards, in SVG downwards. Without this the flat
    // stands on its head.
    const sx = (x) => (x - minX + pad).toFixed(3);
    const sy = (y) => (maxY - y + pad).toFixed(3);

    const parts = [
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width.toFixed(3)} ${height.toFixed(3)}"`,
      ` preserveAspectRatio="xMidYMid meet" shape-rendering="crispEdges">`,
    ];

    if (this.showPoints) {
      parts.push(this.pointsPath(view, sx, sy, Math.max(width, height)));
    } else {
      const cell = view.grid.cell;
      const rects = (runs, className) => {
        const out = [`<g class="${className}">`];
        // A hair of overlap: neighbouring rectangles otherwise show the
        // background between them at some zoom levels.
        const bleed = cell * 0.04;
        for (let i = 0; i < runs.length; i++) {
          const [ix, iy, run] = runs[i];
          out.push(`<rect x="${sx((ix + view.grid.x0) * cell)}" y="${sy((iy + view.grid.y0 + 1) * cell)}"`
            + ` width="${(run * cell + bleed).toFixed(3)}" height="${(cell + bleed).toFixed(3)}"/>`);
        }
        out.push('</g>');
        return out.join('');
      };
      parts.push(rects(view.cells.free, 'free'));
      parts.push(rects(view.cells.walls, 'wall'));
    }

    const running = track.stats(this.session).running;
    const poses = this.session.poses;
    if (this.showTrack && poses.length > 1) {
      const points = [];
      for (let i = 0; i < poses.length; i++) {
        points.push(`${sx(poses[i].x)},${sy(poses[i].y)}`);
      }
      parts.push(`<polyline class="track" points="${points.join(' ')}"/>`);
    }

    if (poses.length) {
      const first = poses[0];
      const last = poses[poses.length - 1];
      parts.push(`<circle class="start" cx="${sx(first.x)}" cy="${sy(first.y)}" r="${radius.toFixed(3)}"/>`);
      parts.push(`<circle class="${running ? 'robot' : 'end'}"`
        + ` cx="${sx(last.x)}" cy="${sy(last.y)}" r="${radius.toFixed(3)}"/>`);
    }

    parts.push('</svg>');
    return parts.join('');
  }

  pointsPath(view, sx, sy, extent) {
    const points = view.points;
    const count = points.length / 2;
    const step = Math.max(1, Math.ceil(count / MAX_DRAWN_POINTS));
    // A cell wide at least, but never a speck in a big flat.
    const size = Math.max(Number(this.cell) || 0.05, extent * 0.004);
    const half = size / 2;
    const out = ['<g class="points">'];

    for (let i = 0; i < count; i += step) {
      // The point is the middle of its mark, not its upper left corner.
      out.push(`<rect x="${sx(points[i * 2] - half)}" y="${sy(points[i * 2 + 1] + half)}"`
        + ` width="${size.toFixed(3)}" height="${size.toFixed(3)}"/>`);
    }

    out.push('</g>');
    return out.join('');
  }

  /**
   * Points, grid and extent of the session on display - computed once and kept
   * until the session or one of the grid's parameters changes. Drawing it at
   * another size costs nothing.
   */
  prepare() {
    if (this.view) {
      this.ensureGrid();
      return this.view;
    }

    const points = track.allPoints(this.session.scans);

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    const stretch = (x, y) => {
      if (x < minX) { minX = x; }
      if (x > maxX) { maxX = x; }
      if (y < minY) { minY = y; }
      if (y > maxY) { maxY = y; }
    };
    for (let i = 0; i < points.length; i += 2) {
      stretch(points[i], points[i + 1]);
    }
    for (const pose of this.session.poses) {
      stretch(pose.x, pose.y);
    }
    if (!isFinite(minX)) {
      minX = maxX = minY = maxY = 0;
    }

    this.view = { points, grid: null, cells: null, bounds: { minX, maxX, minY, maxY } };
    this.ensureGrid();
    return this.view;
  }

  /** The occupancy grid, which the raw endpoints do not need. */
  ensureGrid() {
    if (this.showPoints || this.view.grid) {
      return;
    }
    const cell = Number(this.cell) > 0 ? Number(this.cell) : 0.05;
    this.view.grid = track.occupancy(this.session.scans, cell, this.view.points);
    this.view.cells = track.classify(this.view.grid, Number(this.threshold), Number(this.minSeen));
  }
}

window.customElements.define('ftui-neato-map', FtuiNeatoMap);

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
import { isNumeric, debounce } from '../../modules/ftui/ftui.helper.js';
import * as track from './neato-track.js';
import { wallLines, wallTest } from './neato-walls.js';
import { alignScans } from './neato-align.js';
import { countMissed, trackIsDense, standstills } from './neato-run.js';

/*
* Attributes that are nothing but a CSS custom property on the element.
*
* A size takes a bare number as em, the way margin and padding do in FTUI. A
* colour takes what CSS takes, and on top of that the colour names FTUI uses
* elsewhere - 'primary', 'warning', 'red' - which resolve through the theme.
*/
const STYLE_ATTRIBUTES = {
  'text-size': ['--neato-map-font-size', 'size'],
  'arrow-size': ['--neato-map-arrow-size', 'size'],
  'min-height': ['--neato-map-min-height', 'size'],
  'wall-color': ['--neato-map-wall-color', 'color'],
  'free-color': ['--neato-map-free-color', 'color'],
  'point-color': ['--neato-map-point-color', 'color'],
  'track-color': ['--neato-map-track-color', 'color'],
  'start-color': ['--neato-map-start-color', 'color'],
  'end-color': ['--neato-map-end-color', 'color'],
  'text-color': ['--neato-map-text-color', 'color'],
  'background-color': ['--neato-map-background', 'color'],
  'missed-color': ['--neato-map-missed-color', 'color'],
  'stuck-color': ['--neato-map-stuck-color', 'color'],
  'free-opacity': ['--neato-map-free-opacity', 'plain'],
};

const TEXTS = {
  de: {
    loading: 'Karte wird geladen …',
    none: 'Keine Aufzeichnung gefunden',
    empty: 'Aufzeichnung ohne Punkte',
    failed: 'Aufzeichnung nicht lesbar',
    noList: 'Aufzeichnungen nicht auflistbar',
    running: 'läuft',
    older: 'älter',
    newer: 'neuer',
    minutes: 'min',
    metres: 'm',
    covered: 'Abdeckung %s %',
    still: '%s s gestanden',
  },
  en: {
    loading: 'Loading map …',
    none: 'No recording found',
    empty: 'Recording without points',
    failed: 'Recording not readable',
    noList: 'Cannot list the recordings',
    running: 'running',
    older: 'older',
    newer: 'newer',
    minutes: 'min',
    metres: 'm',
    covered: '%s % covered',
    still: 'stood still for %s s',
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
    this.olderButton = this.shadowRoot.querySelector('.older');
    this.newerButton = this.shadowRoot.querySelector('.newer');

    // With rotate="auto" the tile's shape decides how the map is turned, so a
    // tile that changes shape needs the drawing built again. The data behind
    // it is not touched - this is a redraw, not a reload.
    // FTUI's debounce takes the delay at call time, not here.
    this.onStageResized = debounce(() => {
      if (String(this.rotate).toLowerCase() === 'auto' && this.session && !this.note) {
        this.render();
      }
    }, this);

    this.onVisibilityChanged = () => {
      this.startPolling();
      if (!this.session) {
        // A tile on a tab that has just been opened for the first time.
        this.requestUpdate({});
      }
    };
    // Time runs to the right: the arrow to the right goes towards the newest
    // run, the one to the left back into the past.
    this.olderButton.addEventListener('click', () => this.step(1));
    this.newerButton.addEventListener('click', () => this.step(-1));
    this.stage.addEventListener('pointerdown', (event) => this.onPointerDown(event));
    this.stage.addEventListener('pointerup', (event) => this.onPointerUp(event));
    this.stage.addEventListener('pointercancel', () => { this.swipeStart = null; });
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
      cell: 0.10,
      threshold: 0.25,
      minSeen: 2,
      pad: 0.4,
      // 'lines' draws the walls as the straight pieces they are, 'cells' as
      // the grid cells the evidence marks.
      walls: 'lines',
      // Lay the revolutions on top of each other before drawing. Costs a
      // moment on a long run and is what makes a wall one line.
      align: true,
      lineTolerance: 0.04,
      joinGap: 0.8,
      joinOffset: 0.12,
      joinAngle: 4,
      closeCorners: true,
      cornerReach: 0.8,
      clearance: 0.1,
      minWall: 0.6,
      snapAngle: 8,
      // how it looks
      showTrack: true,
      showPoints: false,
      showInfo: true,
      showControls: true,
      // What the brush never went over, hatched, plus the share it did cover
      // in the line below. Off by default: it is an interpretation of the
      // track, not a measurement, and on a thinned recording it says nothing.
      showMissed: false,
      // Width of the robot in metres - everything within half of that of its
      // centre counts as swept.
      brushWidth: 0.32,
      // Standing still this long away from where it set off is not something
      // a vacuum does on purpose. Marked with a ring. 0 turns it off.
      showStuck: true,
      stuckSeconds: 20,
      // Turning the map a quarter at a time. 'auto' picks whichever of the
      // four fills the tile best, which is what a recording needs whose axes
      // are the robot's heading at the moment it set off.
      rotate: 'auto',
      // Sizes of the line below the map and of the arrows. A bare number is
      // em, as elsewhere in FTUI; any CSS length works as well.
      textSize: '',
      arrowSize: '',
      minHeight: '',
      // Colours. A CSS colour, or one of FTUI's colour names.
      wallColor: '',
      freeColor: '',
      freeOpacity: '',
      pointColor: '',
      trackColor: '',
      startColor: '',
      endColor: '',
      missedColor: '',
      stuckColor: '',
      textColor: '',
      backgroundColor: '',
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
      <button class="older" type="button">
        <svg viewBox="0 0 24 24"><polyline points="15,5 8,12 15,19"/></svg>
      </button>
      <div class="info">
        <span class="title"></span>
        <span class="sub"></span>
      </div>
      <button class="newer" type="button">
        <svg viewBox="0 0 24 24"><polyline points="9,5 16,12 9,19"/></svg>
      </button>
    </div>`;
  }

  onConnected() {
    document.addEventListener('ftuiVisibilityChanged', this.onVisibilityChanged, false);
    if (typeof ResizeObserver === 'function') {
      this.stageObserver = new ResizeObserver(() => this.onStageResized(150));
      this.stageObserver.observe(this.stage);
    }
    this.note = this.texts.loading;
    this.render();
    this.requestUpdate({ list: true });
  }

  onDisconnected() {
    document.removeEventListener('ftuiVisibilityChanged', this.onVisibilityChanged, false);
    if (this.stageObserver) {
      this.stageObserver.disconnect();
      this.stageObserver = null;
    }
    this.stopPolling();
  }

  onAttributeChanged(name, value, oldValue) {
    if (value === oldValue) {
      return;
    }
    if (STYLE_ATTRIBUTES[name]) {
      this.setStyleAttribute(name, value);
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
      case 'walls':
      case 'align':
      case 'line-tolerance':
      case 'join-gap':
      case 'join-offset':
      case 'join-angle':
      case 'close-corners':
      case 'corner-reach':
      case 'clearance':
      case 'min-wall':
      case 'snap-angle':
      case 'show-missed':
      case 'brush-width':
        this.view = null;
        this.requestUpdate({});
        break;
      case 'rotate':
      case 'pad':
      case 'show-track':
      case 'show-points':
      case 'show-info':
      case 'show-controls':
      case 'show-stuck':
      case 'stuck-seconds':
        this.requestUpdate({});
        break;
    }
  }

  /**
   * A size or colour from the markup, as a CSS custom property on the element.
   *
   * Empty hands the decision back to the stylesheet, which is where the
   * defaults live - setting an attribute back to '' undoes it.
   */
  setStyleAttribute(name, value) {
    const [property, kind] = STYLE_ATTRIBUTES[name];

    if (value === null || value === '') {
      this.style.removeProperty(property);
      return;
    }

    let css = value;
    if (kind === 'size') {
      css = isNumeric(value) ? value + 'em' : value;
    } else if (kind === 'color') {
      css = cssColor(value);
    }
    this.style.setProperty(property, css);
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
    // Hold on to the pointer: the map is an SVG, and a drag that starts on it
    // would otherwise end somewhere else - or not end at all.
    try {
      this.stage.setPointerCapture(event.pointerId);
    } catch (err) {
      // Not every pointer can be captured; the swipe then works as before.
    }
  }

  onPointerUp(event) {
    try {
      if (this.stage.hasPointerCapture(event.pointerId)) {
        this.stage.releasePointerCapture(event.pointerId);
      }
    } catch (err) {
      // see onPointerDown
    }

    if (!this.swipeStart) {
      return;
    }
    const dx = event.clientX - this.swipeStart.x;
    const dy = event.clientY - this.swipeStart.y;
    const swipe = Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.5
      && Date.now() - this.swipeStart.time < 800;
    this.swipeStart = null;

    if (swipe) {
      // The runs lie on a time line, the older ones to the left: dragging to
      // the left pulls a newer one into view, to the right an older one.
      this.step(dx < 0 ? -1 : 1);
    }
  }

  onKeyDown(event) {
    if (event.key === 'ArrowLeft') {
      this.step(1);                      // back in time
      event.preventDefault();
    } else if (event.key === 'ArrowRight') {
      this.step(-1);                     // towards the newest run
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

    // index 0 is the newest run, so the arrow to the right runs out first.
    this.newerButton.disabled = this.index <= 0;
    this.newerButton.title = texts.newer;
    this.olderButton.disabled = this.index >= count - 1;
    this.olderButton.title = texts.older;

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
    const missed = this.missedFloor();
    if (missed) {
      parts.push(texts.covered.replace('%s', String(Math.round(missed.covered * 100))));
    }
    if (count > 1) {
      parts.push(`${this.index + 1}/${count}`);
    }

    this.subElement.innerHTML = (info && info.running ? `<i class="live" title="${texts.running}"></i>` : '')
      + parts.join(' · ').replace(/[<>&]/g, '');
  }

  /**
   * How far the map is turned, in quarters.
   *
   * The axes of a recording are the robot's heading when it set off, so the
   * same flat comes out upright in one run and on its side in the next.
   * 'auto' turns it to whichever quarter fills the tile best.
   */
  quarters(width, height) {
    const asked = String(this.rotate || '').trim().toLowerCase();

    if (asked !== 'auto' && asked !== '') {
      return ((Math.round(Number(asked) / 90) % 4) + 4) % 4;
    }

    const box = this.stage.getBoundingClientRect();
    if (!(box.width > 0 && box.height > 0)) {
      return 0;                                  // not laid out yet
    }

    // How much of the tile each of the two shapes covers. A quarter turn
    // swaps width and height, so there are only two answers to compare.
    const fill = (w, h) => Math.min(box.width / w, box.height / h) ** 2 * w * h
      / (box.width * box.height);

    return fill(height, width) > fill(width, height) * 1.02 ? 1 : 0;
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

    // A quarter turn swaps the two sides of the view box, and the drawing is
    // turned inside it - the coordinates themselves stay as they are.
    const turns = this.quarters(width, height);
    const across = turns % 2 === 1;
    const boxWidth = across ? height : width;
    const boxHeight = across ? width : height;
    const spin = [
      '',
      ` transform="translate(${height.toFixed(3)},0) rotate(90)"`,
      ` transform="translate(${width.toFixed(3)},${height.toFixed(3)}) rotate(180)"`,
      ` transform="translate(0,${width.toFixed(3)}) rotate(270)"`,
    ][turns];

    const parts = [
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${boxWidth.toFixed(3)} ${boxHeight.toFixed(3)}"`,
      ` preserveAspectRatio="xMidYMid meet" shape-rendering="crispEdges">`,
      `<g${spin}>`,
    ];

    if (this.showPoints) {
      parts.push(this.pointsPath(view, sx, sy, Math.max(width, height)));
    } else if (view.lines) {
      parts.push(`<g class="free">${this.cellRects(view.cells.free, view, sx, sy)}</g>`);
      const out = ['<g class="walls">'];
      for (const wall of view.lines) {
        out.push(`<line x1="${sx(wall.x0)}" y1="${sy(wall.y0)}"`
          + ` x2="${sx(wall.x1)}" y2="${sy(wall.y1)}"/>`);
      }
      out.push('</g>');
      parts.push(out.join(''));
    } else {
      const rects = (runs, className) =>
        `<g class="${className}">${this.cellRects(runs, view, sx, sy)}</g>`;
      parts.push(rects(view.cells.free, 'free'));
      parts.push(rects(view.cells.walls, 'wall'));
    }

    // The floor he left out, hatched: it lies on top of the free area and has
    // to read as a texture, because it is the same floor, only not cleaned.
    const missed = this.missedFloor();
    if (missed && missed.runs.length) {
      parts.push('<defs><pattern id="neato-missed" width="0.36" height="0.36"'
        + ' patternUnits="userSpaceOnUse" patternTransform="rotate(45)">'
        + '<line class="hatch" x1="0" y1="0" x2="0" y2="0.36"/></pattern></defs>'
        + `<g class="missed">${this.cellRects(missed.runs, view, sx, sy)}</g>`);
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

    // Where he stood still away from the base: a ring, and the seconds in the
    // tooltip. Drawn over the track, because that is what it is about.
    for (const stop of this.standstills()) {
      parts.push(`<circle class="stuck" cx="${sx(stop.x)}" cy="${sy(stop.y)}"`
        + ` r="${(radius * 2.4).toFixed(3)}"><title>`
        + `${this.texts.still.replace('%s', String(Math.round(stop.seconds)))}`
        + '</title></circle>');
    }

    if (poses.length) {
      const first = poses[0];
      const last = poses[poses.length - 1];
      parts.push(`<circle class="start" cx="${sx(first.x)}" cy="${sy(first.y)}" r="${radius.toFixed(3)}"/>`);
      parts.push(`<circle class="${running ? 'robot' : 'end'}"`
        + ` cx="${sx(last.x)}" cy="${sy(last.y)}" r="${radius.toFixed(3)}"/>`);
    }

    parts.push('</g></svg>');
    return parts.join('');
  }

  /** Row runs as rectangles, in metres. */
  cellRects(runs, view, sx, sy) {
    const cell = view.grid.cell;
    // A hair of overlap: neighbouring rectangles otherwise show the
    // background between them at some zoom levels.
    const bleed = cell * 0.04;
    const out = [];

    for (let i = 0; i < runs.length; i++) {
      const [ix, iy, run] = runs[i];
      out.push(`<rect x="${sx((ix + view.grid.x0) * cell)}" y="${sy((iy + view.grid.y0 + 1) * cell)}"`
        + ` width="${(run * cell + bleed).toFixed(3)}" height="${(cell + bleed).toFixed(3)}"/>`);
    }

    return out.join('');
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
   * The floor the brush never went over - or nothing, if that cannot be said.
   *
   * A recording whose poses are far apart says nothing about where the robot
   * drove between two of them, and a share of the floor computed from it would
   * be a number with nothing behind it. Then there is none.
   */
  missedFloor() {
    if (!this.showMissed || !this.session || this.note || this.showPoints) {
      return null;
    }
    this.prepare();
    return this.view.missed && trackIsDense(this.view.missed) ? this.view.missed : null;
  }

  /** Where he stood still long enough that something was wrong. */
  standstills() {
    const seconds = Number(this.stuckSeconds);
    if (!this.showStuck || !this.session || !(seconds > 0)) {
      return [];
    }
    return standstills(this.session, { seconds });
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

    const cell = Number(this.cell) > 0 ? Number(this.cell) : 0.10;
    const threshold = Number(this.threshold);
    const seen = Number(this.minSeen);

    // The poses the robot reports are good to a few centimetres, and over an
    // hour those centimetres smear every wall into a band. Laying the
    // revolutions onto each other first is what makes a wall one line - see
    // neato-align.js. The track is not touched by it.
    const scans = this.align && this.session.scans.length > 2
      ? alignScans(this.session.scans).scans
      : this.session.scans;

    const points = scans === this.session.scans ? this.view.points : track.allPoints(scans);
    this.view.grid = track.occupancy(scans, cell, points);
    this.view.cells = track.classify(this.view.grid, threshold, seen);

    // Which of the free floor the brush never went over. Costs about 10 ms on
    // an hour long run, so it is only done when it is asked for.
    if (this.showMissed) {
      this.view.missed = countMissed(this.view.grid, this.view.cells, this.session.poses,
        { width: Number(this.brushWidth) });
    }

    if (this.walls === 'lines') {
      const { walls, direction } = wallLines(scans, this.view.grid,
        wallTest(this.view.grid, threshold, seen), {
          tolerance: Number(this.lineTolerance),
          gap: Number(this.joinGap),
          joinOffset: Number(this.joinOffset),
          joinDegrees: Number(this.joinAngle),
          // Where the robot drove there is no wall, and a doorway it drove
          // through is not a corner to be closed.
          poses: this.session.poses,
          cornerReach: this.closeCorners ? Number(this.cornerReach) : 0,
          clearance: Number(this.clearance),
          minLength: Number(this.minWall),
          snapDegrees: Number(this.snapAngle),
        });
      this.view.lines = walls;
      this.view.direction = direction;
    }
  }
}

/**
 * A colour as CSS can use it.
 *
 * '#9ec9f0', 'rgb(...)' and 'var(--x)' are passed through. A bare name is
 * looked up the way FTUI's styles/colors.css does it: 'primary' is the theme's
 * --primary-color, 'red' its --red, and whatever the theme does not know stays
 * the plain CSS colour of that name.
 */
function cssColor(value) {
  const name = String(value).trim();

  if (!/^[a-z][a-z0-9-]*$/i.test(name)) {
    return name;
  }

  return `var(--${name}-color, var(--${name}, ${name}))`;
}

window.customElements.define('ftui-neato-map', FtuiNeatoMap);

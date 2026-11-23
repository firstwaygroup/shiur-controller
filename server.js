'use strict';
// Shiur Controller: the laptop engine.
// One list of things to show, three modes (Me / Show / Screen).
// Talks to OBS, serves the button bar on the laptop and the optional remote for an iPad or phone.
// Started by the Shiur icon (with --launch) it also starts OBS hidden and opens the Zoom meeting.
// Needs only Node.js and OBS. No other installs.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { exec, execFile, spawn } = require('child_process');

const ROOT = __dirname;
const DATA = process.env.SHIUR_DATA_DIR || path.join(ROOT, 'data');
const MEDIA = path.join(DATA, 'media');
const PUBLIC = path.join(ROOT, 'public');
const IS_WIN = process.platform === 'win32';
const LAUNCH = process.argv.includes('--launch');
const NO_ZOOM = process.argv.includes('--no-zoom');   // started again after a stop: Zoom is already open
fs.mkdirSync(MEDIA, { recursive: true });

const CONFIG_FILE = path.join(DATA, 'config.json');
const LIST_FILE = path.join(DATA, 'list.json');

const DEFAULT_TILES = [
  { name: 'MDY', url: '' },
  { name: 'Claude', url: 'https://claude.ai' },
  { name: 'Google Images', url: 'https://images.google.com' },
  { name: 'Sefaria', url: 'https://www.sefaria.org' }
];
const DEFAULT_CONFIG = { port: 8080, obsHost: '127.0.0.1', obsPort: 4455, obsPassword: '', cameraDevice: '', screenMonitor: '', screenProp: '', roomMonitor: null, recordButton: false, tiles: DEFAULT_TILES, zoomLink: '', obsPath: '' };

// Names inside OBS. These match the first version, so an existing setup carries on.
const SCENES = { me: 'Shiur - Me', show: 'Shiur - Material', screen: 'Shiur - Screen', room: 'Shiur - Room' };
const INPUTS = { camera: 'Shiur Camera', item: 'Shiur Material', screen: 'Shiur Laptop Screen', title: 'Shiur Title Card', oldTablet: 'Shiur Tablet Screen' };

const IMAGE_EXT = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' };
const VIDEO_EXT = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime' };
const PAGE_EXT = { '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.pdf': 'application/pdf' };   // Claude charts, PDFs: opened live
const DOWNLOADS = process.env.SHIUR_DOWNLOADS || path.join(os.homedir(), 'Downloads');
function kindOf(ext) { return IMAGE_EXT[ext] ? 'image' : VIDEO_EXT[ext] ? 'video' : PAGE_EXT[ext] ? 'page' : null; }
const MAX_UPLOAD = 1024 * 1024 * 1024;
const ZOOMS = [1, 1.25, 1.5, 2, 2.5, 3, 4];
const PAN_STEP = 12;

// ---------- storage ----------

function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; } }
function writeJson(file, value) { const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(value, null, 2)); fs.renameSync(tmp, file); }

let config = Object.assign({}, DEFAULT_CONFIG, readJson(CONFIG_FILE, {}));
let list = Object.assign({ title: '', items: [] }, readJson(LIST_FILE, {}));
if (!Array.isArray(list.items)) list.items = [];
function saveConfig() { writeJson(CONFIG_FILE, config); }
function saveList() { writeJson(LIST_FILE, list); }

function newId() { return crypto.randomBytes(6).toString('hex'); }
function looksLikeImageUrl(url) { return /\.(jpe?g|png|gif|webp|bmp)(\?|#|$)/i.test(url); }
function shortUrl(url) {
  try { const u = new URL(url); return u.hostname.replace(/^www\./, '') + (u.pathname.length > 1 ? u.pathname.slice(0, 40) : ''); }
  catch (e) { return url.slice(0, 60); }
}

function cleanItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const type = ['link', 'image', 'video', 'page'].includes(raw.type) ? raw.type : null;
  if (!type) return null;
  const item = {
    id: typeof raw.id === 'string' && /^[a-z0-9]{6,32}$/i.test(raw.id) ? raw.id : newId(),
    type,
    title: String(raw.title || '').trim().slice(0, 120)
  };
  if (type === 'link') {
    const url = String(raw.url || '').trim();
    if (!/^https?:\/\//i.test(url)) return null;
    item.url = url.slice(0, 2000);
    if (looksLikeImageUrl(item.url)) item.picture = true;
    if (!item.title) {
      let host = '';
      try { host = new URL(item.url).hostname.replace(/^www\./, ''); } catch (e) { /* ignore */ }
      item.title = item.picture ? 'Picture from ' + (host || 'the web') : shortUrl(item.url);
    }
  } else {
    const file = String(raw.file || '');
    if (!/^[a-z0-9]+\.[a-z0-9]+$/i.test(file)) return null;
    item.file = file;
    if (!item.title) item.title = type === 'video' ? 'Video' : type === 'page' ? 'Chart' : 'Picture';
  }
  return item;
}

function removeUnusedMedia() {
  const used = new Set(list.items.filter(it => it.file).map(it => it.file));
  for (const f of fs.readdirSync(MEDIA)) {
    if (!used.has(f) && !f.endsWith('.part')) { try { fs.unlinkSync(path.join(MEDIA, f)); } catch (e) { /* ignore */ } }
  }
}

// ---------- live state ----------

const state = {
  mode: 'me',                       // me | show | screen
  currentId: null,
  showCounter: 0,
  view: { zoom: 1, x: 0, y: 0 },    // zoom and move for pictures
  media: { paused: false, restart: 0 },
  recording: false,                 // only used when the Record button is switched on in Setup
  recordStartedAt: null,
  lastRecordingPath: null,
  obs: { connected: false, error: 'Connecting to OBS...', scenesReady: false },
  message: null,
  ended: false,                     // true after End shiur
  panel: 'big'                      // the Shiur app on the laptop: 'big' (fills the screen) or 'small' (a strip at the bottom)
};
let lastItemUrl = null;

function currentItem() { return list.items.find(it => it.id === state.currentId) || null; }
// Web pages and charts open live on the laptop screen (so they can be clicked through); pictures and videos are shown.
function isLive(item) { return !!item && (item.type === 'page' || (item.type === 'link' && !item.picture)); }
function liveUrl(item) { return item.type === 'page' ? localUrl('/media/' + encodeURIComponent(item.file)) : item.url; }
function currentIndex() { return list.items.findIndex(it => it.id === state.currentId); }
function base() { return 'http://127.0.0.1:' + config.port; }

function itemUrlFor(item) {
  if (!item) return base() + '/view/title';
  const v = '&v=' + state.showCounter;
  if (item.type === 'link') return item.picture ? base() + '/view/picture?u=' + encodeURIComponent(item.url) + v : item.url;
  if (item.type === 'page') return base() + '/media/' + encodeURIComponent(item.file);
  return base() + '/view/file?f=' + encodeURIComponent(item.file) + '&t=' + item.type + v;
}

function publicState() {
  return {
    mode: state.mode,
    title: list.title,
    items: list.items,
    current: currentItem(),
    currentIndex: currentIndex(),
    view: state.view,
    media: state.media,
    recordButton: !!config.recordButton,
    recording: state.recording,
    recordAgoMs: state.recordStartedAt ? Date.now() - state.recordStartedAt : 0,
    lastRecordingPath: state.lastRecordingPath,
    obs: state.obs,
    message: state.message,
    ended: state.ended,
    panel: state.panel,
    liveUrl: isLive(currentItem()) ? liveUrl(currentItem()) : null,
    hasBar: !!bar,
    zoomPanel: !!(bar && bar.zoomPanel)
  };
}

const sseClients = new Set();
function broadcast() {
  const data = 'data: ' + JSON.stringify(publicState()) + '\n\n';
  for (const res of sseClients) { try { res.write(data); } catch (e) { sseClients.delete(res); } }
}
setInterval(() => { for (const res of sseClients) { try { res.write(': ping\n\n'); } catch (e) { sseClients.delete(res); } } }, 20000);

// ---------- OBS (obs-websocket v5) ----------

function sha256b64(s) { return crypto.createHash('sha256').update(s).digest('base64'); }

class Obs {
  constructor() { this.ws = null; this.identified = false; this.pending = new Map(); this.nextId = 1; this.timer = null; this.closeReason = null; this.onStatus = () => {}; this.onEvent = () => {}; }
  connect() {
    clearTimeout(this.timer);
    if (typeof WebSocket === 'undefined') { this.onStatus(false, 'This Node.js is too old. Install the latest LTS version from nodejs.org.'); return; }
    if (this.ws) { const old = this.ws; this.ws = null; try { old.close(); } catch (e) { /* ignore */ } }
    this.closeReason = null;
    let ws;
    try { ws = new WebSocket('ws://' + config.obsHost + ':' + config.obsPort); }
    catch (e) { this.onStatus(false, 'Could not reach OBS.'); this.retry(); return; }
    this.ws = ws;
    this.identified = false;
    ws.onmessage = ev => this.handle(ws, ev.data);
    ws.onerror = () => {};
    ws.onclose = ev => {
      if (this.ws !== ws) return;
      this.ws = null; this.identified = false; this.failAll('OBS disconnected');
      let reason = this.closeReason;
      if (!reason && ev && ev.code === 4009) reason = 'The OBS password is wrong. Fix it on the Setup page.';
      if (!reason) reason = 'OBS is not open, or its WebSocket server is turned off.';
      this.onStatus(false, reason);
      this.retry();
    };
  }
  retry() { clearTimeout(this.timer); this.timer = setTimeout(() => this.connect(), 4000); }
  handle(ws, raw) {
    let msg;
    try { msg = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw).toString()); } catch (e) { return; }
    const d = msg.d || {};
    if (msg.op === 0) {
      const identify = { rpcVersion: 1, eventSubscriptions: 1 | 4 | 64 };
      if (d.authentication) {
        if (!config.obsPassword) { this.closeReason = 'OBS wants a password. Type it in on the Setup page.'; try { ws.close(); } catch (e) { /* ignore */ } return; }
        identify.authentication = sha256b64(sha256b64(config.obsPassword + d.authentication.salt) + d.authentication.challenge);
      }
      ws.send(JSON.stringify({ op: 1, d: identify }));
    } else if (msg.op === 2) {
      this.identified = true;
      this.onStatus(true, null);
    } else if (msg.op === 7) {
      const p = this.pending.get(d.requestId);
      if (!p) return;
      this.pending.delete(d.requestId); clearTimeout(p.timer);
      const st = d.requestStatus || {};
      if (st.result) p.resolve(d.responseData || {}); else p.reject(new Error(st.comment || (d.requestType + ' failed (code ' + st.code + ')')));
    } else if (msg.op === 5) {
      this.onEvent(d.eventType, d.eventData || {});
    }
  }
  call(requestType, requestData) {
    return new Promise((resolve, reject) => {
      if (!this.ws || !this.identified) return reject(new Error('Not connected to OBS'));
      const requestId = String(this.nextId++);
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error('OBS did not answer (' + requestType + ')')); }, 10000);
      this.pending.set(requestId, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData: requestData || {} } }));
    });
  }
  failAll(reason) { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(reason)); } this.pending.clear(); }
}

const obs = new Obs();
let roomOpenedThisRun = false;

obs.onStatus = async (ok, error) => {
  state.obs.connected = ok;
  state.obs.error = error;
  if (ok) {
    lastItemUrl = null;
    roomIds = null;
    await checkScenes();
    if (state.obs.scenesReady) await whenReady();
    console.log('  OBS: connected' + (state.obs.scenesReady ? '' : ' (open the Setup page and press "Create the shiur scenes")'));
  }
  broadcast();
};
obs.onEvent = (type, data) => {
  if (type === 'SceneCreated' || type === 'SceneRemoved' || type === 'SceneListChanged') checkScenes().then(broadcast);
  if (type === 'RecordStateChanged') {
    if (data.outputState === 'OBS_WEBSOCKET_OUTPUT_STARTED') { state.recording = true; state.recordStartedAt = Date.now(); }
    else if (data.outputState === 'OBS_WEBSOCKET_OUTPUT_STOPPED') { state.recording = false; state.recordStartedAt = null; if (data.outputPath) state.lastRecordingPath = data.outputPath; }
    broadcast();
  }
};

async function checkScenes() {
  try {
    const r = await obs.call('GetSceneList');
    const names = (r.scenes || []).map(s => s.sceneName);
    let ok = Object.values(SCENES).every(n => names.includes(n));
    if (ok) {
      const inputs = await obs.call('GetInputList');
      const names2 = (inputs.inputs || []).map(i => i.inputName);
      ok = names2.includes(INPUTS.title) && names2.includes(INPUTS.screen);
    }
    state.obs.scenesReady = ok;
  } catch (e) { state.obs.scenesReady = false; }
}

// Make the picture sharp: OBS at least 1280x720 (16:9), and the camera at its best size.
let qualityChecked = false, relayoutTried = false;
const LAYOUT_VERSION = 3;   // raise this when the way things sit in the picture changes, so OBS is updated by itself
async function ensureVideoQuality() {
  const v = await obs.call('GetVideoSettings');
  const baseOk = v.baseWidth >= 1280 && v.baseHeight >= 720 && Math.abs(v.baseWidth / v.baseHeight - 16 / 9) < 0.02;
  const outOk = v.outputWidth >= 1280 && v.outputHeight >= 720 && Math.abs(v.outputWidth / v.outputHeight - 16 / 9) < 0.02;
  if (baseOk && outOk) return false;
  const vc = await obs.call('GetVirtualCamStatus');
  if (vc.outputActive) return false;   // can only change it while Zoom is not using the camera
  const change = { outputWidth: 1280, outputHeight: 720 };
  if (!baseOk) { change.baseWidth = 1920; change.baseHeight = 1080; }
  await obs.call('SetVideoSettings', change);
  console.log('  OBS picture size set to ' + (change.baseWidth ? '1920x1080 / ' : '') + '1280x720');
  return true;
}
async function bestCameraResolution() {
  try {
    const r = await obs.call('GetInputPropertiesListPropertyItems', { inputName: INPUTS.camera, propertyName: 'resolution' });
    const sizes = (r.propertyItems || [])
      .map(i => /^(\d+)x(\d+)$/.exec(String(i.itemValue || i.itemName || '').trim()))
      .filter(Boolean).map(m => ({ w: +m[1], h: +m[2], s: m[0] }))
      .filter(z => z.w <= 1920 && z.h <= 1080);
    if (!sizes.length) return;
    const wide = z => (Math.abs(z.w / z.h - 16 / 9) < 0.05 ? 1 : 0);
    sizes.sort((a, b) => (wide(b) - wide(a)) || (b.w * b.h - a.w * a.h));
    await obs.call('SetInputSettings', { inputName: INPUTS.camera, inputSettings: { res_type: 1, resolution: sizes[0].s } });
    config.cameraRes = sizes[0].s; saveConfig();
    console.log('  Camera set to ' + sizes[0].s);
  } catch (e) { /* not critical */ }
}

// Everything that should simply be "on" once OBS is ready: the camera for Zoom, the wall screen, the right scene.
async function whenReady() {
  if (!qualityChecked) {
    qualityChecked = true;
    try { if (await ensureVideoQuality()) { await setupScenes(); return; } } catch (e) { /* carry on */ }
  }
  if (config.layoutVersion !== LAYOUT_VERSION && !relayoutTried) {
    relayoutTried = true;
    try { await setupScenes(); return; } catch (e) { /* carry on */ }
  }
  if (!config.cameraRes) await bestCameraResolution();
  try {
    const rec = await obs.call('GetRecordStatus');
    state.recording = !!rec.outputActive;
    state.recordStartedAt = rec.outputActive ? Date.now() - (rec.outputDuration || 0) : null;
  } catch (e) { /* ignore */ }
  try {
    const vc = await obs.call('GetVirtualCamStatus');
    if (!vc.outputActive) await obs.call('StartVirtualCam');
  } catch (e) { state.message = 'Could not switch on the OBS camera for Zoom: ' + e.message; }
  if (!roomOpenedThisRun && config.roomMonitor !== null && config.roomMonitor !== undefined) {
    try { await obs.call('OpenSourceProjector', { sourceName: SCENES.room, monitorIndex: config.roomMonitor }); roomOpenedThisRun = true; } catch (e) { /* ignore */ }
  }
  await applyCrop();
  await applyToObs();
  if (LAUNCH) openZoom();
}

function screenKind() {
  if (process.platform === 'win32') return 'monitor_capture';
  if (process.platform === 'darwin') return 'screen_capture';
  return 'xshm_input';
}

function cameraKind() {
  if (process.platform === 'win32') return 'dshow_input';
  if (process.platform === 'darwin') return 'macos-avcapture';
  return 'v4l2_input';
}

async function ensureItem(sceneName, sourceName, enabled) {
  try { return (await obs.call('GetSceneItemId', { sceneName, sourceName })).sceneItemId; }
  catch (e) { return (await obs.call('CreateSceneItem', { sceneName, sourceName, sceneItemEnabled: enabled !== false })).sceneItemId; }
}
async function place(sceneName, sceneItemId, box) {
  await obs.call('SetSceneItemTransform', {
    sceneName, sceneItemId,
    sceneItemTransform: { positionX: box.x, positionY: box.y, alignment: 5, boundsType: 'OBS_BOUNDS_SCALE_INNER', boundsAlignment: 0, boundsWidth: box.w, boundsHeight: box.h }
  });
}
async function toTop(sceneName, sceneItemId) {
  const l = await obs.call('GetSceneItemList', { sceneName });
  await obs.call('SetSceneItemIndex', { sceneName, sceneItemId, sceneItemIndex: Math.max(0, (l.sceneItems || []).length - 1) });
}

// What Zoom sees: in ME, you; in SHOW and SCREEN, only the material, as big as it can be (people watch on phones).
let videoSize = { w: 1920, h: 1080 };
async function hideItem(sceneName, sourceName) {
  const id = await ensureItem(sceneName, sourceName, false);
  await obs.call('SetSceneItemEnabled', { sceneName, sceneItemId: id, sceneItemEnabled: false });
}

// The button bar sits on the edge of the laptop screen. The Shiur app tells us where the free part of the
// screen is (without the bar and the taskbar), and only that part is shown to the wall and Zoom.
let bar = null;   // { mon: {x,y,w,h}, work: {x,y,w,h} } in real screen pixels
function cropFromBar() {
  const none = { cropLeft: 0, cropTop: 0, cropRight: 0, cropBottom: 0 };
  if (!bar) return none;
  const mon = bar.mon, work = bar.work, c = v => Math.max(0, Math.round(v));
  return { cropLeft: c(work.x - mon.x), cropTop: c(work.y - mon.y), cropRight: c(mon.x + mon.w - work.x - work.w), cropBottom: c(mon.y + mon.h - work.y - work.h) };
}
async function applyCrop() {
  if (!state.obs.connected || !state.obs.scenesReady || !bar) return;
  let crop = cropFromBar();
  try {
    const id = (await obs.call('GetSceneItemId', { sceneName: SCENES.screen, sourceName: INPUTS.screen })).sceneItemId;
    const t = (await obs.call('GetSceneItemTransform', { sceneName: SCENES.screen, sceneItemId: id })).sceneItemTransform || {};
    // Only cut if OBS is capturing the same screen the bar is on.
    if (t.sourceWidth && t.sourceHeight && (Math.abs(t.sourceWidth - bar.mon.w) > 4 || Math.abs(t.sourceHeight - bar.mon.h) > 4)) crop = { cropLeft: 0, cropTop: 0, cropRight: 0, cropBottom: 0 };
  } catch (e) { return; }
  for (const sceneName of [SCENES.screen, SCENES.room]) {
    try {
      const id = (await obs.call('GetSceneItemId', { sceneName, sourceName: INPUTS.screen })).sceneItemId;
      await obs.call('SetSceneItemTransform', { sceneName, sceneItemId: id, sceneItemTransform: crop });
    } catch (e) { /* ignore */ }
  }
}

// A small live picture of what Zoom sees, for the bar.
const preview = { at: 0, buf: null, pending: null };
function getPreview() {
  if (preview.buf && Date.now() - preview.at < 700) return Promise.resolve(preview.buf);
  if (preview.pending) return preview.pending;
  const sceneName = state.mode === 'show' ? SCENES.show : state.mode === 'screen' ? SCENES.screen : SCENES.me;
  const w = 480, h = Math.round(w * videoSize.h / videoSize.w);
  preview.pending = obs.call('GetSourceScreenshot', { sourceName: sceneName, imageFormat: 'jpg', imageWidth: w, imageHeight: h, imageCompressionQuality: 70 })
    .then(r => { preview.buf = Buffer.from(String(r.imageData || '').replace(/^data:[^,]*,/, ''), 'base64'); preview.at = Date.now(); return preview.buf; })
    .finally(() => { preview.pending = null; });
  return preview.pending;
}

// ---------- starting and ending (Windows, when started by the Shiur icon) ----------

const launch = { obsStartedByUs: false, zoomOpened: false };
// Small jobs for the Shiur app on the laptop, which moves windows: bring Zoom to the front, or put it behind.
const winCmd = { seq: 0, action: null };
function windowJob(action) { winCmd.seq++; winCmd.action = action; }
function localUrl(p) { return 'http://localhost:' + config.port + p; }
function openUrl(u) {
  if (!IS_WIN || !u || process.env.SHIUR_NO_OPEN) return false;
  try { const c = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', u], { detached: true, stdio: 'ignore', windowsHide: true }); c.on('error', () => {}); c.unref(); return true; }
  catch (e) { return false; }
}
function isRunning(image) {
  return new Promise(resolve => {
    if (!IS_WIN) return resolve(false);
    execFile('tasklist', ['/FI', 'IMAGENAME eq ' + image, '/NH'], { windowsHide: true }, (err, out) => resolve(!err && String(out).toLowerCase().includes(image.toLowerCase())));
  });
}
function findObs() {
  const c = [config.obsPath];
  for (const b of [process.env.ProgramFiles, process.env.ProgramW6432, process.env['ProgramFiles(x86)']]) if (b) c.push(path.join(b, 'obs-studio', 'bin', '64bit', 'obs64.exe'));
  return c.find(f => { try { return f && fs.existsSync(f); } catch (e) { return false; } }) || null;
}
async function ensureObsRunning() {
  if (!IS_WIN || await isRunning('obs64.exe')) return;
  const exe = findObs();
  if (!exe) { state.message = 'OBS is not installed on this laptop. Get it from obsproject.com.'; broadcast(); return; }
  // If OBS was not closed properly last time, it asks about "Safe Mode" on start. Clear its note so it just starts.
  try {
    const dir = path.join(process.env.APPDATA || '', 'obs-studio', '.sentinel');
    for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { force: true, recursive: true });
  } catch (e) { /* nothing to clear */ }
  try {
    const c = spawn(exe, ['--minimize-to-tray', '--disable-shutdown-check', '--disable-updater', '--disable-missing-files-check'], { cwd: path.dirname(exe), detached: true, stdio: 'ignore' });
    c.on('error', () => {}); c.unref();
    launch.obsStartedByUs = true;
  } catch (e) { state.message = 'Could not start OBS: ' + e.message; broadcast(); }
}
// https://us02web.zoom.us/j/123456789?pwd=abc  ->  zoommtg://us02web.zoom.us/join?action=join&confno=123456789&pwd=abc
function zoomAppUrl(link) {
  let u; try { u = new URL(String(link || '').trim()); } catch (e) { return null; }
  if (!/(^|\.)zoom\.(us|com)$/i.test(u.hostname)) return null;
  const mm = /\/(?:j|w)\/(\d{9,13})/.exec(u.pathname);
  if (!mm) return null;
  const pwd = u.searchParams.get('pwd');
  return 'zoommtg://' + u.hostname + '/join?action=join&confno=' + mm[1] + (pwd ? '&pwd=' + encodeURIComponent(pwd) : '');
}
function openZoom(force) {
  if (!config.zoomLink || (launch.zoomOpened && !force) || (NO_ZOOM && !force)) return;
  launch.zoomOpened = true;
  openUrl(zoomAppUrl(config.zoomLink) || config.zoomLink);
}
function closesObs() { return IS_WIN && (LAUNCH || launch.obsStartedByUs); }
let ending = false;
async function endShiur() {
  if (ending) return;
  ending = true;
  // Stop what OBS is sending first, so it can close without asking anything.
  try { const rec = await obs.call('GetRecordStatus'); if (rec.outputActive) await obs.call('StopRecord'); } catch (e) { /* ignore */ }
  const closeObs = closesObs();
  if (closeObs) { try { await obs.call('StopVirtualCam'); } catch (e) { /* ignore */ } }
  state.ended = true; broadcast();   // the Shiur app now closes the bar and asks OBS to close
  if (closeObs) {
    // Only if OBS is still open after a while.
    setTimeout(() => isRunning('obs64.exe').then(r => { if (r) execFile('taskkill', ['/IM', 'obs64.exe'], { windowsHide: true }, () => {}); }), 8000);
    setTimeout(() => isRunning('obs64.exe').then(r => { if (r) execFile('taskkill', ['/F', '/IM', 'obs64.exe'], { windowsHide: true }, () => {}); }), 16000);
  }
  setTimeout(() => process.exit(0), closeObs ? 18000 : 3000);
}

// Builds (or repairs) the scenes. Safe to press again.
async function setupScenes() {
  const video = await obs.call('GetVideoSettings');
  const W = video.baseWidth || 1920, H = video.baseHeight || 1080;
  videoSize = { w: W, h: H };
  const full = { x: 0, y: 0, w: W, h: H };

  const scenes = new Set(((await obs.call('GetSceneList')).scenes || []).map(s => s.sceneName));
  for (const name of [SCENES.me, SCENES.show, SCENES.screen, SCENES.room]) if (!scenes.has(name)) await obs.call('CreateScene', { sceneName: name });

  const inputs = new Set(((await obs.call('GetInputList')).inputs || []).map(i => i.inputName));
  const browser = url => ({ url, width: 1280, height: 720, reroute_audio: true, shutdown: false, restart_when_active: false, css: 'body { margin: 0; }' });
  if (!inputs.has(INPUTS.item)) await obs.call('CreateInput', { sceneName: SCENES.show, inputName: INPUTS.item, inputKind: 'browser_source', inputSettings: browser(itemUrlFor(null)), sceneItemEnabled: true });
  if (!inputs.has(INPUTS.camera)) {
    const s = {}; if (config.cameraDevice) s.video_device_id = config.cameraDevice;
    await obs.call('CreateInput', { sceneName: SCENES.me, inputName: INPUTS.camera, inputKind: cameraKind(), inputSettings: s, sceneItemEnabled: true });
  }
  if (!inputs.has(INPUTS.screen)) {
    const s = { capture_cursor: true };
    if (config.screenMonitor && config.screenProp) s[config.screenProp] = config.screenMonitor;
    await obs.call('CreateInput', { sceneName: SCENES.screen, inputName: INPUTS.screen, inputKind: screenKind(), inputSettings: s, sceneItemEnabled: true });
  }
  if (!inputs.has(INPUTS.title)) await obs.call('CreateInput', { sceneName: SCENES.room, inputName: INPUTS.title, inputKind: 'browser_source', inputSettings: browser(base() + '/view/title'), sceneItemEnabled: true });

  // Me: camera fills the picture.
  await place(SCENES.me, await ensureItem(SCENES.me, INPUTS.camera), full);
  // Show (what Zoom sees): the item, full size. You are not shown, so it is as big as possible on phones.
  await place(SCENES.show, await ensureItem(SCENES.show, INPUTS.item), full);
  await hideItem(SCENES.show, INPUTS.camera);
  // Screen (what Zoom sees): the laptop screen, full size.
  await place(SCENES.screen, await ensureItem(SCENES.screen, INPUTS.screen), full);
  await hideItem(SCENES.screen, INPUTS.camera);
  // Wall: the item; the laptop screen above it in SCREEN mode; the title card on top when nothing is shown.
  await place(SCENES.room, await ensureItem(SCENES.room, INPUTS.item), full);
  const scr = await ensureItem(SCENES.room, INPUTS.screen, false);
  await place(SCENES.room, scr, full);
  await toTop(SCENES.room, scr);
  const title = await ensureItem(SCENES.room, INPUTS.title);
  await place(SCENES.room, title, full);
  await toTop(SCENES.room, title);
  try {
    const old = await obs.call('GetSceneItemId', { sceneName: SCENES.room, sourceName: INPUTS.oldTablet });
    await obs.call('SetSceneItemEnabled', { sceneName: SCENES.room, sceneItemId: old.sceneItemId, sceneItemEnabled: false });
  } catch (e) { /* not there: fine */ }
  try { await obs.call('SetInputAudioMonitorType', { inputName: INPUTS.item, monitorType: 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT' }); } catch (e) { /* not critical */ }

  roomIds = null; lastItemUrl = null;
  config.layoutVersion = LAYOUT_VERSION; saveConfig();
  await checkScenes();
  await whenReady();
}

let roomIds = null;
async function setWall(showTitle, showScreen) {
  if (!roomIds) roomIds = {
    title: (await obs.call('GetSceneItemId', { sceneName: SCENES.room, sourceName: INPUTS.title })).sceneItemId,
    screen: (await obs.call('GetSceneItemId', { sceneName: SCENES.room, sourceName: INPUTS.screen })).sceneItemId
  };
  await obs.call('SetSceneItemEnabled', { sceneName: SCENES.room, sceneItemId: roomIds.screen, sceneItemEnabled: showScreen });
  await obs.call('SetSceneItemEnabled', { sceneName: SCENES.room, sceneItemId: roomIds.title, sceneItemEnabled: showTitle });
}

async function applyToObs() {
  if (!state.obs.connected || !state.obs.scenesReady) return;
  try {
    const url = itemUrlFor(currentItem());
    if (url !== lastItemUrl) { await obs.call('SetInputSettings', { inputName: INPUTS.item, inputSettings: { url } }); lastItemUrl = url; }
    const m = state.mode;
    await setWall(m === 'me' || (m === 'show' && !currentItem()), m === 'screen');
    await obs.call('SetCurrentProgramScene', { sceneName: m === 'show' ? SCENES.show : m === 'screen' ? SCENES.screen : SCENES.me });
    state.message = null;
  } catch (e) { state.message = 'OBS problem: ' + e.message; }
}

async function update(fn) { fn(); await applyToObs(); broadcast(); return publicState(); }

function showItem(id) {
  state.currentId = id;
  state.showCounter++;
  state.view = { zoom: 1, x: 0, y: 0 };
  state.media = { paused: false, restart: state.media.restart };
  const item = currentItem();
  if (isLive(item)) {
    // Open it on the laptop and show the screen, so it can be clicked through live.
    openUrl(liveUrl(item));
    if (state.mode !== 'screen') windowJob('zoomBack');
    state.mode = 'screen';
    state.panel = 'small';
  } else {
    state.mode = 'show';
    state.panel = 'big';
  }
}

function clampView() {
  const lim = (state.view.zoom - 1) * 50;
  state.view.x = Math.max(-lim, Math.min(lim, state.view.x));
  state.view.y = Math.max(-lim, Math.min(lim, state.view.y));
}

// ---------- HTTP ----------

function send(res, code, type, body) { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body); }
function json(res, code, obj) { send(res, code, 'application/json; charset=utf-8', JSON.stringify(obj)); }
function notFound(res) { send(res, 404, 'text/plain; charset=utf-8', 'Not found'); }
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('Too large')); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function servePublic(res, name, type) {
  fs.readFile(path.join(PUBLIC, name), (err, buf) => { if (err) return notFound(res); send(res, 200, type, buf); });
}

function serveMedia(req, res, file) {
  if (!/^[a-z0-9]+\.[a-z0-9]+$/i.test(file)) return notFound(res);
  const full = path.join(MEDIA, file);
  const ext = path.extname(file).toLowerCase();
  const type = IMAGE_EXT[ext] || VIDEO_EXT[ext] || PAGE_EXT[ext] || 'application/octet-stream';
  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) return notFound(res);
    const range = req.headers.range;
    if (range) {
      const mm = /bytes=(\d*)-(\d*)/.exec(range);
      let start = mm && mm[1] ? parseInt(mm[1], 10) : 0;
      let end = mm && mm[2] ? parseInt(mm[2], 10) : st.size - 1;
      if (mm && !mm[1] && mm[2]) { start = Math.max(0, st.size - parseInt(mm[2], 10)); end = st.size - 1; }
      if (isNaN(start) || isNaN(end) || start >= st.size || start > end) { res.writeHead(416, { 'Content-Range': 'bytes */' + st.size }); return res.end(); }
      end = Math.min(end, st.size - 1);
      res.writeHead(206, { 'Content-Type': type, 'Content-Length': end - start + 1, 'Content-Range': 'bytes ' + start + '-' + end + '/' + st.size, 'Accept-Ranges': 'bytes' });
      fs.createReadStream(full, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'max-age=3600' });
      fs.createReadStream(full).pipe(res);
    }
  });
}

// The pages OBS shows: the title card, and pictures/videos that follow zoom, move and play/pause from the remote.
function viewPage(inner, script) {
  return '<!doctype html><html><head><meta charset="utf-8"><style>' +
    'html,body{margin:0;width:100%;height:100%;background:#0E1014;overflow:hidden}' +
    '#m{width:100%;height:100%;object-fit:contain;display:block;transition:transform .25s ease}' +
    '.card{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:22px;color:#F5EFE3;text-align:center;padding:0 60px;box-sizing:border-box}' +
    '.card h1{margin:0;font-size:104px;font-weight:700;font-family:Georgia,"Times New Roman",serif;line-height:1.15}' +
    '.card p{margin:0;font-size:36px;color:#C9C2B4;font-family:"Segoe UI",Arial,sans-serif}' +
    '</style></head><body>' + inner + '<script>' + script + '</script></body></html>';
}
const FOLLOW_SCRIPT = `
var restart=null;
function apply(s){
  var v=s.view||{zoom:1,x:0,y:0}, m=document.getElementById('m');
  if(m) m.style.transform='translate('+v.x+'%,'+v.y+'%) scale('+v.zoom+')';
  if(m && m.tagName==='VIDEO'){
    if(restart===null) restart=s.media.restart;
    if(s.media.restart!==restart){ restart=s.media.restart; m.currentTime=0; }
    if(s.media.paused||s.mode!=='show'){ if(!m.paused) m.pause(); }
    else if(m.paused && !m.ended){ var p=m.play(); if(p&&p.catch)p.catch(function(){}); }
  }
}
var es=new EventSource('/api/events'); es.onmessage=function(e){ apply(JSON.parse(e.data)); };`;
const TITLE_SCRIPT = `
var es=new EventSource('/api/events');
es.onmessage=function(e){ var s=JSON.parse(e.data); document.getElementById('t').textContent=s.title||'Daf Yomi shiur'; };`;

function handleView(req, res, url) {
  const kind = url.pathname.slice('/view/'.length);
  if (kind === 'title') {
    return send(res, 200, 'text/html; charset=utf-8', viewPage('<div class="card"><h1 id="t" dir="auto">' + esc(list.title || 'Daf Yomi shiur') + '</h1></div>', TITLE_SCRIPT));
  }
  if (kind === 'file') {
    const f = url.searchParams.get('f') || '';
    if (!/^[a-z0-9]+\.[a-z0-9]+$/i.test(f)) return notFound(res);
    const src = '/media/' + encodeURIComponent(f);
    const inner = url.searchParams.get('t') === 'video'
      ? '<video id="m" src="' + src + '" autoplay playsinline></video>'
      : '<img id="m" src="' + src + '" alt="">';
    return send(res, 200, 'text/html; charset=utf-8', viewPage(inner, FOLLOW_SCRIPT));
  }
  if (kind === 'picture') {
    const u = url.searchParams.get('u') || '';
    if (!/^https?:\/\//i.test(u)) return notFound(res);
    return send(res, 200, 'text/html; charset=utf-8', viewPage('<img id="m" src="' + esc(u) + '" alt="" referrerpolicy="no-referrer">', FOLLOW_SCRIPT));
  }
  notFound(res);
}

function handleUpload(req, res, url) {
  const name = String(url.searchParams.get('name') || 'file').slice(0, 200);
  const showNow = url.searchParams.get('show') === '1';
  const ext = path.extname(name).toLowerCase();
  const type = kindOf(ext);
  if (!type) return json(res, 400, { error: 'Only pictures, videos, Claude charts (.html) and PDFs can be added.' });
  const id = newId();
  const fileName = id + ext;
  const partPath = path.join(MEDIA, fileName + '.part');
  const out = fs.createWriteStream(partPath);
  let size = 0, failed = false;
  req.on('data', c => {
    size += c.length;
    if (size > MAX_UPLOAD && !failed) { failed = true; req.unpipe(out); out.destroy(); fs.unlink(partPath, () => {}); json(res, 413, { error: 'That file is bigger than 1 GB.' }); req.destroy(); }
  });
  req.pipe(out);
  out.on('finish', async () => {
    if (failed) return;
    fs.renameSync(partPath, path.join(MEDIA, fileName));
    let title = path.basename(name, path.extname(name)).replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!title || /^(image|img|photo|video|screenshot)?\s*\d*$/i.test(title)) title = '';
    const n = list.items.filter(it => it.type === type).length + 1;
    const item = { id, type, title: (title || (type === 'video' ? 'Video ' : type === 'page' ? 'Chart ' : 'Picture ') + n).slice(0, 120), file: fileName };
    list.items.push(item);
    saveList();
    if (showNow) { showItem(item.id); await applyToObs(); }
    broadcast();
    json(res, 200, { item });
  });
  out.on('error', () => { if (failed) return; failed = true; fs.unlink(partPath, () => {}); json(res, 500, { error: 'Could not save the file.' }); });
}

function titleFromName(name) {
  let t = path.basename(name, path.extname(name)).replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (/^(image|img|photo|video|screenshot|download)?[\s-]*\(?\d*\)?$/i.test(t)) t = '';
  return t.slice(0, 120);
}
// Your newest files in Downloads: pictures, videos, Claude charts (.html) and PDFs.
function recentFiles() {
  let names = [];
  try { names = fs.readdirSync(DOWNLOADS); } catch (e) { return []; }
  const out = [];
  for (const name of names) {
    const ext = path.extname(name).toLowerCase(), kind = kindOf(ext);
    if (!kind || name.startsWith('.')) continue;
    try { const st = fs.statSync(path.join(DOWNLOADS, name)); if (st.isFile()) out.push({ name, kind, ext, size: st.size, mtime: st.mtimeMs, pdf: ext === '.pdf' }); } catch (e) { /* skip */ }
  }
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, 24);
}
function recentFile(name) {
  name = String(name || '');
  if (!name || name !== path.basename(name) || name.includes('..')) return null;
  const ext = path.extname(name).toLowerCase(), kind = kindOf(ext);
  const full = path.join(DOWNLOADS, name);
  try { if (!kind || !fs.statSync(full).isFile()) return null; } catch (e) { return null; }
  return { name, ext, kind, full };
}

function lanAddresses() {
  const out = [];
  for (const l of Object.values(os.networkInterfaces())) for (const a of l || []) if ((a.family === 'IPv4' || a.family === 4) && !a.internal) out.push(a.address);
  return out;
}
function setupStatus() {
  return { obs: state.obs, obsHost: config.obsHost, obsPort: config.obsPort, passwordSet: !!config.obsPassword, cameraDevice: config.cameraDevice, screenMonitor: config.screenMonitor, roomMonitor: config.roomMonitor, recordButton: !!config.recordButton, port: config.port, addresses: lanAddresses(), zoomLink: config.zoomLink || '', launched: LAUNCH, hasBar: !!bar, isWindows: IS_WIN };
}

async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname, m = req.method;

  if (m === 'GET') {
    if (p === '/' || p === '/controller') return servePublic(res, 'controller.html', 'text/html; charset=utf-8');
    if (p === '/setup') return servePublic(res, 'setup.html', 'text/html; charset=utf-8');
    if (p === '/bar') return servePublic(res, 'bar.html', 'text/html; charset=utf-8');
    if (p === '/api/ping') return json(res, 200, { ok: true, ended: state.ended, closeObs: closesObs(), panel: state.panel, mode: state.mode, seq: winCmd.seq, action: winCmd.action });
    if (p === '/api/preview.jpg') {
      if (!state.obs.connected || !state.obs.scenesReady) return send(res, 503, 'text/plain', 'Not ready');
      try { const buf = await getPreview(); return send(res, 200, 'image/jpeg', buf); }
      catch (e) { return send(res, 503, 'text/plain', 'Not ready'); }
    }
    if (p === '/app.css') return servePublic(res, 'app.css', 'text/css; charset=utf-8');
    if (p.startsWith('/media/')) return serveMedia(req, res, decodeURIComponent(p.slice(7)));
    if (p.startsWith('/view/')) return handleView(req, res, url);
    if (p === '/api/state') return json(res, 200, publicState());
    if (p === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write('retry: 2000\n\n');
      res.write('data: ' + JSON.stringify(publicState()) + '\n\n');
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }
    if (p === '/api/setup/status') return json(res, 200, setupStatus());
    if (p === '/api/setup/cameras') {
      try {
        const r = await obs.call('GetInputPropertiesListPropertyItems', { inputName: INPUTS.camera, propertyName: 'video_device_id' });
        return json(res, 200, { items: (r.propertyItems || []).filter(i => i.itemEnabled !== false).map(i => ({ name: i.itemName, value: i.itemValue })) });
      } catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (p === '/api/setup/screens') {
      for (const prop of ['monitor_id', 'monitor']) {
        try {
          const r = await obs.call('GetInputPropertiesListPropertyItems', { inputName: INPUTS.screen, propertyName: prop });
          const items = (r.propertyItems || []).filter(i => i.itemEnabled !== false).map(i => ({ name: i.itemName, value: String(i.itemValue), prop }));
          if (items.length) return json(res, 200, { items });
        } catch (e) { /* try the next name */ }
      }
      return json(res, 400, { error: 'Could not list the laptop screens. Press "Create the shiur scenes" first.' });
    }
    if (p === '/api/tiles') return json(res, 200, { tiles: config.tiles || DEFAULT_TILES });
    if (p === '/api/recent') return json(res, 200, { files: recentFiles() });
    if (p.startsWith('/dl/')) {
      const f = recentFile(decodeURIComponent(p.slice(4)));
      if (!f) return notFound(res);
      const type = IMAGE_EXT[f.ext] || VIDEO_EXT[f.ext] || PAGE_EXT[f.ext];
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      return fs.createReadStream(f.full).pipe(res);
    }
    if (p === '/start') return servePublic(res, 'start.html', 'text/html; charset=utf-8');
    if (p === '/api/setup/monitors') {
      try {
        const r = await obs.call('GetMonitorList');
        return json(res, 200, { items: (r.monitors || []).map(mo => ({ name: (mo.monitorName || 'Screen') + ' (' + mo.monitorWidth + ' x ' + mo.monitorHeight + ')', value: mo.monitorIndex })) });
      } catch (e) { return json(res, 400, { error: e.message }); }
    }
    return notFound(res);
  }

  if (m === 'POST' && p === '/api/upload') return handleUpload(req, res, url);

  if (m === 'POST') {
    let body;
    try { const t = await readBody(req, 1024 * 1024); body = t ? JSON.parse(t) : {}; } catch (e) { return json(res, 400, { error: 'Bad request' }); }

    if (p === '/api/mode') {
      if (!['me', 'show', 'screen'].includes(body.mode)) return json(res, 400, { error: 'Bad mode' });
      if (body.mode === 'screen' && state.mode !== 'screen') windowJob('zoomBack');   // keep Zoom's own window out of the picture
      return json(res, 200, await update(() => { state.mode = body.mode; state.panel = body.mode === 'screen' ? 'small' : 'big'; }));
    }
    if (p === '/api/panel') {
      // big: the app fills the laptop screen (only when the screen is not being shown). small: a strip at the bottom.
      if (body.size === 'big') return json(res, 200, await update(() => { if (state.mode === 'screen') state.mode = 'me'; state.panel = 'big'; }));
      return json(res, 200, await update(() => { state.panel = 'small'; }));
    }
    if (p === '/api/open-url') {
      // A "look something up" button: open the site on the laptop, privately, with the app as a strip.
      const u = String(body.url || '');
      if (!/^https?:\/\//i.test(u)) return json(res, 400, { error: 'That button has no web address yet.' });
      const opened = openUrl(u);
      await update(() => { state.panel = 'small'; });
      return json(res, 200, { opened, url: u });
    }
    if (p === '/api/recent/open' || p === '/api/recent/add') {
      const f = recentFile(body.name);
      if (!f) return json(res, 404, { error: 'That file is not in Downloads any more.' });
      if (p === '/api/recent/open') {
        const u = localUrl('/dl/' + encodeURIComponent(f.name));
        const opened = openUrl(u);
        await update(() => { state.panel = 'small'; });
        return json(res, 200, { opened, url: '/dl/' + encodeURIComponent(f.name) });
      }
      const id = newId(), fileName = id + f.ext;
      try { fs.copyFileSync(f.full, path.join(MEDIA, fileName)); } catch (e) { return json(res, 500, { error: 'Could not copy that file.' }); }
      const item = cleanItem({ id, type: f.kind, file: fileName, title: titleFromName(f.name) });
      list.items.push(item); saveList();
      broadcast();
      return json(res, 200, { item });
    }
    if (p === '/api/show') {
      if (!list.items.find(x => x.id === body.id)) return json(res, 404, { error: 'That item is no longer in the list.' });
      return json(res, 200, await update(() => showItem(body.id)));
    }
    if (p === '/api/next' || p === '/api/prev') {
      if (!list.items.length) return json(res, 200, publicState());
      let i = currentIndex();
      if (i === -1) i = p === '/api/next' ? 0 : list.items.length - 1;
      else i = p === '/api/next' ? Math.min(list.items.length - 1, i + 1) : Math.max(0, i - 1);
      return json(res, 200, await update(() => showItem(list.items[i].id)));
    }
    if (p === '/api/add-link') {
      const item = cleanItem({ type: 'link', url: body.url, title: body.title });
      if (!item) return json(res, 400, { error: 'That does not look like a web address.' });
      list.items.push(item);
      saveList();
      return json(res, 200, await update(() => { if (body.show) showItem(item.id); }));
    }
    if (p === '/api/list') {
      const items = (Array.isArray(body.items) ? body.items : list.items).map(cleanItem).filter(Boolean);
      const seen = new Set();
      list = { title: typeof body.title === 'string' ? body.title.slice(0, 80) : list.title, items: items.filter(it => (seen.has(it.id) ? false : (seen.add(it.id), true))) };
      saveList();
      removeUnusedMedia();
      return json(res, 200, await update(() => { if (state.currentId && !currentItem()) { state.currentId = null; state.mode = 'me'; } }));
    }
    if (p === '/api/list/clear') {
      list = { title: list.title, items: [] };
      saveList();
      removeUnusedMedia();
      return json(res, 200, await update(() => { state.currentId = null; state.mode = 'me'; }));
    }
    if (p === '/api/view') {
      const a = body.action;
      return json(res, 200, await update(() => {
        const v = state.view;
        const zi = ZOOMS.indexOf(v.zoom);
        if (a === 'in') v.zoom = ZOOMS[Math.min(ZOOMS.length - 1, (zi < 0 ? 0 : zi) + 1)];
        else if (a === 'out') v.zoom = ZOOMS[Math.max(0, (zi < 0 ? 0 : zi) - 1)];
        else if (a === 'fit') { v.zoom = 1; v.x = 0; v.y = 0; }
        else if (a === 'up') v.y += PAN_STEP;
        else if (a === 'down') v.y -= PAN_STEP;
        else if (a === 'left') v.x += PAN_STEP;
        else if (a === 'right') v.x -= PAN_STEP;
        clampView();
      }));
    }
    if (p === '/api/media') {
      return json(res, 200, await update(() => {
        if (body.action === 'restart') state.media = { paused: false, restart: state.media.restart + 1 };
        else state.media = { paused: !state.media.paused, restart: state.media.restart };
      }));
    }

    if (p === '/api/record') {
      if (!config.recordButton) return json(res, 400, { error: 'Recording is switched off in Setup.' });
      try {
        const rec = await obs.call('GetRecordStatus');
        if (body.action === 'start' && !rec.outputActive) await obs.call('StartRecord');
        if (body.action === 'stop' && rec.outputActive) { const r = await obs.call('StopRecord'); if (r.outputPath) state.lastRecordingPath = r.outputPath; state.recording = false; state.recordStartedAt = null; }
      } catch (e) { return json(res, 400, { error: 'Recording problem: ' + e.message }); }
      broadcast();
      return json(res, 200, publicState());
    }
    if (p === '/api/setup/record-button') {
      config.recordButton = !!body.on; saveConfig(); broadcast();
      return json(res, 200, setupStatus());
    }
    if (p === '/api/setup/obs') {
      if (typeof body.obsHost === 'string' && body.obsHost.trim()) config.obsHost = body.obsHost.trim();
      if (body.obsPort) config.obsPort = parseInt(body.obsPort, 10) || 4455;
      if (typeof body.obsPassword === 'string' && body.obsPassword !== '') config.obsPassword = body.obsPassword;
      saveConfig();
      state.obs.error = 'Connecting to OBS...';
      obs.connect();
      return json(res, 200, setupStatus());
    }
    if (p === '/api/setup/scenes') {
      try { await setupScenes(); broadcast(); return json(res, 200, { ok: true }); }
      catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (p === '/api/setup/camera') {
      try {
        await obs.call('SetInputSettings', { inputName: INPUTS.camera, inputSettings: { video_device_id: String(body.value || '') } });
        config.cameraDevice = String(body.value || ''); config.cameraRes = ''; saveConfig();
        await bestCameraResolution();
        return json(res, 200, { ok: true });
      } catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (p === '/api/setup/screen') {
      try {
        const prop = body.prop === 'monitor' ? 'monitor' : 'monitor_id';
        const value = prop === 'monitor' ? parseInt(body.value, 10) : String(body.value || '');
        await obs.call('SetInputSettings', { inputName: INPUTS.screen, inputSettings: { [prop]: value, capture_cursor: true } });
        config.screenMonitor = value; config.screenProp = prop; saveConfig();
        return json(res, 200, { ok: true });
      } catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (p === '/api/tiles') {
      const tiles = (Array.isArray(body.tiles) ? body.tiles : []).slice(0, 12).map(t => ({ name: String(t.name || '').slice(0, 40), url: /^https?:\/\//i.test(String(t.url || '').trim()) ? String(t.url).trim().slice(0, 500) : '' })).filter(t => t.name);
      config.tiles = tiles; saveConfig();
      return json(res, 200, { tiles });
    }
    if (p === '/api/bar') {
      const box = b => b && [b.x, b.y, b.w, b.h].every(v => typeof v === 'number' && isFinite(v)) && b.w > 0 && b.h > 0 ? { x: b.x, y: b.y, w: b.w, h: b.h } : null;
      const mon = box(body.mon), work = box(body.work);
      if (!mon || !work) return json(res, 400, { error: 'Bad bar position' });
      bar = { mon, work, zoomPanel: !!body.zoomPanel };
      await applyCrop(); broadcast();
      return json(res, 200, { ok: true, crop: cropFromBar() });
    }
    if (p === '/api/launch') { if (state.mode !== 'screen') { state.panel = 'big'; broadcast(); } ensureObsRunning().then(() => { if (state.obs.connected && state.obs.scenesReady) whenReady().then(broadcast); }); return json(res, 200, { ok: true }); }
    if (p === '/api/end') { json(res, 200, { ok: true }); endShiur(); return; }
    if (p === '/api/open-zoom') {
      if (!config.zoomLink) return json(res, 200, { opened: openUrl(localUrl('/setup')), setup: true });
      openZoom(true);
      return json(res, 200, { ok: true });
    }
    if (p === '/api/zoom-front') {
      // Show the Zoom tiles on the laptop. If the screen is being shown, go to ME first so nobody sees them.
      await update(() => { if (state.mode === 'screen') state.mode = 'me'; state.panel = 'small'; });
      windowJob('zoomFront');
      return json(res, 200, { ok: true, hasBar: !!bar });
    }
    if (p === '/api/open') {
      const pages = { editor: '/', start: '/start', setup: '/setup' };
      const page = pages[body.page];
      if (!page) return json(res, 400, { error: 'Unknown page' });
      // It opens in the browser on the laptop: make the app small so it can be seen (and stop showing the screen first).
      await update(() => { if (state.mode === 'screen') state.mode = 'me'; state.panel = 'small'; });
      return json(res, 200, { opened: openUrl(localUrl(page)), url: page });
    }
    if (p === '/api/setup/zoom') {
      const link = String(body.link || '').trim();
      if (link) {
        let ok = false; try { const u = new URL(link); ok = /^https?:$/.test(u.protocol) && /(^|\.)zoom\.(us|com)$/i.test(u.hostname); } catch (e) { /* not a link */ }
        if (!ok) return json(res, 400, { error: 'That does not look like a Zoom meeting link.' });
      }
      config.zoomLink = link.slice(0, 500); saveConfig();
      return json(res, 200, setupStatus());
    }
    if (p === '/api/setup/room-screen') {
      try {
        const idx = parseInt(body.value, 10);
        const monitorIndex = isNaN(idx) ? -1 : idx;
        await obs.call('OpenSourceProjector', { sourceName: SCENES.room, monitorIndex });
        config.roomMonitor = monitorIndex; saveConfig(); roomOpenedThisRun = true;
        return json(res, 200, { ok: true });
      } catch (e) { return json(res, 400, { error: e.message }); }
    }
    return notFound(res);
  }
  notFound(res);
}

const server = http.createServer((req, res) => {
  route(req, res).catch(err => { console.error(err); try { json(res, 500, { error: 'Something went wrong: ' + err.message }); } catch (e) { /* ignore */ } });
});
server.on('error', err => {
  if (err.code === 'EADDRINUSE') console.log('\n  The Shiur Controller is already running (or port ' + config.port + ' is busy). Close the other window first.\n');
  else console.log('\n  Could not start: ' + err.message + '\n');
  process.exit(1);
});
server.listen(config.port, '0.0.0.0', () => {
  const addrs = lanAddresses();
  console.log('');
  console.log('  ==============================================');
  console.log('   Shiur Controller is running');
  console.log('  ==============================================');
  console.log('   Setup (this laptop):  http://localhost:' + config.port + '/setup');
  for (const a of addrs) console.log('   Remote (iPad/phone):  http://' + a + ':' + config.port);
  console.log('');
  console.log('   Keep this window open during the shiur.');
  console.log('  ==============================================');
  console.log('');
  obs.connect();
  if (LAUNCH) {
    // Started by the Shiur icon: start OBS hidden. If setup is not finished after a while, open the Setup page.
    ensureObsRunning();
    setTimeout(() => { if (!state.obs.connected || !state.obs.scenesReady) { state.panel = 'small'; broadcast(); openUrl(localUrl('/setup')); } }, 25000);
  } else if (IS_WIN && !process.env.SHIUR_NO_BROWSER) exec('start "" "http://localhost:' + config.port + '/setup"');
});

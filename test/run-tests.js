'use strict';
// Tests the engine (server.js) against a pretend OBS. Run with: npm test
// GitHub runs this before every build; a failing test stops the release.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 18090, OBS_PORT = 14455;
const BASE = 'http://127.0.0.1:' + PORT;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shiur-test-'));
const dataDir = path.join(tmp, 'data'), downloads = path.join(tmp, 'downloads'), stateFile = path.join(tmp, 'obs.json');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(downloads, { recursive: true });
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ port: PORT, obsPort: OBS_PORT, obsPassword: 'secret123' }));
fs.writeFileSync(path.join(downloads, 'Months chart.html'), '<!doctype html><title>Months</title><h1>Months</h1>');
fs.writeFileSync(path.join(downloads, 'notes.txt'), 'not shown');

const kids = [];
function start(file, args, env) {
  const p = spawn(process.execPath, [file].concat(args || []), { env: Object.assign({}, process.env, env), stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { out += d; });
  p.output = () => out;
  kids.push(p);
  return p;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function get(p) { const r = await fetch(BASE + p); return r.headers.get('content-type').includes('json') ? r.json() : r.text(); }
async function post(p, body) {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const j = await r.json(); j._status = r.status; return j;
}
const obsState = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
function item(scene, source) { return (obsState().items[scene] || []).find(i => i.sourceName === source); }

let failed = 0, passed = 0;
function check(name, ok, info) {
  if (ok) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (info !== undefined ? '  -> ' + JSON.stringify(info) : '')); }
}

async function main() {
  start(path.join(__dirname, 'mock-obs.js'), [stateFile], { MOCK_OBS_PORT: String(OBS_PORT) });
  await sleep(600);
  const server = start(path.join(ROOT, 'server.js'), [], { SHIUR_DATA_DIR: dataDir, SHIUR_DOWNLOADS: downloads, SHIUR_NO_BROWSER: '1', SHIUR_NO_OPEN: '1' });
  for (let i = 0; i < 40; i++) { try { await get('/api/ping'); break; } catch (e) { await sleep(250); } }
  for (let i = 0; i < 40; i++) { if ((await get('/api/state')).obs.connected) break; await sleep(250); }

  console.log('Engine and OBS');
  check('connects to OBS', (await get('/api/state')).obs.connected);
  check('pages are served', ['/', '/bar', '/setup', '/start'].every(Boolean) && (await get('/bar')).includes('Shiur bar'));
  const scenes = await post('/api/setup/scenes');
  check('creates the scenes', scenes.ok === true, scenes);
  const st = obsState();
  check('all four scenes exist', ['Shiur - Me', 'Shiur - Material', 'Shiur - Screen', 'Shiur - Room'].every(n => st.scenes.includes(n)), st.scenes);
  check('OBS picture set to at least 1280x720', st.video.outputWidth >= 1280 && st.video.outputHeight >= 720, st.video);
  check('virtual camera for Zoom is on', st.vc === true);
  const mat = item('Shiur - Material', 'Shiur Material').transform, scr = item('Shiur - Screen', 'Shiur Laptop Screen').transform;
  check('on Zoom, the item and the screen fill the whole picture', mat.positionX === 0 && mat.boundsWidth === st.video.baseWidth && scr.positionX === 0 && scr.boundsWidth === st.video.baseWidth, { mat, scr });
  check('on Zoom, you are not shown with the item or the screen', item('Shiur - Material', 'Shiur Camera').enabled === false && item('Shiur - Screen', 'Shiur Camera').enabled === false);

  console.log('Modes and the app size');
  let s = await post('/api/mode', { mode: 'screen' });
  check('SCREEN: shows the screen, app becomes the strip', s.mode === 'screen' && s.panel === 'small' && obsState().current === 'Shiur - Screen', [s.mode, s.panel]);
  check('SCREEN: the wall shows the screen', item('Shiur - Room', 'Shiur Laptop Screen').enabled === true && item('Shiur - Room', 'Shiur Title Card').enabled === false);
  check('SCREEN: nothing else peeks out around the screen on the wall', item('Shiur - Room', 'Shiur Material').enabled === false);
  s = await post('/api/mode', { mode: 'me' });
  check('ME: Zoom sees you, the app is big again', s.mode === 'me' && s.panel === 'big' && obsState().current === 'Shiur - Me', [s.mode, s.panel]);
  check('ME: the wall shows the title', item('Shiur - Room', 'Shiur Title Card').enabled === true && item('Shiur - Room', 'Shiur Material').enabled === true);
  const ping = await get('/api/ping');
  check('ping tells the app the size and mode', ping.panel === 'big' && ping.mode === 'me', ping);

  console.log('The strip is cut out of what people see');
  const bar = await post('/api/bar', { mon: { x: 0, y: 0, w: 1366, h: 768 }, work: { x: 0, y: 0, w: 1366, h: 628 }, zoomPanel: true });
  check('crop matches the free part of the screen', bar.crop && bar.crop.cropBottom === 140 && bar.crop.cropRight === 0, bar.crop);
  check('crop applied to the screen in OBS', item('Shiur - Screen', 'Shiur Laptop Screen').transform.cropBottom === 140);

  console.log('Tonight\'s list');
  const recent = await get('/api/recent');
  check('recent downloads lists charts but not other files', recent.files.length === 1 && recent.files[0].name === 'Months chart.html', recent.files);
  const added = await post('/api/recent/add', { name: 'Months chart.html' });
  check('a chart from Downloads can be added', added.item && added.item.type === 'page', added);
  const link = await post('/api/add-link', { url: 'https://example.com/picture.png' });
  check('a picture link can be added', link.items.some(i => i.picture === true));
  s = await post('/api/show', { id: link.items.find(i => i.picture).id });
  check('a picture is SHOWn, app stays big', s.mode === 'show' && s.panel === 'big', [s.mode, s.panel]);
  s = await post('/api/show', { id: added.item.id });
  check('a chart opens live on the screen (SCREEN, strip)', s.mode === 'screen' && s.panel === 'small', [s.mode, s.panel]);
  await post('/api/mode', { mode: 'me' });
  s = await post('/api/mode', { mode: 'show' });
  check('SHOW with a chart opens it live too, never a still copy', s.mode === 'screen' && s.panel === 'small', [s.mode, s.panel]);
  check('the app is told to bring the chart onto the laptop screen', (await get('/api/ping')).action === 'live');
  const bad = await post('/api/recent/add', { name: '../server.js' });
  check('files outside Downloads are refused', bad._status === 404);

  console.log('Zoom and setup');
  check('a bad Zoom link is refused', (await post('/api/setup/zoom', { link: 'https://example.com' }))._status === 400);
  check('a Zoom link is saved', (await post('/api/setup/zoom', { link: 'https://us02web.zoom.us/j/81234567890?pwd=abc' })).zoomLink.includes('zoom.us'));
  s = await post('/api/zoom-front');
  check('opening Zoom big stops showing the screen and makes the app small', (await get('/api/state')).mode === 'me' && (await get('/api/state')).panel === 'small');

  console.log('Ending');
  await post('/api/end');
  await sleep(500);   // it first stops what OBS is sending
  check('End shiur tells the app it has ended', (await get('/api/ping')).ended === true);
  await sleep(3500);
  check('the engine stops by itself after ending', server.exitCode !== null || server.signalCode !== null);
}

main().catch(e => { failed++; console.log('  FAIL crashed: ' + (e && e.stack || e)); }).finally(() => {
  for (const k of kids) { try { k.kill(); } catch (e) { /* ignore */ } }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { const srv = kids[1]; if (srv) console.log('\nEngine output:\n' + srv.output()); }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  process.exit(failed ? 1 : 0);
});

// A pretend OBS (obs-websocket v5) for testing the engine without OBS. Used by test/run-tests.js.
// Usage: node test/mock-obs.js [state-file]   (port: MOCK_OBS_PORT, default 4455; password: secret123)
const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const fs = require('fs');
const PASSWORD = 'secret123';
const LOG = process.argv[2] || null;
const SHOT = 'data:image/jpg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//2wBDAQ4ODhMREyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0//wAARCAASACADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDFoooruOUKKKKACiiigAooooA//9k=';
const b64 = s => crypto.createHash('sha256').update(s).digest('base64');
const st = { scenes: ['Scene'], current: 'Scene', inputs: {}, items: { Scene: [] }, next: 1, rec: false, vc: false, projectors: [], log: [] };
// Written in one go (temp file + rename) so the tests never read half a file.
const dump = () => { if (!LOG) return; const t = JSON.stringify(st, null, 2); try { fs.writeFileSync(LOG + '.tmp', t); fs.renameSync(LOG + '.tmp', LOG); } catch (e) { try { fs.writeFileSync(LOG, t); } catch (e2) { /* ignore */ } } };
let clients = [];
const emit = (eventType, eventData) => clients.forEach(ws => ws.send(JSON.stringify({ op: 5, d: { eventType, eventIntent: 1, eventData } })));
const item = (sc, id) => { const it = (st.items[sc] || []).find(i => i.sceneItemId === id); if (!it) throw new Error('No item ' + id + ' in ' + sc); return it; };
function handle(t, d) {
  switch (t) {
    case 'GetSceneList': return { currentProgramSceneName: st.current, scenes: st.scenes.map(n => ({ sceneName: n })) };
    case 'CreateScene': if (st.scenes.includes(d.sceneName)) throw new Error('exists'); st.scenes.push(d.sceneName); st.items[d.sceneName] = []; emit('SceneCreated', { sceneName: d.sceneName }); return {};
    case 'GetInputList': return { inputs: Object.keys(st.inputs).map(n => ({ inputName: n, inputKind: st.inputs[n].kind })) };
    case 'CreateInput': { if (st.inputs[d.inputName]) throw new Error('exists'); st.inputs[d.inputName] = { kind: d.inputKind, settings: d.inputSettings || {} }; const id = st.next++; st.items[d.sceneName].push({ sceneItemId: id, sourceName: d.inputName, enabled: d.sceneItemEnabled !== false }); return { sceneItemId: id }; }
    case 'GetVideoSettings': return st.video || (st.video = { baseWidth: 1366, baseHeight: 768, outputWidth: 852, outputHeight: 480 });
    case 'SetVideoSettings': if (st.vc) throw new Error('output active'); st.video = Object.assign(st.video || {}, d); return {};
    case 'GetSceneItemId': { const it = (st.items[d.sceneName] || []).find(i => i.sourceName === d.sourceName); if (!it) throw new Error('No source ' + d.sourceName); return { sceneItemId: it.sceneItemId }; }
    case 'CreateSceneItem': { if (!st.inputs[d.sourceName]) throw new Error('No source'); const id = st.next++; st.items[d.sceneName].push({ sceneItemId: id, sourceName: d.sourceName, enabled: d.sceneItemEnabled !== false }); return { sceneItemId: id }; }
    case 'SetSceneItemTransform': { const it = item(d.sceneName, d.sceneItemId); it.transform = Object.assign(it.transform || {}, d.sceneItemTransform); return {}; }
    case 'GetSceneItemList': return { sceneItems: st.items[d.sceneName].map(i => ({ sceneItemId: i.sceneItemId, sourceName: i.sourceName })) };
    case 'SetSceneItemIndex': { const a = st.items[d.sceneName], it = item(d.sceneName, d.sceneItemId); a.splice(a.indexOf(it), 1); a.splice(d.sceneItemIndex, 0, it); return {}; }
    case 'SetSceneItemEnabled': item(d.sceneName, d.sceneItemId).enabled = d.sceneItemEnabled; return {};
    case 'SetInputSettings': if (!st.inputs[d.inputName]) throw new Error('No input'); Object.assign(st.inputs[d.inputName].settings, d.inputSettings); return {};
    case 'SetInputAudioMonitorType': st.inputs[d.inputName].monitor = d.monitorType; return {};
    case 'SetCurrentProgramScene': if (!st.scenes.includes(d.sceneName)) throw new Error('No scene'); st.current = d.sceneName; return {};
    case 'GetRecordStatus': return { outputActive: st.rec, outputDuration: st.rec ? 5000 : 0 };
    case 'StartRecord': st.rec = true; emit('RecordStateChanged', { outputActive: true, outputState: 'OBS_WEBSOCKET_OUTPUT_STARTED' }); return {};
    case 'StopRecord': st.rec = false; emit('RecordStateChanged', { outputActive: false, outputState: 'OBS_WEBSOCKET_OUTPUT_STOPPED', outputPath: 'C:\\Videos\\shiur.mkv' }); return { outputPath: 'C:\\Videos\\shiur.mkv' };
    case 'GetVirtualCamStatus': return { outputActive: st.vc };
    case 'StartVirtualCam': st.vc = true; return {};
    case 'GetInputPropertiesListPropertyItems': if (d.propertyName === 'resolution') return { propertyItems: ['640x480','1280x720','1920x1080','2560x1440','1280x960'].map(x => ({ itemName: x, itemValue: x, itemEnabled: true })) }; if (d.propertyName === 'monitor_id') return { propertyItems: [{ itemName: 'Built-in display (1920x1080)', itemValue: '\\\\?\\DISPLAY#BOE0900', itemEnabled: true }, { itemName: 'TV (3840x2160)', itemValue: '\\\\?\\DISPLAY#SAM7100', itemEnabled: true }] }; return { propertyItems: [{ itemName: 'Integrated Webcam', itemValue: 'cam1', itemEnabled: true }, { itemName: 'USB Camera', itemValue: 'cam2', itemEnabled: true }] };
    case 'GetMonitorList': return { monitors: [{ monitorName: 'Laptop', monitorIndex: 0, monitorWidth: 1920, monitorHeight: 1080 }, { monitorName: 'TV', monitorIndex: 1, monitorWidth: 3840, monitorHeight: 2160 }] };
    case 'OpenSourceProjector': st.projectors.push(d); return {};
    case 'GetSceneItemTransform': { const it = item(d.sceneName, d.sceneItemId); const src = it.sourceName === 'Shiur Laptop Screen' ? [1366, 768] : [1920, 1080]; return { sceneItemTransform: Object.assign({ sourceWidth: src[0], sourceHeight: src[1] }, it.transform || {}) }; }
    case 'GetSourceScreenshot': return { imageData: SHOT };
    case 'StopVirtualCam': st.vc = false; return {};
    default: throw new Error('Mock does not know ' + t);
  }
}
const wss = new WebSocketServer({ port: parseInt(process.env.MOCK_OBS_PORT || '4455', 10) });
wss.on('connection', ws => {
  const salt = crypto.randomBytes(16).toString('base64'), challenge = crypto.randomBytes(16).toString('base64');
  ws.send(JSON.stringify({ op: 0, d: { rpcVersion: 1, authentication: { salt, challenge } } }));
  ws.on('message', raw => {
    const m = JSON.parse(raw);
    if (m.op === 1) {
      if (m.d.authentication !== b64(b64(PASSWORD + salt) + challenge)) { ws.close(4009, 'auth'); return; }
      clients.push(ws); ws.on('close', () => { clients = clients.filter(c => c !== ws); });
      ws.send(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } }));
    } else if (m.op === 6) {
      const { requestType, requestId, requestData } = m.d;
      st.log.push(requestType);
      let out; try { out = { ok: true, data: handle(requestType, requestData || {}) }; } catch (e) { out = { ok: false, c: e.message }; }
      dump();   // save before answering, so the tests see the change as soon as the engine replies
      ws.send(JSON.stringify({ op: 7, d: { requestType, requestId, requestStatus: { result: out.ok, code: out.ok ? 100 : 600, comment: out.c }, responseData: out.data } }));
    }
    dump();
  });
});

module.exports = { st };

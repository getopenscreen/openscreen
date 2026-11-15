const { app, BrowserWindow, sharedTexture, ipcMain } = require('electron');
const env = process.env, W = +env.PROBE_W, H = +env.PROBE_H, fds = env.PROBE_FDS.split(',').map(Number), stride = +env.PROBE_STRIDE;
const done = (r, c) => { console.log('RESULT', r); app.exit(c); };
setTimeout(() => done('timeout', 3), 60000);
app.on('child-process-gone', (_e, d) => console.log('CHILD GONE', d.type, d.reason));
const stats = a => { a.sort((x, y) => x - y); return `mean ${(a.reduce((s, v) => s + v, 0) / a.length).toFixed(2)} ms p95 ${a[Math.floor(a.length * 0.95)].toFixed(2)} ms`; };
const src = Buffer.alloc(W * H * 4, 0x7f);
ipcMain.handle('rb', () => Buffer.from(src)); // readback emulation: copy + IPC reply, as addon.readFrame does
app.whenReady().then(async () => {
  console.log('GPU', JSON.stringify(app.getGPUFeatureStatus()));
  const w = new BrowserWindow({ width: W, height: H, show: true, webPreferences: { preload: `${__dirname}/preload.js`, sandbox: false } });
  await w.loadFile(`${__dirname}/index.html`);
  const acks = []; ipcMain.on('ack', (_e, r) => acks.shift()?.(r));
  const next = () => new Promise(r => acks.push(r));
  const send = async fd => {
    const imp = sharedTexture.importSharedTexture({ textureInfo: { pixelFormat: 'rgba', codedSize: { width: W, height: H },
      handle: { nativePixmap: { planes: [{ stride, offset: 0, size: stride * H, fd }], modifier: env.PROBE_MOD, supportsZeroCopyWebGpuImport: false } } } });
    const p = next();
    await sharedTexture.sendSharedTexture({ frame: w.webContents.mainFrame, importedSharedTexture: imp }, { check: fd === fds[0] });
    imp.release(); return p;
  };
  try {
    const first = await send(fds[0]);
    console.log('CHECK', first);
    const t = [];
    for (const fd of fds.slice(1)) { const t0 = performance.now(); await send(fd); t.push(performance.now() - t0); }
    console.log('SHARED', W + 'x' + H, stats(t));
    const rb = await w.webContents.executeJavaScript(`window.readbackBench(${fds.length - 1})`);
    console.log('READBACK', W + 'x' + H, stats(rb));
    done(first.startsWith('pass') ? 'pass' : first, first.startsWith('pass') ? 0 : 1);
  } catch (e) { done(`error: ${e.message}`, 2); }
});

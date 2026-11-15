const { sharedTexture, ipcRenderer, contextBridge } = require('electron');
const W = +process.env.PROBE_W, H = +process.env.PROBE_H;
const g = new OffscreenCanvas(W, H).getContext('2d', { willReadFrequently: false });
sharedTexture.setSharedTextureReceiver(async ({ importedSharedTexture }, meta) => {
  const f = importedSharedTexture.getVideoFrame();
  g.drawImage(f, 0, 0); f.close(); importedSharedTexture.release();
  if (!meta?.check) { g.getImageData(0, 0, 1, 1); return ipcRenderer.send('ack', 'ok'); } // 1px read forces the draw to finish
  const d = g.getImageData(0, 0, W, H).data; let bad = 0, black = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y*W + x)*4, want = [x & 255, y & 255, (x ^ y) & 255, 255];
    if (d[i] + d[i+1] + d[i+2] === 0) black++;
    if (want.some((v, k) => Math.abs(d[i+k] - v) > 1)) bad++;
  }
  ipcRenderer.send('ack', bad === 0 ? 'pass' : black === W*H ? 'black frame' : `mismatch: ${bad}/${W*H} px (first px ${[...d.slice(0,4)]})`);
});
const rbBench = async n => {
  const c = new OffscreenCanvas(W, H).getContext('2d'), t = [];
  for (let k = 0; k < n; k++) {
    const t0 = performance.now(); const b = await ipcRenderer.invoke('rb');
    c.putImageData(new ImageData(new Uint8ClampedArray(b.buffer, b.byteOffset, b.byteLength), W, H), 0, 0); c.getImageData(0, 0, 1, 1);
    t.push(performance.now() - t0);
  }
  return t;
};
contextBridge.exposeInMainWorld('readbackBench', rbBench);

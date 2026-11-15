/* MP3 変換用の Web Worker（lamejs を使用。ライセンス: vendor/lamejs-LICENSE.txt） */
importScripts('vendor/lame.min.js');

self.onmessage = e => {
  try {
    const { rate, kbps, chans } = e.data;
    const nch = chans.length;
    const encoder = new lamejs.Mp3Encoder(nch, rate, kbps);
    const left = toInt16(chans[0]);
    const right = nch > 1 ? toInt16(chans[1]) : null;
    const BLOCK = 1152 * 32;
    const out = [];
    let lastPct = -1;
    for (let i = 0; i < left.length; i += BLOCK) {
      const l = left.subarray(i, i + BLOCK);
      const mp3 = right ? encoder.encodeBuffer(l, right.subarray(i, i + BLOCK)) : encoder.encodeBuffer(l);
      if (mp3.length) out.push(new Uint8Array(mp3));
      const pct = Math.floor(i / left.length * 100);
      if (pct !== lastPct && pct % 2 === 0) { lastPct = pct; self.postMessage({ progress: pct }); }
    }
    const end = encoder.flush();
    if (end.length) out.push(new Uint8Array(end));
    self.postMessage({ progress: 100 });
    self.postMessage({ done: true, chunks: out });
  } catch (err) {
    self.postMessage({ error: String(err && err.message || err) });
  }
};

function toInt16(f) {
  const o = new Int16Array(f.length);
  for (let i = 0; i < f.length; i++) {
    let s = f[i];
    s = s < -1 ? -1 : s > 1 ? 1 : s;
    o[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return o;
}

/* 音量をそろえる処理（Web Worker）— 省メモリ版
   iPhoneのメモリを使いすぎないよう、曲は小分け（約100万サンプルずつ）で受け取り、
   曲全体のコピーは持たない。持つのは 100msごとの合計（測定用）と 5msごとの抑え量（リミッター用）だけ。
   手順： init → measure（小分けで全体）→ decide（ゲイン決定）→［limscan（小分け）］→ encode（小分け）→ finish
   測定は ITU-R BS.1770（K特性フィルタ、400msブロック、絶対ゲート -70LUFS・相対ゲート -10LU） */
importScripts('vendor/lame.min.js');

const CEIL = 0.95;     // 音割れしない上限
let S = null;          // 処理中の状態

self.onmessage = e => {
  const m = e.data;
  try {
    if (m.cmd === 'init') { init(m); reply({}); }
    else if (m.cmd === 'measure') { measure(m.parts); reply({}); }
    else if (m.cmd === 'decide') reply(decide());
    else if (m.cmd === 'limscan') { limscan(m.parts); reply({}); }
    else if (m.cmd === 'encode') { encode(m.parts); reply({}); }
    else if (m.cmd === 'finish') { const end = S.enc.flush(); if (end.length) S.out.push(new Uint8Array(end)); const chunks = S.out; S = null; reply({ chunks }); }
  } catch (err) { self.postMessage({ error: String(err && err.message || err) }); }
};
function reply(r) { self.postMessage(Object.assign({ ok: true }, r)); }

function biquadHighShelf(fs, f0, gainDb, q) {
  const A = Math.pow(10, gainDb / 40), w = 2 * Math.PI * f0 / fs, cs = Math.cos(w), al = Math.sin(w) / (2 * q), sq = 2 * Math.sqrt(A) * al;
  const a0 = (A + 1) - (A - 1) * cs + sq;
  return [A * ((A + 1) + (A - 1) * cs + sq) / a0, -2 * A * ((A - 1) + (A + 1) * cs) / a0, A * ((A + 1) + (A - 1) * cs - sq) / a0,
          2 * ((A - 1) - (A + 1) * cs) / a0, ((A + 1) - (A - 1) * cs - sq) / a0];
}
function biquadHighPass(fs, f0, q) {
  const w = 2 * Math.PI * f0 / fs, cs = Math.cos(w), al = Math.sin(w) / (2 * q), a0 = 1 + al;
  return [(1 + cs) / 2 / a0, -(1 + cs) / a0, (1 + cs) / 2 / a0, -2 * cs / a0, (1 - al) / a0];
}

function init({ rate, n, nch, target, kbps, minDiff }) {
  const step = Math.max(1, Math.round(rate * 0.1));
  S = { rate, n, nch, target, kbps, minDiff, step, pos: 0, peak: 0,
        hs: biquadHighShelf(rate, 1681.974450955533, 3.999843853973347, 0.7071752369554196),
        hp: biquadHighPass(rate, 38.13547087602444, 0.5003270373238773),
        st: Array.from({ length: nch }, () => new Float64Array(8)),   // フィルタの状態（チャンネルごと）
        subs: new Float64Array(Math.ceil(n / step) + 1) };
}

// 小分けのデータでラウドネスの材料（100msごとの合計）とピークを集める
function measure(parts) {
  const [b0, b1, b2, a1, a2] = S.hs, [d0, d1, d2, e1, e2] = S.hp, step = S.step, subs = S.subs;
  const len = parts[0].length;
  for (let c = 0; c < parts.length; c++) {
    const x = parts[c], z0 = S.st[c];
    let x1 = z0[0], x2 = z0[1], y1 = z0[2], y2 = z0[3], u1 = z0[4], u2 = z0[5], w1 = z0[6], w2 = z0[7], peak = S.peak;
    for (let j = 0; j < len; j++) {
      const xi = x[j]; const av = xi < 0 ? -xi : xi; if (av > peak) peak = av;
      const y = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = xi; y2 = y1; y1 = y;
      const z = d0 * y + d1 * u1 + d2 * u2 - e1 * w1 - e2 * w2; u2 = u1; u1 = y; w2 = w1; w1 = z;
      subs[((S.pos + j) / step) | 0] += z * z;
    }
    z0[0] = x1; z0[1] = x2; z0[2] = y1; z0[3] = y2; z0[4] = u1; z0[5] = u2; z0[6] = w1; z0[7] = w2; S.peak = peak;
  }
  S.pos += len;
}

function decide() {
  const { subs, step, n, peak, target, minDiff } = S;
  const full = Math.floor(n / step), lk = z => -0.691 + 10 * Math.log10(z), zs = [];
  if (full >= 4) for (let j = 0; j + 4 <= full; j++) zs.push((subs[j] + subs[j + 1] + subs[j + 2] + subs[j + 3]) / (4 * step));
  else { let s = 0; for (let j = 0; j < subs.length; j++) s += subs[j]; zs.push(s / Math.max(1, n)); }
  S.subs = null;
  const abs = zs.filter(z => z > 0 && lk(z) > -70);
  if (!abs.length || peak === 0) return { lufs: null, peak, gainDb: 0, skip: true };
  const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
  const rel = lk(mean(abs)) - 10, gated = abs.filter(z => lk(z) > rel);
  const lufs = lk(mean(gated.length ? gated : abs));
  let gainDb = Math.max(-20, Math.min(18, target - lufs));    // 極端な変更はしない（-20〜+18dB）
  const peakLimitDb = 20 * Math.log10(CEIL / peak);
  if (gainDb > peakLimitDb + 6) gainDb = peakLimitDb + 6;      // リミッターで上げるのは +6dB まで
  if (Math.abs(gainDb) < minDiff) return { lufs, peak, gainDb, skip: true };
  const limit = gainDb > peakLimitDb;
  // 変換の準備
  S.g = Math.pow(10, gainDb / 20); S.limit = limit; S.pos = 0; S.cur = 1;
  S.LA = Math.max(1, Math.round(S.rate * 0.005)); S.rel = Math.exp(-1 / (S.rate * 0.15));
  S.bm = limit ? new Float32Array(Math.ceil(n / S.LA) + 2).fill(1) : null;
  S.enc = new lamejs.Mp3Encoder(S.nch, S.rate, S.kbps); S.out = [];
  return { lufs, peak, gainDb, skip: false, limit };
}

// リミッター用：5msごとに「どれだけ抑えれば音割れしないか」の最小値を記録
function limscan(parts) {
  const { g, LA, bm } = S, len = parts[0].length;
  for (let j = 0; j < len; j++) {
    let m = 0; for (let c = 0; c < parts.length; c++) { const v = Math.abs(parts[c][j]) * g; if (v > m) m = v; }
    if (m > CEIL) { const k = ((S.pos + j) / LA) | 0, v = CEIL / m; if (v < bm[k]) bm[k] = v; }
  }
  S.pos += len;
}

// 音量を変えて MP3 に変換（小分け）
function encode(parts) {
  if (S.encStarted !== true) { S.encStarted = true; S.pos = 0; }
  const { g, LA, bm, rel } = S, len = parts[0].length, nch = parts.length;
  const L = new Int16Array(len), R = nch > 1 ? new Int16Array(len) : null;
  let cur = S.cur;
  for (let j = 0; j < len; j++) {
    let gg = g;
    if (bm) { const k = ((S.pos + j) / LA) | 0, t = Math.min(bm[k], bm[k + 1]); cur = t < cur ? cur + (t - cur) * 0.25 : t + (cur - t) * rel; gg = g * cur; }
    let v = parts[0][j] * gg; v = v < -1 ? -1 : v > 1 ? 1 : v; L[j] = v < 0 ? v * 0x8000 : v * 0x7fff;
    if (R) { let w = parts[1][j] * gg; w = w < -1 ? -1 : w > 1 ? 1 : w; R[j] = w < 0 ? w * 0x8000 : w * 0x7fff; }
  }
  S.cur = cur; S.pos += len;
  const BLK = 1152 * 32;
  for (let s = 0; s < len; s += BLK) {
    const mp3 = R ? S.enc.encodeBuffer(L.subarray(s, s + BLK), R.subarray(s, s + BLK)) : S.enc.encodeBuffer(L.subarray(s, s + BLK));
    if (mp3.length) S.out.push(new Uint8Array(mp3));
  }
}

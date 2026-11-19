/* 音量をそろえる処理（Web Worker）
   1. ITU-R BS.1770 の方法でラウドネス（LUFS）を測る
      （K特性フィルタ → 400msごとの平均 → 絶対ゲート -70LUFS・相対ゲート -10LU）
   2. 目標の大きさとの差（ゲイン）を求める。音割れしないよう、ピークが 0.98 を超えない範囲に抑える
   3. 差が小さい曲はそのまま。差がある曲だけ、音量を合わせた MP3 を作る（lamejs） */
importScripts('vendor/lame.min.js');

self.onmessage = e => {
  try {
    const { rate, chans, target, kbps, minDiff } = e.data;
    const loud = measureLoudness(chans, rate);
    let peak = 0;
    for (const c of chans) for (let i = 0; i < c.length; i++) { const v = c[i] < 0 ? -c[i] : c[i]; if (v > peak) peak = v; }
    if (!Number.isFinite(loud) || peak === 0) { self.postMessage({ done: true, lufs: null, peak, gainDb: 0, skip: true }); return; }
    let gainDb = target - loud;
    gainDb = Math.max(-20, Math.min(18, gainDb));                     // 極端な変更はしない（最大 +18dB）
    const peakLimitDb = 20 * Math.log10(0.95 / peak);
    // ピークで頭打ちになる曲は、リミッター（大きな瞬間だけ抑える）を使って最大 +6dB まで追加で上げる
    if (gainDb > peakLimitDb + 6) gainDb = peakLimitDb + 6;
    const useLimiter = gainDb > peakLimitDb;
    if (Math.abs(gainDb) < minDiff) { self.postMessage({ done: true, lufs: loud, peak, gainDb, skip: true }); return; }
    const g = Math.pow(10, gainDb / 20);
    const nch = chans.length;
    const enc = new lamejs.Mp3Encoder(nch, rate, kbps);
    const [L, R] = render16(chans, g, rate, useLimiter);
    const BLOCK = 1152 * 32, out = [];
    let last = -1;
    for (let i = 0; i < L.length; i += BLOCK) {
      const mp3 = R ? enc.encodeBuffer(L.subarray(i, i + BLOCK), R.subarray(i, i + BLOCK)) : enc.encodeBuffer(L.subarray(i, i + BLOCK));
      if (mp3.length) out.push(new Uint8Array(mp3));
      const pct = Math.floor(i / L.length * 100); if (pct !== last && pct % 5 === 0) { last = pct; self.postMessage({ progress: pct }); }
    }
    const end = enc.flush(); if (end.length) out.push(new Uint8Array(end));
    self.postMessage({ done: true, lufs: loud, peak, gainDb, limited: useLimiter, skip: false, chunks: out });
  } catch (err) { self.postMessage({ error: String(err && err.message || err) }); }
};

// 音量を変えて16bitに変換する。必要なら先読み型のリミッターで音割れを防ぐ
function render16(chans, g, fs, limit) {
  const n = chans[0].length, nch = chans.length, CEIL = 0.95;
  const outs = chans.map(() => new Int16Array(n));
  let env = null;
  if (limit) {
    const need = new Float32Array(n);
    for (let i = 0; i < n; i++) { let m = 0; for (let c = 0; c < nch; c++) { const v = Math.abs(chans[c][i]) * g; if (v > m) m = v; } need[i] = m > CEIL ? CEIL / m : 1; }
    const LA = Math.max(1, Math.round(fs * 0.005));               // 5ms 先読み
    const nb = Math.ceil(n / LA), bm = new Float32Array(nb + 1).fill(1);
    for (let i = 0; i < n; i++) { const k = (i / LA) | 0; if (need[i] < bm[k]) bm[k] = need[i]; }
    const rel = Math.exp(-1 / (fs * 0.15));                       // 0.15秒かけて戻す
    env = need; let cur = 1;
    for (let i = 0; i < n; i++) {
      const k = (i / LA) | 0, t = Math.min(bm[k], bm[k + 1]);
      cur = t < cur ? cur + (t - cur) * 0.25 : t + (cur - t) * rel;
      env[i] = cur;
    }
  }
  for (let c = 0; c < nch; c++) {
    const x = chans[c], o = outs[c];
    for (let i = 0; i < n; i++) { let s = x[i] * g * (env ? env[i] : 1); s = s < -1 ? -1 : s > 1 ? 1 : s; o[i] = s < 0 ? s * 0x8000 : s * 0x7fff; }
  }
  return [outs[0], nch > 1 ? outs[1] : null];
}

// 2次フィルタの係数（RBJ方式。BS.1770のK特性を任意のサンプリング周波数で作る）
function highShelf(fs, f0, gainDb, q) {
  const A = Math.pow(10, gainDb / 40), w = 2 * Math.PI * f0 / fs, cs = Math.cos(w), al = Math.sin(w) / (2 * q), sq = 2 * Math.sqrt(A) * al;
  const a0 = (A + 1) - (A - 1) * cs + sq;
  return [A * ((A + 1) + (A - 1) * cs + sq) / a0, -2 * A * ((A - 1) + (A + 1) * cs) / a0, A * ((A + 1) + (A - 1) * cs - sq) / a0,
          2 * ((A - 1) - (A + 1) * cs) / a0, ((A + 1) - (A - 1) * cs - sq) / a0];
}
function highPass(fs, f0, q) {
  const w = 2 * Math.PI * f0 / fs, cs = Math.cos(w), al = Math.sin(w) / (2 * q), a0 = 1 + al;
  return [(1 + cs) / 2 / a0, -(1 + cs) / a0, (1 + cs) / 2 / a0, -2 * cs / a0, (1 - al) / a0];
}
function filterSquares(x, c1, c2) {
  // K特性フィルタを通した信号の2乗を返す（メモリ節約のため Float32Array）
  const out = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0, u1 = 0, u2 = 0, z1 = 0, z2 = 0;
  const [b0, b1, b2, a1, a2] = c1, [d0, d1, d2, e1, e2] = c2;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    const y = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = xi; y2 = y1; y1 = y;
    const z = d0 * y + d1 * u1 + d2 * u2 - e1 * z1 - e2 * z2; u2 = u1; u1 = y; z2 = z1; z1 = z;
    out[i] = z * z;
  }
  return out;
}
function measureLoudness(chans, fs) {
  const c1 = highShelf(fs, 1681.974450955533, 3.999843853973347, 0.7071752369554196);
  const c2 = highPass(fs, 38.13547087602444, 0.5003270373238773);
  const sq = chans.map(c => filterSquares(c, c1, c2));
  const n = sq[0].length, block = Math.round(fs * 0.4), step = Math.round(fs * 0.1);
  if (n < block) { // 短すぎる場合は全体の平均
    let s = 0; for (const c of sq) { let m = 0; for (let i = 0; i < n; i++) m += c[i]; s += m / Math.max(1, n); }
    return -0.691 + 10 * Math.log10(s);
  }
  // 累積和で 400ms ブロックの平均を高速に求める
  const cum = sq.map(c => { const a = new Float64Array(n + 1); for (let i = 0; i < n; i++) a[i + 1] = a[i] + c[i]; return a; });
  const zs = [];
  for (let st = 0; st + block <= n; st += step) { let s = 0; for (const a of cum) s += (a[st + block] - a[st]) / block; zs.push(s); }
  const lk = z => -0.691 + 10 * Math.log10(z);
  const abs = zs.filter(z => z > 0 && lk(z) > -70); if (!abs.length) return -Infinity;
  const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
  const rel = lk(mean(abs)) - 10;
  const gated = abs.filter(z => lk(z) > rel);
  return lk(mean(gated.length ? gated : abs));
}

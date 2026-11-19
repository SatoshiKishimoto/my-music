'use strict';
/* =========================================================
   音量をそろえる（ラウドネス・ノーマライズ）
   iPhoneではWebアプリから再生音量を変えられないため、
   曲ごとに「音量を合わせた音声（MP3）」をあらかじめ作って保存し、
   設定がオンのときはそちらを再生する（動画は映像はそのまま、音声だけ差し替え）。
   ふつうの再生のしくみを使うので、バックグラウンド再生やロック画面の操作もそのまま使える。
   ========================================================= */
(() => {
  const KEY = 'my-music-normalize-v1';
  const TARGET_LUFS = -16;   // 目標の大きさ（音楽配信サービスと同程度）
  const KBPS = 256;          // 音量を合わせた音声の音質
  const MIN_DIFF_DB = 1.0;   // 差がこれより小さい曲は元のファイルのまま（容量を使わない）
  const MAX_FILE = 150 * 1048576;   // これより大きいファイルはメモリ不足を避けるため処理しない
  const MAX_SEC = 20 * 60;          // 20分を超える音声も処理しない
  const WORKING = 'my-music-norm-working-v1';   // 処理中の曲（アプリが強制終了したかの判定用）
  window.normDelay = 0.026;  // MP3にしたときに先頭に入るわずかな無音（映像との同期用、秒）
  window.normOn = (() => { try { return localStorage.getItem(KEY) === '1'; } catch { return false; } })();
  let busy = false, stopped = false, paused = false;
  const queue = [];

  window.srcFor = t => (normOn && t && t.kind === 'local' && t.normUrl) ? t.normUrl : t.url;
  window.usingNorm = t => !!(normOn && t && t.kind === 'local' && t.normUrl);

  function status() {
    const el = $('normStatus'); if (!el) return;
    const loc = tracks.filter(t => t.kind === 'local');
    const done = loc.filter(t => t.gainDb != null).length;
    if (!normOn) el.textContent = 'オフ：ファイルごとの元の音量で再生します';
    else if (paused) el.textContent = `一時停止中（${done} / ${loc.length} 件準備済み）。スイッチを入れ直すと再開します`;
    else if (busy || queue.length) el.textContent = `準備中… ${done} / ${loc.length} 件（アプリを開いたままにしてください）`;
    else el.textContent = loc.length ? `オン：${loc.length} 件の音量をそろえて再生します` : 'オン：追加した曲の音量を自動でそろえます';
    $('normToggle').checked = normOn;
  }
  window.normStatus = status;

  window.normEnqueue = list => {
    if (!normOn) { status(); return; }
    for (const t of list) if (t.kind === 'local' && t.gainDb == null && !queue.includes(t)) queue.push(t);
    stopped = false; status(); if (!paused) run();
  };

  async function run() {
    if (busy) return; busy = true; status();
    while (normOn && !stopped && !paused && queue.length) {
      const t = queue.shift(); if (!tracks.includes(t) || !t.blob) continue;
      // 画面を離れているときや、動画を映像付きで再生しているときは、負担を避けて待つ
      if (document.visibilityState === 'hidden' || (typeof videoOn !== 'undefined' && videoOn && !audio.paused)) { queue.unshift(t); await new Promise(r => setTimeout(r, 3000)); continue; }
      try {
        if (t.blob.size > MAX_FILE) throw new Error('too large');
        try { localStorage.setItem(WORKING, t.id); } catch {}
        const r = await analyze(t);
        try { localStorage.removeItem(WORKING); } catch {}
        if (r.blob && !(await enoughSpace(r.blob.size))) { stopped = true; notify('空き容量が少ないため、音量をそろえる処理を止めました'); break; }
        t.gainDb = r.gainDb; t.lufs = r.lufs;
        if (r.blob) { if (t.normUrl) URL.revokeObjectURL(t.normUrl); t.normBlob = r.blob; t.normUrl = URL.createObjectURL(r.blob); }
        await dbUpdate(t.id, { gainDb: r.gainDb, lufs: r.lufs, norm: r.blob || null });
        // 一時停止中の曲なら、すぐに音量をそろえた音声へ切り替える
        if (t.id === currentId && audio.paused) applyToCurrent();
      } catch {
        try { localStorage.removeItem(WORKING); } catch {}
        t.gainDb = 0; t.lufs = null; t.normSkipped = true;   // 解析できない・大きすぎる曲は元の音量のまま
        await dbUpdate(t.id, { gainDb: 0, lufs: null, norm: null, normSkipped: true });
      }
      status();
      await new Promise(r => setTimeout(r, 1500));   // 1曲ごとに少し休んでメモリを解放させる
    }
    busy = false; status(); if (typeof showDiag === 'function') showDiag();
  }

  async function enoughSpace(bytes) {
    try { const e = await navigator.storage?.estimate?.(); if (!e || !e.quota) return true; return bytes < (e.quota - e.usage) * 0.8; } catch { return true; }
  }

  function decodeAudio(buf) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return Promise.reject(new Error('no AudioContext'));
    const ctx = new AC();
    return new Promise((resolve, reject) => {
      try { const p = ctx.decodeAudioData(buf, resolve, reject); if (p && typeof p.then === 'function') p.then(resolve, reject); } catch (e) { reject(e); }
    }).finally(() => { try { ctx.close(); } catch {} });
  }

  // 曲を小分け（約100万サンプル＝4MBずつ）にしてワーカーへ渡す。曲全体のコピーは作らない
  async function analyze(t) {
    let ab = await decodeAudio(await t.blob.arrayBuffer());
    if (ab.duration > MAX_SEC) throw new Error('too long');
    const rate = ab.sampleRate, n = ab.length, nch = Math.min(2, ab.numberOfChannels);
    const w = new Worker('norm-worker.js');
    const call = (msg, transfer) => new Promise((resolve, reject) => {
      w.onmessage = e => { const d = e.data; if (d.error) reject(new Error(d.error)); else resolve(d); };
      w.onerror = err => reject(err);
      w.postMessage(msg, transfer || []);
    });
    const PART = 1 << 20;
    const sendAll = async cmd => {
      for (let s = 0; s < n; s += PART) {
        const len = Math.min(PART, n - s), parts = [];
        for (let c = 0; c < nch; c++) {
          const a = new Float32Array(len);
          if (ab.copyFromChannel) ab.copyFromChannel(a, c, s); else a.set(ab.getChannelData(c).subarray(s, s + len));
          parts.push(a);
        }
        await call({ cmd, parts }, parts.map(p => p.buffer));
      }
    };
    try {
      await call({ cmd: 'init', rate, n, nch, target: TARGET_LUFS, kbps: KBPS, minDiff: MIN_DIFF_DB });
      await sendAll('measure');
      const d = await call({ cmd: 'decide' });
      if (d.skip) return { gainDb: Math.round(d.gainDb * 10) / 10, lufs: d.lufs, blob: null };
      if (d.limit) await sendAll('limscan');
      await sendAll('encode');
      const f = await call({ cmd: 'finish' });
      return { gainDb: Math.round(d.gainDb * 10) / 10, lufs: d.lufs, blob: new Blob(f.chunks, { type: 'audio/mpeg' }) };
    } finally { w.terminate(); ab = null; }
  }

  // 再生中の曲の音声を、位置を保ったまま切り替える（設定を変えたとき）
  function applyToCurrent() {
    const t = curTrack(); if (!t || t.kind !== 'local') return;
    const want = srcFor(t); if (audio.src === want) return;
    const time = audio.currentTime || 0, playing = !audio.paused;
    audio.src = want;
    audio.addEventListener('loadedmetadata', () => { try { audio.currentTime = time; } catch {} }, { once: true });
    if (playing) audio.play().catch(() => {}); else audio.load();
  }

  $('normToggle').addEventListener('change', e => {
    normOn = e.target.checked; try { localStorage.setItem(KEY, normOn ? '1' : '0'); } catch {}
    if (normOn) { paused = false; notify('曲ごとの音量の違いを自動でそろえます。初回は1曲ずつ準備します'); normEnqueue(tracks); }
    else { stopped = true; queue.length = 0; notify('ファイルごとの元の音量で再生します'); }
    applyToCurrent(); status();
  });

  // 前回、処理中にアプリが強制終了していたら、その曲は処理せず元の音量のままにして、自動処理を一時停止する
  const crashed = (() => { try { return localStorage.getItem(WORKING); } catch { return null; } })();
  if (crashed) {
    try { localStorage.removeItem(WORKING); } catch {}
    paused = true;
    dbUpdate(crashed, { gainDb: 0, lufs: null, norm: null, normSkipped: true });
    const mark = () => { const t = tracks.find(x => x.id === crashed); if (t) { t.gainDb = 0; t.normSkipped = true; } status(); };
    setTimeout(mark, 1500);
    setTimeout(() => notify('前回、音量の準備中にアプリが終了したため、その曲は元の音量のままにし、準備を一時停止しました'), 2000);
  }
  status();
  // 起動直後は動作を軽くするため、少し待ってから準備を始める
  setTimeout(() => { if (normOn && tracks.length) normEnqueue(tracks); }, 4000);
})();

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
  window.normDelay = 0.026;  // MP3にしたときに先頭に入るわずかな無音（映像との同期用、秒）
  window.normOn = (() => { try { return localStorage.getItem(KEY) === '1'; } catch { return false; } })();
  let busy = false, stopped = false;
  const queue = [];

  window.srcFor = t => (normOn && t && t.kind === 'local' && t.normUrl) ? t.normUrl : t.url;
  window.usingNorm = t => !!(normOn && t && t.kind === 'local' && t.normUrl);

  function status() {
    const el = $('normStatus'); if (!el) return;
    const loc = tracks.filter(t => t.kind === 'local');
    const done = loc.filter(t => t.gainDb != null).length;
    if (!normOn) el.textContent = 'オフ：ファイルごとの元の音量で再生します';
    else if (busy || queue.length) el.textContent = `準備中… ${done} / ${loc.length} 件（アプリを開いたままにしてください）`;
    else el.textContent = loc.length ? `オン：${loc.length} 件の音量をそろえて再生します` : 'オン：追加した曲の音量を自動でそろえます';
    $('normToggle').checked = normOn;
  }
  window.normStatus = status;

  window.normEnqueue = list => {
    if (!normOn) { status(); return; }
    for (const t of list) if (t.kind === 'local' && t.gainDb == null && !queue.includes(t)) queue.push(t);
    stopped = false; status(); run();
  };

  async function run() {
    if (busy) return; busy = true; status();
    while (normOn && !stopped && queue.length) {
      const t = queue.shift(); if (!tracks.includes(t) || !t.blob) continue;
      try {
        const r = await analyze(t);
        if (r.blob && !(await enoughSpace(r.blob.size))) { stopped = true; notify('空き容量が少ないため、音量をそろえる処理を止めました'); break; }
        t.gainDb = r.gainDb; t.lufs = r.lufs;
        if (r.blob) { if (t.normUrl) URL.revokeObjectURL(t.normUrl); t.normBlob = r.blob; t.normUrl = URL.createObjectURL(r.blob); }
        await dbUpdate(t.id, { gainDb: r.gainDb, lufs: r.lufs, norm: r.blob || null });
        // 一時停止中の曲なら、すぐに音量をそろえた音声へ切り替える
        if (t.id === currentId && audio.paused) applyToCurrent();
      } catch {
        t.gainDb = 0; t.lufs = null;   // 解析できない曲は元の音量のまま
        await dbUpdate(t.id, { gainDb: 0, lufs: null, norm: null });
      }
      status();
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

  async function analyze(t) {
    const ab = await decodeAudio(await t.blob.arrayBuffer());
    const chans = []; for (let i = 0; i < Math.min(2, ab.numberOfChannels); i++) chans.push(ab.getChannelData(i).slice(0));
    return new Promise((resolve, reject) => {
      const w = new Worker('norm-worker.js');
      w.onmessage = e => {
        const d = e.data; if (d.progress != null) return;
        w.terminate();
        if (d.error) reject(new Error(d.error));
        else resolve({ gainDb: Math.round(d.gainDb * 10) / 10, lufs: d.lufs, blob: d.skip ? null : new Blob(d.chunks, { type: 'audio/mpeg' }) });
      };
      w.onerror = e => { w.terminate(); reject(e); };
      w.postMessage({ rate: ab.sampleRate, chans, target: TARGET_LUFS, kbps: KBPS, minDiff: MIN_DIFF_DB }, chans.map(c => c.buffer));
    });
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
    if (normOn) { notify('曲ごとの音量の違いを自動でそろえます。初回は1曲ずつ準備します'); normEnqueue(tracks); }
    else { stopped = true; queue.length = 0; notify('ファイルごとの元の音量で再生します'); }
    applyToCurrent(); status();
  });

  status();
  if (normOn && tracks.length) normEnqueue(tracks);
})();

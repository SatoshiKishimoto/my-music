'use strict';
/* =========================================================
   音声の取り出し（動画・音声ファイル → MP3 / WAV）
   - iPhone内だけで処理します（サーバーへは送りません）
   - Web Audio API で音声をデコード → WAV は直接書き出し、
     MP3 は lamejs（vendor/lame.min.js）を Web Worker で使って変換
   ========================================================= */
(() => {
  const BIG_FILE = 400 * 1048576;      // これを超えるとメモリ不足の注意を出す
  const LONG_AUDIO_SEC = 30 * 60;      // 30分を超える音声は WAV が非常に大きくなる
  let job = null;                      // 実行中の処理（キャンセル用）

  window.openExtract = function openExtract(t) {
    if (!t || t.kind !== 'local' || !t.blob) { notify('アプリに保存した曲・動画だけ音声を取り出せます'); return; }
    const body = openSheet(`音声を取り出す：${t.title}`);
    body.append(el('div', 'sheet-note', '動画や音声ファイルから音声だけを取り出し、MP3またはWAVファイルにします。処理はこのiPhoneの中だけで行います。'));
    body.append(el('div', 'sheet-label', '保存形式'));
    sheetItem(body, '🎵 MP3（192kbps・おすすめ）', () => run(t, 'mp3', 192), { keep: true });
    sheetItem(body, '🎵 MP3（128kbps・小さめ）', () => run(t, 'mp3', 128), { keep: true });
    sheetItem(body, '🎼 WAV（無圧縮・高音質・大きめ）', () => run(t, 'wav'), { keep: true });
  };

  function progressUI(title) {
    const body = openSheet(title);
    const msg = el('div', 'progress-msg', '準備中…');
    const bar = el('div', 'progress'); const fill = el('div', 'progress-fill'); bar.append(fill);
    body.append(msg, bar, el('div', 'sheet-note', '変換中はアプリを開いたままにしてください。長い動画は数分かかることがあります。'));
    return { set(text, pct) { msg.textContent = text; if (pct != null) fill.style.width = Math.max(2, Math.min(100, pct)) + '%'; } };
  }

  async function run(t, fmt, kbps) {
    if (job) { notify('いま別の変換を実行中です'); return; }
    if (t.blob.size > BIG_FILE && !confirm(`大きなファイルです（約${fmtSize(t.blob.size)}）。iPhoneのメモリが足りず失敗することがあります。続けますか？`)) return;
    const my = job = { cancelled: false, worker: null };
    const ui = progressUI(`変換中：${t.title}`);
    $('sheetCancel').onclick = () => { my.cancelled = true; my.worker?.terminate(); job = null; $('sheetCancel').onclick = null; closeSheet(); notify('変換を中止しました'); };
    try {
      ui.set('ファイルを読み込み中…', 5);
      const buf = await t.blob.arrayBuffer(); if (my.cancelled) return;
      ui.set('音声を取り出し中…', 15);
      const audioBuf = await decode(buf); if (my.cancelled) return;
      if (!audioBuf || !audioBuf.length) throw new Error('no audio');
      const sec = audioBuf.duration;
      if (fmt === 'wav' && sec > LONG_AUDIO_SEC && !confirm(`音声が長いため、WAVファイルが約${fmtSize(sec * audioBuf.sampleRate * 4)}になります。続けますか？（MP3なら約${fmtSize(sec * 24000)}）`)) { finish(); return; }
      const chans = []; for (let i = 0; i < Math.min(2, audioBuf.numberOfChannels); i++) chans.push(audioBuf.getChannelData(i));
      let out;
      if (fmt === 'wav') { ui.set('WAVファイルを作成中…', 60); await new Promise(r => setTimeout(r, 30)); out = encodeWav(chans, audioBuf.sampleRate); }
      else out = await encodeMp3(chans, audioBuf.sampleRate, kbps, p => ui.set(`MP3に変換中… ${p}%`, 20 + p * 0.8), my);
      if (my.cancelled) return;
      finish(); showResult(t, out, fmt, sec);
    } catch (e) {
      if (my.cancelled) return;
      finish(); closeSheet();
      notify('音声を取り出せませんでした（音声が入っていない・この形式に未対応・メモリ不足のいずれかの可能性があります）');
    }
    function finish() { if (job === my) job = null; $('sheetCancel').onclick = null; }
  }

  // ブラウザの機能で音声を PCM に変換（MP4/MOV/M4A/MP3/WAV に対応。iPhoneのSafariが再生できる音声形式なら可）
  function decode(buf) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return Promise.reject(new Error('no AudioContext'));
    const ctx = new AC();
    return new Promise((resolve, reject) => {
      try {
        const p = ctx.decodeAudioData(buf, resolve, reject);
        if (p && typeof p.then === 'function') p.then(resolve, reject);
      } catch (e) { reject(e); }
    }).finally(() => { try { ctx.close(); } catch {} });
  }

  // 16bit PCM の WAV を作る
  function encodeWav(chans, rate) {
    const n = chans[0].length, ch = chans.length, bytes = n * ch * 2;
    const buf = new ArrayBuffer(44 + bytes), v = new DataView(buf);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + bytes, true); str(8, 'WAVE'); str(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true); v.setUint32(24, rate, true);
    v.setUint32(28, rate * ch * 2, true); v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, bytes, true);
    let o = 44;
    for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) { let s = chans[c][i]; s = s < -1 ? -1 : s > 1 ? 1 : s; v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); o += 2; }
    return new Blob([buf], { type: 'audio/wav' });
  }

  // MP3 への変換は重いので Web Worker（別スレッド）で行う
  function encodeMp3(chans, rate, kbps, onProgress, my) {
    return new Promise((resolve, reject) => {
      const w = new Worker('mp3-worker.js'); my.worker = w;
      w.onmessage = e => {
        const d = e.data;
        if (d.progress != null) onProgress(d.progress);
        else if (d.done) { w.terminate(); resolve(new Blob(d.chunks, { type: 'audio/mpeg' })); }
        else if (d.error) { w.terminate(); reject(new Error(d.error)); }
      };
      w.onerror = e => { w.terminate(); reject(e); };
      const copies = chans.map(c => c.slice(0));
      w.postMessage({ rate, kbps, chans: copies }, copies.map(c => c.buffer));
    });
  }

  function showResult(t, blob, fmt, sec) {
    const fileName = `${safeFileName(t.title)}.${fmt}`;
    const body = openSheet('音声を取り出しました');
    body.append(el('div', 'result-box', `✅ ${fmt.toUpperCase()}　${formatTime(sec)}　約${fmtSize(blob.size)}\n${fileName}`));
    body.append(el('div', 'sheet-label', 'このファイルをどうしますか？'));
    // 共有シートは「タップした瞬間」に開く必要があるので、ここでボタンを押してもらう
    sheetItem(body, '📁 「ファイル」アプリに保存', () => shareOrDownload(blob, fileName), { keep: true });
    const addBtn = sheetItem(body, '＋ ライブラリに音楽として追加', async () => {
      addBtn.disabled = true; addBtn.textContent = '追加中…';
      const added = await addBlobToLibrary(blob, fileName, { title: `${t.title}（音声）`, folder: t.folder, thumb: t.thumb, artist: t.artist, after: t.id });
      addBtn.textContent = added ? '✓ ライブラリに追加しました' : '＋ ライブラリに音楽として追加';
      if (!added) addBtn.disabled = false;
    }, { keep: true });
    body.append(el('div', 'sheet-note', '「ファイル」アプリに保存：共有メニューが開いたら「"ファイル"に保存」を選び、保存先のフォルダを選んでください。'));
  }
})();

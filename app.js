'use strict';
const APP_VERSION = 'v9';
/* =========================================================
   My Music — iPhone向け個人音楽プレーヤー
   ========================================================= */
const $ = id => document.getElementById(id);
const audio = $('audio');

const STORE = 'my-music-remote-v1';        // Web曲（URL）
const ORDER_KEY = 'my-music-order-v1';     // 曲順
const FOLDERS_KEY = 'my-music-folders-v1'; // フォルダ一覧
const FOLDER_MAP_KEY = 'my-music-folder-map-v1'; // 曲ID → フォルダ名
const VIEW_ALL = '__all__', VIEW_NONE = '__none__';

let tracks = [], folders = [], currentId = null, shuffle = false, repeat = 0, toastTimer;
let view = VIEW_ALL;      // 一覧で表示中のフォルダ
let playView = VIEW_ALL;  // 再生中のキュー（どのフォルダから再生したか）
let query = '';

/* ---------- ユーティリティ ---------- */
function uid() { return crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random(); }
function notify(message) { const t = $('toast'); t.textContent = message; t.classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('visible'), 3000); }
function formatTime(sec) { if (!Number.isFinite(sec)) return '0:00'; sec = Math.max(0, Math.floor(sec)); return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`; }
function safeTitle(url) { try { return decodeURIComponent(new URL(url).pathname.split('/').pop()) || 'Web audio'; } catch { return 'Web audio'; } }
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
function readJSON(key, fallback) { try { const v = JSON.parse(localStorage.getItem(key) || 'null'); return v ?? fallback; } catch { return fallback; } }

/* ---------- 保存（localStorage） ---------- */
function saveState() {
  try {
    localStorage.setItem(STORE, JSON.stringify(tracks.filter(t => t.kind !== 'local').map(({ id, title, url, kind, ytId, artist }) => ({ id, title, url, kind, ytId, artist }))));
    localStorage.setItem(ORDER_KEY, JSON.stringify(tracks.map(t => t.id)));
    localStorage.setItem(FOLDERS_KEY, JSON.stringify(folders));
    const map = {}; for (const t of tracks) if (t.folder) map[t.id] = t.folder;
    localStorage.setItem(FOLDER_MAP_KEY, JSON.stringify(map));
  } catch { notify('保存できませんでした'); }
}
function loadRemote() {
  const data = readJSON(STORE, []);
  tracks = Array.isArray(data) ? data.filter(t => typeof t.url === 'string' && /^https:\/\//i.test(t.url)).map(t => {
    const base = { id: String(t.id || uid()), title: String(t.title || safeTitle(t.url)), url: t.url, artist: t.artist || null };
    if (t.kind === 'youtube' && /^[\w-]{11}$/.test(t.ytId || '')) return { ...base, kind: 'youtube', ytId: t.ytId, thumb: ytThumb(t.ytId) };
    return { ...base, kind: 'remote' };
  }) : [];
}
function applySavedOrderAndFolders() {
  const fs = readJSON(FOLDERS_KEY, []); folders = Array.isArray(fs) ? fs.filter(f => typeof f === 'string' && f) : [];
  const map = readJSON(FOLDER_MAP_KEY, {});
  for (const t of tracks) t.folder = (map && folders.includes(map[t.id])) ? map[t.id] : null;
  const order = readJSON(ORDER_KEY, []);
  if (Array.isArray(order) && order.length) { const pos = id => { const i = order.indexOf(id); return i < 0 ? Infinity : i; }; tracks.sort((a, b) => pos(a.id) - pos(b.id)); }
}

/* ---------- 表示対象の絞り込み ---------- */
function inView(t, v) { return v === VIEW_ALL ? true : v === VIEW_NONE ? !t.folder : t.folder === v; }
function queueTracks() { return tracks.filter(t => inView(t, playView)); }
function visibleTracks() { const q = query.trim().toLowerCase(); return tracks.filter(t => inView(t, view) && (!q || t.title.toLowerCase().includes(q) || (t.folder || '').toLowerCase().includes(q) || (t.artist || '').toLowerCase().includes(q))); }

/* ---------- 描画 ---------- */
function render() { renderFolders(); renderTracks(); }

function renderFolders() {
  const bar = $('folderBar'); bar.replaceChildren();
  if (view !== VIEW_ALL && view !== VIEW_NONE && !folders.includes(view)) view = VIEW_ALL;
  const unsorted = tracks.filter(t => !t.folder).length;
  const chip = (label, v, count) => { const b = el('button', 'chip' + (view === v ? ' active' : '')); b.type = 'button'; b.append(el('span', '', label), el('small', '', String(count))); b.addEventListener('click', () => { view = v; render(); }); bar.append(b); };
  chip('すべて', VIEW_ALL, tracks.length);
  for (const f of folders) chip('📁 ' + f, f, tracks.filter(t => t.folder === f).length);
  if (folders.length && unsorted) chip('未分類', VIEW_NONE, unsorted);
  const add = el('button', 'chip add', '＋ フォルダ'); add.type = 'button'; add.addEventListener('click', () => { const f = askFolderName(); if (f) { view = f; render(); notify(`フォルダ「${f}」を作成しました`); } }); bar.append(add);
  const isFolder = folders.includes(view);
  $('folderActions').hidden = !isFolder;
  if (isFolder) $('folderTitle').textContent = '📁 ' + view;
}

function renderTracks() {
  const list = $('tracks'); list.replaceChildren();
  const vis = visibleTracks();
  $('count').textContent = view === VIEW_ALL && !query ? `${tracks.length} 曲` : `${vis.length} / ${tracks.length} 曲`;
  if (!vis.length) {
    list.append(el('li', 'empty', !tracks.length ? '曲がありません。ファイルまたはURLから追加してください。' : query ? '検索に一致する曲がありません。' : folders.includes(view) ? 'このフォルダには曲がありません。曲の「⋯」から移動するか、このフォルダを開いたまま曲を追加してください。' : '曲がありません。'));
    return;
  }
  vis.forEach((track, index) => {
    const li = el('li'); li.dataset.id = track.id; if (track.id === currentId) li.classList.add('current');
    const handle = el('span', 'drag-handle', '≡'); handle.setAttribute('aria-hidden', 'true'); handle.addEventListener('pointerdown', e => startDrag(e, li));
    const btn = el('button', 'track-select'); btn.type = 'button'; btn.addEventListener('click', () => { playView = view; playTrack(track.id); });
    const icon = el('span', 'track-icon'); const playingNow = track.id === currentId && !engine.paused();
    if (track.thumb) { icon.classList.add('has-thumb'); icon.style.backgroundImage = `url("${track.thumb}")`; if (playingNow) { icon.classList.add('playing'); icon.textContent = '♫'; } }
    else icon.textContent = playingNow ? '♫' : '♪';
    const info = el('span', 'track-info');
    info.append(el('span', 'track-name', track.title), el('span', 'track-type', [track.folder && view === VIEW_ALL ? '📁 ' + track.folder : '', track.kind === 'local' ? '保存済み' : track.kind === 'youtube' ? '▶ YouTube' : 'Web URL'].filter(Boolean).join(' · ')));
    btn.append(icon, info);
    const moves = el('span', 'moves');
    const up = el('button', 'move', '▲'); up.type = 'button'; up.disabled = index === 0; up.setAttribute('aria-label', `${track.title}を上へ`); up.addEventListener('click', () => moveTrack(track.id, -1));
    const down = el('button', 'move', '▼'); down.type = 'button'; down.disabled = index === vis.length - 1; down.setAttribute('aria-label', `${track.title}を下へ`); down.addEventListener('click', () => moveTrack(track.id, 1));
    moves.append(up, down);
    const more = el('button', 'more', '⋯'); more.type = 'button'; more.setAttribute('aria-label', `${track.title}のメニュー`); more.addEventListener('click', () => openTrackMenu(track.id));
    li.append(handle, btn, moves, more); list.append(li);
  });
}

function setNow(track) {
  $('trackTitle').textContent = track?.title || '曲を選択してください';
  $('trackSubtitle').textContent = track ? (track.folder || track.artist || (track.kind === 'local' ? 'アプリに保存した曲' : track.kind === 'youtube' ? 'YouTube' : 'Webサーバーから再生')) : 'MP3 / WAV / MP4';
  $('sourceLabel').textContent = track ? (track.kind === 'local' ? 'LOCAL AUDIO' : track.kind === 'youtube' ? 'YOUTUBE' : 'ONLINE AUDIO') : 'READY TO PLAY';
  $('seek').value = '0'; $('currentTime').textContent = '0:00'; $('duration').textContent = '0:00';
  showArt(track); updateMediaMeta(track);
}
function updateMediaMeta(track) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = track ? new MediaMetadata({ title: track.title, artist: track.artist || track.folder || 'My Music', album: track.folder || 'My Music', artwork: track.thumb ? [{ src: track.thumb, sizes: track.kind === 'youtube' ? '480x360' : '320x320', type: 'image/jpeg' }] : [] }) : null;
}
function showArt(track) {
  const yt = track?.kind === 'youtube'; $('art').hidden = yt; $('ytWrap').hidden = !yt;
  const art = $('art'); art.replaceChildren();
  if (track?.thumb) { const img = el('img'); img.src = track.thumb; img.alt = ''; art.append(img); art.classList.add('has-thumb'); }
  else { art.append(el('span', '', '♫')); art.classList.remove('has-thumb'); }
}

/* ---------- 再生 ---------- */
async function playTrack(trackId) {
  const track = tracks.find(t => t.id === trackId); if (!track) return;
  if (currentId !== trackId) {
    currentId = trackId; setNow(track);
    if (track.kind === 'youtube') { audio.pause(); audio.removeAttribute('src'); audio.load(); ytLoad(track); render(); return; }
    ytStop(); audio.src = track.url; audio.load();
  }
  try { await engine.play(); } catch { notify('再生できません。URL・形式・通信状態を確認してください。'); }
  render();
}
function stop() { ytStop(); audio.pause(); audio.removeAttribute('src'); audio.load(); currentId = null; setNow(null); updatePlay(); }
function curTrack() { return tracks.find(t => t.id === currentId) || null; }
// 音声ファイルとYouTubeの両方を同じ操作で扱うための窓口
const engine = {
  yt() { return curTrack()?.kind === 'youtube'; },
  paused() { return this.yt() ? !(ytState === 1 || ytState === 3) : audio.paused; },
  time() { return this.yt() ? (ytPlayer?.getCurrentTime?.() || 0) : audio.currentTime; },
  duration() { return this.yt() ? (ytPlayer?.getDuration?.() || NaN) : audio.duration; },
  seek(s) { if (this.yt()) ytPlayer?.seekTo?.(s, true); else audio.currentTime = s; },
  play() { if (this.yt()) { ytPlayer?.playVideo?.(); return Promise.resolve(); } return audio.play(); },
  pause() { if (this.yt()) ytPlayer?.pauseVideo?.(); else audio.pause(); },
  hasSource() { return this.yt() ? true : !!audio.src; },
};
function step(direction, ended = false) {
  let q = queueTracks(); if (!q.length) { playView = VIEW_ALL; q = tracks; } if (!q.length) return;
  if (ended && repeat === 2 && currentId) { engine.seek(0); engine.play().catch(() => notify('再生できません')); return; }
  if (shuffle && q.length > 1) { const other = q.filter(t => t.id !== currentId); playTrack(other[Math.floor(Math.random() * other.length)].id); return; }
  const idx = q.findIndex(t => t.id === currentId); const next = idx < 0 ? 0 : idx + direction;
  if (next < 0) { playTrack(q[0].id); return; }
  if (next >= q.length) { if (repeat === 1 || !ended) playTrack(q[0].id); else { engine.pause(); engine.seek(0); updatePlay(); } return; }
  playTrack(q[next].id);
}
function updatePlay() {
  const p = engine.paused(); $('play').textContent = p ? '▶' : 'Ⅱ'; $('play').setAttribute('aria-label', p ? '再生' : '一時停止');
  render(); if ('mediaSession' in navigator) navigator.mediaSession.playbackState = p ? 'paused' : 'playing';
}

/* ---------- 曲の操作 ---------- */
function removeTrack(trackId) {
  const idx = tracks.findIndex(t => t.id === trackId); if (idx < 0) return;
  const track = tracks[idx]; if (currentId === trackId) stop();
  tracks.splice(idx, 1);
  if (track.kind === 'local') { URL.revokeObjectURL(track.url); dbDelete(track.id); }
  saveState(); render();
}
// 表示中の一覧の中で入れ替える（他のフォルダの曲の位置は変えない）
function reorderVisible(newIds) {
  const set = new Set(newIds); const slots = []; tracks.forEach((t, i) => { if (set.has(t.id)) slots.push(i); });
  const byId = new Map(tracks.map(t => [t.id, t])); newIds.forEach((id, k) => { tracks[slots[k]] = byId.get(id); });
  saveState();
}
function moveTrack(trackId, dir) {
  const ids = visibleTracks().map(t => t.id); const i = ids.indexOf(trackId); const j = i + dir;
  if (i < 0 || j < 0 || j >= ids.length) return; [ids[i], ids[j]] = [ids[j], ids[i]]; reorderVisible(ids); render();
}

/* ---------- ドラッグで並べ替え ---------- */
let drag = null;
function startDrag(e, li) {
  e.preventDefault(); drag = { li, list: $('tracks'), pointerId: e.pointerId, moved: false }; li.classList.add('dragging');
  try { e.target.setPointerCapture(e.pointerId); } catch {}
  document.addEventListener('pointermove', onDrag, { passive: false }); document.addEventListener('pointerup', endDrag); document.addEventListener('pointercancel', endDrag);
}
function onDrag(e) {
  if (!drag || e.pointerId !== drag.pointerId) return; e.preventDefault();
  const items = [...drag.list.querySelectorAll('li[data-id]')].filter(x => x !== drag.li); let before = null;
  for (const item of items) { const r = item.getBoundingClientRect(); if (e.clientY < r.top + r.height / 2) { before = item; break; } }
  if (before !== drag.li.nextElementSibling || (!before && drag.li !== drag.list.lastElementChild)) { drag.list.insertBefore(drag.li, before); drag.moved = true; }
  if (e.clientY < 60) window.scrollBy(0, -12); else if (e.clientY > window.innerHeight - 60) window.scrollBy(0, 12);
}
function endDrag(e) {
  if (!drag || e.pointerId !== drag.pointerId) return;
  document.removeEventListener('pointermove', onDrag); document.removeEventListener('pointerup', endDrag); document.removeEventListener('pointercancel', endDrag);
  drag.li.classList.remove('dragging');
  if (drag.moved) reorderVisible([...drag.list.querySelectorAll('li[data-id]')].map(x => x.dataset.id));
  drag = null; render();
}

/* ---------- フォルダ ---------- */
function askFolderName(initial = '') {
  const name = (prompt('フォルダ名（歌手名など）', initial) || '').trim(); if (!name) return null;
  if (name === initial) return name;
  if (folders.includes(name)) { notify('同じ名前のフォルダがあります'); return name; }
  folders.push(name); saveState(); return name;
}
function setFolder(trackId, folder) { const t = tracks.find(x => x.id === trackId); if (!t) return; t.folder = folder; saveState(); render(); }
function renameFolder(oldName) {
  const name = (prompt('新しいフォルダ名', oldName) || '').trim(); if (!name || name === oldName) return;
  if (folders.includes(name)) { // 既存フォルダへ統合
    if (!confirm(`「${name}」は既にあります。「${oldName}」の曲を「${name}」にまとめますか？`)) return;
    folders = folders.filter(f => f !== oldName);
  } else folders[folders.indexOf(oldName)] = name;
  for (const t of tracks) if (t.folder === oldName) t.folder = name;
  view = name; saveState(); render(); notify('フォルダ名を変更しました');
}
function deleteFolder(name) {
  const n = tracks.filter(t => t.folder === name).length;
  if (!confirm(`フォルダ「${name}」を削除しますか？${n ? `\n中の ${n} 曲は消えずに「未分類」に戻ります。` : ''}`)) return;
  folders = folders.filter(f => f !== name); for (const t of tracks) if (t.folder === name) t.folder = null;
  view = VIEW_ALL; saveState(); render(); notify('フォルダを削除しました');
}
function moveFolder(name, dir) { const i = folders.indexOf(name), j = i + dir; if (i < 0 || j < 0 || j >= folders.length) return; [folders[i], folders[j]] = [folders[j], folders[i]]; saveState(); render(); }

// 曲名・タグから歌手名を推測
function guessArtist(t) {
  if (t.artist) return t.artist.trim();
  let s = t.title.replace(/[【\[][^】\]]*[】\]]/g, ' ').replace(/_/g, ' ').trim();
  const m = s.match(/^(.+?)\s+[-–—―]\s+.+$/) || s.match(/^(.+?)\s*[／/]\s*.+$/) || s.match(/^(.+?)\s*[「『].+[」』]/);
  if (!m) return null;
  let a = m[1].replace(/\s*[（(][^）)]*[）)]\s*$/, '').trim();
  return a && a.length <= 40 ? a : null;
}
function autoSort() {
  const targets = tracks.filter(t => !t.folder).map(t => [t, guessArtist(t)]).filter(([, a]) => a);
  if (!targets.length) { notify('歌手名を読み取れる未分類の曲がありませんでした'); return; }
  const names = [...new Set(targets.map(([, a]) => a))];
  if (!confirm(`未分類の ${targets.length} 曲を、歌手名で ${names.length} 個のフォルダに振り分けます。\n\n${names.slice(0, 12).join('、')}${names.length > 12 ? ' ほか' : ''}\n\nよろしいですか？（読み取れなかった曲は未分類のままです）`)) return;
  for (const n of names) if (!folders.includes(n)) folders.push(n);
  for (const [t, a] of targets) t.folder = a;
  saveState(); render(); notify(`${targets.length} 曲を振り分けました`);
}

/* ---------- 曲メニュー（シート） ---------- */
function openTrackMenu(trackId) {
  const t = tracks.find(x => x.id === trackId); if (!t) return;
  const sheet = $('sheet'), body = $('sheetBody'); body.replaceChildren();
  $('sheetTitle').textContent = t.title;
  const item = (label, fn, cls = '') => { const b = el('button', 'sheet-item ' + cls, label); b.type = 'button'; b.addEventListener('click', () => { closeSheet(); fn(); }); body.append(b); };
  body.append(el('div', 'sheet-label', 'フォルダに移動'));
  for (const f of folders) item((t.folder === f ? '✓ ' : '　 ') + '📁 ' + f, () => setFolder(t.id, f), t.folder === f ? 'checked' : '');
  item((t.folder ? '　 ' : '✓ ') + 'フォルダなし（未分類）', () => setFolder(t.id, null), t.folder ? '' : 'checked');
  const guess = guessArtist(t);
  if (guess && !folders.includes(guess)) item(`＋ 「${guess}」フォルダを作って移動`, () => { folders.push(guess); setFolder(t.id, guess); });
  item('＋ 新しいフォルダを作って移動', () => { const f = askFolderName(guess || ''); if (f) setFolder(t.id, f); });
  body.append(el('div', 'sheet-label', 'その他'));
  item('✎ 曲名を変更', () => { const n = (prompt('曲名', t.title) || '').trim(); if (n) { t.title = n; if (t.kind === 'local') dbUpdate(t.id, { title: n }); saveState(); render(); if (t.id === currentId) setNow(t); } });
  item('🗑 この曲を削除', () => { if (confirm(`「${t.title}」を削除しますか？${t.kind === 'local' ? '\n（iPhone本体の元ファイルは消えません）' : ''}`)) removeTrack(t.id); }, 'danger');
  sheet.hidden = false; requestAnimationFrame(() => sheet.classList.add('open'));
}
function closeSheet() { const s = $('sheet'); s.classList.remove('open'); setTimeout(() => { s.hidden = true; }, 200); }

/* ---------- イベント ---------- */
$('chooseFiles').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', e => {
  const files = [...e.target.files]; const target = folders.includes(view) ? view : null; const added = [];
  for (const file of files) {
    if (!(/\.(mp3|wav|m4a|aac|ogg|flac|mp4|m4v|mov)$/i.test(file.name) || file.type.startsWith('audio/') || file.type.startsWith('video/'))) continue;
    const t = { id: uid(), title: file.name.replace(/\.[^.]+$/, ''), url: URL.createObjectURL(file), kind: 'local', file, folder: target };
    tracks.push(t); added.push(t);
  }
  e.target.value = '';
  if (!added.length) { notify('追加できる曲がありませんでした'); return; }
  saveState(); render(); persistNew(added).then(() => { metaQueue.push(...added); runMetaQueue(); });
});
$('showUrl').addEventListener('click', () => { $('urlForm').hidden = !$('urlForm').hidden; if (!$('urlForm').hidden) $('urlInput').focus(); });
$('urlForm').addEventListener('submit', e => {
  e.preventDefault(); const url = $('urlInput').value.trim();
  try {
    const info = parseShareUrl(url); const name = $('nameInput').value.trim(); const folder = folders.includes(view) ? view : null;
    if (info.kind === 'youtube') {
      if (tracks.some(t => t.kind === 'youtube' && t.ytId === info.ytId) && !confirm('この動画はすでに登録されています。もう一度追加しますか？')) return;
      const t = { id: uid(), title: name || 'YouTube動画', url: info.url, kind: 'youtube', ytId: info.ytId, thumb: ytThumb(info.ytId), folder, artist: null, needsTitle: !name };
      tracks.push(t); saveState(); render(); fetchYtInfo(t);
      notify('YouTubeの曲を登録しました');
    } else {
      tracks.push({ id: uid(), title: name || info.title || safeTitle(info.url), url: info.url, kind: 'remote', folder });
      saveState(); render(); notify(info.note || 'URLを登録しました');
    }
    $('urlForm').reset(); $('urlForm').hidden = true;
  } catch (err) { notify(err?.userMessage || 'URLを読み取れませんでした。共有リンクまたは https:// のURLを貼り付けてください'); }
});
$('clearLocal').addEventListener('click', () => {
  const locals = tracks.filter(t => t.kind === 'local'); if (!locals.length) { notify('保存した曲はありません'); return; }
  if (!confirm(`アプリに保存した ${locals.length} 曲をすべて削除しますか？（iPhone本体の元ファイルは消えません）`)) return;
  if (currentId && locals.some(t => t.id === currentId)) stop();
  for (const t of locals) URL.revokeObjectURL(t.url); dbClear();
  tracks = tracks.filter(t => t.kind !== 'local'); saveState(); render(); notify('保存した曲を削除しました');
});
$('search').addEventListener('input', e => { query = e.target.value; renderTracks(); });
$('autoSort').addEventListener('click', autoSort);
$('renameFolder').addEventListener('click', () => renameFolder(view));
$('deleteFolder').addEventListener('click', () => deleteFolder(view));
$('folderLeft').addEventListener('click', () => moveFolder(view, -1));
$('folderRight').addEventListener('click', () => moveFolder(view, 1));
$('playFolder').addEventListener('click', () => { const q = tracks.filter(t => inView(t, view)); if (!q.length) { notify('曲がありません'); return; } playView = view; playTrack((shuffle ? q[Math.floor(Math.random() * q.length)] : q[0]).id); });
$('sheet').addEventListener('click', e => { if (e.target.id === 'sheet') closeSheet(); });
$('sheetCancel').addEventListener('click', closeSheet);

$('play').addEventListener('click', () => {
  if (!currentId || !engine.hasSource()) { const q = visibleTracks(); if (q.length) { playView = view; playTrack(q[0].id); } else notify('先に曲を追加してください'); return; }
  if (engine.paused()) engine.play().catch(() => notify('再生できません')); else engine.pause();
});
$('prev').addEventListener('click', () => { if (engine.time() > 3) engine.seek(0); else step(-1); });
$('next').addEventListener('click', () => step(1));
$('shuffle').addEventListener('click', () => { shuffle = !shuffle; $('shuffle').classList.toggle('active', shuffle); $('shuffle').setAttribute('aria-pressed', String(shuffle)); notify(shuffle ? 'シャッフル ON' : 'シャッフル OFF'); });
$('repeat').addEventListener('click', () => { repeat = (repeat + 1) % 3; $('repeat').classList.toggle('active', repeat !== 0); $('repeat').textContent = repeat === 2 ? '↻₁' : '↻'; $('repeat').setAttribute('aria-label', ['リピートなし', '全曲リピート', '1曲リピート'][repeat]); notify(['リピート OFF', 'リピート ON', '1曲リピート'][repeat]); });
$('seek').addEventListener('input', () => { const d = engine.duration(); if (Number.isFinite(d) && d > 0) engine.seek((Number($('seek').value) / 1000) * d); });
$('volume').addEventListener('input', () => { audio.volume = Number($('volume').value); ytPlayer?.setVolume?.(Math.round(audio.volume * 100)); });
function tick() { const d = engine.duration(), c = engine.time(); $('currentTime').textContent = formatTime(c); if (Number.isFinite(d) && d > 0) { $('seek').value = String(Math.round(c / d * 1000)); $('duration').textContent = formatTime(d); } }
audio.addEventListener('timeupdate', tick);
audio.addEventListener('loadedmetadata', () => { $('duration').textContent = formatTime(audio.duration); });
audio.addEventListener('durationchange', () => { $('duration').textContent = formatTime(audio.duration); });
audio.addEventListener('play', updatePlay); audio.addEventListener('pause', updatePlay);
audio.addEventListener('ended', () => step(1, true));
audio.addEventListener('error', () => { if (currentId && !engine.yt()) notify('この曲を再生できません。ファイル形式またはURLを確認してください。'); });
if ('mediaSession' in navigator) {
  const actions = { play: () => engine.play(), pause: () => engine.pause(), previoustrack: () => step(-1), nexttrack: () => step(1),
    seekto: d => { if (Number.isFinite(d.seekTime)) engine.seek(d.seekTime); },
    seekbackward: d => { engine.seek(Math.max(0, engine.time() - (d.seekOffset || 10))); },
    seekforward: d => { engine.seek(Math.min(engine.duration() || Infinity, engine.time() + (d.seekOffset || 10))); } };
  for (const [name, handler] of Object.entries(actions)) { try { navigator.mediaSession.setActionHandler(name, handler); } catch {} }
}

/* ---------- サムネイル・歌手名の取得 ---------- */
const THUMB_PX = 320; const metaQueue = []; let metaBusy = false;
async function runMetaQueue() {
  if (metaBusy) return; metaBusy = true;
  while (metaQueue.length) {
    const t = metaQueue.shift(); if (!tracks.includes(t) || !t.file) continue;
    let meta = {}; try { meta = await readMeta(t); } catch {}
    delete t.file;
    if (meta.thumb) t.thumb = meta.thumb; if (meta.artist) t.artist = meta.artist;
    if (meta.thumb || meta.artist) { dbUpdate(t.id, { thumb: t.thumb || null, artist: t.artist || null }); render(); if (t.id === currentId) { showArt(t); updateMediaMeta(t); } }
  }
  metaBusy = false;
}
async function readMeta(t) {
  const f = t.file; const name = f.name.toLowerCase();
  const isVideo = /\.(mp4|m4v|mov)$/.test(name) || f.type.startsWith('video/');
  let tag = null;
  if (/\.mp3$/.test(name) || f.type === 'audio/mpeg') tag = await id3Tag(f);
  else if (/\.(m4a|mp4|m4v|mov|aac)$/.test(name) || /mp4|m4a|quicktime/.test(f.type)) tag = await mp4Tag(f);
  const out = { artist: tag?.artist || null, thumb: null };
  if (tag?.art) { const u = URL.createObjectURL(tag.art); try { out.thumb = await imageThumb(u); } catch {} finally { URL.revokeObjectURL(u); } }
  if (!out.thumb && isVideo) out.thumb = await videoThumb(t.url);
  return out;
}
function coverCrop(src, w, h) { const c = document.createElement('canvas'); c.width = c.height = THUMB_PX; const s = Math.min(w, h); c.getContext('2d').drawImage(src, (w - s) / 2, (h - s) / 2, s, s, 0, 0, THUMB_PX, THUMB_PX); return c.toDataURL('image/jpeg', 0.82); }
function imageThumb(url) { return new Promise((res, rej) => { const img = new Image(); img.onload = () => { try { res(coverCrop(img, img.naturalWidth, img.naturalHeight)); } catch (e) { rej(e); } }; img.onerror = rej; img.src = url; }); }
function videoThumb(url) {
  return new Promise(res => {
    const v = document.createElement('video'); v.muted = true; v.playsInline = true; v.setAttribute('playsinline', ''); v.setAttribute('muted', ''); v.preload = 'auto';
    let done = false; const fin = r => { if (done) return; done = true; clearTimeout(timer); v.removeAttribute('src'); v.load(); res(r); };
    const timer = setTimeout(() => fin(null), 10000);
    v.addEventListener('loadedmetadata', () => { const d = v.duration; v.currentTime = Number.isFinite(d) && d > 0 ? Math.min(d * 0.1, 5) : 0.5; });
    v.addEventListener('seeked', () => { setTimeout(() => { try { fin(v.videoWidth ? coverCrop(v, v.videoWidth, v.videoHeight) : null); } catch { fin(null); } }, 150); });
    v.addEventListener('error', () => fin(null)); v.src = url;
  });
}
async function bytes(f, a, b) { return new Uint8Array(await f.slice(a, b).arrayBuffer()); }
const ss = (b, i) => (b[i] & 127) << 21 | (b[i + 1] & 127) << 14 | (b[i + 2] & 127) << 7 | (b[i + 3] & 127);
const be32 = (b, i) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
function decodeText(enc, b) {
  try {
    if (enc === 0) return new TextDecoder('latin1').decode(b);
    if (enc === 1) return new TextDecoder('utf-16').decode(b);
    if (enc === 2) return new TextDecoder('utf-16be').decode(b);
    return new TextDecoder('utf-8').decode(b);
  } catch { return ''; }
}
async function id3Tag(f) {
  const h = await bytes(f, 0, 10); if (h[0] !== 73 || h[1] !== 68 || h[2] !== 51) return null;
  const ver = h[3], flags = h[5], size = ss(h, 6); let b = await bytes(f, 10, 10 + size);
  if (ver < 4 && (flags & 128)) { const o = []; for (let i = 0; i < b.length; i++) { o.push(b[i]); if (b[i] === 255 && b[i + 1] === 0) i++; } b = Uint8Array.from(o); }
  let p = 0; if (flags & 64) p = ver === 3 ? be32(b, 0) + 4 : ss(b, 0);
  const hl = ver === 2 ? 6 : 10; const out = {};
  while (p + hl <= b.length) {
    const fid = String.fromCharCode(...b.slice(p, p + (ver === 2 ? 3 : 4))); if (!/^[A-Z0-9]+$/.test(fid)) break;
    const fs = ver === 2 ? (b[p + 3] << 16 | b[p + 4] << 8 | b[p + 5]) : ver === 4 ? ss(b, p + 4) : be32(b, p + 4);
    const s = p + hl, e = Math.min(s + fs, b.length); if (fs <= 0) break;
    if ((fid === 'TPE1' || fid === 'TP1') && !out.artist) out.artist = decodeText(b[s], b.slice(s + 1, e)).replace(/\0/g, ' ').trim() || undefined;
    if ((fid === 'APIC' || fid === 'PIC') && !out.art) {
      const enc = b[s]; let q = s + 1, mime = 'image/jpeg';
      if (fid === 'PIC') { if (String.fromCharCode(...b.slice(q, q + 3)).toLowerCase() === 'png') mime = 'image/png'; q += 3; }
      else { let m = q; while (m < e && b[m] !== 0) m++; const mt = String.fromCharCode(...b.slice(q, m)); if (mt) mime = mt.includes('/') ? mt : 'image/' + mt.toLowerCase(); q = m + 1; }
      q++;
      if (enc === 1 || enc === 2) { while (q + 1 < e && !(b[q] === 0 && b[q + 1] === 0)) q += 2; q += 2; } else { while (q < e && b[q] !== 0) q++; q++; }
      if (q < e) out.art = new Blob([b.slice(q, e)], { type: mime });
    }
    p = s + fs;
  }
  return out;
}
async function atoms(f, start, end) {
  const out = []; let p = start;
  while (p + 8 <= end) {
    const h = await bytes(f, p, p + 16); let size = be32(h, 0); const type = String.fromCharCode(h[4], h[5], h[6], h[7]); let hl = 8;
    if (size === 1) { size = be32(h, 8) * 4294967296 + be32(h, 12); hl = 16; } else if (size === 0) size = end - p;
    if (size < hl) break; out.push({ type, start: p + hl, end: Math.min(p + size, end) }); p += size;
  }
  return out;
}
async function child(f, box, type, skip = 0) { if (!box) return null; return (await atoms(f, box.start + skip, box.end)).find(a => a.type === type) || null; }
async function mp4Tag(f) {
  const top = await atoms(f, 0, f.size); const moov = top.find(a => a.type === 'moov');
  const udta = await child(f, moov, 'udta'); const meta = await child(f, udta, 'meta'); if (!meta) return null;
  const v = await bytes(f, meta.start, meta.start + 4);
  const ilst = await child(f, meta, 'ilst', (v[0] | v[1] | v[2] | v[3]) === 0 ? 4 : 0); if (!ilst) return null;
  const items = await atoms(f, ilst.start, ilst.end); const out = {};
  for (const it of items) {
    if (it.type !== 'covr' && it.type !== '©ART' && it.type !== 'aART') continue;
    const data = await child(f, it, 'data'); if (!data) continue;
    const hd = await bytes(f, data.start, data.start + 8); const kind = be32(hd, 0) & 0xffffff;
    if (it.type === 'covr' && !out.art) out.art = new Blob([await f.slice(data.start + 8, data.end).arrayBuffer()], { type: kind === 14 ? 'image/png' : 'image/jpeg' });
    else if (it.type !== 'covr' && (!out.artist || it.type === '©ART')) out.artist = new TextDecoder().decode(await bytes(f, data.start + 8, data.end)).trim() || out.artist;
  }
  return out;
}

/* ---------- アプリ内保存（IndexedDB） ----------
   曲データは Blob（ファイル）として保存する。iPhoneのSafariでは Blob はディスク上のファイルとして
   扱われ、読み込み時にメモリへ展開されないため、曲数が多くても起動時に落ちにくい。
   v7以前は ArrayBuffer で保存していたので、起動時に1曲ずつ Blob 形式へ変換する。 */
const DB_NAME = 'my-music-db', DB_STORE = 'tracks'; let dbPromise = null;
function db() {
  if (!dbPromise) dbPromise = new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(DB_STORE)) r.result.createObjectStore(DB_STORE, { keyPath: 'id' }); };
    r.onsuccess = () => { const d = r.result; d.onversionchange = () => { d.close(); dbPromise = null; }; d.onclose = () => { dbPromise = null; }; res(d); };
    r.onerror = () => { dbPromise = null; rej(r.error); };
    r.onblocked = () => { dbPromise = null; rej(new Error('blocked')); };
  });
  return dbPromise;
}
async function dbTxOnce(mode, fn) { const d = await db(); return new Promise((res, rej) => { const tx = d.transaction(DB_STORE, mode); const st = tx.objectStore(DB_STORE); let out; const r = fn(st); if (r) r.onsuccess = () => { out = r.result; }; tx.oncomplete = () => res(out); tx.onerror = tx.onabort = () => rej(tx.error || new Error('abort')); }); }
// iOSでは再起動直後などに接続が切れていることがあるため、失敗したら接続し直して1回だけ再試行
async function dbTx(mode, fn) { try { return await dbTxOnce(mode, fn); } catch (e) { try { (await dbPromise)?.close(); } catch {} dbPromise = null; await new Promise(r => setTimeout(r, 300)); return dbTxOnce(mode, fn); } }
const dbPut = rec => dbTx('readwrite', st => st.put(rec));
const dbGet = id => dbTx('readonly', st => st.get(id));
const dbDelete = id => dbTx('readwrite', st => st.delete(id)).catch(() => {});
const dbClear = () => dbTx('readwrite', st => st.clear()).catch(() => {});
const dbKeys = () => dbTx('readonly', st => st.getAllKeys());
async function dbUpdate(id, patch) { try { await dbTx('readwrite', st => { const g = st.get(id); g.onsuccess = () => { if (g.result) st.put(Object.assign(g.result, patch)); }; return null; }); } catch {} }
function guessType(r) { return r.type || (/\.mp3$/i.test(r.name || '') ? 'audio/mpeg' : /\.(mp4|m4v)$/i.test(r.name || '') ? 'video/mp4' : /\.m4a$/i.test(r.name || '') ? 'audio/mp4' : /\.wav$/i.test(r.name || '') ? 'audio/wav' : ''); }
async function persistNew(list) {
  try { if (navigator.storage?.persist) await navigator.storage.persist(); } catch {}
  let ok = 0, ng = 0, lastErr = '';
  for (const t of list) {
    try { await dbPut({ id: t.id, title: t.title, type: t.file.type || '', name: t.file.name, data: new Blob([t.file], { type: t.file.type || guessType({ name: t.file.name }) }), thumb: null, artist: null }); ok++; }
    catch (e) { ng++; lastErr = e?.name || ''; }
  }
  notify(ng ? `${ok} 曲を保存、${ng} 曲は保存できませんでした（${lastErr === 'QuotaExceededError' ? '容量不足' : lastErr || 'エラー'}）` : `${ok} 曲をアプリに保存しました`);
  showDiag();
}
async function loadLocal() {
  let keys;
  try { keys = await dbKeys() || []; }
  catch (e) { notify('保存した曲を読み込めませんでした（' + (e?.name || 'エラー') + '）。アプリを開き直してください'); return; }
  let failed = 0, migrated = 0;
  for (const key of keys) {   // 1曲ずつ読む（まとめて読むとiPhoneのメモリが足りなくなる）
    try {
      let r = await dbGet(key); if (!r) continue;
      if (!(r.data instanceof Blob)) {   // 旧形式（ArrayBuffer）→ Blob形式に変換して保存し直す
        const blob = new Blob([r.data], { type: guessType(r) }); r.data = blob;
        await dbPut(r); migrated++; r = await dbGet(key); if (!r) continue;
      }
      if (tracks.some(t => t.id === r.id)) continue;
      tracks.push({ id: r.id, title: r.title, url: URL.createObjectURL(r.data), kind: 'local', thumb: r.thumb || null, artist: r.artist || null });
    } catch { failed++; }
    if (migrated && migrated % 3 === 0) { applySavedOrderAndFolders(); render(); }
  }
  if (failed) notify(`${failed} 曲を読み込めませんでした。アプリを開き直すと読み込める場合があります`);
  else if (migrated) notify(`${migrated} 曲を新しい保存形式に変換しました`);
}

/* ---------- 共有リンクの解析 ---------- */
function userError(msg) { const e = new Error(msg); e.userMessage = msg; return e; }
function parseShareUrl(text) {
  // 「共有」でコピーした文章（タイトル＋URL）が貼られても、URL部分だけを取り出す
  const m = String(text).match(/https?:\/\/[^\s<>"'「」]+/i); let raw = m ? m[0] : String(text).trim();
  if (!/^https?:\/\//i.test(raw) && /^[\w-]+(\.[\w-]+)+\//.test(raw)) raw = 'https://' + raw;
  const u = new URL(raw); const host = u.hostname.toLowerCase().replace(/^(www|m)\./, '');
  // YouTube / YouTube Music
  if (host === 'youtu.be' || /(^|\.)youtube\.com$/.test(host) || host === 'youtube-nocookie.com') {
    const id = host === 'youtu.be' ? u.pathname.split('/')[1] : (u.searchParams.get('v') || (u.pathname.match(/^\/(?:shorts|embed|live|v)\/([\w-]{11})/) || [])[1]);
    if (id && /^[\w-]{11}$/.test(id)) return { kind: 'youtube', ytId: id, url: `https://www.youtube.com/watch?v=${id}` };
    if (u.searchParams.get('list')) throw userError('YouTubeの再生リスト全体は登録できません。曲ごとの共有リンクを貼り付けてください');
    throw userError('YouTubeの動画URLを読み取れませんでした');
  }
  // Googleドライブ（ファイルの共有リンク → 直接ダウンロードURL）
  if (host === 'drive.google.com' || host === 'docs.google.com') {
    const id = (u.pathname.match(/\/file\/d\/([\w-]+)/) || [])[1] || u.searchParams.get('id');
    if (!id) throw userError('Googleドライブのファイル共有リンクを貼り付けてください（フォルダのリンクは使えません）');
    return { kind: 'remote', url: `https://drive.google.com/uc?export=download&id=${id}`, note: 'Googleドライブのリンクを登録しました（「リンクを知っている全員」に共有されている必要があります）' };
  }
  // Dropbox（?dl=0 → ?raw=1）
  if (host === 'dropbox.com' || host === 'dl.dropboxusercontent.com') {
    u.searchParams.delete('dl'); u.searchParams.set('raw', '1'); u.protocol = 'https:';
    return { kind: 'remote', url: u.href, note: 'Dropboxのリンクを登録しました' };
  }
  if (/(^|\.)(spotify\.com|music\.apple\.com|soundcloud\.com|nicovideo\.jp|tiktok\.com)$/.test(host))
    throw userError('このサービスのリンクは、仕組み上このアプリでは再生できません（YouTube・Googleドライブ・Dropbox・音声ファイルの直接URLに対応）');
  if (u.protocol !== 'https:') throw userError('https:// で始まるURLのみ登録できます');
  return { kind: 'remote', url: u.href };
}

/* ---------- YouTube（公式の埋め込みプレーヤー） ---------- */
let ytPlayer = null, ytApi = null, ytState = -1, ytTimer = null;
function ytThumb(id) { return `https://i.ytimg.com/vi/${id}/hqdefault.jpg`; }
function loadYtApi() {
  if (ytApi) return ytApi;
  ytApi = new Promise((res, rej) => {
    if (window.YT?.Player) { res(window.YT); return; }
    const prev = window.onYouTubeIframeAPIReady; window.onYouTubeIframeAPIReady = () => { prev?.(); res(window.YT); };
    const s = document.createElement('script'); s.src = 'https://www.youtube.com/iframe_api'; s.async = true;
    s.onerror = () => { ytApi = null; rej(new Error('yt')); }; document.head.append(s);
    setTimeout(() => { if (!window.YT?.Player) { ytApi = null; rej(new Error('timeout')); } }, 15000);
  });
  return ytApi;
}
async function ytLoad(track) {
  ytState = -1; $('ytHint').hidden = false;
  try { await loadYtApi(); } catch { notify('YouTubeに接続できません。通信状態を確認してください'); return; }
  if (currentId !== track.id) return;
  if (ytPlayer?.loadVideoById) { ytPlayer.loadVideoById(track.ytId); startYtTimer(); return; }
  ytPlayer = new YT.Player('ytPlayer', {
    width: '100%', height: '100%', videoId: track.ytId,
    playerVars: { playsinline: 1, rel: 0, autoplay: 1 },
    events: {
      onReady: e => { e.target.setVolume(Math.round(audio.volume * 100)); e.target.playVideo(); startYtTimer(); },
      onStateChange: e => {
        ytState = e.data;
        if (e.data === 1) { $('ytHint').hidden = true; const t = curTrack(); if (t?.needsTitle) { const title = ytPlayer.getVideoData?.().title; if (title) { t.title = title; delete t.needsTitle; saveState(); setNow(t); } } }
        if (e.data === 0) step(1, true);
        updatePlay(); tick();
      },
      onError: e => {
        const msg = { 2: '動画のURLが正しくありません', 5: 'この動画はこの端末で再生できません', 100: '動画が削除されたか非公開です', 101: 'この動画は投稿者が埋め込み再生を許可していません', 150: 'この動画は投稿者が埋め込み再生を許可していません' }[e.data] || 'YouTubeの動画を再生できません';
        notify(msg + '。次の曲へ進むには ⏭ を押してください');
      },
    },
  });
}
function startYtTimer() { clearInterval(ytTimer); ytTimer = setInterval(() => { if (engine.yt()) tick(); }, 500); }
function ytStop() { clearInterval(ytTimer); ytState = -1; try { ytPlayer?.stopVideo?.(); } catch {} $('ytWrap').hidden = true; $('art').hidden = false; }
async function fetchYtInfo(t) {
  try {
    const r = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(t.url)}`); if (!r.ok) return;
    const j = await r.json();
    if (t.needsTitle && j.title) { t.title = j.title; delete t.needsTitle; }
    if (j.author_name && !t.artist) t.artist = j.author_name.replace(/\s*-\s*Topic$/i, '').replace(/\s*(official|オフィシャル)\s*(youtube)?\s*(channel|チャンネル)?$/i, '').trim();
    saveState(); render(); if (t.id === currentId) setNow(t);
  } catch {}
}

/* ---------- 起動 ---------- */
/* ---------- 保存状況の診断 ---------- */
async function showDiag() {
  const box = $('diag'); if (!box) return; const lines = [];
  const standalone = window.navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
  lines.push(['アプリの版', APP_VERSION]);
  lines.push(['開き方', standalone ? 'ホーム画面のアプリ' : 'ブラウザ（Safariまたは他アプリ内のブラウザ）']);
  let ls = 'OK'; try { localStorage.setItem('__t', '1'); localStorage.removeItem('__t'); } catch { ls = '使用不可（プライベートブラウズ・Cookieブロックの可能性）'; }
  lines.push(['設定の保存', ls]);
  let n = '—'; try { const recs = await dbTx('readonly', st => st.count()); n = `${recs} 曲`; } catch (e) { n = '使用不可（' + (e?.name || 'エラー') + '）'; }
  lines.push(['アプリ内に保存した曲', n]);
  try { if (navigator.storage?.estimate) { const est = await navigator.storage.estimate(); lines.push(['使用容量', `${(est.usage / 1048576).toFixed(1)} MB / 上限 約 ${(est.quota / 1073741824).toFixed(1)} GB`]); } } catch {}
  try { if (navigator.storage?.persisted) lines.push(['削除からの保護', (await navigator.storage.persisted()) ? '有効' : '無効（空き容量が少ないとiOSが消すことがあります）']); } catch {}
  box.replaceChildren(...lines.map(([k, v]) => { const r = el('div', 'diag-row'); r.append(el('span', '', k), el('strong', '', v)); return r; }));
  if (!standalone) box.append(el('p', 'diag-tip', 'ホーム画面のアプリとブラウザでは保存場所が別です。Claudeアプリ内などのブラウザで開くと、閉じたときに保存した曲が消える場合があります。Safariで開いて「共有 → ホーム画面に追加」したアプリから使ってください。'));
}

async function init() {
  loadRemote(); applySavedOrderAndFolders(); render(); updatePlay();
  await loadLocal(); applySavedOrderAndFolders(); render();
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).then(r => r.update()).catch(() => {});
  showDiag();
}
init();

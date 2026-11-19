'use strict';
const APP_VERSION = 'v18';
/* =========================================================
   My Music — iPhone向け 個人用 音楽・動画プレーヤー（PWA）
   ========================================================= */
const $ = id => document.getElementById(id);
const audio = $('audio');   // 音はいつもこの要素から出す（画面を離れても再生を続けられる）
const video = $('video');   // 動画モードの映像表示用（消音して音声に同期させる）
let cur = audio;            // 再生を管理する要素（常に audio）
let videoOn = false;        // 映像を表示しているか

const STORE = 'my-music-remote-v1';        // Web曲（URL）
const ORDER_KEY = 'my-music-order-v1';     // 曲順
const FOLDERS_KEY = 'my-music-folders-v1'; // フォルダ一覧
const FOLDER_MAP_KEY = 'my-music-folder-map-v1'; // 曲ID → フォルダ名
const MODE_KEY = 'my-music-mode-v1';           // 音楽モード / 動画モード
const VIEW_ALL = '__all__', VIEW_NONE = '__none__';
let mode = localStorage.getItem(MODE_KEY) === 'video' ? 'video' : 'music';
let typeFilter = 'all', playType = 'all';      // 種類での絞り込み（すべて / 音楽 / 動画）

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
function mediaOf(type, name) { return /^video\//.test(type || '') || /\.(mp4|m4v|mov)(\?|#|$)/i.test(name || '') ? 'video' : 'audio'; }
function fmtSize(n) { if (!n) return ''; return n >= 1073741824 ? (n / 1073741824).toFixed(1) + 'GB' : n >= 1048576 ? (n / 1048576).toFixed(1) + 'MB' : Math.max(1, Math.round(n / 1024)) + 'KB'; }
function extOf(t) { const m = (t.name || '').match(/\.([a-z0-9]{2,4})$/i); if (m) return m[1].toLowerCase(); const ty = t.blob?.type || ''; return { 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'video/mp4': 'mp4', 'video/quicktime': 'mov' }[ty] || (t.media === 'video' ? 'mp4' : 'm4a'); }
// ファイル形式（拡張子）を表示用に返す
function formatOf(t) {
  if (!t) return '';
  if (t.kind === 'youtube') return 'YouTube';
  if (t.kind === 'local') return extOf(t).toUpperCase();
  const m = (() => { try { return decodeURIComponent(new URL(t.url).pathname); } catch { return ''; } })().match(/\.([a-z0-9]{2,4})$/i);
  return m ? m[1].toUpperCase() : '形式不明';
}
function safeFileName(s) { return String(s || 'my-music').replace(/[\\/:*?"<>|\n\r]+/g, ' ').trim().slice(0, 80) || 'my-music'; }
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
    if (t.kind === 'youtube' && /^[\w-]{11}$/.test(t.ytId || '')) return { ...base, kind: 'youtube', ytId: t.ytId, thumb: ytThumb(t.ytId), media: 'video' };
    return { ...base, kind: 'remote', media: mediaOf('', t.url) };
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
function matchType(t, f) { return f === 'all' || t.media === f; }
function setQueue() { playView = view; playType = typeFilter; }
function queueTracks() { return tracks.filter(t => inView(t, playView) && matchType(t, playType)); }
function visibleTracks() { const q = query.trim().toLowerCase(); return tracks.filter(t => inView(t, view) && matchType(t, typeFilter) && (!q || t.title.toLowerCase().includes(q) || (t.folder || '').toLowerCase().includes(q) || (t.artist || '').toLowerCase().includes(q) || formatOf(t).toLowerCase() === q.replace(/^\./, ''))); }

/* ---------- 描画 ---------- */
function render() { renderFolders(); renderTracks(); refreshMini(); }

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
  $('count').textContent = view === VIEW_ALL && !query && typeFilter === 'all' ? `${tracks.length} 件` : `${vis.length} / ${tracks.length} 件`;
  if (!vis.length) {
    list.append(el('li', 'empty', !tracks.length ? '曲・動画がありません。ファイルまたはURLから追加してください。' : query ? '検索に一致する曲がありません。' : typeFilter !== 'all' ? (typeFilter === 'video' ? '動画はありません。' : '音楽はありません。') : folders.includes(view) ? 'このフォルダには曲がありません。曲の「⋯」から移動するか、このフォルダを開いたまま曲を追加してください。' : '曲がありません。'));
    return;
  }
  vis.forEach((track, index) => {
    const li = el('li'); li.dataset.id = track.id; if (track.id === currentId) li.classList.add('current');
    const handle = el('span', 'drag-handle', '≡'); handle.setAttribute('aria-hidden', 'true'); handle.addEventListener('pointerdown', e => startDrag(e, li));
    const btn = el('button', 'track-select'); btn.type = 'button'; btn.addEventListener('click', () => { setQueue(); playTrack(track.id); });
    const icon = el('span', 'track-icon'); const playingNow = track.id === currentId && !engine.paused();
    if (track.thumb) { icon.classList.add('has-thumb'); icon.style.backgroundImage = `url("${track.thumb}")`; if (playingNow) { icon.classList.add('playing'); icon.textContent = '♫'; } }
    else icon.textContent = playingNow ? '♫' : '♪';
    const info = el('span', 'track-info');
    const meta = el('span', 'track-type');
    const fmt = formatOf(track);
    if (track.kind !== 'youtube') { const badge = el('span', 'fmt-badge ' + (track.media === 'video' ? 'fmt-video' : 'fmt-audio'), fmt); meta.append(badge); }
    meta.append(document.createTextNode([track.media === 'video' ? '🎬 動画' : '🎵 音楽', track.folder && view === VIEW_ALL ? '📁 ' + track.folder : '', track.kind === 'local' ? '保存済み' : track.kind === 'youtube' ? '▶ YouTube' : 'Web URL', track.kind === 'local' ? fmtSize(track.size) : ''].filter(Boolean).join(' · ')));
    info.append(el('span', 'track-name', track.title), meta);
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
  $('trackSubtitle').textContent = track ? (track.folder || track.artist || (track.kind === 'local' ? 'アプリに保存した' + (track.media === 'video' ? '動画' : '曲') : track.kind === 'youtube' ? 'YouTube' : 'Webサーバーから再生')) : 'MP3 / WAV / M4A / MP4 / MOV';
  $('sourceLabel').textContent = track ? sourceText(track) : 'READY TO PLAY';
  $('seek').value = '0'; $('currentTime').textContent = '0:00'; $('duration').textContent = '0:00';
  showArt(track); updateMediaMeta(track); updateMini(track);
}
function updateMediaMeta(track) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = track ? new MediaMetadata({ title: track.title, artist: track.artist || track.folder || 'My Music', album: track.folder || 'My Music', artwork: track.thumb ? [{ src: track.thumb, sizes: track.kind === 'youtube' ? '480x360' : '320x320', type: 'image/jpeg' }] : [] }) : null;
}
function showArt(track) {
  const yt = track?.kind === 'youtube', vid = !yt && !!track && videoOn;
  $('art').hidden = yt || vid; $('ytWrap').hidden = !yt; $('videoWrap').hidden = !vid;
  const art = $('art'); art.replaceChildren();
  if (track?.thumb) { const img = el('img'); img.src = track.thumb; img.alt = ''; art.append(img); art.classList.add('has-thumb'); }
  else { art.append(el('span', '', '♫')); art.classList.remove('has-thumb'); }
}

/* ---------- 再生 ---------- */
function wantVideo(t) { return mode === 'video' && !!t && t.kind !== 'youtube' && t.media === 'video'; }
function clearEl(m) { try { m.pause(); } catch {} if (m.getAttribute('src')) { m.removeAttribute('src'); m.load(); } }
async function playTrack(trackId) {
  const track = tracks.find(t => t.id === trackId); if (!track) return;
  if (!navigator.onLine && track.kind !== 'local') { notify('オフラインのため再生できません（端末に保存した曲・動画は再生できます）'); return; }
  if (currentId !== trackId) {
    currentId = trackId;
    if (track.kind === 'youtube') { clearEl(audio); detachVideo(); cur = audio; setNow(track); ytLoad(track); render(); return; }
    ytStop(); detachVideo(); cur = audio; audio.src = window.srcFor ? srcFor(track) : track.url; audio.load();
    if (wantVideo(track)) attachVideo(track);
    setNow(track);
  }
  try { await engine.play(); } catch { notify('再生できません。URL・形式・通信状態を確認してください。'); }
  render();
}
function stop() { ytStop(); clearEl(audio); detachVideo(); cur = audio; currentId = null; setNow(null); updatePlay(); }
function curTrack() { return tracks.find(t => t.id === currentId) || null; }
// 音声ファイルとYouTubeの両方を同じ操作で扱うための窓口
const engine = {
  yt() { return curTrack()?.kind === 'youtube'; },
  paused() { return this.yt() ? !(ytState === 1 || ytState === 3) : cur.paused; },
  time() { return this.yt() ? (ytPlayer?.getCurrentTime?.() || 0) : cur.currentTime; },
  duration() { return this.yt() ? (ytPlayer?.getDuration?.() || NaN) : cur.duration; },
  seek(s) { if (this.yt()) ytPlayer?.seekTo?.(s, true); else cur.currentTime = s; },
  play() { if (this.yt()) { ytPlayer?.playVideo?.(); return Promise.resolve(); } return cur.play(); },
  pause() { if (this.yt()) ytPlayer?.pauseVideo?.(); else cur.pause(); },
  hasSource() { return this.yt() ? true : !!cur.getAttribute('src'); },
};
function step(direction, ended = false) {
  let q = queueTracks(); if (!q.length) { playView = VIEW_ALL; playType = 'all'; q = tracks; }
  if (!navigator.onLine) q = q.filter(t => t.kind === 'local' || t.id === currentId);   // オフライン時は保存済みだけ
  if (!q.length) return;
  if (ended && repeat === 2 && currentId) { engine.seek(0); engine.play().catch(() => notify('再生できません')); return; }
  if (shuffle && q.length > 1) { const other = q.filter(t => t.id !== currentId); playTrack(other[Math.floor(Math.random() * other.length)].id); return; }
  const idx = q.findIndex(t => t.id === currentId); const next = idx < 0 ? 0 : idx + direction;
  if (next < 0) { playTrack(q[0].id); return; }
  if (next >= q.length) { if (repeat === 1 || !ended) playTrack(q[0].id); else { engine.pause(); engine.seek(0); updatePlay(); } return; }
  playTrack(q[next].id);
}
function updatePlay() {
  const p = engine.paused(); $('play').textContent = p ? '▶' : 'Ⅱ'; $('play').setAttribute('aria-label', p ? '再生' : '一時停止');
  $('miniPlay').textContent = p ? '▶' : 'Ⅱ'; $('miniPlay').setAttribute('aria-label', p ? '再生' : '一時停止');
  render(); if ('mediaSession' in navigator) navigator.mediaSession.playbackState = p ? 'paused' : 'playing';
}

/* ---------- 曲の操作 ---------- */
function removeTrack(trackId) {
  const idx = tracks.findIndex(t => t.id === trackId); if (idx < 0) return;
  const track = tracks[idx]; if (currentId === trackId) stop();
  tracks.splice(idx, 1);
  if (track.kind === 'local') { URL.revokeObjectURL(track.url); if (track.normUrl) URL.revokeObjectURL(track.normUrl); dbDelete(track.id); }
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
function openSheet(title) { clearTimeout(sheetTimer); const body = $('sheetBody'); body.replaceChildren(); $('sheetTitle').textContent = title; const s = $('sheet'); s.hidden = false; requestAnimationFrame(() => s.classList.add('open')); return body; }
function sheetItem(body, label, fn, { cls = '', keep = false } = {}) { const b = el('button', 'sheet-item ' + cls, label); b.type = 'button'; b.addEventListener('click', () => { if (!keep) closeSheet(); fn(); }); body.append(b); return b; }
function openTrackMenu(trackId) {
  const t = tracks.find(x => x.id === trackId); if (!t) return;
  const body = openSheet(t.title);
  const item = (label, fn, cls = '') => sheetItem(body, label, fn, { cls });
  body.append(el('div', 'sheet-label', 'フォルダに移動'));
  for (const f of folders) item((t.folder === f ? '✓ ' : '　 ') + '📁 ' + f, () => setFolder(t.id, f), t.folder === f ? 'checked' : '');
  item((t.folder ? '　 ' : '✓ ') + 'フォルダなし（未分類）', () => setFolder(t.id, null), t.folder ? '' : 'checked');
  const guess = guessArtist(t);
  if (guess && !folders.includes(guess)) item(`＋ 「${guess}」フォルダを作って移動`, () => { folders.push(guess); setFolder(t.id, guess); });
  item('＋ 新しいフォルダを作って移動', () => { const f = askFolderName(guess || ''); if (f) setFolder(t.id, f); });
  body.append(el('div', 'sheet-label', 'ファイル情報'));
  const info = el('div', 'file-info');
  const rows = [['形式', t.kind === 'youtube' ? 'YouTube（公式プレーヤーで再生）' : `${formatOf(t)}（${t.media === 'video' ? '動画' : '音声'}）`]];
  if (t.kind === 'local') { rows.push(['サイズ', fmtSize(t.size) || '—']); if (t.name) rows.push(['元のファイル名', t.name]); if (t.blob?.type) rows.push(['種類（MIME）', t.blob.type]); }
  else rows.push(['保存', t.kind === 'youtube' ? '保存できません（オンライン再生のみ）' : '未保存（URLから再生）']);
  if (t.id === currentId && Number.isFinite(engine.duration()) && engine.duration() > 0) rows.push(['長さ', formatTime(engine.duration())]);
  if (t.kind === 'local' && t.gainDb != null) rows.push(['音量の補正', t.normBlob ? `${t.gainDb > 0 ? '+' : ''}${t.gainDb} dB（元の大きさ ${t.lufs != null ? t.lufs.toFixed(1) + ' LUFS' : '—'}）` : '補正なし（もともと標準的な大きさ）']);
  for (const [k, v] of rows) { const r = el('div', 'file-info-row'); r.append(el('span', '', k), el('strong', '', v)); info.append(r); }
  body.append(info);
  body.append(el('div', 'sheet-label', '保存・変換'));
  if (t.kind === 'local') {
    item('📁 「ファイル」アプリに保存', () => exportTrack(t));
    item('🎧 音声を取り出す（MP3・WAV）', () => window.openExtract ? openExtract(t) : notify('読み込み中です。少し待ってからもう一度お試しください'));
  } else if (t.kind === 'remote') {
    item('⬇ 端末に保存（オフラインで再生）', () => saveRemoteTrack(t));
  } else {
    body.append(el('div', 'sheet-note', 'YouTubeの動画は、規約により保存・音声の取り出しはできません（公式プレーヤーで再生します）'));
  }
  body.append(el('div', 'sheet-label', 'その他'));
  item('✎ 曲名を変更', () => { const n = (prompt('曲名', t.title) || '').trim(); if (n) { t.title = n; if (t.kind === 'local') dbUpdate(t.id, { title: n }); saveState(); render(); if (t.id === currentId) setNow(t); } });
  item('🗑 この曲を削除', () => { if (confirm(`「${t.title}」を削除しますか？${t.kind === 'local' ? '\n（iPhone本体の元ファイルは消えません）' : ''}`)) removeTrack(t.id); }, 'danger');
}
let sheetTimer = null;
function closeSheet() { const s = $('sheet'); s.classList.remove('open'); clearTimeout(sheetTimer); sheetTimer = setTimeout(() => { s.hidden = true; }, 200); }

/* ---------- イベント ---------- */
$('chooseFiles').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', async e => {
  const files = [...e.target.files].filter(f => /\.(mp3|wav|m4a|aac|mp4|m4v|mov)$/i.test(f.name) || f.type.startsWith('audio/') || f.type.startsWith('video/'));
  e.target.value = '';
  if (!files.length) { notify('追加できるファイルがありませんでした（MP3・WAV・M4A・MP4・MOVに対応）'); return; }
  if (!(await checkSpace(files.reduce((a, f) => a + f.size, 0)))) return;
  const target = folders.includes(view) ? view : null; const added = [];
  for (const file of files) {
    const t = { id: uid(), title: file.name.replace(/\.[^.]+$/, ''), url: URL.createObjectURL(file), kind: 'local', file, blob: file, name: file.name, media: mediaOf(file.type, file.name), size: file.size, folder: target };
    tracks.push(t); added.push(t);
  }
  saveState(); render(); persistNew(added).then(() => { metaQueue.push(...added); runMetaQueue(); window.normEnqueue?.(added); });
});
$('showUrl').addEventListener('click', () => { $('urlForm').hidden = !$('urlForm').hidden; if (!$('urlForm').hidden) $('urlInput').focus(); });
$('urlForm').addEventListener('submit', e => {
  e.preventDefault(); const url = $('urlInput').value.trim();
  try {
    const info = parseShareUrl(url); const name = $('nameInput').value.trim(); const folder = folders.includes(view) ? view : null;
    const wantSave = $('saveOffline').checked;
    if (info.kind === 'youtube') {
      if (wantSave) notify('YouTubeは規約により保存できません。公式プレーヤーで再生する形で登録します');
      if (tracks.some(t => t.kind === 'youtube' && t.ytId === info.ytId) && !confirm('この動画はすでに登録されています。もう一度追加しますか？')) return;
      const t = { id: uid(), title: name || 'YouTube動画', url: info.url, kind: 'youtube', ytId: info.ytId, thumb: ytThumb(info.ytId), folder, artist: null, needsTitle: !name };
      tracks.push(t); saveState(); render(); fetchYtInfo(t);
      if (!wantSave) notify('YouTubeの曲を登録しました');
    } else {
      const t = { id: uid(), title: name || info.title || safeTitle(info.url), url: info.url, kind: 'remote', media: mediaOf('', info.url), folder };
      tracks.push(t); saveState(); render();
      if (wantSave) saveRemoteTrack(t); else notify(info.note || 'URLを登録しました');
    }
    $('urlForm').reset(); $('urlForm').hidden = true;
  } catch (err) { notify(err?.userMessage || 'URLを読み取れませんでした。共有リンクまたは https:// のURLを貼り付けてください'); }
});
$('clearLocal').addEventListener('click', () => {
  const locals = tracks.filter(t => t.kind === 'local'); if (!locals.length) { notify('保存した曲・動画はありません'); return; }
  if (!confirm(`アプリに保存した ${locals.length} 件（約${fmtSize(locals.reduce((a, t) => a + (t.size || 0), 0))}）をすべて削除しますか？（iPhone本体の元ファイルは消えません）`)) return;
  if (currentId && locals.some(t => t.id === currentId)) stop();
  for (const t of locals) URL.revokeObjectURL(t.url); dbClear();
  tracks = tracks.filter(t => t.kind !== 'local'); saveState(); render(); notify('保存した曲を削除しました');
});
$('search').addEventListener('input', e => { query = e.target.value; renderTracks(); });
for (const b of document.querySelectorAll('.type-filter button')) b.addEventListener('click', () => {
  typeFilter = b.dataset.type; for (const x of document.querySelectorAll('.type-filter button')) x.classList.toggle('active', x === b); renderTracks();
});
$('modeMusic').addEventListener('click', () => setMode('music'));
$('modeVideo').addEventListener('click', () => setMode('video'));
$('pipBtn').addEventListener('click', togglePiP);
$('fsBtn').addEventListener('click', () => { try { if (video.webkitEnterFullscreen) video.webkitEnterFullscreen(); else video.requestFullscreen?.(); } catch { notify('全画面にできませんでした'); } });
$('autoSort').addEventListener('click', autoSort);
$('renameFolder').addEventListener('click', () => renameFolder(view));
$('deleteFolder').addEventListener('click', () => deleteFolder(view));
$('folderLeft').addEventListener('click', () => moveFolder(view, -1));
$('folderRight').addEventListener('click', () => moveFolder(view, 1));
$('playFolder').addEventListener('click', () => { const q = tracks.filter(t => inView(t, view) && matchType(t, typeFilter)); if (!q.length) { notify('曲がありません'); return; } setQueue(); playTrack((shuffle ? q[Math.floor(Math.random() * q.length)] : q[0]).id); });
$('sheet').addEventListener('click', e => { if (e.target.id === 'sheet') closeSheet(); });
$('sheetCancel').addEventListener('click', closeSheet);

$('play').addEventListener('click', () => {
  if (!currentId || !engine.hasSource()) { const q = visibleTracks(); if (q.length) { setQueue(); playTrack(q[0].id); } else notify('先に曲を追加してください'); return; }
  if (engine.paused()) engine.play().catch(() => notify('再生できません')); else engine.pause();
});
$('prev').addEventListener('click', () => { if (engine.time() > 3) engine.seek(0); else step(-1); });
$('next').addEventListener('click', () => step(1));
$('shuffle').addEventListener('click', () => { shuffle = !shuffle; $('shuffle').classList.toggle('active', shuffle); $('shuffle').setAttribute('aria-pressed', String(shuffle)); notify(shuffle ? 'シャッフル ON' : 'シャッフル OFF'); });
$('repeat').addEventListener('click', () => { repeat = (repeat + 1) % 3; $('repeat').classList.toggle('active', repeat !== 0); $('repeat').textContent = repeat === 2 ? '↻₁' : '↻'; $('repeat').setAttribute('aria-label', ['リピートなし', '全曲リピート', '1曲リピート'][repeat]); notify(['リピート OFF', 'リピート ON', '1曲リピート'][repeat]); });
$('seek').addEventListener('input', () => { const d = engine.duration(); if (Number.isFinite(d) && d > 0) engine.seek((Number($('seek').value) / 1000) * d); });
$('volume').addEventListener('input', () => { audio.volume = video.volume = Number($('volume').value); ytPlayer?.setVolume?.(Math.round(audio.volume * 100)); });
let lastPos = 0;
function tick() {
  const d = engine.duration(), c = engine.time(); $('currentTime').textContent = formatTime(c);
  if (Number.isFinite(d) && d > 0) {
    $('seek').value = String(Math.round(c / d * 1000)); $('duration').textContent = formatTime(d);
    $('miniBar').style.width = (c / d * 100).toFixed(2) + '%';
    // ロック画面のシークバー
    if ('mediaSession' in navigator && navigator.mediaSession.setPositionState && Date.now() - lastPos > 1000) { lastPos = Date.now(); try { navigator.mediaSession.setPositionState({ duration: d, position: Math.min(c, d), playbackRate: 1 }); } catch {} }
  }
}
for (const m of [audio, video]) {   // 使っている方の要素のイベントだけ扱う
  const on = (ev, fn) => m.addEventListener(ev, e => { if (e.target === cur) fn(e); });
  on('timeupdate', tick);
  on('loadedmetadata', () => { $('duration').textContent = formatTime(cur.duration); });
  on('durationchange', () => { $('duration').textContent = formatTime(cur.duration); });
  on('play', updatePlay); on('pause', updatePlay);
  on('ended', () => step(1, true));
  on('error', () => { if (currentId && !engine.yt()) notify('再生できません。ファイル形式またはURLを確認してください。'); });
}
if ('mediaSession' in navigator) {
  const actions = { play: () => engine.play(), pause: () => engine.pause(), previoustrack: () => step(-1), nexttrack: () => step(1),
    seekto: d => { if (Number.isFinite(d.seekTime)) engine.seek(d.seekTime); },
    seekbackward: d => { engine.seek(Math.max(0, engine.time() - (d.seekOffset || 10))); },
    seekforward: d => { engine.seek(Math.min(engine.duration() || Infinity, engine.time() + (d.seekOffset || 10))); },
    stop: () => engine.pause() };
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
// 曲名などを書き換えるときは、曲データに形式（MIMEタイプ）を付け直してから保存する
// （iPhoneでは保存し直したデータの形式が消えることがあり、形式のないデータは再生できないため）
async function dbUpdate(id, patch) { try { await dbTx('readwrite', st => { const g = st.get(id); g.onsuccess = () => { if (g.result) { const rec = Object.assign(g.result, patch); if (rec.data instanceof Blob) { rec.data = typedBlob(rec); rec.type = rec.type || rec.data.type; } st.put(rec); } }; return null; }); } catch {} }
// 保存データに必ず形式を付ける（slice はデータをコピーせずに形式だけ付け替える）
function typedBlob(r) { const type = r.type || r.data.type || guessType(r); return (!type || r.data.type === type) ? r.data : r.data.slice(0, r.data.size, type); }
function guessType(r) { return r.type || (/\.mp3$/i.test(r.name || '') ? 'audio/mpeg' : /\.(mp4|m4v)$/i.test(r.name || '') ? 'video/mp4' : /\.mov$/i.test(r.name || '') ? 'video/quicktime' : /\.m4a$/i.test(r.name || '') ? 'audio/mp4' : /\.wav$/i.test(r.name || '') ? 'audio/wav' : ''); }
async function persistNew(list) {
  try { if (navigator.storage?.persist) await navigator.storage.persist(); } catch {}
  let ok = 0, ng = 0, lastErr = '';
  for (const t of list) {
    try { await dbPut({ id: t.id, title: t.title, type: t.file.type || guessType({ name: t.file.name }), name: t.file.name, data: new Blob([t.file], { type: t.file.type || guessType({ name: t.file.name }) }), thumb: t.thumb || null, artist: t.artist || null }); ok++; }
    catch (e) { ng++; lastErr = e?.name || ''; }
  }
  notify(ng ? `${ok} 件を保存、${ng} 件は保存できませんでした（${lastErr === 'QuotaExceededError' ? '容量不足' : lastErr || 'エラー'}）` : `${ok} 件をアプリに保存しました`);
  showDiag();
}
async function loadLocal() {
  let keys;
  try { keys = await dbKeys() || []; }
  catch (e) { notify('保存した曲を読み込めませんでした（' + (e?.name || 'エラー') + '）。アプリを開き直してください'); return; }
  let failed = 0, migrated = 0, repaired = 0;
  for (const key of keys) {   // 1曲ずつ読む（まとめて読むとiPhoneのメモリが足りなくなる）
    try {
      let r = await dbGet(key); if (!r) continue;
      if (!(r.data instanceof Blob)) {   // 旧形式（ArrayBuffer）→ Blob形式に変換して保存し直す
        const blob = new Blob([r.data], { type: guessType(r) }); r.data = blob;
        await dbPut(r); migrated++; r = await dbGet(key); if (!r) continue;
      }
      if (tracks.some(t => t.id === r.id)) continue;
      const blob = typedBlob(r);
      if (blob !== r.data) {   // 形式が消えていたデータを修復して保存し直す
        r.data = blob; r.type = r.type || blob.type;
        try { await dbPut(r); repaired++; } catch {}
      }
      const norm = r.norm instanceof Blob ? (r.norm.type === 'audio/mpeg' ? r.norm : r.norm.slice(0, r.norm.size, 'audio/mpeg')) : null;
      tracks.push({ id: r.id, title: r.title, url: URL.createObjectURL(blob), blob, name: r.name || '', kind: 'local', media: mediaOf(r.type || blob.type, r.name), size: blob.size || 0, thumb: r.thumb || null, artist: r.artist || null,
        gainDb: typeof r.gainDb === 'number' ? r.gainDb : null, lufs: r.lufs ?? null, normBlob: norm, normUrl: norm ? URL.createObjectURL(norm) : null });
    } catch { failed++; }
    if (migrated && migrated % 3 === 0) { applySavedOrderAndFolders(); render(); }
  }
  if (failed) notify(`${failed} 曲を読み込めませんでした。アプリを開き直すと読み込める場合があります`);
  else if (migrated) notify(`${migrated} 曲を新しい保存形式に変換しました`);
  else if (repaired) notify(`${repaired} 件の再生できなくなっていた曲を修復しました`);
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

/* ---------- 音楽モード / 動画モード ----------
   iPhoneは、ほかのアプリに切り替えると映像（video要素）の再生を止め、
   画面の外から新しく再生を始めることも許さない。
   そこで音はいつも audio 要素から出し、動画モードでは video 要素を消音して
   映像だけを音声に合わせて表示する。切り替えても止まるのは映像だけで、音は続く。 */
function updateModeUI() {
  $('modeMusic').classList.toggle('active', mode === 'music'); $('modeMusic').setAttribute('aria-pressed', String(mode === 'music'));
  $('modeVideo').classList.toggle('active', mode === 'video'); $('modeVideo').setAttribute('aria-pressed', String(mode === 'video'));
}
let ownSeek = false;   // こちらから映像の位置を動かしたときの印
function attachVideo(t) {
  videoOn = true; video.muted = true; video.defaultMuted = true; video.setAttribute('muted', '');
  video.src = t.url; video.load();
  video.addEventListener('loadedmetadata', () => syncVideo(true), { once: true });
}
function detachVideo() { videoOn = false; clearEl(video); }
// 映像を音声の位置に合わせる
function syncVideo(force = false) {
  if (!videoOn || document.visibilityState === 'hidden' || !video.getAttribute('src')) return;
  if (video.readyState >= 1) {
    const at = Math.max(0, audio.currentTime - (window.usingNorm && usingNorm(curTrack()) ? normDelay : 0));
    const diff = Math.abs(video.currentTime - at);
    if (force ? diff > 0.08 : diff > 0.35) { ownSeek = true; try { video.currentTime = at; } catch {} }
  }
  if (!audio.paused && video.paused) video.play().catch(() => {});
  if (audio.paused && !video.paused) video.pause();
}
audio.addEventListener('play', () => syncVideo(true));
audio.addEventListener('playing', () => syncVideo(true));
audio.addEventListener('pause', () => { if (videoOn) video.pause(); });
audio.addEventListener('seeked', () => syncVideo(true));
audio.addEventListener('timeupdate', () => syncVideo(false));
audio.addEventListener('ended', () => { if (videoOn) video.pause(); });
// 全画面の再生画面（iPhone標準の操作パネル）で操作したときは、音声側にも反映する
const fullscreenNow = () => !!(video.webkitDisplayingFullscreen || document.fullscreenElement === video || document.webkitFullscreenElement === video);
video.addEventListener('play', () => { if (fullscreenNow() && audio.paused) audio.play().catch(() => {}); });
video.addEventListener('pause', () => { if (fullscreenNow() && document.visibilityState === 'visible' && !audio.paused && !video.ended) audio.pause(); });
video.addEventListener('seeked', () => { if (ownSeek) { ownSeek = false; return; } if (fullscreenNow() && Math.abs(video.currentTime - audio.currentTime) > 0.5) audio.currentTime = video.currentTime; });
video.addEventListener('volumechange', () => { if (!video.muted) video.muted = true; });   // 音が二重にならないよう映像側は常に消音
video.addEventListener('webkitendfullscreen', () => syncVideo(true));
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncVideo(true); });

function sourceText(t) { return t.kind === 'youtube' ? 'YOUTUBE' : `${formatOf(t)} · ` + (t.kind === 'local' ? 'LOCAL ' : 'ONLINE ') + (t.media === 'video' ? (videoOn ? 'VIDEO' : 'VIDEO · AUDIO ONLY') : 'AUDIO'); }
function setNowLabels(t) { $('sourceLabel').textContent = sourceText(t); }
function setMode(m) {
  if (m === mode) return; mode = m; try { localStorage.setItem(MODE_KEY, m); } catch {} updateModeUI();
  const t = curTrack();
  if (!t) { notify(m === 'video' ? '動画モード：動画を映像付きで再生します' : '音楽モード：音声だけを再生します'); return; }
  if (t.kind === 'youtube') { notify('YouTubeは公式プレーヤーで再生します'); return; }
  if (m === 'video' && t.media !== 'video') { notify('この曲は音声のみです。動画を選ぶと映像付きで再生します'); return; }
  if (wantVideo(t)) attachVideo(t); else detachVideo();
  showArt(t); setNowLabels(t);
}
// iOSではホーム画面に追加したアプリ（スタンドアロン）だとピクチャ・イン・ピクチャが使えない（WebKitの制限）
function isStandalone() { return window.navigator.standalone === true || matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches; }
function pipAvailable() {
  if (/iPhone|iPad|iPod/.test(navigator.userAgent) && isStandalone()) return false;
  return (typeof video.webkitSupportsPresentationMode === 'function' && video.webkitSupportsPresentationMode('picture-in-picture')) || !!document.pictureInPictureEnabled;
}
function updatePipUI() {
  const ok = pipAvailable();
  $('pipBtn').hidden = !ok;
  $('pipNote').hidden = ok;
}
function inPiP() { return video.webkitPresentationMode === 'picture-in-picture' || document.pictureInPictureElement === video; }
async function togglePiP() {
  if (!pipAvailable()) { notify('ホーム画面のアプリでは、iOSの制限でピクチャ・イン・ピクチャを使えません'); updatePipUI(); return; }
  try {
    if (typeof video.webkitSetPresentationMode === 'function' && video.webkitSupportsPresentationMode?.('picture-in-picture')) video.webkitSetPresentationMode(inPiP() ? 'inline' : 'picture-in-picture');
    else if (document.pictureInPictureEnabled) { if (document.pictureInPictureElement) await document.exitPictureInPicture(); else await video.requestPictureInPicture(); }
    else notify('この端末ではピクチャ・イン・ピクチャを使えません');
  } catch { notify('ピクチャ・イン・ピクチャを開始できませんでした（再生中に押してください）'); }
}
window.addEventListener('online', () => { render(); showDiag(); });
window.addEventListener('offline', () => { notify('オフラインです。保存済みの曲・動画のみ再生できます'); render(); showDiag(); });

/* ---------- 保存：「ファイル」アプリ・空き容量・URLからのダウンロード ---------- */
// 共有シート（「"ファイル"に保存」）を開く。iPhoneではタップ操作の中で呼ぶ必要がある
function shareOrDownload(blob, filename) {
  const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    return navigator.share({ files: [file], title: filename }).then(() => true).catch(e => {
      if (e && e.name === 'AbortError') return false;
      downloadBlob(file, filename); return true;
    });
  }
  downloadBlob(file, filename); return Promise.resolve(true);
}
function downloadBlob(blob, filename) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename; document.body.append(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 60000);
  notify('ダウンロードしました（「ファイル」アプリの「ダウンロード」に保存されます）');
}
function exportTrack(t) {
  if (!t.blob) { notify('この曲は保存データがありません'); return; }
  shareOrDownload(t.blob, `${safeFileName(t.title)}.${extOf(t)}`);
}
async function checkSpace(bytes) {
  try {
    const e = await navigator.storage?.estimate?.(); if (!e || !e.quota) return true;
    const free = e.quota - e.usage;
    if (bytes > free * 0.9) return confirm(`空き容量が足りない可能性があります。\n必要：約${fmtSize(bytes)}／アプリが使える残り：約${fmtSize(free)}\n\n保存を続けますか？（いらない曲・動画を削除すると空きが増えます）`);
  } catch {}
  return true;
}
// 直接ダウンロードが許可されたURL（CORS対応）だけを保存する。許可されていない場合は保存しない
async function saveRemoteTrack(t) {
  if (t.kind !== 'remote') return;
  if (/(^|\.)youtube\.com|youtu\.be/i.test(t.url)) { notify('YouTubeは規約により保存できません'); return; }
  if (!navigator.onLine) { notify('オフラインのため保存できません'); return; }
  notify('ダウンロード中…');
  let res;
  try { res = await fetch(t.url, { mode: 'cors', credentials: 'omit' }); }
  catch { notify('配布元がアプリからの直接ダウンロードを許可していないため保存できません。URLのまま（オンライン時のみ）再生できます'); return; }
  if (!res.ok) { notify(`ダウンロードできませんでした（エラー ${res.status}）`); return; }
  const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const total = Number(res.headers.get('content-length')) || 0;
  const pathName = (() => { try { return decodeURIComponent(new URL(res.url || t.url).pathname.split('/').pop() || ''); } catch { return ''; } })();
  const cd = res.headers.get('content-disposition') || ''; const cdName = (cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i) || [])[1];
  const name = cdName ? decodeURIComponent(cdName) : pathName;
  const isMedia = /^(audio|video)\//.test(type) || /\.(mp3|wav|m4a|aac|mp4|m4v|mov)$/i.test(name);
  if (!isMedia) { notify('音声・動画ファイルではないため保存できませんでした（共有ページのURLではなく、ファイル本体のURLが必要です）'); return; }
  if (total && !(await checkSpace(total))) return;
  let blob;
  try {
    if (res.body && res.body.getReader) {
      const reader = res.body.getReader(); const chunks = []; let got = 0, lastShown = 0;
      for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); got += value.length;
        if (total && got / total - lastShown >= 0.1) { lastShown = got / total; notify(`ダウンロード中… ${Math.round(lastShown * 100)}%`); } }
      blob = new Blob(chunks, { type: type || guessType({ name }) });
    } else blob = await res.blob();
  } catch { notify('ダウンロードが途中で止まりました。通信状態を確認してください'); return; }
  const fileName = name && /\.[a-z0-9]{2,4}$/i.test(name) ? name : `${safeFileName(t.title)}.${mediaOf(type, name) === 'video' ? 'mp4' : 'mp3'}`;
  const file = new File([blob], fileName, { type: blob.type });
  // URL登録の曲を、同じ位置・同じフォルダのまま「保存済み」に置き換える
  Object.assign(t, { kind: 'local', url: URL.createObjectURL(blob), file, blob, name: fileName, media: mediaOf(blob.type, fileName), size: blob.size });
  saveState(); render();
  await persistNew([t]); metaQueue.push(t); runMetaQueue(); window.normEnqueue?.([t]); showDiag();
}
// 取り出した音声などを、新しい曲としてライブラリに追加する
async function addBlobToLibrary(blob, fileName, { title, folder = null, thumb = null, artist = null, after = null } = {}) {
  if (!(await checkSpace(blob.size))) return null;
  const file = new File([blob], fileName, { type: blob.type });
  const t = { id: uid(), title: title || fileName.replace(/\.[^.]+$/, ''), url: URL.createObjectURL(blob), kind: 'local', file, blob, name: fileName, media: mediaOf(blob.type, fileName), size: blob.size, folder, thumb, artist };
  const i = after ? tracks.findIndex(x => x.id === after) : -1;
  if (i >= 0) tracks.splice(i + 1, 0, t); else tracks.push(t);
  saveState(); render(); await persistNew([t]); delete t.file; window.normEnqueue?.([t]); showDiag(); return t;
}

/* ---------- ミニプレーヤー（画面の下に固定） ----------
   下の方の曲を選んだときも、上までスクロールせずに操作できるようにする */
function updateMini(track) {
  $('miniTitle').textContent = track?.title || '曲を選択してください';
  $('miniSub').textContent = track ? [formatOf(track), track.folder || track.artist || ''].filter(Boolean).join(' · ') : 'タップしてプレーヤーを表示';
  const art = $('miniArt');
  if (track?.thumb) { art.style.backgroundImage = `url("${track.thumb}")`; art.textContent = ''; }
  else { art.style.backgroundImage = ''; art.textContent = track?.media === 'video' ? '🎬' : '♪'; }
  if (!track) $('miniBar').style.width = '0%';
}
let playerVisible = true;
function refreshMini() {
  const show = !playerVisible && (tracks.length > 0 || !!currentId);
  $('mini').hidden = !show; document.body.classList.toggle('mini-on', show);
}
if ('IntersectionObserver' in window) {
  // プレーヤーの操作ボタンが画面から外れたらミニプレーヤーを出す
  new IntersectionObserver(es => { playerVisible = es[0].isIntersecting; refreshMini(); }, { threshold: 0.6 }).observe($('playerCard').querySelector('.controls'));
}
$('miniPrev').addEventListener('click', () => $('prev').click());
$('miniPlay').addEventListener('click', () => $('play').click());
$('miniNext').addEventListener('click', () => $('next').click());
$('miniBack').addEventListener('click', () => seekBy(-10));
$('miniFwd').addEventListener('click', () => seekBy(10));
$('miniInfo').addEventListener('click', () => $('playerCard').scrollIntoView({ behavior: 'smooth', block: 'start' }));

/* ---------- 音量 ----------
   iPhoneのSafariは、Webアプリから音量を変えることを許可していない（常に最大のまま）。
   音を加工して無理に変える方法は、画面を離れたときに再生が止まる原因になるため使わず、
   iPhoneではスライダーを隠して本体の音量ボタンを案内する。 */
function isIOS() { return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); }
function volumeControllable() { if (isIOS()) return false; try { const a = document.createElement('audio'); a.volume = 0.5; return Math.abs(a.volume - 0.5) < 0.01; } catch { return false; } }
function updateVolumeUI() { const ok = volumeControllable(); $('volumeRow').hidden = !ok; $('volumeNote').hidden = ok; }

/* ---------- 早送り・巻き戻し ---------- */
function seekBy(sec) {
  if (!currentId || !engine.hasSource()) { notify('先に曲を再生してください'); return; }
  const d = engine.duration(); let t = engine.time() + sec;
  t = Math.max(0, Number.isFinite(d) && d > 0 ? Math.min(d - 0.3, t) : t);
  engine.seek(t); tick();
}
$('back10').addEventListener('click', () => seekBy(-10));
$('fwd10').addEventListener('click', () => seekBy(10));
// PCではキーボードの ← → でも 10秒戻る／進む（入力欄では無効）
document.addEventListener('keydown', e => {
  if (e.target.closest('input, textarea, select, [contenteditable]')) return;
  if (e.key === 'ArrowLeft') { e.preventDefault(); seekBy(-10); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); seekBy(10); }
});

/* ---------- 起動 ---------- */
/* ---------- 保存状況の診断 ---------- */
async function showDiag() {
  const box = $('diag'); if (!box) return; const lines = [];
  const standalone = window.navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
  lines.push(['アプリの版', APP_VERSION]);
  lines.push(['開き方', standalone ? 'ホーム画面のアプリ' : 'ブラウザ（Safariまたは他アプリ内のブラウザ）']);
  let ls = 'OK'; try { localStorage.setItem('__t', '1'); localStorage.removeItem('__t'); } catch { ls = '使用不可（プライベートブラウズ・Cookieブロックの可能性）'; }
  lines.push(['設定の保存', ls]);
  let n = '—'; try { const recs = await dbTx('readonly', st => st.count()); n = `${recs} 件`; } catch (e) { n = '使用不可（' + (e?.name || 'エラー') + '）'; }
  lines.push(['アプリ内に保存した曲・動画', n]);
  const loc = tracks.filter(t => t.kind === 'local'), au = loc.filter(t => t.media === 'audio'), vi = loc.filter(t => t.media === 'video');
  const sum = a => fmtSize(a.reduce((x, t) => x + (t.size || 0), 0)) || '0KB';
  lines.push(['内訳', `🎵 音楽 ${au.length}件（${sum(au)}）／🎬 動画 ${vi.length}件（${sum(vi)}）`]);
  const nd = loc.filter(t => t.gainDb != null), nc = loc.filter(t => t.normBlob);
  lines.push(['音量そろえ', window.normOn ? `オン：${nd.length}/${loc.length} 件準備済み（専用の音声 ${nc.length} 件・${fmtSize(nc.reduce((x, t) => x + (t.normBlob?.size || 0), 0)) || '0KB'}）` : 'オフ']);
  lines.push(['オンライン状態', navigator.onLine ? '接続中' : 'オフライン（保存済みの曲・動画のみ再生できます）']);
  try { if (navigator.storage?.estimate) { const est = await navigator.storage.estimate(); lines.push(['使用容量', `${(est.usage / 1048576).toFixed(1)} MB / 上限 約 ${(est.quota / 1073741824).toFixed(1)} GB`]); } } catch {}
  try { if (navigator.storage?.persisted) lines.push(['削除からの保護', (await navigator.storage.persisted()) ? '有効' : '無効（空き容量が少ないとiOSが消すことがあります）']); } catch {}
  box.replaceChildren(...lines.map(([k, v]) => { const r = el('div', 'diag-row'); r.append(el('span', '', k), el('strong', '', v)); return r; }));
  if (!standalone) box.append(el('p', 'diag-tip', 'ホーム画面のアプリとブラウザでは保存場所が別です。Claudeアプリ内などのブラウザで開くと、閉じたときに保存した曲が消える場合があります。Safariで開いて「共有 → ホーム画面に追加」したアプリから使ってください。'));
}

async function init() {
  updateModeUI(); updatePipUI(); updateVolumeUI(); updateMini(null);
  loadRemote(); applySavedOrderAndFolders(); render(); updatePlay();
  await loadLocal(); applySavedOrderAndFolders(); render();
  window.normEnqueue?.(tracks); window.normStatus?.();
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).then(r => r.update()).catch(() => {});
  showDiag();
}
init();

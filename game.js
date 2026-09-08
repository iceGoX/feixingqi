import { COLORS, COLOR_META, TRACK, HOME, FINISH, boardLocation } from './shared/board.js';
import { movementSteps, capturesForStep, PresentationQueue, directionHeading, nearestHeading, restingHeading } from './shared/motion.js';
import { RULE_VERSION, createGame, currentPlayer, legalMoves, previewMove, rollDice, movePlane, validateGame } from './shared/engine.js';

const $ = id => document.getElementById(id);
const planeArt = (color, heading = 0) => `<span class="plane-art art-${color}" style="--heading:${heading}deg" aria-hidden="true"></span>`;
const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const API = new URL('./api/', location.href);
const SESSION = 'feixingqi-session-v1', LOCAL = 'feixingqi-local-v1';
let mode = null, room = null, localGame = null, credentials = null, busy = false, connected = true, entryMode = 'create', selected = null, streamController = null, streamEpoch = 0, lastShownRoll = null, lastGameVersion = null, toastTimer, confirmAction;
const presentation = new PresentationQueue();
let movement = null;
function stopMovement() {
  const active = movement; movement = null;
  active?.animations.forEach(animation => animation.cancel());
  $('board').removeAttribute('aria-busy');
}
function resetPresentation() { stopMovement(); presentation.reset(); }
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const game = () => mode === 'online' ? room?.game : localGame;
const actor = () => mode === 'online' ? room?.selfId : currentPlayer(localGame)?.id;
const readStorage = (storage, key) => { try { return JSON.parse(storage.getItem(key)); } catch { return null; } };
const writeStorage = (storage, key, value) => { try { value === null ? storage.removeItem(key) : storage.setItem(key, JSON.stringify(value)); } catch { /* Private mode can disable storage; the active game still works. */ } };
function toast(message) { clearTimeout(toastTimer); $('toast').textContent = message; $('toast').hidden = false; toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4200); }
function formError(message = '') { $('formError').textContent = message; $('formError').hidden = !message; }
function gameError(message = '') { $('gameError').textContent = message; $('gameError').hidden = !message; }
function setBusy(value) { busy = value; $('entrySubmit').disabled = value; $('localButton').disabled = value; if (mode) render(); }
function validName() {
  const value = $('nickname').value.normalize('NFKC').replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').trim();
  if (!value || [...value].length > 12) throw new Error('请输入 1～12 个字的昵称');
  writeStorage(localStorage, 'feixingqi-nickname', value); return value;
}
const capacity = () => Number(document.querySelector('input[name="capacity"]:checked').value);
function switchTab(tab) {
  entryMode = tab; const join = tab === 'join';
  for (const [id, active] of [['createTab', !join], ['joinTab', join]]) { $(id).classList.toggle('active', active); $(id).setAttribute('aria-selected', String(active)); }
  $('roomField').hidden = !join; $('roomCode').required = join; $('countField').hidden = join; $('localButton').hidden = join; $('localHint').hidden = join;
  $('entrySubmit').textContent = join ? '加入房间' : '创建房间'; $('lobbyTitle').textContent = join ? '和朋友会合。' : '一起，准备起飞。'; formError();
}
async function request(route, { method = 'GET', body, token = credentials?.token, signal } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
  try {
    const response = await fetch(new URL(route, API), { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: controller.signal, cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) { const error = new Error(data.message || '暂时无法连接，请重试'); error.code = data.error; error.status = response.status; throw error; }
    return data;
  } catch (error) {
    if (!error.code) { error.code = 'NETWORK'; error.message = '连接暂时中断，请检查网络后重试'; }
    throw error;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
function acceptRoom(next) {
  if (room && next.code === room.code && next.version < room.version) return;
  if (room?.game?.version !== next.game?.version || room?.game?.round !== next.game?.round) selected = null;
  room = next; connected = true;
  if (room.game && room.game.ruleVersion !== RULE_VERSION) { connected = false; $('connectionBanner').textContent = '游戏已更新，请刷新页面继续对局。'; }
  render();
}
function stopStream() { streamEpoch++; streamController?.abort(); streamController = null; }
function roomLost(message) { resetPresentation(); stopStream(); mode = null; room = null; credentials = null; writeStorage(sessionStorage, SESSION, null); selected = null; connected = true; render(); toast(message); }
async function subscribe() {
  stopStream(); const epoch = streamEpoch; let failures = 0;
  while (mode === 'online' && credentials && epoch === streamEpoch) {
    const controller = new AbortController(); streamController = controller;
    try {
      const response = await fetch(new URL(`rooms/${credentials.code}/events`, API), { headers: { Authorization: `Bearer ${credentials.token}` }, signal: controller.signal, cache: 'no-store' });
      if (!response.ok) { const data = await response.json(); if ([401, 404].includes(response.status)) return roomLost(data.message); throw new Error(data.message); }
      const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '';
      while (epoch === streamEpoch) {
        const { value, done } = await reader.read(); if (done) throw new Error('stream ended');
        buffer += decoder.decode(value, { stream: true });
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
          const event = block.match(/^event: (.+)$/m)?.[1], raw = block.match(/^data: (.+)$/m)?.[1];
          if (!raw) continue;
          const data = JSON.parse(raw);
          if (event === 'closed') return roomLost(data.message);
          if (event === 'state') { failures = 0; acceptRoom(data); }
        }
        if (buffer.length > 256000) throw new Error('stream exceeded limit');
      }
    } catch {
      if (epoch !== streamEpoch || mode !== 'online') return;
      connected = false; render();
    }
    const delay = Math.min(10000, 700 * 2 ** failures++);
    await new Promise(resolve => setTimeout(resolve, delay));
  }
}
async function enterOnline(data) {
  mode = 'online'; credentials = { code: data.room.code, token: data.token }; room = null;
  writeStorage(sessionStorage, SESSION, credentials); acceptRoom(data.room); void subscribe();
}
async function submitEntry(event) {
  event.preventDefault(); if (busy) return; formError();
  try {
    const name = validName(); setBusy(true);
    if (entryMode === 'join') {
      const code = $('roomCode').value.trim().toUpperCase();
      if (!/^[A-Z0-9]{6}$/.test(code)) throw new Error('请输入六位字母或数字房间号');
      await enterOnline(await request(`rooms/${code}/join`, { method: 'POST', body: { nickname: name }, token: null }));
    } else await enterOnline(await request('rooms', { method: 'POST', body: { nickname: name, capacity: capacity() }, token: null }));
  } catch (e) { formError(e.message); } finally { setBusy(false); }
}
function startLocal() {
  if (busy) return;
  try {
    const name = validName(), count = capacity(); stopStream(); credentials = null; room = null; mode = 'local'; connected = true;
    localGame = createGame(Array.from({ length: count }, (_, i) => ({ id: `local-${i}`, nickname: i === 0 ? name : `玩家${['一','二','三','四'][i]}` })));
    selected = null; resetPresentation(); writeStorage(localStorage, LOCAL, localGame); render();
  } catch (e) { formError(e.message); }
}
function randomDice() {
  const array = new Uint32Array(1); do { crypto.getRandomValues(array); } while (array[0] >= 4294967292);
  return array[0] % 6 + 1;
}
async function perform(type, extras = {}) {
  if (busy || movement || (mode === 'online' && !connected)) return;
  gameError(); const beforeVersion = room?.version; setBusy(true);
  try {
    if (mode === 'local') {
      if (type === 'roll') { $('die').classList.add('rolling'); await new Promise(resolve => setTimeout(resolve, reducedMotion.matches ? 0 : 340)); localGame = rollDice(localGame, actor(), randomDice()); }
      else if (type === 'move') localGame = movePlane(localGame, actor(), extras.planeId, extras.merge);
      else if (type === 'replay') localGame = createGame(localGame.players, localGame.round + 1);
      selected = null; writeStorage(localStorage, LOCAL, localGame);
    } else {
      const body = { type, ...extras, expectedVersion: room.version, requestId: crypto.randomUUID() };
      let result;
      for (let attempt = 0; attempt < 2; attempt++) {
        try { result = await request(`rooms/${room.code}/action`, { method: 'POST', body }); break; }
        catch (e) { if (e.code !== 'NETWORK' || attempt === 1) throw e; await new Promise(resolve => setTimeout(resolve, 450)); }
      }
      acceptRoom(result.room);
    }
  } catch (e) {
    if (mode === 'online' && ['VERSION_CONFLICT', 'NETWORK'].includes(e.code)) {
      try { const latest = await request(`rooms/${credentials.code}`); acceptRoom(latest.room); if (latest.room.version > beforeVersion) toast('棋盘已同步到最新状态'); else gameError(e.message); }
      catch { connected = false; gameError(e.message); }
    } else if (['IDENTITY', 'ROOM_EXPIRED'].includes(e.code)) roomLost(e.message);
    else { gameError(e.message); toast(e.message); }
  } finally { setBusy(false); }
}
function inviteURL() { const url = new URL('./', location.href); url.searchParams.set('room', room.code); return url.href; }
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('已复制，发给朋友就能加入'); }
  catch { $('copyFallback').value = text; $('copyDialog').showModal(); $('copyFallback').select(); }
}
function askLeave() {
  if (!mode || busy || movement) return;
  const waiting = mode === 'online' && room.status === 'waiting', finished = game()?.finished;
  $('confirmTitle').textContent = waiting ? '退出这个房间？' : finished ? '返回大厅？' : '退出当前对局？';
  $('confirmMessage').textContent = mode === 'local' ? finished ? '返回大厅后，你可以重新选择人数开局。' : '这局同屏游戏将结束，当前进度会被清除。' : waiting ? '退出后将离开候场，可以通过房间号重新加入。' : finished ? '离开后，将无法参加这个房间的再来一局。' : '退出后会结束你的本局参与，其他玩家继续游戏。';
  $('confirmCancel').textContent = waiting ? '继续等待' : '留在这里';
  confirmAction = async () => {
    if (mode === 'online') await request(`rooms/${room.code}/leave`, { method: 'POST', body: {} });
    else writeStorage(localStorage, LOCAL, null);
    stopStream(); credentials = null; writeStorage(sessionStorage, SESSION, null); mode = null; room = null; localGame = null; selected = null; resetPresentation(); connected = true; render();
  };
  $('confirmDialog').showModal();
}
function showPage(id) { for (const page of ['lobbyPage', 'waitingPage', 'gamePage', 'resultPage']) $(page).hidden = page !== id; }
function render() {
  $('inviteButton').hidden = mode !== 'online' || !room;
  $('connectionBanner').hidden = mode !== 'online' || connected;
  if (!connected && room?.game?.ruleVersion === RULE_VERSION) $('connectionBanner').textContent = '正在重新连接…连接恢复后会同步棋盘，暂时不能操作。';
  $('modeLabel').textContent = mode === 'online' && room ? `好友房 · ${room.code} · ${room.capacity} 人` : mode === 'local' ? `同屏 · ${localGame.players.length} 人` : '';
  if (!mode || !room && mode === 'online') { showPage('lobbyPage'); const saved = readStorage(localStorage, LOCAL); $('resumeLocal').hidden = !saved || !validateGame(saved) || saved.finished; return; }
  if (mode === 'online' && room.status === 'waiting') { showPage('waitingPage'); renderWaiting(); return; }
  const g = game();
  if (presentation.observe(g, `${mode}:${room?.code || 'local'}:${g.round}`)) stopMovement();
  if (movement) return; // Never replace moving DOM nodes on a duplicate SSE or request response.
  let next;
  while ((next = presentation.take())) {
    if (next.move && !reducedMotion.matches && !document.hidden) { void animateMove(next); return; }
  }
  if (presentation.current.finished) { showPage('resultPage'); renderResult(); return; }
  showPage('gamePage'); renderGame(presentation.current);
}
function renderWaiting() {
  const full = room.members.length === room.capacity, host = room.selfId === room.hostId;
  $('waitingTitle').textContent = full ? '到齐啦，准备起飞！' : '等朋友，一起起飞。';
  $('waitingCode').textContent = room.code; $('seatCount').textContent = `已加入 ${room.members.length} / ${room.capacity} 人`;
  $('waitingSeats').innerHTML = Array.from({ length: room.capacity }, (_, i) => {
    const member = room.members[i], color = member?.colors[0] || COLORS[i], m = COLOR_META[color];
    return `<div class="seat${member ? '' : ' empty'}" style="--seat-soft:${m.soft};--seat-color:${m.ink}"><div class="seat-color">${member ? member.colors.map(c => COLOR_META[c].name).join('·') : '+'}</div><strong>${member ? esc(member.nickname) : '等待加入'}</strong><small>${member ? [member.id === room.selfId ? '你' : '', member.id === room.hostId ? '房主' : '已加入'].filter(Boolean).join(' · ') : '邀请一位朋友'}</small></div>`;
  }).join('');
  $('startButton').disabled = !full || !host || busy || !connected;
  $('startButton').textContent = !host ? '等待房主开始' : full ? busy ? '正在开始…' : '开始游戏' : '等待玩家加入';
  $('waitingHint').textContent = !host ? '开始后自动进入棋盘' : room.capacity === 2 ? '双人对局：每人控制两色，共 8 架飞机' : '人齐后，由房主开始游戏';
  $('leaveWaitingButton').disabled = busy; $('copyInviteButton').disabled = busy;
}
const pipPositions = { 1: [4], 2: [0,8], 3: [0,4,8], 4: [0,2,6,8], 5: [0,2,4,6,8], 6: [0,2,3,5,6,8] };
function drawDice(value, isRolling = false) { $('die').innerHTML = Array.from({ length: 9 }, (_, i) => `<span class="pip${pipPositions[value || 1].includes(i) ? ' on' : ''}"></span>`).join(''); $('die').setAttribute('aria-label', value ? `骰子 ${value} 点` : '尚未掷骰'); $('die').classList.toggle('rolling', isRolling); }
function boardSVG() {
  const cell = (v, color) => `<polygon points="${v.polygon.map(p => p.join(',')).join(' ')}" fill="${COLOR_META[color].fill}" stroke="#FFF8EE" stroke-width=".035"/><circle cx="${v.center[0]}" cy="${v.center[1]}" r=".34" fill="#FFFCF6"/>`;
  let svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-.15 -.15 17.3 17.3" role="img" aria-label="52格环道、四色终点航道和飞行捷径"><defs>';
  for (const c of COLORS) svg += `<marker id="arrow-${c}" markerWidth="5" markerHeight="5" refX="4" refY="2.5" orient="auto" markerUnits="strokeWidth"><path d="M0 0 L5 2.5 L0 5" fill="${COLOR_META[c].ink}"/></marker>`;
  svg += '</defs><rect x="-.11" y="-.11" width="17.22" height="17.22" rx=".3" fill="#FFFCF6" stroke="#DECFB7" stroke-width=".04"/>';
  for (const c of COLORS) { const m = COLOR_META[c]; svg += `<rect x="${m.airport[0]}" y="${m.airport[1]}" width="4" height="4" rx=".25" fill="${m.soft}" stroke="${m.fill}" stroke-width=".035"/>`; }
  TRACK.forEach(v => { svg += cell(v, v.color); });
  for (const c of COLORS) HOME[c].forEach(v => { svg += cell(v, c); });
  for (const c of COLORS) {
    const m = COLOR_META[c], a = TRACK[m.flight].center, b = TRACK[(m.flight + 12) % 52].center, join = TRACK[(m.entry + 3) % 52].center;
    svg += `<path d="M${a} L${b}" fill="none" stroke="${m.ink}" stroke-width=".055" stroke-dasharray=".13 .09" marker-end="url(#arrow-${c})"/><circle cx="${m.launch[0]}" cy="${m.launch[1]}" r=".4" fill="${m.soft}" stroke="${m.fill}" stroke-width=".035"/><path d="M${m.launch} L${join}" fill="none" stroke="${m.ink}" stroke-width=".055" marker-end="url(#arrow-${c})"/>`;
    const entry = TRACK[m.entry].center, first = HOME[c][0].center;
    svg += `<path d="M${entry} L${[(entry[0]+first[0])/2,(entry[1]+first[1])/2]}" fill="none" stroke="${m.ink}" stroke-width=".045" marker-end="url(#arrow-${c})"/>`;
  }
  return svg + '</svg><div class="plane-layer"></div>';
}
$('board').innerHTML = boardSVG();
function renderBoard(g, moves, preview) {
  const layer = $('board').querySelector('.plane-layer'); layer.replaceChildren();
  const leaders = [], seen = new Set();
  for (const plane of g.planes) {
    if (plane.progress < -1 || seen.has(plane.group)) continue;
    const group = g.planes.filter(p => p.group === plane.group); seen.add(plane.group);
    leaders.push({ plane, group, loc: boardLocation(plane.progress === FINISH ? { ...plane, progress: -1 } : plane) });
  }
  for (const { plane, group, loc } of leaders) {
    const stackedHere = leaders.filter(l => l.loc.key === loc.key), index = stackedHere.findIndex(l => l.plane.id === plane.id), offset = stackedHere.length > 1 ? (index - (stackedHere.length - 1) / 2) * .3 : 0;
    const move = moves.find(m => m.ids.includes(plane.id)), selectable = !!move && !busy && !movement && connected;
    const button = document.createElement('button'); button.type = 'button'; button.dataset.plane = plane.id; button.dataset.heading = restingHeading(plane);
    button.className = `plane${selectable ? ' selectable' : ''}${preview?.ids.includes(plane.id) ? ' selected' : ''}${plane.progress === FINISH ? ' finished' : ''}`;
    button.disabled = !selectable; button.style.setProperty('--plane-color', COLOR_META[plane.color].ink);
    const left = (loc.center[0] + offset + .15) / 17.3 * 100, top = (loc.center[1] + .15) / 17.3 * 100;
    button.style.left = `${left}%`; button.style.top = `${top}%`;
    button.setAttribute('aria-label', `${COLOR_META[plane.color].name}色${group.map(p => p.number + 1).join('、')}号${group.length > 1 ? '叠子' : '飞机'}${plane.progress === FINISH ? '已抵达' : plane.progress < 0 ? '在机场' : ''}`);
    button.innerHTML = `${planeArt(plane.color, restingHeading(plane))}<span class="plane-number">${plane.progress === FINISH ? '✓' : group.length > 1 ? '×'+group.length : plane.number+1}</span>`;
    layer.append(button);

  }
  if (preview) {
    const p = g.planes.find(p => p.id === preview.planeId), target = boardLocation({ ...p, progress: preview.to });
    const ghost = document.createElement('div'); ghost.className = 'plane ghost'; ghost.style.left = `${(target.center[0]+.15)/17.3*100}%`; ghost.style.top = `${(target.center[1]+.15)/17.3*100}%`; ghost.style.setProperty('--plane-color', COLOR_META[p.color].ink); ghost.setAttribute('aria-hidden','true'); ghost.innerHTML = planeArt(p.color, restingHeading({ ...p, progress: preview.to })); layer.append(ghost);
  }
}
const positionStyle = center => ({ left: `${(center[0] + .15) / 17.3 * 100}%`, top: `${(center[1] + .15) / 17.3 * 100}%` });
async function animateMove({ before, move }) {
  const active = { animations: new Set() }; movement = active; selected = null;
  showPage('gamePage'); renderGame(before); $('board').setAttribute('aria-busy', 'true');
  const layer = $('board').querySelector('.plane-layer');
  const mover = [...layer.querySelectorAll('[data-plane]')].find(node => move.ids.includes(node.dataset.plane));
  const plane = before.planes.find(p => p.id === move.planeId), captured = new Set();
  async function turnAircraft(node, heading) {
    const art = node.querySelector('.plane-art'), from = Number(node.dataset.heading), to = nearestHeading(from, heading);
    if (Math.abs(to - from) > .1) {
      const rotation = art.animate([{ transform: `rotate(${from}deg)` }, { transform: `rotate(${to}deg)` }], { duration: 100, easing: 'ease-out', fill: 'forwards' });
      active.animations.add(rotation);
      try { await rotation.finished; if (movement !== active) return; art.style.setProperty('--heading', `${to}deg`); node.dataset.heading = to; }
      finally { rotation.cancel(); active.animations.delete(rotation); }
    }
  }
  async function travel(node, center, kind, duration) {
    const from = { left: node.style.left, top: node.style.top }, to = positionStyle(center);
    // Rotate in place first; then follow the exact segment, including shortcut and return legs.
    await turnAircraft(node, directionHeading([parseFloat(from.left), parseFloat(from.top)], [parseFloat(to.left), parseFloat(to.top)]));
    if (movement !== active) return;
    const transform = 'translate(-50%,-50%)';
    const lift = kind === 'flight' ? 1.18 : kind === 'jump' || kind === 'launch' ? 1.13 : 1.06;
    const animation = node.animate([
      { ...from, transform, offset: 0 },
      { left: `${(parseFloat(from.left) + parseFloat(to.left)) / 2}%`, top: `${(parseFloat(from.top) + parseFloat(to.top)) / 2}%`, transform: `${transform} scale(${lift})`, offset: .4 },
      { ...to, transform, offset: .8 },
      { ...to, transform, offset: 1 }
    ], { duration, easing: 'ease-in-out', fill: 'forwards' });
    active.animations.add(animation);
    try { await animation.finished; if (movement !== active) return; Object.assign(node.style, to); }
    finally { animation.cancel(); active.animations.delete(animation); }
  }
  try {
    if (!mover) return;
    mover.classList.add('moving');
    for (const step of movementSteps(move)) {
      if (movement !== active) return;
      const labels = { walk: '逐格前进', bounce: '终点折返', launch: '起飞', jump: '同色跳跃', flight: '沿捷径飞行' };
      $('actionTitle').textContent = labels[step.kind];
      const duration = { walk: 190, bounce: 190, launch: 400, jump: 440, flight: 680 }[step.kind];
      await travel(mover, boardLocation({ ...plane, progress: step.progress }).center, step.kind, duration);
      if (movement !== active) return;
      const hits = capturesForStep(before, move, step).filter(id => !captured.has(id));
      hits.forEach(id => captured.add(id));
      const victims = [...layer.querySelectorAll('[data-plane]')].filter(node => hits.includes(node.dataset.plane));
      await Promise.all(victims.map(async node => {
        const victim = before.planes.find(p => p.id === node.dataset.plane);
        await travel(node, boardLocation({ ...victim, progress: -1 }).center, 'capture', 300);
      }));
    }
    if (!move.finishes && movement === active) await turnAircraft(mover, restingHeading({ ...plane, progress: move.to }));
    if (move.finishes && movement === active) {
      $('actionTitle').textContent = '抵达终点！';
      const finish = mover.animate([{ opacity: 1, transform: 'translate(-50%,-50%)' }, { opacity: 0, transform: 'translate(-50%,-50%) scale(.5)' }], { duration: 260, fill: 'forwards' });
      active.animations.add(finish); await finish.finished;
    }
  } catch (error) {
    if (error.name !== 'AbortError') console.warn('飞机动画已跳过', error);
  } finally {
    if (movement === active) { stopMovement(); render(); }
  }
}
// Background tabs and reduced-motion users get the current authoritative board immediately.
function skipMovement() { if (movement) { stopMovement(); presentation.reset(); render(); } }
document.addEventListener('visibilitychange', () => { if (document.hidden) skipMovement(); });
reducedMotion.addEventListener('change', () => { if (reducedMotion.matches) skipMovement(); });
function renderGame(g = presentation.current || game()) {
  const p = currentPlayer(g), ownTurn = mode === 'local' || p.id === actor(), active = ownTurn && connected && !busy && !movement;
  const m = COLOR_META[p.colors[0]], allMoves = ownTurn ? legalMoves(g, actor()) : [];
  let preview = selected ? previewMove(g, selected) : null; if (!preview) selected = null;
  $('gamePage').style.setProperty('--turn-color', m.ink);
  $('turnHeading').textContent = ownTurn ? `${p.nickname}，轮到你` : `等待 ${p.nickname}`;
  if (movement) $('turnHeading').textContent = `${p.nickname}，飞行中`;
  $('turnNumber').textContent = `第 ${g.turnNumber} 回合`;
  $('actionTitle').textContent = !ownTurn ? `等待 ${p.nickname}` : g.phase === 'roll' ? `${p.nickname}，轮到你` : '选择一架飞机';
  $('actionHint').textContent = !ownTurn ? `${p.nickname}正在${g.phase === 'roll' ? '掷骰' : '选择飞机'}` : p.colors.length === 2 ? `你控制${p.colors.map(c => COLOR_META[c].name).join('、')}两色，共 8 架飞机` : g.phase === 'roll' ? '轻掷骰子，开启这一回合' : '轻点飞机，查看落点后确认';
  if (movement) { $('actionTitle').textContent = '飞机正在前进'; $('actionHint').textContent = '沿航线一步一步走，落稳后继续下一步'; }
  drawDice(g.dice || g.lastRoll?.value, busy && !movement && g.phase === 'roll');
  $('diceCaption').textContent = g.dice ? `本次点数：${g.dice}${g.dice === 6 ? ' · 行动后可再掷' : ''}` : g.lastRoll ? `上次掷出 ${g.lastRoll.value}` : '掷出 6 可以起飞';
  $('rollButton').hidden = g.phase !== 'roll'; $('rollButton').disabled = !active; $('rollButton').textContent = busy ? '掷骰中…' : ownTurn ? '掷骰子' : '等待对方掷骰';
  $('selectionArea').hidden = !ownTurn || g.phase !== 'move';
  $('planeChoices').innerHTML = allMoves.map(move => {
    const meta = COLOR_META[move.color];
    return `<button type="button" class="plane-choice${preview?.ids.includes(move.planeId) ? ' selected' : ''}" data-plane="${move.planeId}" style="--plane-color:${meta.ink};--plane-soft:${meta.soft}" ${!active ? 'disabled' : ''} aria-pressed="${!!preview?.ids.includes(move.planeId)}">${planeArt(move.color)}${meta.name} ${move.number+1}${move.ids.length > 1 ? ` · ${move.ids.length}架` : '号'}</button>`;
  }).join('');
  $('previewHint').textContent = preview ? describePreview(preview, g.dice) : '选择后会显示半透明落点预览';
  $('stackOption').hidden = !preview?.mergeTargets.length; if ($('stackOption').hidden) $('mergeCheck').checked = false;
  $('confirmButton').disabled = !preview || !active; $('confirmButton').textContent = busy ? '正在移动…' : preview?.from === -1 ? '确认起飞' : '确认移动';
  $('cancelSelection').disabled = busy || !!movement || !selected; $('leaveGameButton').disabled = busy || !!movement;
  $('playerStrip').innerHTML = g.players.map(player => {
    const meta = COLOR_META[player.colors[0]], complete = g.planes.filter(q => q.owner === player.id && q.progress === FINISH).length, total = player.colors.length * 4;
    return `<div class="player-chip${player.id === p.id ? ' active' : ''}" style="--player-color:${meta.ink};--player-soft:${meta.soft}"><strong>${esc(player.nickname)}</strong><small>${player.colors.map(c => COLOR_META[c].name).join('/')} · ${player.forfeited ? '已退出' : player.rank ? '第'+player.rank+'名' : player.id === p.id ? '当前回合' : `抵达 ${complete}/${total}`}</small></div>`;
  }).join('');
  $('playerList').innerHTML = g.players.map(player => {
    const planes = g.planes.filter(q => q.owner === player.id), complete = planes.filter(q => q.progress === FINISH).length;
    return `<div class="summary-row" style="--player-color:${COLOR_META[player.colors[0]].ink}"><strong>${player.colors.map(c => COLOR_META[c].name).join('/')} · ${esc(player.nickname)}</strong><small>${player.forfeited ? '已退出' : `抵达 ${complete}/${planes.length}`}</small></div>`;
  }).join('');
  $('moveLog').innerHTML = g.log.map(item => `<li>${esc(item.text)}</li>`).join('') || '<li>等待第一次掷骰</li>';
  renderBoard(g, allMoves, preview);
  if (g.lastRoll && lastShownRoll !== `${g.round}:${g.lastRoll.sequence}`) {
    lastShownRoll = `${g.round}:${g.lastRoll.sequence}`;
    if (g.log[0]?.kind === 'pass') toast(`掷出 ${g.lastRoll.value}，没有飞机可动，已轮到下一位`);
  }
  lastGameVersion = g.version;
}
function describePreview(move, dice) {
  if (move.from === -1) return '移到起飞点，完成后可再掷一次。';
  const parts = [`按点数前进 ${dice} 步`];
  if (move.stages.some(s => s.kind === 'bounce')) parts.push('到达终点后反弹');
  for (const stage of move.stages) { if (stage.kind === 'jump') parts.push('同色跳跃 4 格'); if (stage.kind === 'flight') parts.push('沿虚线飞行'); }
  if (move.finishes) parts.push('抵达终点');
  if (move.captures.length) parts.push(`撞回 ${move.captures.length} 架敌机`);
  if (move.ids.length > 1) parts.push(`${move.ids.length} 架叠子一起移动`);
  return parts.join('，') + '。';
}
function selectPlane(id) { if (busy || movement || !connected || !legalMoves(game(), actor()).some(m => m.ids.includes(id))) return; selected = id; $('mergeCheck').checked = false; renderGame(); }
function renderResult() {
  const g = game(), winner = g.players.find(p => p.rank === 1), ranked = [...g.players].sort((a,b) => (a.rank || 99) - (b.rank || 99));
  const arrived = winner && g.planes.filter(p => p.owner === winner.id).every(p => p.progress === FINISH);
  $('resultTitle').textContent = winner ? `${winner.nickname}，${arrived ? '率先抵达' : '获得本局胜利'}！` : '本局已结束';
  $('resultSubtitle').textContent = winner && !arrived ? '其他玩家已退出，本局结束。' : '谢谢一起飞行，下一局再见。';
  $('rankingList').innerHTML = ranked.map(p => `<li class="${p.rank === 1 ? 'winner' : ''}"><span class="rank">${p.rank || '—'}</span><span>${esc(p.nickname)}<small>${p.colors.map(c => COLOR_META[c].name+'色').join(' / ')}${p.forfeited ? ' · 已退出' : ''}</small></span></li>`).join('');
  const accepted = room?.replay?.accepted.includes(room.selfId);
  $('replayButton').textContent = mode === 'local' ? '再来一局' : accepted ? '等待其他玩家同意' : '邀请再来一局';
  $('replayButton').disabled = busy || mode === 'online' && (!connected || !room.replay.available || accepted);
  $('replayHint').textContent = mode === 'local' ? '使用相同人数，重新起飞' : !room.replay.available ? '有玩家已经离开，请回大厅重新创建房间' : room.replay.accepted.length ? `已同意 ${room.replay.accepted.length} / ${room.capacity} 人` : '所有玩家同意后，一起开始下一局';
}

$('createTab').onclick = () => switchTab('create'); $('joinTab').onclick = () => switchTab('join');
for (const tab of [$('createTab'), $('joinTab')]) tab.addEventListener('keydown', e => { if (['ArrowLeft', 'ArrowRight'].includes(e.key)) { e.preventDefault(); const next = entryMode === 'create' ? 'join' : 'create'; switchTab(next); $(next+'Tab').focus(); } });
document.querySelectorAll('input[name="capacity"]').forEach(input => input.onchange = () => { $('countHint').textContent = capacity() === 2 ? '每人控制两种相对颜色，共 8 架飞机' : '每人 4 架飞机，各执一种颜色'; });
$('entryForm').onsubmit = submitEntry; $('localButton').onclick = startLocal;
$('resumeButton').onclick = () => { const saved = readStorage(localStorage, LOCAL); if (!saved || !validateGame(saved)) return toast('这局存档已无法恢复'); stopStream(); resetPresentation(); mode = 'local'; localGame = saved; connected = true; selected = null; render(); };
$('startButton').onclick = () => perform('start'); $('rollButton').onclick = () => perform('roll');
$('confirmButton').onclick = () => { if (selected) void perform('move', { planeId: selected, merge: $('mergeCheck').checked }); };
$('cancelSelection').onclick = () => { if (movement) return; selected = null; renderGame(); };
$('board').onclick = event => { const plane = event.target.closest('[data-plane]'); if (plane) selectPlane(plane.dataset.plane); };
$('planeChoices').onclick = event => { const plane = event.target.closest('[data-plane]'); if (plane) selectPlane(plane.dataset.plane); };
for (const id of ['leaveWaitingButton', 'leaveGameButton', 'resultLobbyButton', 'brandButton']) $(id).onclick = askLeave;
for (const id of ['copyInviteButton', 'inviteButton']) $(id).onclick = () => room && copyText(inviteURL());
$('copyCodeButton').onclick = () => copyText(room.code);
$('rulesButton').onclick = () => $('rulesDialog').showModal();
document.querySelectorAll('[data-close]').forEach(button => button.onclick = () => $(button.dataset.close).close());
$('confirmCancel').onclick = () => $('confirmDialog').close();
$('confirmAccept').onclick = async () => { $('confirmAccept').disabled = true; try { await confirmAction(); $('confirmDialog').close(); } catch (e) { toast(e.message); } finally { $('confirmAccept').disabled = false; } };
$('replayButton').onclick = () => perform('replay');
window.addEventListener('online', () => { if (mode === 'online') void subscribe(); });
window.addEventListener('offline', () => { if (mode === 'online') { connected = false; render(); } });
document.addEventListener('visibilitychange', () => { if (!document.hidden && mode === 'online' && credentials) void subscribe(); });
window.addEventListener('beforeunload', event => { if (mode === 'online' && room?.status === 'playing') { event.preventDefault(); event.returnValue = ''; } });
$('nickname').value = readStorage(localStorage, 'feixingqi-nickname') || '';
const inviteCode = new URL(location.href).searchParams.get('room');
if (inviteCode) { switchTab('join'); $('roomCode').value = inviteCode.toUpperCase().slice(0,6); }
render();
const savedSession = readStorage(sessionStorage, SESSION);
if (savedSession?.code && savedSession?.token && (!inviteCode || savedSession.code === inviteCode.toUpperCase())) {
  credentials = savedSession;
  request(`rooms/${savedSession.code}`).then(data => { mode = 'online'; acceptRoom(data.room); void subscribe(); }).catch(e => { if (['IDENTITY','ROOM_EXPIRED'].includes(e.code)) writeStorage(sessionStorage, SESSION, null); credentials = null; toast(e.message); });
}
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});

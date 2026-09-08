import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGame, rollDice, movePlane, forfeit, colorAssignments, validateGame, RuleError } from '../shared/engine.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.json': 'application/json; charset=utf-8', '.woff2': 'font/woff2' };
const hash = s => crypto.createHash('sha256').update(s).digest('hex');
const makeId = () => crypto.randomBytes(18).toString('base64url');
function apiError(code, message, status = 400) { const e = new Error(message); e.code = code; e.status = status; return e; }
function nickname(value) {
  if (typeof value !== 'string') throw apiError('NICKNAME', '请填写昵称');
  const name = value.normalize('NFKC').replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').trim();
  if (!name || [...name].length > 12) throw apiError('NICKNAME', '昵称需要 1～12 个字');
  return name;
}
async function readBody(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw apiError('CONTENT_TYPE', '请求格式不正确', 415);
  let size = 0, chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > 8192) throw apiError('BODY_SIZE', '请求内容过大', 413); chunks.push(chunk); }
  try { const value = JSON.parse(Buffer.concat(chunks).toString()); if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(); return value; }
  catch { throw apiError('JSON', '请求内容无法读取'); }
}

export function createApp({ root = ROOT, dataDir = process.env.DATA_DIR || path.join(ROOT, '.data'), maxRooms = 200, maxRoomsPerIp = 12, clock = Date.now, dice = () => crypto.randomInt(1, 7), persist = true } = {}) {
  const rooms = new Map(), rates = new Map(), streams = new Map();
  const storeFile = path.join(dataDir, 'rooms.json');
  let closed = false;
  function save() {
    if (!persist) return;
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const content = JSON.stringify([...rooms.values()].map(({ requests, ...r }) => ({ ...r, requests: [...requests].slice(-64) })));
    const temp = `${storeFile}.tmp`;
    fs.writeFileSync(temp, content, { mode: 0o600 });
    fs.renameSync(temp, storeFile);
  }
  if (persist && fs.existsSync(storeFile)) {
    try {
      const saved = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
      for (const r of saved.slice(0, maxRooms)) {
        if (/^[A-Z0-9]{6}$/.test(r.code) && Array.isArray(r.members) && (!r.game || validateGame(r.game))) {
          r.requests = new Map(r.requests || []); rooms.set(r.code, r);
        }
      }
    } catch (e) { throw new Error(`无法读取房间存档：${e.message}`); }
  }
  function ttl(room) { return room.status === 'waiting' ? 2 * 3600000 : room.status === 'finished' ? 3600000 : 24 * 3600000; }
  function snapshot(room, member) {
    const active = room.members.filter(m => !m.left);
    const colors = colorAssignments(room.capacity);
    return {
      code: room.code, capacity: room.capacity, hostId: room.hostId, status: room.status, version: room.version, selfId: member.id,
      members: room.members.map((m, i) => ({ id: m.id, nickname: m.nickname, left: !!m.left, colors: room.game?.players.find(p => p.id === m.id)?.colors || colors[i] || [] })),
      game: room.game, replay: { accepted: room.replay, count: active.length, available: active.length === room.capacity }
    };
  }
  function sendStream(connection, event, data) {
    if (connection.res.destroyed) return;
    if (connection.res.writableLength > 128 * 1024) return connection.res.destroy();
    connection.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
  function notify(room) {
    for (const connection of streams.get(room.code) || []) {
      const member = room.members.find(m => m.id === connection.memberId && !m.left);
      if (member) sendStream(connection, 'state', snapshot(room, member));
      else { sendStream(connection, 'closed', { message: '你已离开房间' }); connection.res.end(); }
    }
  }
  function removeRoom(code) {
    for (const c of streams.get(code) || []) { sendStream(c, 'closed', { message: '房间已失效，请重新创建或加入' }); c.res.end(); }
    streams.delete(code); rooms.delete(code);
  }
  function cleanup() {
    let removed = false;
    for (const [code, r] of rooms) if (clock() - r.updatedAt > ttl(r)) { removeRoom(code); removed = true; }
    for (const [ip, row] of rates) if (clock() - row.start > 60000) rates.delete(ip);
    if (removed) save();
  }
  const timer = setInterval(cleanup, 60000); timer.unref();
  function limit(ip, method) {
    const row = rates.get(ip);
    if (!row || clock() - row.start >= 60000) { rates.set(ip, { start: clock(), reads: 0, writes: 0 }); }
    const current = rates.get(ip), key = method === 'GET' ? 'reads' : 'writes';
    if (++current[key] > (key === 'reads' ? 360 : 100)) throw apiError('RATE_LIMIT', '操作太频繁，请稍后再试', 429);
    if (rates.size > 10000) cleanup();
  }
  function ipAddress(req) {
    const remote = req.socket.remoteAddress || 'unknown';
    return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote) && req.headers['x-real-ip'] ? String(req.headers['x-real-ip']).slice(0, 64) : remote;
  }
  function memberFor(room, req) {
    const token = req.headers.authorization?.replace(/^Bearer /, '') || '';
    if (token.length < 16 || token.length > 128) throw apiError('IDENTITY', '房间身份已失效，请重新加入', 401);
    const key = hash(token), member = room.members.find(m => m.tokenHash === key && !m.left);
    if (!member) throw apiError('IDENTITY', '房间身份已失效，请重新加入', 401);
    return member;
  }
  function originCheck(req) {
    if (!req.headers.origin) return;
    let host; try { host = new URL(req.headers.origin).host; } catch { throw apiError('ORIGIN', '请求来源不正确', 403); }
    if (host !== req.headers.host) throw apiError('ORIGIN', '请求来源不正确', 403);
  }
  function json(res, status, body) { res.writeHead(status, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); }
  function newMember(name) { const token = makeId(); return { token, member: { id: makeId(), nickname: nickname(name), tokenHash: hash(token), left: false } }; }
  function makeCode() { const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let c; do { c = Array.from({ length: 6 }, () => alphabet[crypto.randomInt(alphabet.length)]).join(''); } while (rooms.has(c)); return c; }

  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    try {
      let pathname = new URL(req.url, 'http://localhost').pathname;
      if (pathname === '/feixingqi') { res.writeHead(308, { Location: '/feixingqi/' }); return res.end(); }
      if (pathname.startsWith('/feixingqi/')) pathname = pathname.slice('/feixingqi'.length);
      if (!pathname.startsWith('/api/')) {
        if (!['GET', 'HEAD'].includes(req.method)) throw apiError('METHOD', '方法不支持', 405);
        let file = decodeURIComponent(pathname).replace(/^\//, '') || 'index.html';
        const allowed = /^(index\.html|styles\.css|game\.js|sw\.js|manifest\.json|shared\/(board|engine|motion)\.js|assets\/[a-zA-Z0-9_.-]+\.(jpg|png|webp|woff2))$/;
        if (!allowed.test(file)) throw apiError('NOT_FOUND', '页面不存在', 404);
        const full = path.join(root, file);
        if (!fs.existsSync(full)) throw apiError('NOT_FOUND', '页面不存在', 404);
        res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'");
        res.setHeader('Content-Type', MIME[path.extname(file)] || 'application/octet-stream');
        const stat = fs.statSync(full), etag = `"${stat.size.toString(16)}-${Math.trunc(stat.mtimeMs).toString(16)}"`;
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('ETag', etag);
        if (req.headers['if-none-match'] === etag) { res.writeHead(304); return res.end(); }
        if (file === 'sw.js') res.setHeader('Service-Worker-Allowed', pathname.startsWith('/feixingqi/') ? '/feixingqi/' : '/');
        if (req.method === 'HEAD') return res.end();
        return fs.createReadStream(full).pipe(res);
      }
      originCheck(req);
      const ip = ipAddress(req); limit(ip, req.method);
      if (req.method === 'GET' && pathname === '/api/health') return json(res, 200, { ok: true, service: 'feixingqi', release: process.env.RELEASE_ID || 'development', rooms: rooms.size });
      if (req.method === 'POST' && pathname === '/api/rooms') {
        cleanup();
        const body = await readBody(req), capacity = body.capacity;
        colorAssignments(capacity);
        if (rooms.size >= maxRooms) throw apiError('SERVER_CAPACITY', '房间暂时已满，请稍后再试', 503);
        if ([...rooms.values()].filter(r => r.creatorIp === ip).length >= maxRoomsPerIp) throw apiError('ROOM_LIMIT', '创建的房间过多，请先结束已有房间', 429);
        const { token, member } = newMember(body.nickname), code = makeCode();
        const room = { code, capacity, hostId: member.id, members: [member], game: null, status: 'waiting', version: 1, creatorIp: ip, updatedAt: clock(), replay: [], requests: new Map() };
        rooms.set(code, room); save();
        return json(res, 201, { token, room: snapshot(room, member) });
      }
      const match = pathname.match(/^\/api\/rooms\/([A-Za-z0-9]{6})(?:\/(join|events|action|leave))?$/);
      if (!match) throw apiError('NOT_FOUND', '接口不存在', 404);
      const code = match[1].toUpperCase(), operation = match[2], room = rooms.get(code);
      if (!room || clock() - room.updatedAt > ttl(room)) { if (room) { removeRoom(code); save(); } throw apiError('ROOM_EXPIRED', '房间不存在或已失效', 404); }
      if (operation === 'join' && req.method === 'POST') {
        const body = await readBody(req);
        if (room.status !== 'waiting') throw apiError('ALREADY_STARTED', '这局已经开始，请朋友下一局再邀请你', 409);
        if (room.members.length >= room.capacity) throw apiError('ROOM_FULL', '房间已满', 409);
        const { token, member } = newMember(body.nickname);
        room.members.push(member); room.version++; room.updatedAt = clock(); save(); notify(room);
        return json(res, 200, { token, room: snapshot(room, member) });
      }
      const member = memberFor(room, req);
      if (!operation && req.method === 'GET') return json(res, 200, { room: snapshot(room, member) });
      if (operation === 'events' && req.method === 'GET') {
        const set = streams.get(code) || new Set();
        if ([...set].filter(c => c.memberId === member.id).length >= 4 || [...streams.values()].reduce((n, s) => n + s.size, 0) >= 800) throw apiError('STREAM_LIMIT', '连接过多，请关闭重复页面', 429);
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        const connection = { res, memberId: member.id }; set.add(connection); streams.set(code, set);
        sendStream(connection, 'state', snapshot(room, member));
        const heartbeat = setInterval(() => { if (!res.destroyed) res.write(': keepalive\n\n'); }, 15000);
        res.on('close', () => { clearInterval(heartbeat); set.delete(connection); if (!set.size) streams.delete(code); });
        return;
      }
      if (req.method !== 'POST' || !['action', 'leave'].includes(operation)) throw apiError('METHOD', '方法不支持', 405);
      const body = await readBody(req);
      if (operation === 'leave') {
        if (room.status === 'waiting') {
          room.members = room.members.filter(m => m.id !== member.id);
          if (room.hostId === member.id) room.hostId = room.members[0]?.id || null;
        } else {
          member.left = true;
          room.game = forfeit(room.game, member.id);
          if (room.game.finished) room.status = 'finished';
        }
        room.version++; room.updatedAt = clock();
        if (!room.members.some(m => !m.left)) removeRoom(code); else notify(room);
        save(); return json(res, 200, { ok: true });
      }
      if (typeof body.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(body.requestId)) throw apiError('REQUEST_ID', '请求标识无效');
      const key = member.id + ':' + body.requestId;
      if (room.requests.has(key)) return json(res, 200, { room: snapshot(room, member), duplicate: true });
      if (body.expectedVersion !== room.version) throw apiError('VERSION_CONFLICT', '棋盘已更新，请根据最新状态操作', 409);
      switch (body.type) {
        case 'start':
          if (room.hostId !== member.id) throw apiError('HOST_ONLY', '只有房主可以开始游戏', 403);
          if (room.status !== 'waiting') throw apiError('ALREADY_STARTED', '游戏已经开始', 409);
          if (room.members.length !== room.capacity) throw apiError('WAITING', '请等待所有玩家加入', 409);
          room.game = createGame(room.members); room.status = 'playing'; break;
        case 'roll':
          if (room.status !== 'playing') throw apiError('NOT_PLAYING', '当前不在对局中', 409);
          room.game = rollDice(room.game, member.id, dice()); break;
        case 'move':
          if (room.status !== 'playing') throw apiError('NOT_PLAYING', '当前不在对局中', 409);
          room.game = movePlane(room.game, member.id, body.planeId, body.merge ?? false);
          if (room.game.finished) room.status = 'finished'; break;
        case 'replay':
          if (room.status !== 'finished') throw apiError('NOT_FINISHED', '本局尚未结束', 409);
          if (room.members.some(m => m.left)) throw apiError('PLAYER_LEFT', '有玩家已离开，请重新创建房间', 409);
          if (!room.replay.includes(member.id)) room.replay.push(member.id);
          if (room.replay.length === room.capacity) { room.game = createGame(room.members, room.game.round + 1); room.status = 'playing'; room.replay = []; }
          break;
        default: throw apiError('ACTION', '不支持的操作');
      }
      room.version++; room.updatedAt = clock(); room.requests.set(key, true);
      while (room.requests.size > 64) room.requests.delete(room.requests.keys().next().value);
      save(); notify(room); return json(res, 200, { room: snapshot(room, member) });
    } catch (e) {
      if (res.headersSent) { res.end(); return; }
      const status = e.status || (e instanceof RuleError ? 409 : 500);
      if (status === 500) console.error('Request failed:', e.code || e.name);
      json(res, status, { error: e.code || 'SERVER_ERROR', message: status === 500 ? '暂时无法完成操作，请重试' : e.message });
    }
  });
  server.requestTimeout = 20000; server.headersTimeout = 15000; server.maxHeadersCount = 40;
  function close() { if (closed) return; closed = true; clearInterval(timer); for (const set of streams.values()) for (const c of set) c.res.end(); server.close(); }
  return { server, rooms, streams, cleanup, close };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2), arg = name => args[args.indexOf(name) + 1];
  const port = Number(process.env.PORT || (args.includes('--port') && arg('--port')) || 4173);
  const host = process.env.HOST || (args.includes('--host') && arg('--host')) || '127.0.0.1';
  const app = createApp();
  app.server.listen(port, host, () => console.log(`飞行棋 http://${host}:${port}/`));
  process.on('SIGTERM', app.close); process.on('SIGINT', app.close);
}

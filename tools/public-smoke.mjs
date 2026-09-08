import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { legalMoves } from '../shared/engine.js';
if (!process.argv[2]) { console.error('用法：node tools/public-smoke.mjs <目标地址，包含子路径并以 / 结尾>'); process.exit(1); }
const base = new URL(process.argv[2]);
assert.ok(['http:', 'https:'].includes(base.protocol) && base.pathname.endsWith('/') && !base.username && !base.password && !base.search && !base.hash, '请提供有效目标地址，不要包含凭据、查询参数或片段');
const manifest = JSON.parse(fs.readFileSync('dist/release.json'));
const results = [], sessions = [];
async function api(route, body, token) {
  const response = await fetch(new URL('api/'+route, base), { method: body ? 'POST' : 'GET', headers: { ...(body ? {'Content-Type':'application/json'} : {}), ...(token ? {Authorization:'Bearer '+token} : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
  const data = await response.json();
  if (!response.ok) throw new Error(`${route}: ${response.status} ${data.error}`);
  return data;
}
try {
  const page = await fetch(base, {signal:AbortSignal.timeout(15000)});assert.equal(page.status,200);assert.match(await page.text(),/<title>飞行棋/);results.push('page');
  const redirect = await fetch(base.href.replace(/\/$/,''),{redirect:'manual',signal:AbortSignal.timeout(15000)});assert.ok([301,308].includes(redirect.status));results.push('slash redirect');
  const health = await api('health');assert.equal(health.release,manifest.release);results.push('release '+health.release);
  for (const [file,expected] of Object.entries(manifest.files)) {
    if (file==='package.json'||file.startsWith('server/'))continue;
    const response=await fetch(new URL(file,base),{cache:'no-store',signal:AbortSignal.timeout(20000)});assert.equal(response.status,200,file);
    const bytes=Buffer.from(await response.arrayBuffer());assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),expected,file);
  }
  results.push('public asset hashes');
  const host=await api('rooms',{nickname:'发布验收甲',capacity:2});sessions.push({code:host.room.code,token:host.token});
  const guest=await api(`rooms/${host.room.code}/join`,{nickname:'发布验收乙'});sessions.push({code:host.room.code,token:guest.token});
  const tokens=new Map([[host.room.selfId,host.token],[guest.room.selfId,guest.token]]),code=host.room.code;
  const streamController=new AbortController();
  const stream=await fetch(new URL(`api/rooms/${code}/events`,base),{headers:{Authorization:'Bearer '+host.token},signal:AbortSignal.any([streamController.signal, AbortSignal.timeout(15000)])});
  assert.match(stream.headers.get('content-type'),/text\/event-stream/);
  const initial=await stream.body.getReader().read();assert.match(new TextDecoder().decode(initial.value),/event: state/);streamController.abort();results.push('SSE');
  let room=(await api(`rooms/${code}/action`,{type:'start',expectedVersion:guest.room.version,requestId:crypto.randomUUID()},host.token)).room;
  assert.equal(room.game.planes.filter(p=>p.owner===host.room.selfId).length,8);results.push('two-player ownership');
  for(let i=0;i<40&&room.game.phase==='roll';i++){
    const token=tokens.get(room.game.players[room.game.turn].id);
    room=(await api(`rooms/${code}/action`,{type:'roll',expectedVersion:room.version,requestId:crypto.randomUUID()},token)).room;
  }
  assert.equal(room.game.phase,'move');
  const move=legalMoves(room.game)[0], token=tokens.get(room.game.players[room.game.turn].id);
  const body={type:'move',planeId:move.planeId,merge:false,expectedVersion:room.version,requestId:crypto.randomUUID()};
  room=(await api(`rooms/${code}/action`,body,token)).room;
  assert.equal(room.game.planes.find(p=>p.id===move.planeId).progress,0);
  const duplicate=await api(`rooms/${code}/action`,body,token);assert.equal(duplicate.duplicate,true);assert.equal(duplicate.room.version,room.version);results.push('authoritative launch and idempotency');
  const guestState=await api(`rooms/${code}`,undefined,guest.token);assert.equal(guestState.room.version,room.version);results.push('room state synchronization');
} finally {
  for(const session of sessions)try{await api(`rooms/${session.code}/leave`,{},session.token);}catch{}
}
fs.mkdirSync('artifacts',{recursive:true});fs.writeFileSync('artifacts/public-smoke.json',JSON.stringify({time:new Date().toISOString(),url:base.href,release:manifest.release,results},null,2)+'\n');
console.log(JSON.stringify({release:manifest.release,results},null,2));

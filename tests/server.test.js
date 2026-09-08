import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createApp } from '../server/app.js';

async function start(t, options={}) {
  const app=createApp({persist:false,dice:()=>6,...options});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(()=>app.close());
  const base=`http://127.0.0.1:${app.server.address().port}`;
  async function api(route,body,token,method=body?'POST':'GET',extra={}){
    const r=await fetch(base+'/api/'+route,{method,headers:{...(body?{'Content-Type':'application/json'}:{}),...(token?{Authorization:'Bearer '+token}:{}),...extra},body:body?JSON.stringify(body):undefined});
    return {status:r.status,data:await r.json()};
  }
  const create=async(count=2)=>{const r=await api('rooms',{nickname:'小飞',capacity:count});assert.equal(r.status,201);return r.data;};
  return {...app,base,api,create};
}
test('好友房创建加入，房主开始，权限/版本/骰子/重复请求校验',async t=>{
  const app=await start(t),host=await app.create(),code=host.room.code;
  assert.match(code,/^[A-Z0-9]{6}$/);assert.equal(JSON.stringify(host.room).includes('tokenHash'),false);
  assert.equal((await app.api(`rooms/${code}`)).status,401);
  const guest=(await app.api(`rooms/${code}/join`,{nickname:'小蓝'})).data;
  const route=`rooms/${code}/action`;
  assert.equal((await app.api(route,{type:'start',requestId:'start_guest',expectedVersion:2},guest.token)).status,403);
  const begin=await app.api(route,{type:'start',requestId:'start_host_1',expectedVersion:2},host.token);assert.equal(begin.status,200);assert.equal(begin.data.room.game.planes.length,16);
  assert.equal((await app.api(route,{type:'roll',expectedVersion:2,requestId:'outdated_1'},host.token)).data.error,'VERSION_CONFLICT');
  const action={type:'roll',dice:1,expectedVersion:3,requestId:'roll_reliable_1'};
  const rolled=await app.api(route,action,host.token);assert.equal(rolled.data.room.game.dice,6);
  const repeated=await app.api(route,action,host.token);assert.equal(repeated.data.duplicate,true);assert.equal(repeated.data.room.version,rolled.data.room.version);
  const move=await app.api(route,{type:'move',planeId:'blue-1',expectedVersion:4,requestId:'move_blue_1'},host.token);assert.equal(move.status,200);assert.equal(move.data.room.game.planes.find(p=>p.id==='blue-1').progress,0);
  assert.equal((await app.api(route,{type:'roll',expectedVersion:5,requestId:'guest_roll_1'},guest.token)).status,409);
});
test('输入、来源、静态私密路径与房间上限',async t=>{
  const a=await start(t,{maxRoomsPerIp:1});
  assert.equal((await a.api('rooms',{nickname:'',capacity:2})).status,400);
  assert.equal((await a.api('rooms',{nickname:'测试',capacity:5})).status,409);
  assert.equal((await a.api('rooms',{nickname:'测试',capacity:2},null,'POST',{Origin:'https://evil.invalid'})).status,403);
  await a.create();assert.equal((await a.api('rooms',{nickname:'另一个',capacity:2})).data.error,'ROOM_LIMIT');
  for(const resource of ['/server/app.js','/.data/rooms.json','/design/tokens.json','/package.json','/%2e%2e/.ssh/config'])assert.equal((await fetch(a.base+resource)).status,404);
});
test('SSE initial state、退出和TTL回收关闭所有连接',async t=>{
  let now=Date.now();const a=await start(t,{clock:()=>now}),h=await a.create();
  const response=await fetch(a.base+`/api/rooms/${h.room.code}/events`,{headers:{Authorization:'Bearer '+h.token}});
  assert.equal(response.headers.get('content-type'),'text/event-stream');const reader=response.body.getReader();
  const first=new TextDecoder().decode((await reader.read()).value);assert.match(first,/event: state/);assert.equal(JSON.parse(first.split('data: ')[1].trim()).code,h.room.code);
  now+=2*3600000+1;a.cleanup();assert.equal(a.rooms.size,0);assert.equal(a.streams.size,0);
  const closed=new TextDecoder().decode((await reader.read()).value);assert.match(closed,/event: closed/);assert.equal((await reader.read()).done,true);
});
test('等待房间退出移交房主，最后玩家退出清理',async t=>{
  const a=await start(t),h=await a.create(),code=h.room.code;const g=(await a.api(`rooms/${code}/join`,{nickname:'朋友'})).data;
  await a.api(`rooms/${code}/leave`,{},h.token);
  const state=(await a.api(`rooms/${code}`,undefined,g.token)).data.room;assert.equal(state.hostId,state.selfId);assert.equal(state.members.length,1);
  await a.api(`rooms/${code}/leave`,{},g.token);assert.equal(a.rooms.size,0);
});
test('存档重启后身份和已掷骰状态保持，不重新掷骰',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'feixingqi-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const first=await start(t,{persist:true,dataDir:dir});const h=await first.create(),code=h.room.code;await first.api(`rooms/${code}/join`,{nickname:'朋友'});
  await first.api(`rooms/${code}/action`,{type:'start',requestId:'start_persist',expectedVersion:2},h.token);
  await first.api(`rooms/${code}/action`,{type:'roll',requestId:'roll_persist',expectedVersion:3},h.token);first.close();
  const second=await start(t,{persist:true,dataDir:dir});const restored=await second.api(`rooms/${code}`,undefined,h.token);
  assert.equal(restored.status,200);assert.equal(restored.data.room.game.dice,6);assert.equal(restored.data.room.game.phase,'move');
  const file=fs.readFileSync(path.join(dir,'rooms.json'),'utf8');assert.equal(file.includes(h.token),false);
});
test('静态资源支持校验缓存，避免发布后继续使用旧版本',async t=>{
  const a=await start(t);const first=await fetch(a.base+'/game.js');assert.equal(first.status,200);assert.equal(first.headers.get('cache-control'),'no-cache');
  const etag=first.headers.get('etag');assert.ok(etag);assert.equal((await fetch(a.base+'/game.js',{headers:{'If-None-Match':etag}})).status,304);
});
test('再来一局须全部同意；有人离开时不允许直接重开',async t=>{
  const a=await start(t),h=await a.create(),code=h.room.code;const g=(await a.api(`rooms/${code}/join`,{nickname:'朋友'})).data;
  await a.api(`rooms/${code}/action`,{type:'start',requestId:'start_replay',expectedVersion:2},h.token);
  const r=a.rooms.get(code);r.status='finished';r.game.finished=true;r.game.phase='finished';r.game.dice=null;r.game.players.forEach((p,i)=>{p.rank=i+1;r.game.planes.filter(q=>q.owner===p.id).forEach(q=>q.progress=56);});r.game.ranking=r.game.players.map(p=>p.id);
  let response=await a.api(`rooms/${code}/action`,{type:'replay',requestId:'replay_first',expectedVersion:r.version},h.token);
  assert.equal(response.data.room.status,'finished');assert.equal(response.data.room.replay.accepted.length,1);
  response=await a.api(`rooms/${code}/action`,{type:'replay',requestId:'replay_second',expectedVersion:r.version},g.token);
  assert.equal(response.data.room.status,'playing');assert.equal(response.data.room.game.round,2);assert.ok(response.data.room.game.planes.every(p=>p.progress===-1));
  await a.api(`rooms/${code}/leave`,{},h.token);
  response=await a.api(`rooms/${code}/action`,{type:'replay',requestId:'replay_after_exit',expectedVersion:r.version},g.token);
  assert.equal(response.status,409);assert.equal(response.data.error,'PLAYER_LEFT');
});
test('通过 current 发布符号链接启动服务，不会误判为模块导入退出',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'feixingqi-start-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  fs.symlinkSync(process.cwd(),path.join(dir,'current'),'dir');
  const child=spawn(process.execPath,[path.join(dir,'current/server/app.js')],{env:{...process.env,PORT:'0',HOST:'127.0.0.1',DATA_DIR:path.join(dir,'state')},stdio:['ignore','pipe','pipe']});
  t.after(()=>child.kill('SIGTERM'));
  await new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(new Error('服务未启动')),6000);
    child.stdout.on('data',chunk=>{if(chunk.toString().includes('飞行棋 http://')){clearTimeout(timeout);resolve();}});
    child.once('exit',code=>{clearTimeout(timeout);reject(new Error('启动时退出: '+code));});
    child.once('error',reject);
  });
  child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { TRACK, COLORS, COLOR_META, HOME, FINISH, ringIndex, boardLocation } from '../shared/board.js';
import { createGame, currentPlayer, legalMoves, previewMove, rollDice, movePlane, forfeit, validateGame } from '../shared/engine.js';
const members = n => Array.from({ length: n }, (_, i) => ({ id: 'p'+i, nickname: '玩家'+i }));
const fresh = (n = 4) => createGame(members(n));
function setup(progress, dice = 1) { const g = fresh(); g.planes[0].progress = progress; g.phase = 'move'; g.dice = dice; return g; }

test('棋盘52格、四色各13格、四条正交捷径及每色两格不可达', () => {
  assert.equal(TRACK.length, 52);
  assert.equal(new Set(TRACK.map(c => c.center.join(','))).size, 52);
  for (const color of COLORS) {
    assert.equal(TRACK.filter(c => c.color === color).length, 13);
    const m = COLOR_META[color], a = TRACK[m.flight].center, b = TRACK[(m.flight + 12) % 52].center;
    assert.ok(a[0] === b[0] || a[1] === b[1]);
    assert.equal(TRACK[m.flight].color, color); assert.equal(TRACK[(m.flight + 12) % 52].color, color);
    assert.equal(HOME[color].length, 6);
    const reachable = new Set(Array.from({ length: 50 }, (_, i) => ringIndex(color, i+1)));
    assert.equal(reachable.size, 50); assert.equal(ringIndex(color, 50), m.entry);
  }
});
test('双人各控相对两色与8架飞机，3/4人各一色', () => {
  const g = fresh(2); assert.deepEqual(g.players[0].colors, ['red','blue']); assert.deepEqual(g.players[1].colors, ['yellow','green']);
  assert.equal(g.planes.filter(p => p.owner === 'p0').length, 8); assert.equal(fresh(3).planes.length,12); assert.equal(fresh(4).planes.length,16);
  assert.throws(() => createGame(members(1)));
});
test('无可移动飞机自动换人；只有6可以起飞', () => {
  const g = rollDice(fresh(), 'p0', 5); assert.equal(currentPlayer(g).id,'p1'); assert.equal(g.phase,'roll');
  const six = rollDice(fresh(), 'p0', 6); assert.equal(legalMoves(six).length,4);
  const takeoff = movePlane(six,'p0','red-1'); assert.equal(takeoff.planes[0].progress,0); assert.equal(currentPlayer(takeoff).id,'p0');
});
test('回合、重复掷骰、无效点数、非法飞机均拒绝且原状态不变', () => {
  const g = fresh(), before = structuredClone(g);
  assert.throws(() => rollDice(g,'p1',6),{code:'NOT_YOUR_TURN'});
  for (const n of [0,7,1.5,'6',NaN]) assert.throws(() => rollDice(g,'p0',n));
  const r = rollDice(g,'p0',6); assert.throws(() => rollDice(r,'p0',6),{code:'WRONG_PHASE'});
  assert.throws(() => movePlane(r,'p0','yellow-1'),{code:'ILLEGAL_MOVE'}); assert.deepEqual(g,before);
});
test('移出起飞点后按骰子计步，同色跳跃不无限连跳', () => {
  const g = setup(0,2), move = previewMove(g,'red-1'); assert.equal(move.to,6); assert.deepEqual(move.stages.map(s=>s.kind),['walk','jump']);
  const result = movePlane(g,'p0','red-1'); assert.equal(result.planes[0].progress,6);
});
test('直达捷径飞行后追加4格；跳到捷径不追加', () => {
  const direct = previewMove(setup(12,6),'red-1'); assert.equal(direct.to,34); assert.deepEqual(direct.stages.map(s=>s.kind),['walk','flight','jump']);
  const jumping = previewMove(setup(12,2),'red-1'); assert.equal(jumping.to,30); assert.deepEqual(jumping.stages.map(s=>s.kind),['walk','jump','flight']);
});
test('走步/飞行落点、航道交叉点、追加跳跃落点全部结算撞机', () => {
  const g = setup(12,6), enemies = g.planes.filter(p=>p.color==='blue');
  [44,53,4,8].forEach((p,i)=>enemies[i].progress=p);
  const preview = previewMove(g,'red-1'); assert.equal(preview.captures.length,4);
  const result = movePlane(g,'p0','red-1'); assert.ok(result.planes.filter(p=>p.color==='blue').every(p=>p.progress===-1));
});
test('普通经过不撞机；只有落点碰撞', () => {
  const g=setup(0,3); const enemy=g.planes.find(p=>p.color==='blue'); enemy.progress=28; // red step 2, only passed during a roll of 3
  assert.equal(boardLocation({...g.planes[0],progress:2}).key,boardLocation(enemy).key);
  assert.equal(previewMove(g,'red-1').captures.length,0);
});
test('双人双色不会互撞，异色同格不能合成叠子', () => {
  const g=fresh(2); g.phase='move';g.dice=2;g.planes.find(p=>p.id==='red-1').progress=0;
  const blue=g.planes.find(p=>p.id==='blue-1');blue.progress=32;
  const preview=previewMove(g,'red-1');assert.equal(preview.to,6);assert.deepEqual(preview.captures,[]);assert.deepEqual(preview.mergeTargets,[]);
  const result=movePlane(g,'p0','red-1',true);assert.equal(result.planes.find(p=>p.id==='blue-1').progress,32);assert.notEqual(result.planes[0].group,blue.group);
});
test('双人自己的对色航道也不会被飞行击落',()=>{
  const g=fresh(2);g.phase='move';g.dice=6;g.planes[0].progress=12;g.planes.find(p=>p.id==='blue-1').progress=53;
  assert.deepEqual(previewMove(g,'red-1').captures,[]);
});
test('可选叠子默认不合并；合并后持续整体移动', () => {
  const g=setup(0,2);g.planes[1].progress=6;
  const separate=movePlane(g,'p0','red-1',false);assert.notEqual(separate.planes[0].group,separate.planes[1].group);
  let stacked=movePlane(g,'p0','red-1',true);assert.equal(stacked.planes[0].group,stacked.planes[1].group);
  stacked.turn=0;stacked=rollDice(stacked,'p0',3);assert.equal(legalMoves(stacked)[0].ids.length,2);
  const moved=movePlane(stacked,'p0','red-2');assert.equal(moved.planes[0].progress,9);assert.equal(moved.planes[1].progress,9);assert.ok(validateGame(moved));
});
test('整组被撞回机场后解除叠子', () => {
  const g=setup(0,3), blue=g.planes.filter(p=>p.color==='blue');blue[0].progress=29;blue[1].progress=29;blue[1].group=blue[0].group;
  const result=movePlane(g,'p0','red-1');assert.equal(result.planes.find(p=>p.id==='blue-1').progress,-1);assert.equal(result.planes.find(p=>p.id==='blue-2').group,'blue-2');
});
test('不执行三连六回机场；三次6后仍可继续', () => {
  let g=fresh();for(let i=0;i<3;i++){g=rollDice(g,'p0',6);g=movePlane(g,'p0','red-1');}
  assert.ok(g.planes[0].progress>0);assert.equal(currentPlayer(g).id,'p0');assert.equal(g.phase,'roll');
});
test('入口不跳进航道；航道无同色跳跃，终点精确到达及反弹', () => {
  assert.equal(previewMove(setup(46,4),'red-1').to,50);
  assert.equal(previewMove(setup(50,1),'red-1').to,51);
  assert.equal(previewMove(setup(52,1),'red-1').to,53);
  assert.equal(previewMove(setup(54,2),'red-1').to,56);
  const bounce=previewMove(setup(54,5),'red-1');assert.equal(bounce.to,53);assert.equal(bounce.stages[0].kind,'bounce');
});
test('双人必须旗下8架全部完成；剩一人时确定最后名次', () => {
  let g=fresh(2);for(const p of g.planes.filter(p=>p.owner==='p0'))p.progress=56;
  g.planes.find(p=>p.id==='blue-4').progress=55;g.phase='move';g.dice=1;
  assert.equal(g.players[0].rank,null);g=movePlane(g,'p0','blue-4');assert.equal(g.players[0].rank,1);assert.equal(g.players[1].rank,2);assert.equal(g.finished,true);
});
test('四人完成后继续其余回合；完成者不可再次行动', () => {
  const g=setup(55,1);g.planes.filter(p=>p.owner==='p0'&&p.id!=='red-1').forEach(p=>p.progress=56);
  const n=movePlane(g,'p0','red-1');assert.equal(n.finished,false);assert.equal(n.players[0].rank,1);assert.equal(currentPlayer(n).id,'p1');
  assert.throws(()=>rollDice(n,'p0',6));
});
test('退出当前玩家推进回合；多人游戏其他玩家继续', () => {
  let g=forfeit(fresh(),'p0');assert.equal(currentPlayer(g).id,'p1');assert.equal(g.finished,false);assert.ok(g.planes.filter(p=>p.owner==='p0').every(p=>p.progress===-2));
  g=forfeit(forfeit(g,'p2'),'p3');assert.equal(g.finished,true);assert.equal(g.players[1].rank,1);
});
test('固定种子跑完整2/3/4人对局，所有中间状态有效且最终完成', () => {
  let seed=13;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};
  for(const count of [2,3,4])for(let round=0;round<4;round++){
    let g=fresh(count),actions=0;
    while(!g.finished&&actions++<20000){
      if(g.phase==='roll')g=rollDice(g,currentPlayer(g).id,random()%6+1);
      else{const moves=legalMoves(g);assert.ok(moves.length);const m=moves[random()%moves.length];g=movePlane(g,currentPlayer(g).id,m.planeId,random()%2===0);}
      assert.ok(validateGame(g));
    }
    assert.ok(g.finished,`${count}人对局超出步数`);assert.equal(g.ranking.length,count);
  }
});

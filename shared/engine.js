import { COLORS, COLOR_META, TRACK, FINISH, HOME_START, ringIndex, boardLocation } from './board.js';

export class RuleError extends Error {
  constructor(code, message) { super(message); this.name = 'RuleError'; this.code = code; }
}
const fail = (code, message) => { throw new RuleError(code, message); };
const copy = value => structuredClone(value);
export const RULE_VERSION = '2026-09-08.1';

export function colorAssignments(count) {
  if (![2, 3, 4].includes(count)) fail('PLAYER_COUNT', '请选择 2、3 或 4 名玩家');
  return count === 2 ? [['red', 'blue'], ['yellow', 'green']] : COLORS.slice(0, count).map(c => [c]);
}

export function createGame(members, round = 1) {
  const assigned = colorAssignments(members.length);
  const players = members.map((m, i) => ({ id: m.id, nickname: m.nickname, colors: assigned[i], rank: null, forfeited: false }));
  if (new Set(players.map(p => p.id)).size !== members.length) fail('PLAYERS', '玩家身份重复');
  const planes = players.flatMap(player => player.colors.flatMap(color => Array.from({ length: 4 }, (_, number) => ({
    id: `${color}-${number + 1}`, number, color, owner: player.id, progress: -1, group: `${color}-${number + 1}`
  }))));
  return { ruleVersion: RULE_VERSION, round, version: 1, players, planes, turn: 0, turnNumber: 1, phase: 'roll', dice: null, lastRoll: null, lastMove: null, ranking: [], log: [], finished: false };
}

export function currentPlayer(game) { return game.players[game.turn]; }
function requireTurn(game, actor, phase) {
  if (game.finished) fail('GAME_FINISHED', '本局已经结束');
  const player = currentPlayer(game);
  if (!player || player.id !== actor || player.rank || player.forfeited) fail('NOT_YOUR_TURN', '请等待你的回合');
  if (phase && game.phase !== phase) fail('WRONG_PHASE', phase === 'roll' ? '本次已经掷骰，请选择飞机' : '请先掷骰子');
}
function log(game, kind, text, details = {}) {
  game.log.unshift({ sequence: game.version + 1, kind, text, ...details });
  game.log = game.log.slice(0, 24);
}
function label(plane) { return `${COLOR_META[plane.color].name}色 ${plane.number + 1} 号`; }
function groupMembers(game, plane) { return game.planes.filter(p => p.group === plane.group && p.color === plane.color && p.progress === plane.progress); }

function capturesAt(game, mover, progress, movingIds) {
  const loc = boardLocation({ ...mover, progress });
  if (loc.kind !== 'track') return [];
  return game.planes.filter(p => !movingIds.has(p.id) && p.owner !== mover.owner && p.progress > 0 && p.progress < HOME_START && boardLocation(p).key === loc.key).map(p => p.id);
}

export function previewMove(game, planeId) {
  const plane = game.planes.find(p => p.id === planeId);
  if (!plane || plane.owner !== currentPlayer(game)?.id || plane.progress < -1 || plane.progress >= FINISH || game.phase !== 'move' || game.finished) return null;
  if (plane.progress === -1 && game.dice !== 6) return null;
  const moving = groupMembers(game, plane), movingIds = new Set(moving.map(p => p.id));
  const captures = new Set(), stages = [];
  function land(progress, kind) {
    stages.push({ progress, kind });
    capturesAt(game, plane, progress, movingIds).forEach(id => captures.add(id));
    return progress;
  }
  let target;
  if (plane.progress === -1) target = land(0, 'launch');
  else {
    const raw = plane.progress + game.dice;
    target = land(raw > FINISH ? 2 * FINISH - raw : raw, raw > FINISH ? 'bounce' : 'walk');
    if (target > 0 && target < 50 && TRACK[ringIndex(plane.color, target)].color === plane.color) {
      const directFlight = ringIndex(plane.color, target) === COLOR_META[plane.color].flight;
      if (!directFlight) target = land(Math.min(50, target + 4), 'jump');
      if (target < 50 && ringIndex(plane.color, target) === COLOR_META[plane.color].flight) {
        // A flight crosses the third interior step of the opposite home lane.
        const opposite = COLORS[(COLORS.indexOf(plane.color) + 2) % 4];
        game.planes.filter(p => p.color === opposite && p.progress === 53 && p.owner !== plane.owner).forEach(p => captures.add(p.id));
        target = land(target + 12, 'flight');
        if (directFlight) target = land(target + 4, 'jump');
      }
    }
  }
  const canStack = target >= 0 && target < FINISH;
  const mergeTargets = canStack ? game.planes.filter(p => p.color === plane.color && !movingIds.has(p.id) && p.progress === target).map(p => p.id) : [];
  return { planeId: plane.id, color: plane.color, number: plane.number, ids: [...movingIds], from: plane.progress, to: target, stages, captures: [...captures], mergeTargets, finishes: target === FINISH };
}

export function legalMoves(game, actor = currentPlayer(game)?.id) {
  if (game.finished || game.phase !== 'move' || currentPlayer(game)?.id !== actor) return [];
  const seen = new Set();
  return game.planes.filter(p => p.owner === actor).flatMap(p => {
    if (seen.has(p.group)) return [];
    seen.add(p.group);
    const move = previewMove(game, p.id);
    return move ? [move] : [];
  });
}

function completePlayers(game) {
  for (const player of game.players) {
    if (player.rank || player.forfeited) continue;
    if (game.planes.filter(p => p.owner === player.id).every(p => p.progress === FINISH)) {
      player.rank = game.ranking.length + 1;
      game.ranking.push(player.id);
      log(game, 'finish', `${player.nickname}全部抵达，获得第 ${player.rank} 名`, { playerId: player.id });
    }
  }
  const remaining = game.players.filter(p => !p.rank && !p.forfeited);
  if (remaining.length <= 1) {
    if (remaining.length === 1) {
      remaining[0].rank = game.ranking.length + 1;
      game.ranking.push(remaining[0].id);
    }
    game.finished = true;
    game.phase = 'finished';
    game.dice = null;
  }
}
function advance(game, repeat = false) {
  completePlayers(game);
  if (game.finished) return;
  const player = currentPlayer(game);
  if (!repeat || player.rank || player.forfeited) {
    do { game.turn = (game.turn + 1) % game.players.length; } while (currentPlayer(game).rank || currentPlayer(game).forfeited);
    game.turnNumber++;
  }
  game.phase = 'roll';
  game.dice = null;
}

export function rollDice(source, actor, value) {
  requireTurn(source, actor, 'roll');
  if (!Number.isInteger(value) || value < 1 || value > 6) fail('DICE', '骰子点数无效');
  const game = copy(source);
  game.dice = value;
  game.lastRoll = { value, playerId: actor, sequence: game.version + 1 };
  game.phase = 'move';
  game.lastMove = null;
  log(game, 'roll', `${currentPlayer(game).nickname}掷出 ${value}`, { value, playerId: actor });
  if (!legalMoves(game).length) {
    log(game, 'pass', '没有可移动的飞机，轮到下一位');
    advance(game);
  }
  game.version++;
  return game;
}

export function movePlane(source, actor, planeId, merge = false) {
  requireTurn(source, actor, 'move');
  if (typeof merge !== 'boolean') fail('STACK', '叠子选项无效');
  const preview = previewMove(source, planeId);
  if (!preview) fail('ILLEGAL_MOVE', '这架飞机当前不能移动');
  const game = copy(source), movingIds = new Set(preview.ids);
  for (const plane of game.planes) {
    if (preview.captures.includes(plane.id)) { plane.progress = -1; plane.group = plane.id; }
    if (movingIds.has(plane.id)) plane.progress = preview.to;
  }
  const moving = game.planes.find(p => p.id === planeId);
  if (merge && preview.mergeTargets.length) {
    const merged = new Set([...preview.ids, ...preview.mergeTargets]);
    const group = [...merged].sort()[0];
    for (const plane of game.planes) if (merged.has(plane.id)) plane.group = group;
  }
  game.lastMove = { ...preview, playerId: actor, merged: merge && preview.mergeTargets.length > 0, sequence: game.version + 1 };
  const kind = preview.from < 0 ? '起飞' : preview.finishes ? '抵达终点' : preview.stages.some(s => s.kind === 'flight') ? '沿捷径飞行' : preview.stages.some(s => s.kind === 'bounce') ? '在终点反弹' : '前进';
  log(game, 'move', `${label(moving)}${preview.ids.length > 1 ? `等 ${preview.ids.length} 架` : ''}${kind}${preview.captures.length ? `，撞回 ${preview.captures.length} 架敌机` : ''}${game.lastMove.merged ? '，组成叠子' : ''}`, { planeId, captures: preview.captures.length });
  const repeat = game.dice === 6;
  advance(game, repeat);
  game.version++;
  return game;
}

export function forfeit(source, actor) {
  const game = copy(source), player = game.players.find(p => p.id === actor);
  if (!player) fail('PLAYER', '玩家不存在');
  if (game.finished || player.forfeited || player.rank) return game;
  player.forfeited = true;
  for (const plane of game.planes) if (plane.owner === actor) { plane.progress = -2; plane.group = plane.id; }
  log(game, 'leave', `${player.nickname}退出本局`);
  if (currentPlayer(game).id === actor) advance(game);
  else completePlayers(game);
  game.version++;
  return game;
}

export function validateGame(game) {
  if (game.ruleVersion !== RULE_VERSION || !Array.isArray(game.players) || ![2, 3, 4].includes(game.players.length)) return false;
  const expected = createGame(game.players, game.round);
  if (game.planes?.length !== expected.planes.length || !Number.isInteger(game.turn) || game.turn < 0 || game.turn >= game.players.length) return false;
  if (!['roll', 'move', 'finished'].includes(game.phase)) return false;
  if (game.phase === 'move' && (!Number.isInteger(game.dice) || game.dice < 1 || game.dice > 6)) return false;
  const ids = new Set();
  for (const plane of game.planes) {
    const def = expected.planes.find(p => p.id === plane.id);
    if (!def || ids.has(plane.id) || plane.owner !== def.owner || plane.color !== def.color || plane.number !== def.number || !Number.isInteger(plane.progress) || plane.progress < -2 || plane.progress > FINISH || typeof plane.group !== 'string') return false;
    ids.add(plane.id);
  }
  for (const plane of game.planes) {
    const group = game.planes.filter(p => p.group === plane.group);
    if (group.some(p => p.color !== plane.color || p.progress !== plane.progress)) return false;
  }
  return true;
}

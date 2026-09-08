import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, rollDice, movePlane, previewMove } from '../shared/engine.js';
import { COLORS, FINISH, boardLocation } from '../shared/board.js';
import { movementSteps, capturesForStep, canAnimateMove, PresentationQueue, directionHeading, nearestHeading, restingHeading } from '../shared/motion.js';

const initial = () => createGame([{ id: 'a', nickname: '甲' }, { id: 'b', nickname: '乙' }]);
function setup(color, progress, dice) {
  const g = initial(), plane = g.planes.find(p => p.color === color);
  plane.progress = progress;
  g.turn = g.players.findIndex(p => p.id === plane.owner);
  return { g: rollDice(g, plane.owner, dice), id: plane.id };
}

test('every color/dice/position animates exactly the dice steps and ends at the rules target', () => {
  for (const color of COLORS) for (let from = -1; from < FINISH; from++) for (let dice = 1; dice <= 6; dice++) {
    const { g, id } = setup(color, from, dice), move = previewMove(g, id);
    if (!move) continue;
    const steps = movementSteps(move);
    assert.equal(steps.at(-1).progress, move.to);
    const walk = steps.filter(s => ['walk', 'bounce'].includes(s.kind));
    assert.equal(walk.length, from < 0 ? 0 : dice);
    let previous = from;
    for (const step of walk) { assert.equal(Math.abs(step.progress - previous), 1); previous = step.progress; }
    for (const step of steps) assert.ok(boardLocation({ ...g.planes.find(p => p.id === id), progress: step.progress }).center.every(Number.isFinite));
  }
});
test('bounce shows arrival then every reverse step even when returning to the original cell', () => {
  const { g, id } = setup('red', 54, 4);
  assert.deepEqual(movementSteps(previewMove(g, id)).map(s => s.progress), [55, 56, 55, 54]);
});
test('shortcut flight stays a single flight leg and jump stays a single hop', () => {
  const move = { from: 10, stages: [{ kind: 'walk', progress: 12 }, { kind: 'flight', progress: 24 }, { kind: 'jump', progress: 28 }] };
  assert.deepEqual(movementSteps(move).map(s => [s.kind, s.progress]), [['walk', 11], ['walk', 12], ['flight', 24], ['jump', 28]]);
});
test('captures wait for their landing stage, not a passed-over track cell', () => {
  const { g, id } = setup('red', 1, 2), mover = g.planes.find(p => p.id === id);
  const enemy = g.planes.find(p => p.owner !== mover.owner);
  const landing = boardLocation({ ...mover, progress: 3 }).key;
  enemy.progress = Array.from({ length: 50 }, (_, i) => i + 1).find(progress => boardLocation({ ...enemy, progress }).key === landing);
  const move = previewMove(g, id), steps = movementSteps(move);
  assert.ok(move.captures.includes(enemy.id));
  assert.deepEqual(capturesForStep(g, move, steps[0]), []);
  assert.ok(capturesForStep(g, move, steps[1]).includes(enemy.id));
});
test('consecutive movement animates once across duplicate SSE/HTTP responses and queued next roll', () => {
  const { g, id } = setup('red', -1, 6), after = movePlane(g, 'a', id), roll = rollDice(after, 'a', 2);
  const queue = new PresentationQueue();
  assert.equal(queue.observe(g, 'room:1'), true);
  queue.observe(after, 'room:1');
  assert.ok(queue.take().move);
  queue.observe(structuredClone(after), 'room:1'); queue.observe(roll, 'room:1');
  assert.equal(queue.take().move, null); assert.equal(queue.take(), null);
  assert.equal(queue.current.version, roll.version);
});
test('reconnect gaps, new rounds and stale snapshots never replay an old movement', () => {
  const { g, id } = setup('red', -1, 6), after = movePlane(g, 'a', id), queue = new PresentationQueue();
  assert.equal(canAnimateMove({ ...g, version: g.version - 1 }, after), false);
  assert.equal(canAnimateMove({ ...g, round: g.round + 1 }, after), false);
  queue.observe(after, 'room:1'); queue.observe(g, 'room:1'); assert.equal(queue.take(), null);
  queue.observe(createGame(g.players, 2), 'room:2'); assert.equal(queue.take(), null);
});
test('up-facing sprites point along cardinal and diagonal travel vectors', () => {
  assert.equal(directionHeading([0, 0], [0, -1]), 0);
  assert.equal(directionHeading([0, 0], [1, 0]), 90);
  assert.equal(directionHeading([0, 0], [0, 1]), 180);
  assert.equal(directionHeading([0, 0], [-1, 0]), 270);
  assert.equal(directionHeading([0, 0], [1, -1]), 45);
});
test('every aircraft faces its launch pad or next board step at rest', () => {
  for (const color of COLORS) for (let number = 0; number < 4; number++) for (let progress = -1; progress <= FINISH; progress++) {
    const plane = { id: `${color}-${number + 1}`, color, number, progress };
    const effective = progress === FINISH ? -1 : progress;
    const from = boardLocation({ ...plane, progress: effective }).center;
    const to = boardLocation({ ...plane, progress: effective < 0 ? 0 : effective + 1 }).center;
    const rad = restingHeading(plane) * Math.PI / 180, distance = Math.hypot(to[0] - from[0], to[1] - from[1]);
    assert.ok(Math.abs(Math.sin(rad) - (to[0] - from[0]) / distance) < 1e-10);
    assert.ok(Math.abs(-Math.cos(rad) - (to[1] - from[1]) / distance) < 1e-10);
  }
});
test('turns take the short route across zero and handle accumulated rotations', () => {
  assert.equal(nearestHeading(350, 10), 370);
  assert.equal(nearestHeading(10, 350), -10);
  for (let current = -1440; current <= 1440; current += 30) for (let target = 0; target < 360; target += 15) {
    const result = nearestHeading(current, target);
    assert.ok(Math.abs(result - current) <= 180);
    assert.equal(((result % 360) + 360) % 360, target);
  }
});
test('finish bounce reverses the nose for each color and shortcut follows its straight path', () => {
  for (const color of COLORS) {
    const { g, id } = setup(color, 54, 4), plane = g.planes.find(p => p.id === id);
    const centers = [54, 55, 56, 55, 54].map(progress => boardLocation({ ...plane, progress }).center);
    const forward = directionHeading(centers[1], centers[2]), backward = directionHeading(centers[2], centers[3]);
    assert.equal(Math.abs(nearestHeading(forward, backward) - forward), 180);
    assert.equal(directionHeading(centers[0], centers[1]), forward);
    assert.equal(directionHeading(centers[3], centers[4]), backward);
  }
});

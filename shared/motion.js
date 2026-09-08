import { FINISH, boardLocation } from './board.js';

// Sprite noses point up. CSS positive rotation is clockwise in board coordinates.
export function directionHeading(from, to) {
  return (Math.atan2(to[0] - from[0], from[1] - to[1]) * 180 / Math.PI + 360) % 360;
}
export function nearestHeading(current, target) {
  return current + ((target - current + 540) % 360 + 360) % 360 - 180;
}
export function restingHeading(plane) {
  const progress = plane.progress === FINISH ? -1 : plane.progress;
  const from = boardLocation({ ...plane, progress }).center;
  const to = boardLocation({ ...plane, progress: progress < 0 ? 0 : progress + 1 }).center;
  return directionHeading(from, to);
}

// Expand only the dice leg. Jumps and flights follow their shortcut, not the ring.
export function movementSteps(move) {
  const steps = [];
  let progress = move.from;
  for (const stage of move.stages) {
    if (stage.kind === 'walk' || stage.kind === 'bounce') {
      if (stage.kind === 'bounce') {
        while (progress < FINISH) steps.push({ progress: ++progress, kind: 'walk' });
        while (progress > stage.progress) steps.push({ progress: --progress, kind: 'bounce' });
      } else {
        while (progress < stage.progress) steps.push({ progress: ++progress, kind: 'walk' });
      }
      // A bounce can return to the starting cell, but still has a full route.
      if (steps.length) steps.at(-1).landing = true;
    } else {
      progress = stage.progress;
      steps.push({ progress, kind: stage.kind, landing: true });
    }
  }
  return steps;
}

export function capturesForStep(before, move, step) {
  if (!step.landing) return [];
  const plane = before.planes.find(p => p.id === move.planeId);
  const target = boardLocation({ ...plane, progress: step.progress });
  return before.planes.filter(p => move.captures.includes(p.id) && (
    boardLocation(p).key === target.key || step.kind === 'flight' && p.progress === 53
  )).map(p => p.id);
}

export function canAnimateMove(before, after) {
  const move = after?.lastMove;
  return !!(before && move && before.round === after.round && after.version === before.version + 1 &&
    move.sequence === after.version && before.planes.some(p => p.id === move.planeId && p.progress === move.from));
}

// Responses and SSE can deliver the same version while an animation is playing.
// Keep each consecutive snapshot once, and snap to state after reconnect gaps.
export class PresentationQueue {
  reset() { this.current = null; this.latest = null; this.pending = []; this.scope = null; }
  constructor() { this.reset(); }
  observe(snapshot, scope) {
    if (this.scope !== scope || !this.current || this.pending.length >= 8) {
      this.reset(); this.scope = scope; this.current = this.latest = snapshot;
      return true;
    }
    if (snapshot.version > this.latest.version) { this.pending.push(snapshot); this.latest = snapshot; }
    return false;
  }
  take() {
    const after = this.pending.shift();
    if (!after) return null;
    const before = this.current; this.current = after;
    return { before, after, move: canAnimateMove(before, after) ? after.lastMove : null };
  }
}

export const COLORS = ['red', 'yellow', 'blue', 'green'];
export const COLOR_META = {
  red: { name: '红', fill: '#E8806D', soft: '#FCE7DE', ink: '#A83F32', entry: 26, flight: 46, airport: [0, 13], launch: [5, 16.5] },
  yellow: { name: '黄', fill: '#EABB4A', soft: '#FFF1C7', ink: '#8B6213', entry: 39, flight: 7, airport: [0, 0], launch: [0.5, 5] },
  blue: { name: '蓝', fill: '#76B2D4', soft: '#E1EFF8', ink: '#286488', entry: 0, flight: 20, airport: [13, 0], launch: [12, 0.5] },
  green: { name: '绿', fill: '#83B68E', soft: '#E3F0E1', ink: '#376F45', entry: 13, flight: 33, airport: [13, 13], launch: [16.5, 12] }
};
const rect = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
const quarter = [
  { center: [8.5, 1], polygon: rect(8, 0, 1, 2) },
  { center: [9.5, 1], polygon: rect(9, 0, 1, 2) },
  { center: [10.5, 1], polygon: rect(10, 0, 1, 2) },
  { center: [11.67, 1.33], polygon: [[11, 0], [13, 2], [11, 2]] },
  { center: [12, 2.5], polygon: rect(11, 2, 2, 1) },
  { center: [12, 3.5], polygon: rect(11, 3, 2, 1) },
  { center: [11.67, 4.67], polygon: [[11, 4], [13, 4], [11, 6]] },
  { center: [12.33, 5.33], polygon: [[13, 4], [13, 6], [11, 6]] },
  { center: [13.5, 5], polygon: rect(13, 4, 1, 2) },
  { center: [14.5, 5], polygon: rect(14, 4, 1, 2) },
  { center: [15.67, 5.33], polygon: [[15, 4], [17, 6], [15, 6]] },
  { center: [16, 6.5], polygon: rect(15, 6, 2, 1) },
  { center: [16, 7.5], polygon: rect(15, 7, 2, 1) }
];
export function rotate(point, turns) {
  let [x, y] = point;
  for (let i = 0; i < turns; i++) [x, y] = [17 - y, x];
  return [x, y];
}
const ringColors = ['blue', 'green', 'red', 'yellow'];
export const TRACK = Array.from({ length: 52 }, (_, index) => {
  const q = Math.floor(index / 13), item = quarter[index % 13];
  return { index, color: ringColors[index % 4], center: rotate(item.center, q), polygon: item.polygon.map(p => rotate(p, q)) };
});
export const FINISH = 56;
export const HOME_START = 51;
export const HOME = Object.fromEntries(COLORS.map(color => {
  const q = COLOR_META[color].entry / 13;
  return [color, Array.from({ length: 6 }, (_, i) => ({
    center: rotate([8.5, i === 5 ? 7.5 : 2.5 + i], q),
    polygon: (i === 5 ? [[7, 7], [10, 7], [8.5, 8.5]] : rect(8, 2 + i, 1, 1)).map(p => rotate(p, q))
  }))];
}));
export function ringIndex(color, progress) {
  return (COLOR_META[color].entry + 2 + progress) % 52;
}
export function boardLocation(plane) {
  const meta = COLOR_META[plane.color];
  if (plane.progress < 0) return { kind: 'hangar', key: `hangar:${plane.id}`, center: [meta.airport[0] + 1.1 + (plane.number % 2) * 1.8, meta.airport[1] + 1.1 + Math.floor(plane.number / 2) * 1.8] };
  if (plane.progress === 0) return { kind: 'launch', key: `launch:${plane.color}`, center: meta.launch };
  if (plane.progress >= HOME_START) return { kind: plane.progress === FINISH ? 'finished' : 'home', key: `home:${plane.color}:${plane.progress}`, center: HOME[plane.color][plane.progress - HOME_START].center };
  const index = ringIndex(plane.color, plane.progress);
  return { kind: 'track', key: `track:${index}`, index, center: TRACK[index].center };
}

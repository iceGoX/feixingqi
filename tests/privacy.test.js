import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { inspectBytes } from '../tools/privacy-check.mjs';

test('privacy scanner blocks local terms without embedding actual private values', () => {
  const terms = ['internal.example.invalid'];
  for (const encoding of ['utf8', 'utf16le']) assert.deepEqual(inspectBytes(Buffer.from('HTTPS://INTERNAL.EXAMPLE.INVALID/game', encoding), terms), ['private-term']);
  assert.deepEqual(inspectBytes(Buffer.from(Buffer.from(terms[0]).toString('base64')), terms), ['private-term']);
  assert.deepEqual(inspectBytes(Buffer.from('ordinary game source'), terms), []);
});
test('privacy scanner inspects compressed PNG text metadata', () => {
  const payload = Buffer.concat([Buffer.from('Comment\0\0'), deflateSync('internal.example.invalid')]);
  const header = Buffer.alloc(8); header.writeUInt32BE(payload.length); header.write('zTXt', 4);
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), header, payload, Buffer.alloc(4)]);
  assert.deepEqual(inspectBytes(png, ['internal.example.invalid']), ['private-term']);
});
test('smoke test requires an explicit target before accessing any server', () => {
  const result = spawnSync(process.execPath, ['tools/public-smoke.mjs'], { encoding: 'utf8', timeout: 2000 });
  assert.equal(result.status, 1); assert.match(result.stderr, /目标地址/);
});

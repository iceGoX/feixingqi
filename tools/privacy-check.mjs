import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { inflateSync } from 'node:zlib';

const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\b(?:gh[pousr]_[A-Za-z0-9]{25,}|github_pat_[A-Za-z0-9_]{30,})\b/,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bAKID[A-Za-z0-9]{25,}\b/,
  /(?<![\w])\/(?:Users|home)\/[A-Za-z0-9_.-]+\//
];

export function inspectBytes(bytes, terms) {
  const texts = [bytes.toString('utf8'), bytes.toString('utf16le')];
  // PNG text metadata can contain compressed prompts, paths or private URLs.
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const length = bytes.readUInt32BE(offset), kind = bytes.toString('ascii', offset + 4, offset + 8);
      if (offset + length + 12 > bytes.length) break;
      const payload = bytes.subarray(offset + 8, offset + 8 + length);
      try {
        if (kind === 'zTXt') texts.push(inflateSync(payload.subarray(payload.indexOf(0) + 2), { maxOutputLength: 8 * 1024 * 1024 }).toString('utf8'));
        if (kind === 'iTXt') {
          const end = payload.indexOf(0), compressed = payload[end + 1];
          const languageEnd = payload.indexOf(0, end + 3), translatedEnd = payload.indexOf(0, languageEnd + 1);
          const text = payload.subarray(translatedEnd + 1);
          texts.push((compressed ? inflateSync(text, { maxOutputLength: 8 * 1024 * 1024 }) : text).toString('utf8'));
        }
      } catch { return ['unreadable-image-metadata']; }
      offset += length + 12;
    }
  }
  const labels = new Set();
  for (const text of texts) {
    if (terms.some(term => text.toLowerCase().includes(term.toLowerCase()) || text.includes(Buffer.from(term).toString('base64')))) labels.add('private-term');
    if (secretPatterns.some(pattern => pattern.test(text))) labels.add('credential-or-local-path');
  }
  return [...labels];
}

export function checkRepository({ history = false, termsFile = '.local/privacy-terms.json' } = {}) {
  if (!fs.existsSync(termsFile)) throw new Error('缺少本地隐私词清单，请先配置 .local/privacy-terms.json；不要提交该文件。');
  const { terms } = JSON.parse(fs.readFileSync(termsFile, 'utf8'));
  if (!Array.isArray(terms) || !terms.length || terms.some(t => typeof t !== 'string' || t.length < 3)) throw new Error('本地隐私词清单无效');
  const git = args => execFileSync('git', args, { maxBuffer: 64 * 1024 * 1024 });
  const objects = history
    ? git(['rev-list', '--objects', '--all']).toString().trim().split('\n').filter(Boolean).map(row => ({ id: row.split(' ')[0] }))
    : git(['ls-files', '--stage', '-z']).toString().split('\0').filter(Boolean).map(row => ({ id: row.split(' ')[1], name: row.slice(row.indexOf('\t') + 1) }));
  const findings = [];
  for (const object of objects) {
    const labels = [...inspectBytes(Buffer.from(object.name || ''), terms), ...inspectBytes(git(['cat-file', '-p', object.id]), terms)];
    if (object.name && /(?:^|\/)(?:\.local|\.data|dist|artifacts|pixso-export)(?:\/|$)|(?:^|\/)\.env(?:$|\.(?!example$))/.test(object.name)) labels.push('private-file');
    if (labels.length) findings.push({ object: object.id.slice(0, 12), categories: [...new Set(labels)] });
  }
  if (findings.length) { console.error(JSON.stringify({ status: 'blocked', findings }, null, 2)); return false; }
  console.log(JSON.stringify({ status: 'passed', scope: history ? 'all reachable history' : 'git index', objects: objects.length }));
  return true;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { if (!checkRepository({ history: process.argv.includes('--history') })) process.exitCode = 1; }
  catch { console.error('隐私检查未完成：请核对本地词清单和 Git 状态，禁止在缺少检查时推送。'); process.exitCode = 1; }
}

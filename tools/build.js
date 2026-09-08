import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
const files=['index.html','styles.css','game.js','manifest.json','shared/board.js','shared/engine.js','shared/motion.js','server/app.js','package.json','assets/lobby-hero.webp','assets/planes-q-atlas.jpg'];
for(const file of ['game.js','shared/board.js','shared/engine.js','shared/motion.js','server/app.js','sw.js'])execFileSync(process.execPath,['--check',file]);
const hash=crypto.createHash('sha256');for(const file of [...files,'sw.js']){hash.update(file);hash.update(fs.readFileSync(file));}
const release=hash.digest('hex').slice(0,16);
fs.rmSync('dist',{recursive:true,force:true});fs.mkdirSync('dist');
for(const file of files){const dest=path.join('dist',file);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(file,dest);}
fs.writeFileSync('dist/sw.js',fs.readFileSync('sw.js','utf8').replace('feixingqi-dev-v1',`feixingqi-${release}`));
const all=[...files,'sw.js'];const hashes=Object.fromEntries(all.map(file=>[file,crypto.createHash('sha256').update(fs.readFileSync(path.join('dist',file))).digest('hex')]));
fs.writeFileSync('dist/release.json',JSON.stringify({release,files:hashes},null,2)+'\n');
console.log(`构建完成：${release}，${all.length} 个运行文件；设计稿、存档、环境配置不进入发布包。`);

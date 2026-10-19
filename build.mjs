// 把 three + rapier + 游戏代码打成一个可双击打开的单文件 塔.html
// 做法：把两个 ESM 库尾部唯一的 export 语句改写成 namespace 挂到 globalThis，
// 各自包一层 IIFE 避免顶层变量重名，游戏代码去掉 import 语句后塞进 async IIFE。
import fs from 'node:fs';
import path from 'node:path';

const root = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

function toNamespace(src, nsName) {
  const cleaned = src.replace(/\/\/# sourceMappingURL=[^\n]*/g, '');
  const m = cleaned.match(/export\s*\{([^}]*)\}\s*;?\s*$/);
  if (!m) throw new Error(`${nsName}: 找不到末尾 export 语句`);
  const entries = [];
  for (const raw of m[1].split(',')) {
    const item = raw.trim();
    if (!item) continue;
    const parts = item.split(/\s+as\s+/);
    const local = parts[0].trim();
    const pub = (parts.length > 1 ? parts[1] : parts[0]).trim();
    if (pub === 'default') continue;
    if (!/^[A-Za-z_$][\w$]*$/.test(local) || !/^[A-Za-z_$][\w$]*$/.test(pub)) {
      throw new Error(`${nsName}: 无法解析的导出项 "${item}"`);
    }
    entries.push(`${JSON.stringify(pub)}: ${local}`);
  }
  const body = cleaned.slice(0, m.index);
  if (/\bexport\b/.test(body.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, ''))) {
    throw new Error(`${nsName}: 除尾部外还有 export 语句，需要人工检查`);
  }
  return `/* ---- ${nsName} bundle ---- */\n(function(){\n${body}\n;globalThis.${nsName} = {${entries.join(',')}};\n})();\n`;
}

const three = toNamespace(fs.readFileSync(path.join(root, 'libs/three.module.js'), 'utf8'), 'THREE');
const rapier = toNamespace(fs.readFileSync(path.join(root, 'libs/rapier.es.js'), 'utf8'), 'RAPIER');

let game = fs.readFileSync(path.join(root, 'src/game.js'), 'utf8');
game = game.replace(/^\s*import\s+\*\s+as\s+THREE\s+from\s+['"]three['"];?\s*$/m, '');
game = game.replace(/^\s*import\s+\*\s+as\s+RAPIER\s+from\s+['"]rapier['"];?\s*$/m, '');
if (/\bfrom\s+['"](three|rapier)['"]/.test(game)) throw new Error('game.js 里还有未处理的 import');

const html = fs.readFileSync(path.join(root, 'dev.html'), 'utf8');
const boot = `<script>
${three}
${rapier}
(async function(){
"use strict";
${game}
})();
</script>`;

const out = html.replace(
  /<!-- LIB_BOOT -->[\s\S]*?<!-- \/LIB_BOOT -->/,
  () => boot
);

fs.writeFileSync(path.join(root, '塔.html'), out, 'utf8');
fs.writeFileSync(path.join(root, 'index.html'), out, 'utf8');   // GitHub Pages 入口
console.log('已生成 塔.html / index.html：', (Buffer.byteLength(out) / 1024 / 1024).toFixed(2), 'MB');

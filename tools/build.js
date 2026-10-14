'use strict';
/**
 * 前端构建：把 web/src 下的 css/js 按文件名顺序内联进 web/shell.html，
 * 产出单文件 web/index.html（便于直接双击打开或被任意静态服务器托管）。
 * 注意：地图代理占位符 __WB_HTTP_PORT__ / __WB_TMAP_SECRET__ 必须原样保留。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'web', 'src');
const SHELL = path.join(ROOT, 'web', 'shell.html');
const OUT = path.join(ROOT, 'web', 'index.html');

const files = fs.readdirSync(SRC).sort();
const css = files.filter((f) => f.endsWith('.css'));
const js = files.filter((f) => f.endsWith('.js'));

let cssText = '';
css.forEach((f) => {
  cssText += `\n/* ===== ${f} ===== */\n` + fs.readFileSync(path.join(SRC, f), 'utf8');
});

let jsText = '';
js.forEach((f) => {
  jsText += `\n/* ===== ${f} ===== */\n` + fs.readFileSync(path.join(SRC, f), 'utf8');
});

if (jsText.includes('</script')) {
  console.error('构建失败：JS 中不能出现 </script 字符串');
  process.exit(1);
}

// 语法体检：内联成单文件后若存在语法错误，整页脚本会静默失效（白屏）
try {
  new Function(jsText);
} catch (e) {
  console.error('构建失败：JS 语法错误 —— ' + e.message);
  process.exit(1);
}

let html = fs.readFileSync(SHELL, 'utf8');
html = html.replace('/*__CSS__*/', () => cssText).replace('/*__JS__*/', () => jsText);

fs.writeFileSync(OUT, html, 'utf8');

const kb = (n) => (n / 1024).toFixed(1) + ' KB';
console.log('构建完成:', OUT);
console.log('  CSS:', css.join(', '), kb(Buffer.byteLength(cssText)));
console.log('  JS :', js.length, '个文件 ->', kb(Buffer.byteLength(jsText)));
console.log('  合计:', kb(Buffer.byteLength(html)));

const ph = ['__WB_HTTP_PORT__', '__WB_TMAP_SECRET__'].filter((p) => html.includes(p));
console.log('  地图占位符:', ph.length ? '保留 ' + ph.join(', ') : '（未发现，运行将提示填写 key）');

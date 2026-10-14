'use strict';
/**
 * 生成「内置导入模板」——严格复刻源台账格式
 *
 * 用法：
 *   node tools/build-template.js [源xlsx路径] [输出路径]
 *
 * 默认：
 *   源   C:\Users\Rain_Drop\Desktop\房屋土地统计表（江北-测试）.xlsx
 *   输出 server/assets/import-template.xlsx
 *
 * 复刻内容：
 *   第 1-4 行：表头（按源表逐列纵向合并）
 *   第 5 行  ：序号行
 *   第 6 行  ：填表说明（源表逐列说明原样保留）
 *   第 7 行起：数据填写区（列宽、边框、日期/数字格式按字段类型预设）
 *   另附「填写说明」工作表：逐列列出系统字段、类型、必填、可选值、填写说明
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { parseXlsx } = require(path.join(ROOT, 'server/lib/xlsx.js'));
const schema = require(path.join(ROOT, 'server/lib/schema.js'));
const { buildXlsx, colName } = require(path.join(ROOT, 'server/lib/xlsx-writer.js'));

const SRC = process.argv[2]
  || process.env.SRC_XLSX
  || 'C:\\Users\\Rain_Drop\\Desktop\\房屋土地统计表（江北-测试）.xlsx';
const OUT = process.argv[3] || path.join(ROOT, 'server/assets/import-template.xlsx');

/* ------------------------------ 1. 读源表 ------------------------------ */

if (!fs.existsSync(SRC)) {
  console.error('源表不存在：' + SRC);
  console.error('请传入路径：node tools/build-template.js <源xlsx路径>');
  process.exit(1);
}

const parsed = parseXlsx(fs.readFileSync(SRC));
const sheetName = parsed.sheetNames[0];
const rows = parsed.sheets[sheetName];
const meta = (parsed.meta && parsed.meta[sheetName]) || { merges: [], colWidths: [], rowHeights: [] };

/** 与 server 端一致的表头行识别：字段匹配数最多的一行 */
function detectHeaderRow(rs) {
  let best = -1, bestScore = 0;
  const scan = Math.min(30, rs.length);
  for (let i = 0; i < scan; i++) {
    const score = rs[i].filter((c) => c != null && schema.matchField(c)).length;
    if (score > bestScore) { bestScore = score; best = i; }
  }
  return bestScore >= 3 ? best : -1;
}

const headerRow = detectHeaderRow(rows);
if (headerRow < 0) { console.error('未能识别表头行'); process.exit(1); }

const headerRaw = rows[headerRow];
// 末尾空列不进模板
let nCols = 0;
for (let i = 0; i < headerRaw.length; i++) if (headerRaw[i] !== null && headerRaw[i] !== '') nCols = i + 1;
if (!nCols) { console.error('表头为空'); process.exit(1); }

const headers = [];
for (let i = 0; i < nCols; i++) headers.push(headerRaw[i] == null ? '' : String(headerRaw[i]).trim());

const headerBottom = headerRow + 3; // 表头占 4 行（与源表一致：1-4 行纵向合并）

// 序号行 / 填表说明行：表头之后第一个首列命中「序号」「填表说明」等标记的行
const MARK = /^(序号|行次|编号|次序|填表说明|填写说明|说明|备注)/;
let seqRowIdx = -1, noteRowIdx = -1;
// 从表头合并区之后开始找（合并填充会让 2-4 行也出现「行次」）
for (let i = headerBottom + 1; i < Math.min(headerBottom + 10, rows.length); i++) {
  const first = rows[i] && rows[i][0] != null ? String(rows[i][0]).trim() : '';
  if (!first) continue;
  if (seqRowIdx < 0 && /^(序号|编号|次序)/.test(first)) { seqRowIdx = i; continue; }
  if (noteRowIdx < 0 && MARK.test(first)) { noteRowIdx = i; continue; }
}

const seqVals = seqRowIdx >= 0 ? rows[seqRowIdx] : [];
const noteVals = noteRowIdx >= 0 ? rows[noteRowIdx] : [];

/* ------------------------------ 2. 合并单元格（只取表头区） ------------------------------ */

const merges = (meta.merges || [])
  .filter((m) => m.r1 >= headerRow && m.r2 <= Math.max(headerBottom, headerRow) && m.c1 < nCols && m.c2 < nCols)
  .map((m) => `${colName(m.c1)}${m.r1 + 1}:${colName(m.c2)}${m.r2 + 1}`);

/* ------------------------------ 3. 列宽 / 行高 ------------------------------ */

const colWidths = [];
for (let i = 0; i < nCols; i++) {
  const w = meta.colWidths && meta.colWidths[i];
  const f = schema.FIELD_MAP.get(schema.buildHeaderMap(headers)[i]);
  colWidths.push(Number.isFinite(w) && w > 0 ? w : Math.min(40, Math.max(9, (f && f.width ? f.width : 110) / 7)));
}

const rowHeights = new Array(headerBottom + 3).fill(0);
for (let i = 0; i <= headerBottom + 2; i++) {
  const h = meta.rowHeights && meta.rowHeights[i];
  rowHeights[i] = Number.isFinite(h) && h > 0 ? h : 0;
}
if (!rowHeights[headerBottom + 1]) rowHeights[headerBottom + 1] = 19.5;   // 序号行
if (!rowHeights[headerBottom + 2]) rowHeights[headerBottom + 2] = 111.95; // 填表说明行

/* ------------------------------ 4. 样式 ------------------------------ */

const STYLES = [
  // 0 表头
  { font: { bold: true, size: 11, color: 'FF1F3864' }, fill: 'FFD9E1F2', border: true, align: { h: 'center', v: 'center', wrap: true } },
  // 1 序号行
  { font: { bold: true, size: 10, color: 'FF7F6000' }, fill: 'FFFFF2CC', border: true, align: { h: 'center', v: 'center', wrap: true } },
  // 2 填表说明
  { font: { size: 10, color: 'FF7F6000' }, fill: 'FFFFF9E6', border: true, align: { h: 'left', v: 'top', wrap: true } },
  // 3 数据区-文本
  { font: { size: 11 }, border: true, align: { h: 'left', v: 'center', wrap: true } },
  // 4 数据区-数值
  { font: { size: 11 }, border: true, align: { h: 'right', v: 'center' }, numFmt: 'num2' },
  // 5 数据区-整数
  { font: { size: 11 }, border: true, align: { h: 'center', v: 'center' }, numFmt: 'int' },
  // 6 数据区-日期
  { font: { size: 11 }, border: true, align: { h: 'center', v: 'center' }, numFmt: 'date' },
  // 7 说明表-标题
  { font: { bold: true, size: 14, color: 'FF1F3864' }, fill: 'FFFFFFFF', align: { h: 'left', v: 'center' } },
  // 8 说明表-副标题
  { font: { size: 10, color: 'FF606060' }, align: { h: 'left', v: 'center', wrap: true } },
  // 9 说明表-表头
  { font: { bold: true, size: 11, color: 'FFFFFFFF' }, fill: 'FF4472C4', border: true, align: { h: 'center', v: 'center', wrap: true } },
  // 10 说明表-正文
  { font: { size: 10 }, border: true, align: { h: 'left', v: 'top', wrap: true } },
];

const TYPE_LABEL = { text: '文本', number: '数值', date: '日期', enum: '选项' };
const colMap = schema.buildHeaderMap(headers);

const colStyles = headers.map((h, i) => {
  const f = schema.FIELD_MAP.get(colMap[i]);
  if (!f) return 3;
  if (f.type === 'date') return 6;
  if (f.type === 'number') return f.key === 'age' || /人数/.test(f.label) ? 5 : 4;
  return 3;
});

/* ------------------------------ 5. 组装「汇总」表 ------------------------------ */

const sheetRows = [];
// 第 1-4 行：表头（只有第一行写值，其余靠合并单元格）
sheetRows.push(headers.map((h) => ({ v: h, s: 0 })));
for (let r = 1; r <= headerBottom - headerRow; r++) {
  sheetRows.push(headers.map(() => ({ v: '', s: 0 })));
}
// 序号行
sheetRows.push(headers.map((h, i) => ({ v: seqVals[i] == null ? '' : seqVals[i], s: 1 })));
// 填表说明行
sheetRows.push(headers.map((h, i) => ({ v: noteVals[i] == null ? '' : String(noteVals[i]), s: 2 })));
// 数据区首行（空，仅占位提示从本行开始填写）
sheetRows.push(headers.map((h, i) => ({ v: '', s: colStyles[i] })));

/* ------------------------------ 6. 组装「填写说明」表 ------------------------------ */

const guideRows = [];
guideRows.push([{ v: '房屋土地导入模板 · 字段填写说明', s: 7 }]);
guideRows.push([{ v: '本模板严格对齐《房屋土地统计表》格式：「' + sheetName + '」表第 1-4 行为表头（合并单元格），第 5 行为序号行，第 6 行为填表说明，请从第 7 行开始填写数据。导入时序号行与说明行会自动跳过。', s: 8 }]);
guideRows.push([]);
guideRows.push(['列序', 'Excel 表头', '系统字段', '类型', '必填', '可选值 / 格式', '填写说明'].map((t) => ({ v: t, s: 9 })));
headers.forEach((h, i) => {
  const key = colMap[i];
  const f = schema.FIELD_MAP.get(key);
  let note = (noteVals[i] == null ? '' : String(noteVals[i])).replace(/\s+/g, ' ').trim();
  // 首列在源表里是「填表说明」这个行标题，不是该列的填写说明
  if (i === 0 && MARK.test(note)) note = '可留空，导入后按表格顺序自动编号';
  guideRows.push([
    { v: colName(i), s: 10 },
    { v: h, s: 10 },
    { v: f ? f.label : '（未匹配）', s: 10 },
    { v: f ? (TYPE_LABEL[f.type] || f.type) : '-', s: 10 },
    { v: f && f.required ? '必填' : '', s: 10 },
    { v: f ? ((f.options && f.options.length ? f.options.join(' / ') : '') || (f.type === 'date' ? 'YYYY-MM-DD' : '') || (f.type === 'number' ? (f.unit ? '单位：' + f.unit : '数字') : '')) : '', s: 10 },
    { v: note || (f ? '' : '该列未匹配到系统字段，导入时会被忽略'), s: 10 },
  ]);
});

/* ------------------------------ 7. 写出 ------------------------------ */

const buf = buildXlsx([
  {
    name: sheetName || '汇总',
    rows: sheetRows,
    colWidths,
    colWidthUnit: 'char',
    colStyles,
    rowHeights,
    merges,
    freeze: { row: headerBottom + 3, col: 2 }, // 冻结表头+说明区、以及前两列
    styles: STYLES,
  },
  {
    name: '填写说明',
    rows: guideRows,
    colWidths: [8, 26, 24, 10, 8, 34, 70],
    colWidthUnit: 'char',
    merges: ['A1:G1', 'A2:G2'],
    styles: STYLES,
  },
]);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, buf);

/* ------------------------------ 8. 自检：回读模板，校验字段匹配 ------------------------------ */

const back = parseXlsx(buf);
const backRows = back.sheets[back.sheetNames[0]];
const backHeader = detectHeaderRow(backRows);
const backMap = schema.buildHeaderMap(backRows[backHeader].map((h) => (h == null ? '' : String(h))));
const matched = backMap.filter(Boolean).length;

console.log('源表:', SRC);
console.log('工作表:', sheetName, '｜表头第', headerRow + 1, '行（合并至第', headerBottom + 1, '行）');
console.log('序号行:', seqRowIdx >= 0 ? seqRowIdx + 1 : '（无）', '｜填表说明行:', noteRowIdx >= 0 ? noteRowIdx + 1 : '（无）');
console.log('列数:', nCols, '｜合并单元格:', merges.length);
console.log('输出:', OUT, '（' + (buf.length / 1024).toFixed(1) + ' KB）');
console.log('回读校验 —— 表头第', backHeader + 1, '行，字段匹配', matched, '/', nCols, matched === nCols ? '✔ 全部匹配' : '✘ 有未匹配列');

if (matched !== nCols) {
  backRows[backHeader].forEach((h, i) => { if (!backMap[i]) console.log('  未匹配列', colName(i), JSON.stringify(h)); });
  process.exit(1);
}

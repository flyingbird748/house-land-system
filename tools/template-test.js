'use strict';
/**
 * 内置导入模板端到端测试
 *   1. 模板结构信息接口
 *   2. 下载的模板文件与源台账格式一致（列数/表头合并/序号行/说明行/行高列宽/冻结）
 *   3. 空模板导入预览：0 条记录，说明行与序号行自动跳过
 *   4. 用模板表头 + 源数据拼装的文件：55 条全部识别、37 列全部匹配
 *   5. upsert 提交不产生重复
 *
 * 运行：node tools/template-test.js
 */

const fs = require('fs');
const path = require('path');
const { parseXlsx } = require('../server/lib/xlsx.js');
const schema = require('../server/lib/schema.js');
const { buildXlsx, colName } = require('../server/lib/xlsx-writer.js');

const BASE = process.env.BASE || 'http://127.0.0.1:8789';
const SRC = process.env.SRC_XLSX || 'C:\\Users\\Rain_Drop\\Desktop\\房产土地统计表（江北-测试）.xlsx';

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); }
}

async function api(method, p, body, token) {
  const res = await fetch(BASE + p, {
    method,
    headers: Object.assign(
      { 'Content-Type': 'application/json' },
      token ? { Authorization: 'Bearer ' + token } : {},
    ),
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch (e) { data = text; }
  return { status: res.status, data };
}

async function download(p, token) {
  const res = await fetch(BASE + p, { headers: token ? { Authorization: 'Bearer ' + token } : {} });
  return Buffer.from(await res.arrayBuffer());
}

/* ------------------------------ 主流程 ------------------------------ */

(async () => {
  const login = await api('POST', '/api/auth/login', { username: 'admin', password: 'admin123' });
  if (login.status !== 200) { console.error('登录失败', login.data); process.exit(1); }
  const token = login.data.token;

  console.log('① 模板结构信息');
  const info = (await api('GET', '/api/import/template/info', undefined, token)).data;
  check('标记为内置模板', info.builtin === true, info.builtin);
  check('列数 37', info.cols === 37, info.cols);
  check('表头第 1-4 行', info.headerRow === 1 && info.headerToRow === 4, [info.headerRow, info.headerToRow]);
  check('序号行第 5 行', info.seqRow === 5, info.seqRow);
  check('填表说明第 6 行', info.noteRow === 6, info.noteRow);
  check('数据起始第 7 行', info.dataRow === 7, info.dataRow);
  check('37 列全部匹配到字段', info.matched === 37 && (info.unmatched || []).length === 0, info.unmatched);
  check('含「填写说明」工作表', (info.sheets || []).indexOf('填写说明') >= 0, info.sheets);

  console.log('② 下载的模板文件');
  const buf = await download('/api/import/template', token);
  const tpl = parseXlsx(buf);
  const tName = tpl.sheetNames[0];
  const tRows = tpl.sheets[tName];
  const tMeta = (tpl.meta || {})[tName] || {};
  check('是有效 xlsx 且 2 个工作表', tpl.sheetNames.length === 2, tpl.sheetNames);
  check('首个工作表名沿用源表「汇总」', tName === '汇总', tName);
  check('表头 37 列', (tRows[0] || []).filter((x) => x !== null && x !== '').length === 37, (tRows[0] || []).length);
  check('表头纵向合并 37 组', (tMeta.merges || []).filter((m) => m.r1 === 0 && m.r2 === 3).length === 37,
    (tMeta.merges || []).filter((m) => m.r1 === 0 && m.r2 === 3).length);
  check('第 5 行为序号行', String(tRows[4][0]).trim() === '序号', tRows[4][0]);
  check('第 6 行为填表说明行', String(tRows[5][0]).trim() === '填表说明', tRows[5][0]);
  check('第 6 行含源表说明正文', String(tRows[5][1] || '').indexOf('资产名称应为重庆市') === 0, String(tRows[5][1]).slice(0, 12));
  check('第 7 行为空（数据起始）', (tRows[6] || []).every((v) => v === null || v === ''), tRows[6]);
  check('说明行行高 111.95', tMeta.rowHeights && Math.abs(tMeta.rowHeights[5] - 111.95) < 0.01, tMeta.rowHeights && tMeta.rowHeights[5]);
  check('列宽沿用源表（A=9.375）', tMeta.colWidths && Math.abs(tMeta.colWidths[0] - 9.375) < 0.01, tMeta.colWidths && tMeta.colWidths[0]);
  const tm = schema.buildHeaderMap(tRows[0].map((h) => (h == null ? '' : String(h))));
  check('表头逐列匹配 37/37', tm.filter(Boolean).length === 37, tm.filter(Boolean).length);
  check('两列同名「产权证号（如有）」分别映射',
    tm.indexOf('multiShareTitleNo') === 19 && tm.indexOf('splitTitleNo') === 21, [tm.indexOf('multiShareTitleNo'), tm.indexOf('splitTitleNo')]);

  console.log('③ 空模板导入预览');
  const empty = await api('POST', '/api/import/preview',
    { fileName: 'import-template.xlsx', content: buf.toString('base64') }, token);
  check('预览成功', empty.status === 200, empty.data);
  check('识别 0 条数据', empty.data.total === 0, empty.data.total);
  check('表头行定为第 1 行', empty.data.headerRowIndex === 0, empty.data.headerRowIndex);
  check('说明行/序号行被跳过', (empty.data.skipped || []).length >= 4, (empty.data.skipped || []).map((s) => s.row));
  check('37 列全部匹配', (empty.data.mapping || []).filter((m) => m.key).length === 37,
    (empty.data.mapping || []).filter((m) => m.key).length);

  console.log('④ 按模板填写后导入');
  const src = parseXlsx(fs.readFileSync(SRC));
  const sRows = src.sheets[src.sheetNames[0]];
  // 用模板的表头/序号行/说明行 + 源表第 7 行起的数据行，拼成一份「按模板填写」的文件
  const nCols = 37;
  const trim = (r) => { const a = (r || []).slice(0, nCols); while (a.length < nCols) a.push(''); return a; };
  const dataRows = sRows.slice(6, 61).filter((r) => (r || []).some((v) => v !== null && v !== '')).map(trim);

  const filledRows = [
    trim(tRows[0]).map((v) => ({ v: v == null ? '' : v, s: 0 })),
    trim(tRows[0]).map(() => ({ v: '', s: 0 })),
    trim(tRows[0]).map(() => ({ v: '', s: 0 })),
    trim(tRows[0]).map(() => ({ v: '', s: 0 })),
    trim(tRows[4]).map((v) => ({ v: v == null ? '' : v, s: 1 })),
    trim(tRows[5]).map((v) => ({ v: v == null ? '' : v, s: 2 })),
    ...dataRows.map((r) => r.map((v) => ({ v: v == null ? '' : v, s: 3 }))),
  ];
  const merges = [];
  for (let i = 0; i < nCols; i++) merges.push(`${colName(i)}1:${colName(i)}4`);
  const filled = buildXlsx([{
    name: '汇总',
    rows: filledRows,
    colWidths: new Array(nCols).fill(15),
    colWidthUnit: 'char',
    rowHeights: [19.5, 19.5, 19.5, 19.5, 19.5, 111.95],
    merges,
    styles: [
      { font: { bold: true }, fill: 'FFD9E1F2', border: true, align: { h: 'center', v: 'center', wrap: true } },
      { font: { bold: true }, fill: 'FFFFF2CC', border: true, align: { h: 'center', v: 'center' } },
      { fill: 'FFFFF9E6', border: true, align: { h: 'left', v: 'top', wrap: true } },
      { border: true, align: { v: 'center', wrap: true } },
    ],
  }]);

  const pv = await api('POST', '/api/import/preview',
    { fileName: '按模板填写.xlsx', content: filled.toString('base64') }, token);
  check('预览成功', pv.status === 200, pv.data);
  check('识别 55 条', pv.data.total === 55, pv.data.total);
  check('表头行第 1 行', pv.data.headerRowIndex === 0, pv.data.headerRowIndex);
  check('37 列全部匹配', (pv.data.mapping || []).filter((m) => m.key).length === 37, (pv.data.mapping || []).filter((m) => m.key).length);
  // 第 2-4 行（表头合并填充）+ 第 5 行序号 + 第 6 行填表说明
  check('跳过 5 行说明/序号', (pv.data.skipped || []).length === 5, (pv.data.skipped || []).map((s) => s.row));
  const p0 = (pv.data.preview || [])[0] || {};
  check('首条名称正确', p0.name === '重庆市江北区洋河机关办公楼', p0.name);
  check('面积解析为数字', p0.area === 9214, p0.area);
  check('原值解析为数字', Math.abs((p0.originalValue || 0) - 44659781.66) < 0.01, p0.originalValue);
  check('日期解析为 YYYY-MM-DD', p0.acquireDate === '2002-01-01', p0.acquireDate);
  check('坐落位置正确', /洋河中路35号/.test(String(p0.location || '')), p0.location);

  console.log('⑤ upsert 提交不重复');
  const before = (await api('GET', '/api/assets?pageSize=1', undefined, token)).data.total;
  const cm = await api('POST', '/api/import/commit', { token: pv.data.token, mode: 'upsert' }, token);
  check('提交成功', cm.status === 200, cm.data);
  check('未新增重复记录', cm.data.created === 0, cm.data);
  check('更新 55 条', cm.data.updated === 55, cm.data);
  const after = (await api('GET', '/api/assets?pageSize=1', undefined, token)).data.total;
  check('总数保持不变', after === before, [before, after]);

  console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('异常:', e); process.exit(1); });

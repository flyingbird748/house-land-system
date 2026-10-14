'use strict';
/**
 * 初始化导入：把 Excel 台账写入数据库
 * 用法：node tools/seed.js [xlsx路径] [所属单位名称]
 */
const fs = require('fs');
const path = require('path');
const store = require('../server/lib/store.js');
const auth = require('../server/lib/auth.js');
const schema = require('../server/lib/schema.js');
const { parseXlsx } = require('../server/lib/xlsx.js');

const db = store.load();
auth.ensureDefaultUsers();

const file = process.argv[2] || 'C:\\Users\\Rain_Drop\\Desktop\\房产土地统计表（江北-测试）.xlsx';
const unitName = process.argv[3] || '国家税务总局重庆市江北区税务局';

if (!fs.existsSync(file)) {
  console.error('文件不存在:', file);
  process.exit(1);
}

const buf = fs.readFileSync(file);
const t0 = Date.now();
const parsed = parseXlsx(buf);
const sheetName = parsed.sheetNames[0];
const rows = parsed.sheets[sheetName];
console.log(`解析 ${path.basename(file)} [${sheetName}]  ${rows.length} 行，耗时 ${Date.now() - t0}ms`);

// 定位表头行
let headerRow = -1, best = 0;
for (let i = 0; i < Math.min(30, rows.length); i++) {
  const score = rows[i].filter((c) => c != null && schema.matchField(c)).length;
  if (score > best) { best = score; headerRow = i; }
}
const headers = rows[headerRow].map((h) => (h == null ? '' : String(h)));
const colMap = schema.buildHeaderMap(headers);
const matched = colMap.filter(Boolean).length;
console.log(`表头行：第 ${headerRow + 1} 行，识别字段 ${matched} 个`);

// 单位登记
if (unitName && !db.units.some((u) => u.name === unitName)) {
  db.units.push({ id: store.nextId('unit'), name: unitName, code: '', sort: db.units.length + 1 });
}

const now = new Date().toISOString();
const byNo = new Map();
for (const a of db.assets) if (a.assetNo) byNo.set(String(a.assetNo), a);

let created = 0, updated = 0, skippedRows = [];
for (let i = headerRow + 1; i < rows.length; i++) {
  const r = rows[i];
  if (!r || r.every((v) => v === null || v === undefined || v === '')) continue;
  const first = r[0] == null ? '' : String(r[0]).trim();
  if (first && /^(序号|行次|编号|次序|填表说明|填写说明|说明|备注|注[:：]?|合计|总计|小计|合\s*计)/.test(first)) {
    skippedRows.push([i + 1, first.slice(0, 12)]);
    continue;
  }

  const obj = {};
  colMap.forEach((k, ci) => { if (k) obj[k] = schema.coerce(k, r[ci]); });
  if (!obj.name && !obj.sysName && !obj.assetNo) continue;
  if (!obj.unit) obj.unit = unitName;
  if (!obj.name) obj.name = obj.sysName || obj.assetNo || '未命名资产';

  const no = String(obj.assetNo || '').trim();
  const exist = no ? byNo.get(no) : null;
  if (exist) {
    Object.assign(exist, obj, { updatedAt: now, updatedBy: '初始化导入' });
    updated++;
  } else {
    const a = Object.assign({ id: store.nextId('asset'), createdAt: now, updatedAt: now, createdBy: '初始化导入', updatedBy: '初始化导入' }, obj);
    db.assets.push(a);
    if (a.assetNo) byNo.set(a.assetNo, a);
    created++;
  }
}

store.log({ name: '初始化脚本', username: 'seed' }, '导入数据', path.basename(file), `新增 ${created} 条，更新 ${updated} 条`);
store.saveNow();

console.log(`新增 ${created} 条，更新 ${updated} 条，跳过 ${skippedRows.length} 行（说明行/序号行）`);
if (skippedRows.length) console.log('  跳过:', skippedRows.map(([r, s]) => `第${r}行(${s})`).join('、'));
console.log(`当前资产总数：${db.assets.length}，单位：${db.units.map((u) => u.name).join('、') || '（无）'}`);
const filled = (k) => db.assets.filter((a) => a[k] !== null && a[k] !== undefined && a[k] !== '').length;
console.log('字段完整度：', schema.FIELDS.map((f) => `${f.label} ${filled(f.key)}`).join(' | '));

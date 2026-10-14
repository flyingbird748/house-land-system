'use strict';
const fs = require('fs');
const { parseXlsx } = require('../server/lib/xlsx.js');
const { matchField, buildHeaderMap, coerce } = require('../server/lib/schema.js');

const file = process.argv[2] || 'C:\\Users\\Rain_Drop\\Desktop\\房产土地统计表（江北-测试）.xlsx';
const t0 = Date.now();
const { sheetNames, sheets } = parseXlsx(fs.readFileSync(file));
console.log('解析耗时', Date.now() - t0, 'ms');
console.log('工作表:', sheetNames);

const rows = sheets[sheetNames[0]];
console.log('尺寸:', rows.length, 'x', (rows[0] || []).length);

// 自动定位表头行：前 20 行中匹配字段数最多且 >=5 的行
let headerRow = -1, bestScore = 0;
for (let i = 0; i < Math.min(20, rows.length); i++) {
  const score = rows[i].filter((c) => c != null && matchField(c)).length;
  if (score > bestScore) { bestScore = score; headerRow = i; }
}
console.log('表头行(0基):', headerRow, '匹配数:', bestScore);
const headers = rows[headerRow];
console.log('表头映射:', headers.map((h, i) => (h && matchField(h) ? `${i}:${h}->${matchField(h)}` : null)).filter(Boolean).join(' | '));
console.log('未识别列:', headers.map((h, i) => (h && !matchField(h) ? `${i}:${h}` : null)).filter(Boolean).join(' | ') || '（无）');

// 数据行：表头之后，行次为数字 或 资产编号非空
const map = buildHeaderMap(headers);
const records = [];
for (let i = headerRow + 1; i < rows.length; i++) {
  const r = rows[i];
  if (!r) continue;
  const obj = {};
  map.forEach((k, ci) => { if (k) obj[k] = coerce(k, r[ci]); });
  const rowNoVal = r[0];
  const rowNoOk = rowNoVal === null || rowNoVal === '' || (typeof rowNoVal === 'number');
  if (!rowNoOk) { console.log(`  跳过(行次非数字) ${i}:`, JSON.stringify(r[0])); continue; }
  if (!obj.name && !obj.sysName && !obj.assetNo) continue;
  records.push(obj);
}
console.log('有效记录数:', records.length);
console.log('--- 第1条 ---');
console.log(JSON.stringify(records[0], null, 1));
console.log('--- 第8条 ---');
console.log(JSON.stringify(records[7], null, 1));
console.log('--- 第30条 ---');
console.log(JSON.stringify(records[29], null, 1));

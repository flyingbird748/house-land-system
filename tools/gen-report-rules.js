'use strict';
/**
 * gen-report-rules —— 导出「分析报告占位符替代规则说明」
 *
 * 从 /api/report 实时拉取占位符清单（token / label / value / rule），
 * 生成 docs/报告占位符替代规则.md，保证说明与实际汇总口径始终一致。
 *
 * 用法：node tools/gen-report-rules.js [输出路径]
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

function api(method, p, body, token) {
  return new Promise((res, rej) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const r = http.request({
      host: '127.0.0.1', port: 8789, path: p, method,
      headers: Object.assign(
        { 'Content-Type': 'application/json' },
        token ? { Authorization: 'Bearer ' + token } : {},
        data ? { 'Content-Length': Buffer.byteLength(data) } : {},
      ),
    }, (s) => {
      let b = '';
      s.on('data', (c) => { b += c; });
      s.on('end', () => { try { res({ status: s.statusCode, data: JSON.parse(b) }); } catch (e) { res({ status: s.statusCode, data: b }); } });
    });
    r.on('error', rej);
    if (data) r.write(data);
    r.end();
  });
}

function cell(s) { return String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' '); }

(async () => {
  const T = (await api('POST', '/api/auth/login', { username: 'admin', password: 'admin123' })).data.token;
  const R = await api('GET', '/api/report', null, T);
  if (R.status !== 200) throw new Error('拉取报告失败：' + R.status);
  const r = R.data;
  const m = r.meta || {};
  const cfg = (await api('GET', '/api/settings/report', null, T)).data || {};

  const L = [];
  L.push('# 土地房屋资产统计分析报告 —— 占位符替代规则说明');
  L.push('');
  L.push(`> 生成时间：${new Date().toLocaleString('zh-CN')}　统计范围：${m.scopeLabel || '全部单位'}　数据截止：${m.asOf || '（系统当天）'}`);
  L.push('> 本文件由 `node tools/gen-report-rules.js` 从系统实时导出，改动汇总规则后重跑即可同步。');
  L.push('');
  L.push('## 一、占位符是怎么来的');
  L.push('');
  L.push('1. 原始模板 `土地房屋资产统计分析报告.md` 中的填空下划线（Word 转换后形如 `\\_**\\_`、');
  L.push('   `\\____`）已统一规范化为**具名占位符** `{{令牌}}`，保存在 `server/assets/report-template.md`。');
  L.push('2. 报告生成时（`server/lib/report.js`）按当前统计范围内的资产自动汇总，');
  L.push('   逐个把 `{{令牌}}` 替换为计算值；每个令牌的取值规则写在下方对照表里，');
  L.push('   系统首页「分析报告 → 替代规则」按钮可随时查看同一份表格。');
  L.push('3. 模板正文只有一个，但令牌可复用（如 `{{截止日期}}`、`{{自有房产处数}}` 在多个章节出现）。');
  L.push('');
  L.push('## 二、全局口径铁律');
  L.push('');
  L.push('| 项 | 规则 |');
  L.push('| --- | --- |');
  L.push('| 统计范围 | 与左侧「单位范围」一致：系统管理员可看全部，其他角色只能看本单位及下级，普通筛选条件同样生效 |');
  L.push('| 面积字段 | 一律取「产权面积」（建筑面积），含「人均占用办公用房」的分子；**不使用**「办公用房使用面积」——该字段在台账中大面积缺失 |');
  L.push('| 第一部分占比分母 | **统计范围内全部资产面积合计**（含自有、借入、租入） |');
  L.push('| 第二~五部分占比分母 | **自有资产面积合计**（模板注明「占比按面积统计」） |');
  L.push('| 自有 / 借入 / 租入 | 「是否租入借入」=借入、或「产权形式」=从政府借用 → 借入；=租入、或只填「是」且有租金 → 租入；其余 → 自有 |');
  L.push('| 在用 | 自用 + 借用 + 租用；出借 / 闲置 / 已拆除不计入 |');
  L.push('| 数值格式 | 面积保留两位小数并去尾零、带千分位；占比保留一位小数 |');
  L.push('');
  L.push('## 三、需手工维护的参数（系统设置 → 报告参数）');
  L.push('');
  L.push('台账里没有这些口径数据，留空时按兜底规则自动推算，也可由系统管理员在系统设置里固定下来。');
  L.push('');
  L.push('| 参数 | 单位 | 用途 | 当前值 | 留空时的兜底规则 |');
  L.push('| --- | --- | --- | --- | --- |');
  (cfg.params || []).forEach((p) => {
    const v = (cfg.values || {})[p.key];
    L.push(`| ${cell(p.label)} | ${cell(p.unit || '—')} | ${cell(p.hint)} | ${v === '' || v === undefined || v === null ? '（留空·自动推算）' : cell(v)} | ${cell(p.fallback)} |`);
  });
  L.push('');
  L.push('## 四、占位符对照表（按报告中出现顺序）');
  L.push('');
  L.push(`共 ${(r.values || []).length} 项。下表「本次取值」为**当前数据**下的实际结果，数据变化后会自动重算。`);
  L.push('');
  L.push('| # | 占位符 | 含义 | 本次取值 | 替代规则 |');
  L.push('| --- | --- | --- | --- | --- |');
  (r.values || []).forEach((v, i) => {
    L.push(`| ${i + 1} | \`{{${cell(v.token)}}}\` | ${cell(v.label)} | ${cell(v.value) || '（空）'} | ${cell(v.rule)} |`);
  });
  L.push('');
  L.push('## 五、边界与已知约定');
  L.push('');
  L.push('1. **零值措辞**：用途类占位符在该类用房为 0 处时替换为空串（模板里紧跟着句号或「，其中」），');
  L.push('   避免出现「主要用于无」；出租/出借为 0 处时输出「暂无出租对象 / 暂无出借对象」。');
  L.push('2. **人数去重**：台账每条填的是「该房产内人数」，同一办公区多处房产会重复填写，');
  L.push('   因此自动推算按「取值去重后求和」；若两个办公区人数恰好相同会被合并，');
  L.push('   精确人数请在系统设置里维护。');
  L.push('3. **建筑结构**：源台账无此列，已在资产表单与台账新增「建筑结构」字段；');
  L.push('   未填写时第五部分各项计为 0。');
  L.push('4. **房龄分段**：含下限不含上限（10-20 年指 ≥10 且 <20），最后一段为 50 年及以上。');
  L.push('5. **人均占用办公用房**的分子是**产权面积（建筑面积）**，不是「办公用房使用面积」：');
  L.push('   源台账的「办公用房使用面积」大面积缺失（大面积办公用房反而没填），');
  L.push('   且已填部分的使用率从 9% 到 28% 相差悬殊，求和会把人均算成真实值的一半左右。');
  L.push('   分母为「编制人数」，台账该列为空时回退到「现有干部职工人数」。');
  L.push('6. **历史遗留**：使用状态为「已拆除」、产权形式为「已拆除/待拆除」、');
  L.push('   或「无产权」且备注含「不齐全/不具备/无法办理/无审批/手续不全」的资产。');
  L.push('7. **数据缺口可见**：影响本次计算的缺失字段（办公使用面积、编制人数、房龄、建筑结构）');
  L.push('   会写入报告末尾的「附：数据完整性提示」，不会静默按 0 计入。');
  L.push('');
  L.push('---');
  L.push('');
  L.push('## 附：本次生成结果摘要');
  L.push('');
  L.push(`- 资产 ${m.total} 处，总面积 ${m.totalArea} ㎡`);
  L.push(`- 自有 ${m.own} 处 / 借入 ${m.borrow} 处 / 租入 ${m.rentIn} 处，自有面积 ${m.ownArea} ㎡`);
  L.push(`- 未匹配到规则的占位符：${(r.missing || []).length ? (r.missing || []).join('、') : '无'}`);
  L.push('');

  const out = process.argv[2]
    || path.join(__dirname, '..', 'docs', '报告占位符替代规则.md');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, L.join('\n'), 'utf8');
  console.log('已生成：' + out);
  console.log('占位符 ' + (r.values || []).length + ' 项，缺失 ' + (r.missing || []).length + ' 项');
})().catch((e) => { console.error(e); process.exit(1); });

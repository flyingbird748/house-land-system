'use strict';
/**
 * report-test —— 分析报告（需求⑪）接口层测试
 *
 * 覆盖：
 *   1. 占位符全部被替换（正文无 {{}}、无 ____、missing 为空）
 *   2. 数值口径（处数/面积/占比/人均/原值）
 *   3. 报告参数的读写与越权（仅系统管理员可改）
 *   4. 单位作用域：单位管理员只统计本单位
 *   5. 规则表完整（每个占位符都有 rule）
 *   6. 结构字段与房龄分段
 */
const http = require('http');

let pass = 0; let fail = 0;
const fails = [];
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; fails.push(name); console.log('  ✗ ' + name + (extra === undefined ? '' : '  → ' + JSON.stringify(extra))); }
}
function section(t) { console.log('\n== ' + t + ' =='); }

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
const login = async (u, p) => (await api('POST', '/api/auth/login', { username: u, password: p })).data.token;

(async () => {
  const T = await login('admin', 'admin123');
  const UA = await login('unitadmin', 'unitadmin123');
  const VW = await login('viewer', 'viewer123');

  /* ---------------- 1. 报告生成 ---------------- */
  section('报告生成');
  const R = await api('GET', '/api/report', null, T);
  check('接口返回 200', R.status === 200, R.status);
  const r = R.data;
  check('正文为字符串且非空', typeof r.markdown === 'string' && r.markdown.length > 500, (r.markdown || '').length);
  check('正文不含未替换的占位符 {{}}', !/\{\{[^}]*\}\}/.test(r.markdown || ''), (r.markdown || '').match(/\{\{[^}]*\}\}/g));
  check('正文不含残留的填空下划线 ____', !/_{3,}/.test(r.markdown || ''), (r.markdown || '').match(/_{3,}/g));
  check('missing 为空', (r.missing || []).length === 0, r.missing);
  check('HTML 同步生成', typeof r.html === 'string' && /<h1>|<h2>/.test(r.html), (r.html || '').slice(0, 80));
  check('HTML 已转义尖括号（不会注入）', !/<script/i.test(r.html || ''));
  check('规则表非空', (r.values || []).length >= 60, (r.values || []).length);
  check('每个占位符都有替代规则', (r.values || []).every((v) => v.rule && v.rule.length > 4),
    (r.values || []).filter((v) => !v.rule).slice(0, 5));

  /* ---------------- 2. 数值口径 ---------------- */
  section('数值口径');
  const A = await api('GET', '/api/assets?pageSize=all', null, T);
  const rows = A.data.rows || [];
  const nArea = (l) => Math.round(l.reduce((s, a) => s + Number(a.area || 0), 0) * 100) / 100;
  const m = r.meta || {};
  check('总处数 = 台账条数', m.total === rows.length, { got: m.total, want: rows.length });
  check('总面积 = 台账面积合计', Math.abs(m.totalArea - nArea(rows)) < 0.05, { got: m.totalArea, want: nArea(rows) });
  const ownRows = rows.filter((a) => !(a.leasedIn === '租入' || a.leasedIn === '借入' || a.leasedIn === '是' || a.titleType === '从政府借用'));
  check('自有处数与独立计算一致', m.own === ownRows.length, { got: m.own, want: ownRows.length });

  const v = (t) => { const x = (r.values || []).find((y) => y.token === t); return x ? x.value : null; };
  check('自有面积与独立计算一致', Math.abs(Number(String(v('自有面积')).replace(/,/g, '')) - nArea(ownRows)) < 0.05,
    { got: v('自有面积'), want: nArea(ownRows) });
  check('人均办公用房为正数', Number(v('人均办公用房')) > 0, v('人均办公用房'));
  // 口径：建筑面积（产权面积）——源台账的「办公用房使用面积」大面积缺失，不能做分子
  const perCap = Number(String(v('人均办公用房')).replace(/,/g, ''));
  const offArea = Number(String(v('在用办公用房面积')).replace(/,/g, ''));
  const staffBase = Number(String(v('编制人数')).replace(/,/g, ''));
  check('人均办公用房 = 在用办公用房建筑面积 ÷ 编制人数',
    Math.abs(perCap - offArea / staffBase) < 0.05, { perCap, offArea, staffBase, want: offArea / staffBase });
  check('返回数据完整性提示 notes', (r.notes || []).length > 0, r.notes);
  check('提示写明「办公用房使用面积」缺失', (r.notes || []).some((n) => /办公用房使用面积/.test(n)), r.notes);
  check('提示写明编制人数缺失', (r.notes || []).some((n) => /编制人数/.test(n)), r.notes);
  check('正文含「附：数据完整性提示」小节', /数据完整性提示/.test(r.markdown || ''));
  check('占比均为百分数', ['在用办公用房占比', '出租占比', '闲置占比', '历史遗留占比'].every((t) => /%$/.test(String(v(t)))),
    ['在用办公用房占比', '出租占比', '闲置占比', '历史遗留占比'].map(v));
  check('截止日期格式为 ×年×月×日', /^\d{4}年\d{1,2}月\d{1,2}日$/.test(String(v('截止日期'))), v('截止日期'));
  check('局名不含「国家税务总局」与「税务局」', !/国家税务总局|税务局/.test(String(v('局名'))), v('局名'));
  check('区县名来自局名', String(v('局名')).indexOf(String(v('区县'))) >= 0, { j: v('局名'), q: v('区县') });
  check('零值用途不出现「主要用于无」', !/主要用于无/.test(r.markdown || ''), (r.markdown || '').match(/主要用于无/g));
  check('零值对象不出现「主要出租给无」', !/主要(出租|出借)给(无)?使用/.test(r.markdown || '') || !/给无使用/.test(r.markdown || ''));

  /* 按面积统计的分母：第二部分占比分母是自有面积 */
  const pctOf = (t) => Number(String(v(t)).replace('%', ''));
  const sumBuckets = ['自办公用房占比', '自住宅占比', '自车库占比', '自其他房产占比'].reduce((s, t) => s + pctOf(t), 0);
  check('自有三类房产占比合计约 100%', Math.abs(sumBuckets - 100) < 1.5, sumBuckets);
  const ageSum = ['房龄10年内占比', '房龄10至20年占比', '房龄20至30年占比', '房龄30至40年占比', '房龄40至50年占比', '房龄50年以上占比']
    .reduce((s, t) => s + pctOf(t), 0);
  check('房龄分段占比合计约 100%（有房龄数据时）', Math.abs(ageSum - 100) < 1.5 || ageSum === 0, ageSum);

  /* ---------------- 3. 报告参数 ---------------- */
  section('报告参数（仅系统管理员）');
  const S0 = await api('GET', '/api/settings/report', null, T);
  check('系统管理员可读报告参数', S0.status === 200, S0.status);
  check('参数定义含 5 项', (S0.data.params || []).length === 5, (S0.data.params || []).length);
  check('每项参数都有兜底说明', (S0.data.params || []).every((p) => p.fallback && p.hint));
  check('单位管理员读报告参数被拒 403', (await api('GET', '/api/settings/report', null, UA)).status === 403);
  check('只读用户读报告参数被拒 403', (await api('GET', '/api/settings/report', null, VW)).status === 403);
  check('单位管理员改报告参数被拒 403',
    (await api('PUT', '/api/settings/report', { approvedStaff: 1 }, UA)).status === 403);
  check('未登录读报告参数被拒 401', (await api('GET', '/api/settings/report', null, null)).status === 401);

  const before = S0.data.values || {};
  const put1 = await api('PUT', '/api/settings/report', { approvedStaff: 480, deptCount: 18, officeCount: 9, actualStaff: 460, asOf: '2026-09-30' }, T);
  check('保存报告参数 200', put1.status === 200, put1.status);
  check('保存后回显新值', put1.data.values.approvedStaff === 480 && put1.data.values.deptCount === 18, put1.data.values);
  const R2 = await api('GET', '/api/report', null, T);
  const v2 = (t) => { const x = (R2.data.values || []).find((y) => y.token === t); return x ? x.value : null; };
  check('报告采用新编制人数', String(v2('编制人数')) === '480', v2('编制人数'));
  check('报告采用新科室数', String(v2('科室数')) === '18', v2('科室数'));
  check('截止日期采用参数值', String(v2('截止日期')) === '2026年9月30日', v2('截止日期'));
  check('人均办公用房随编制人数变化', String(v2('人均办公用房')) !== String(v('人均办公用房')),
    { old: v('人均办公用房'), neu: v2('人均办公用房') });
  check('非法值（负数/字母）被忽略为留空',
    (await api('PUT', '/api/settings/report', { deptCount: -5, officeCount: 'abc' }, T)).data.values.deptCount === '');

  // 还原
  await api('PUT', '/api/settings/report', before, T);
  const R3 = await api('GET', '/api/report', null, T);
  check('还原参数后报告回到自动推算', String(R3.data.meta.total) === String(m.total), { a: m.total, b: R3.data.meta.total });

  /* ---------------- 4. 单位作用域 ---------------- */
  section('单位作用域');
  const RU = await api('GET', '/api/report', null, UA);
  check('单位管理员可生成报告', RU.status === 200, RU.status);
  check('单位管理员报告范围更小', RU.data.meta.total <= m.total, { ua: RU.data.meta.total, admin: m.total });
  check('单位管理员报告无未替换占位符', !/\{\{[^}]*\}\}/.test(RU.data.markdown || ''), (RU.data.markdown || '').match(/\{\{[^}]*\}\}/g));
  const RS = await api('GET', '/api/report?unit=' + encodeURIComponent('国家税务总局重庆市江北区税务局'), null, T);
  check('按单位筛选后报告随范围变化', RS.status === 200 && typeof RS.data.markdown === 'string');
  check('筛选后 meta 的统计范围标签正确', /江北区/.test(RS.data.meta.scopeLabel || ''), RS.data.meta.scopeLabel);

  /* ---------------- 5. 权限 ---------------- */
  section('权限');
  check('未登录访问报告 401', (await api('GET', '/api/report', null, null)).status === 401);
  check('只读用户可查看报告（只读不改数据）', (await api('GET', '/api/report', null, VW)).status === 200);

  /* ---------------- 6. 操作日志 ---------------- */
  section('操作日志');
  const L = await api('GET', '/api/logs?pageSize=20', null, T);
  const logs = L.data.rows || L.data.logs || [];
  // 日志结构：action=修改系统设置，detail=变更明细（编制干部职工人数：… → …）
  const has = logs.some((x) => /修改系统设置/.test(String(x.action || ''))
    && /编制干部职工人数|税务所数|报告截止日期/.test(String(x.detail || '')));
  check('修改报告参数写入操作日志', has, logs.slice(0, 3).map((x) => x.action + '/' + x.detail));

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  if (fail) { console.log('失败项：\n  - ' + fails.join('\n  - ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });

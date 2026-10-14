'use strict';
/**
 * report —— 土地房屋资产统计分析报告（自动汇总生成）
 *
 * 输入：一批资产（已按单位可见范围与筛选条件过滤）+ 报告参数
 * 输出：填充完成的 markdown、HTML、以及「占位符 → 数值 → 计算规则」对照表
 *
 * 模板：server/assets/report-template.md
 *   原始模板里的填空下划线（Word 转换后形如 \_**\_、\_***、\____）已统一规范化为
 *   具名占位符 {{令牌}}，替代规则见本文件 RULES 与接口返回的 values[].rule。
 *
 * 口径铁律：
 *   1. 分母：第一部分「占土地房屋资产总面积」的分母是【统计范围内全部资产面积合计】；
 *      第二、三、四、五部分「占比」的分母是【自有资产面积合计】（模板注明按面积统计）。
 *   2. 面积一律取「产权面积（area）」；仅「人均占用办公用房」使用「办公用房使用面积」。
 *   3. 权属来源：按「是否租入借入 + 产权形式」判定自有 / 借入 / 租入。
 */
const fs = require('fs');
const path = require('path');
const reportcfg = require('./reportcfg.js');

const TEMPLATE_PATH = path.join(__dirname, '..', 'assets', 'report-template.md');

/** 兜底模板：磁盘文件缺失时仍可出报告 */
const FALLBACK_TEMPLATE = '# 土地房屋资产统计分析报告\n\n数据范围：{{局名}}，共 {{总处数}} 处、{{总面积}} 平方米。\n';

function readTemplate() {
  try {
    const s = fs.readFileSync(TEMPLATE_PATH, 'utf8');
    return s && s.indexOf('{{') >= 0 ? s : FALLBACK_TEMPLATE;
  } catch (e) {
    return FALLBACK_TEMPLATE;
  }
}

/* ------------------------------ 小工具 ------------------------------ */

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function r2(v) { return Math.round(num(v) * 100) / 100; }
function r1(v) { return Math.round(num(v) * 10) / 10; }
/** 数字字符串：保留两位小数并去掉多余的 0，带千分位 */
function nTxt(v, digits) {
  const d = digits === undefined ? 2 : digits;
  const n = num(v);
  const s = (Math.round(n * Math.pow(10, d)) / Math.pow(10, d)).toFixed(d);
  const t = s.replace(/\.?0+$/, '');
  return t.split('.').map((part, i) => (i === 0 ? part.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : part)).join('.');
}
function sumArea(list) { return r2(list.reduce((s, a) => s + num(a.area), 0)); }
function sumVal(list) { return r2(list.reduce((s, a) => s + num(a.originalValue), 0)); }
/** 占比：part / total，保留 1 位小数；分母为 0 时返回 0% */
function pct(part, total) {
  const t = num(total);
  if (!t) return '0%';
  return (Math.round((num(part) / t) * 1000) / 10) + '%';
}
function cut(s, n) {
  const t = String(s == null ? '' : s).trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}
/** 取某字段出现频次最高的前 n 个值（去空、去重） */
function topValues(list, field, n, cutLen) {
  const m = new Map();
  list.forEach((a) => {
    const v = String(a[field] == null ? '' : a[field]).trim();
    if (!v || v === '无') return;
    m.set(v, (m.get(v) || 0) + 1);
  });
  return [...m.entries()]
    .sort((x, y) => y[1] - x[1] || String(x[0]).localeCompare(String(y[0]), 'zh-CN'))
    .slice(0, n || 3)
    .map((x) => cut(x[0], cutLen || 24));
}
function joinTxt(arr, empty) {
  return arr && arr.length ? arr.join('、') : (empty || '无');
}

/** 出租/出借对象：去掉「出租给」「出借给」等句首动词，避免出现「主要出租给 出租给×× 使用」 */
function cleanTarget(s) {
  return String(s || '').replace(/^(出租给|出借给|租给|借给|出租至|出借至)+/, '').trim();
}
/** 出租/出借整句：有对象时「主要××给…使用」，无对象时给一句完整的话，避免出现「主要用于无」 */
function targetSentence(list, verb, emptyTxt) {
  const arr = topValues(list, 'useUnit', 3, 24).map(cleanTarget).filter(Boolean);
  return arr.length ? `主要${verb}给${arr.join('、')}使用` : emptyTxt;
}
/** 用途短语：有值返回「，主要用于××」；该类用房为 0 处时返回空串（模板里紧跟着句号或「，其中」） */
function usagePhrase(sub, field) {
  const arr = topValues(sub, field, 3, 20);
  return arr.length ? `，主要用于${arr.join('、')}` : '';
}

/* ------------------------------ 分类判定 ------------------------------ */

const LEASE_IN_YES = ['是', '借入', '租入'];

/** 权属来源：自有 / 借入 / 租入 */
function sourceOf(a) {
  const li = String(a.leasedIn || '').trim();
  if (li === '租入') return '租入';
  if (li === '借入') return '借入';
  if (li === '是') {
    // 只填了「是」时按租入借入期限/租金判断：有租金视为租入，否则视为借入
    return num(a.leaseRent) > 0 ? '租入' : '借入';
  }
  if (a.titleType === '从政府借用') return '借入';
  return '自有';
}
const isOwn = (a) => sourceOf(a) === '自有';
const isBorrow = (a) => sourceOf(a) === '借入';
const isRentIn = (a) => sourceOf(a) === '租入';

/** 在用：自用 + 借用 + 租用（出借/闲置/已拆除不算本局在用） */
const isInUse = (a) => a.useStatus === '自用' || isBorrow(a) || isRentIn(a);

const isOffice = (a) => a.category === '办公用房';
/** 在用其他用房：在用且非办公用房、非土地 */
const isOtherRoom = (a) => isInUse(a) && a.category !== '办公用房' && a.category !== '土地';

/** 出租 / 出借（我方对外） */
const isRentedOut = (a) => a.rentedOut === '出租' || (a.rentedOut === '是' && a.useStatus !== '出借');
const isLentOut = (a) => a.rentedOut === '出借' || a.useStatus === '出借';

/** 闲置：状态为闲置，或长期/阶段性闲置标记为「是」 */
const isIdle = (a) => a.useStatus === '闲置' || a.idleLong === '是' || a.idleStage === '是';

/** 历史遗留：已拆除 / 待拆除 / 无产权且资料不全无法办证 */
function isLegacy(a) {
  if (a.useStatus === '已拆除') return true;
  if (a.titleType === '已拆除' || a.titleType === '待拆除') return true;
  const txt = String(a.titleType || '') + String(a.remark || '');
  return a.hasTitle === '无产权' && /不齐全|不具备|无法办理|无审批|手续不全/.test(txt);
}

/** 房龄分段：含下限、不含上限，最后一段为 50 年以上 */
const AGE_BUCKETS = [
  { key: '房龄10年内', label: '房龄10年以内', min: 0, max: 10 },
  { key: '房龄10至20年', label: '房龄10-20年', min: 10, max: 20 },
  { key: '房龄20至30年', label: '房龄20-30年', min: 20, max: 30 },
  { key: '房龄30至40年', label: '房龄30-40年', min: 30, max: 40 },
  { key: '房龄40至50年', label: '房龄40-50年', min: 40, max: 50 },
  { key: '房龄50年以上', label: '房龄50年以上', min: 50, max: Infinity },
];

const STRUCTURES = [
  { key: '钢筋混凝土结构', match: /钢筋混凝土|钢混|框架/ },
  { key: '钢结构', match: /钢结构/ },
  { key: '砖混结构', match: /砖混|砖木/ },
  { key: '木结构', match: /木结构/ },
];

const TITLE_KINDS = [
  { key: '不动产权证', match: (a) => a.titleType === '不动产权证' },
  { key: '其他权属证明', match: (a) => a.hasTitle === '有产权' && a.titleType !== '不动产权证' },
  { key: '无权属证明', match: (a) => !(a.hasTitle === '有产权') },
];

/* ------------------------------ 单位名称拆分 ------------------------------ */

/**
 * 由单位全称拆出「局名中间段」与「区县名」：
 *   国家税务总局重庆市江北区税务局 → { mid: '重庆市江北区', district: '江北区' }
 */
function splitUnitName(name) {
  const full = String(name || '').trim();
  let mid = full.replace(/^国家税务总局/, '').replace(/税务局$/, '').trim();
  if (!mid) mid = full;
  let district = mid.replace(/^[^省]*省/, '').replace(/^[^市]*市/, '').trim();
  if (!district) district = mid;
  return { mid, district };
}

/* ------------------------------ 人数口径 ------------------------------ */

/** 把「使用单位（使用人）」按标点切成词条 */
function useUnitTokens(a) {
  return String(a.useUnit || '')
    .split(/[、,，;；/]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * 现有干部职工人数：
 * 台账每条记录填的是「该房产内实有人数」，同一办公区的多处房产会重复填写同一个值
 * （例如金桥北岸 8 处房产都填 52 人），直接求和会成倍虚高。
 * 口径：按「实际人数」取值去重后求和。
 * 已知局限：两个办公区人数恰好相同时会被合并，精确人数请在「系统设置 → 报告参数」维护。
 */
function staffNow(list) {
  const s = new Set();
  list.forEach((a) => {
    const n = num(a.actualStaff);
    if (n > 0) s.add(n);
  });
  let total = 0;
  s.forEach((v) => { total += v; });
  return total;
}

/** 内设科室（组、中心）：从「使用单位（使用人）」里抽取科/组/中心/办公室结尾的词条去重 */
function deptCount(list) {
  const s = new Set();
  list.forEach((a) => {
    useUnitTokens(a).forEach((t) => {
      if (/税务所/.test(t)) return;
      if (/(科|组|中心|办公室|部|党委|纪检组)$/.test(t)) s.add(t);
    });
  });
  return s.size;
}

/** 税务所数：从「使用单位（使用人）」的词条里取含「税务所」的，截到「税务所」为止再去重 */
function officeCount(list) {
  const s = new Set();
  list.forEach((a) => {
    useUnitTokens(a).forEach((t) => {
      if (!/税务所/.test(t)) return;
      const m = /^.*?税务所/.exec(t);
      if (m) s.add(m[0].replace(/^[\s、,，;；]+/, ''));
    });
  });
  return s.size;
}

/* ------------------------------ Markdown → HTML ------------------------------ */

function inline(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
}

function mdToHtml(md) {
  const out = [];
  let para = [];
  let quote = false;
  const flush = () => { if (para.length) { out.push('<p>' + para.join('') + '</p>'); para = []; } };
  const closeQuote = () => { if (quote) { out.push('</blockquote>'); quote = false; } };
  String(md).split(/\r?\n/).forEach((raw) => {
    const line = raw.trim();
    if (!line) { flush(); closeQuote(); return; }
    let m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (m) {
      flush(); closeQuote();
      const lv = Math.min(m[1].length, 4);
      out.push(`<h${lv}>${inline(m[2])}</h${lv}>`);
      return;
    }
    if (/^>\s?/.test(line)) {
      flush();
      if (!quote) { out.push('<blockquote>'); quote = true; }
      out.push('<p>' + inline(line.replace(/^>\s?/, '')) + '</p>');
      return;
    }
    closeQuote();
    para.push(inline(line));
  });
  flush();
  closeQuote();
  return out.join('\n');
}

/* ------------------------------ 主流程 ------------------------------ */

/**
 * @param {Array} assets 已过滤的资产列表
 * @param {Object} ctx  { unitNames: [], scopeLabel: '', params: {} }
 */
function build(assets, ctx) {
  const list = Array.isArray(assets) ? assets : [];
  const c = ctx || {};
  const params = c.params || {};
  const V = {};            // token -> { value, label, rule }
  const order = [];        // 保持文档出现顺序

  /** 登记一个占位符的取值与规则 */
  function put(token, label, value, rule) {
    if (!(token in V)) order.push(token);
    V[token] = { token, label, value: String(value), rule };
  }
  /** 批量登记 处数/面积/占比 三件套 */
  function putGroup(prefix, label, sub, denom) {
    put(prefix + '处数', `${label}·处数`, sub.length, `统计范围内${label}的资产条数`);
    put(prefix + '面积', `${label}·面积`, nTxt(sumArea(sub)), `统计范围内${label}的「产权面积」合计（㎡，保留两位）`);
    put(prefix + '占比', `${label}·占比`, pct(sumArea(sub), denom), `${label}面积 ÷ ${denom === totalArea ? '全部资产总面积' : '自有资产面积合计'}，保留一位小数`);
  }

  /* ---- 总量 ---- */
  const totalArea = sumArea(list);
  const own = list.filter(isOwn);
  const borrow = list.filter(isBorrow);
  const rentIn = list.filter(isRentIn);
  const ownArea = sumArea(own);

  /* ---- 名称 ---- */
  const names = (c.unitNames || []).filter(Boolean);
  const mainName = names.length === 1 ? names[0] : (c.scopeLabel && c.scopeLabel !== '全部单位' ? c.scopeLabel : (names[0] || ''));
  const sp = splitUnitName(mainName);

  put('局名', '局名（不含总局与税务局字样）', sp.mid || '—',
    '当前统计范围的单位名称，去掉「国家税务总局」前缀与「税务局」后缀；多单位时取范围内第一个单位。');
  put('区县', '区县名', sp.district || '—',
    '局名再去掉省级与市级前缀后的剩余部分（如「重庆市江北区」→「江北区」）。');

  /* ---- 人数与机构 ---- */
  const cfg = reportcfg.get();
  const cfgOf = (k) => (params[k] === undefined || params[k] === null || params[k] === '' ? cfg[k] : params[k]);

  const staffN = (cfgOf('actualStaff') === '' || cfgOf('actualStaff') === undefined)
    ? staffNow(list)
    : num(cfgOf('actualStaff'));
  put('现有干部职工', '现有干部职工人数', staffN,
    '优先取「系统设置 → 报告参数」的现有干部职工人数；未设置时按台账「实际人数」取值去重后求和——同一办公区的多处房产会重复填写同一个人数，直接求和会成倍虚高。');

  const approvedCfg = cfgOf('approvedStaff');
  let approvedN = num(approvedCfg);
  let approvedRule = '取「系统设置 → 报告参数」的编制干部职工人数。';
  if (!approvedN) {
    const mx = list.reduce((m, a) => Math.max(m, num(a.approvedStaff)), 0);
    if (mx > 0) {
      approvedN = mx;
      approvedRule = '系统设置未填，取台账「编制人数」的最大值。';
    } else {
      approvedN = staffN;
      approvedRule = '系统设置未填且台账无编制人数，退化为「现有干部职工人数」。';
    }
  }
  put('编制人数', '编制干部职工人数', approvedN, approvedRule);

  const deptCfg = cfgOf('deptCount');
  const deptN = (deptCfg === '' || deptCfg === undefined) ? deptCount(list) : num(deptCfg);
  put('科室数', '内设科室（组、中心）数', deptN,
    '优先取「系统设置 → 报告参数」的内设科室数；未设置时从资产「使用单位（使用人）」中抽取以「科/组/中心/办公室/部/党委」结尾且不含「税务所」的名称去重计数。');

  const officeCfg = cfgOf('officeCount');
  const officeN = (officeCfg === '' || officeCfg === undefined) ? officeCount(list) : num(officeCfg);
  put('税务所数', '税务所数', officeN,
    '优先取「系统设置 → 报告参数」的税务所数；未设置时从「使用单位（使用人）」与资产名称中用正则抽取「××税务所」并去重计数。');

  /* ---- 概况 ---- */
  put('总处数', '资产总处数', list.length, '统计范围内资产条数（含自有、借入、租入及历史遗留）。');
  put('总面积', '资产总面积', nTxt(totalArea), '统计范围内全部资产「产权面积」合计（㎡）。');
  put('自有处数', '自有资产处数', own.length, '权属来源判为「自有」的资产条数（既非借入也非租入）。');
  put('自有面积', '自有资产面积', nTxt(ownArea), '自有资产「产权面积」合计（㎡）。');
  put('自有原值', '自有资产原值（万元）', nTxt(sumVal(own) / 10000), '自有资产「原值」合计 ÷ 10000，保留两位小数。');
  put('借入处数', '借入房产处数', borrow.length, '「是否租入借入」=借入，或「产权形式」=从政府借用的资产条数。');
  put('借入面积', '借入房产面积', nTxt(sumArea(borrow)), '借入房产「产权面积」合计（㎡）。');
  put('租入处数', '租入房产处数', rentIn.length, '「是否租入借入」=租入（或仅填「是」且存在租入租金）的资产条数。');
  put('租入面积', '租入房产面积', nTxt(sumArea(rentIn)), '租入房产「产权面积」合计（㎡）。');

  /* ---- 一、按使用情况 ---- */
  const officeUse = list.filter((a) => isInUse(a) && isOffice(a));
  const officeBorrow = officeUse.filter(isBorrow);
  const officeRentIn = officeUse.filter(isRentIn);
  const officeUseArea = sumArea(officeUse);
  // 「办公用房使用面积」合计仅用于数据完整性提示（源台账大面积缺失，不作为报告口径）
  const officeUseInner = r2(officeUse.reduce((s, a) => s + num(a.officeArea), 0));

  putGroup('在用办公用房', '在用办公用房', officeUse, totalArea);
  // 分子用「产权面积（建筑面积）」：源台账的「办公用房使用面积」大面积缺失且填写口径不一，
  // 直接求和会漏掉近一半办公面积（详见 build() 末尾的数据完整性提示）。
  const perCapita = approvedN ? r2(officeUseArea / approvedN) : 0;
  put('人均办公用房', '人均占用办公用房', nTxt(perCapita),
    '在用办公用房的「产权面积（建筑面积）」合计 ÷ 编制人数（㎡/人）；编制人数缺失时按现有干部职工人数计算。'
    + '不用「办公用房使用面积」是因为该字段在台账中大面积缺失（会被当成 0 计入）。');
  putGroup('办公用房借用', '在用办公用房中借用', officeBorrow, totalArea);
  put('办公用房借用用途', '借用办公用房用途短语', usagePhrase(officeBorrow, 'purpose'),
    '借用办公用房按「资产用途」出现频次取前 3 项，拼成「，主要用于××」；该类用房为 0 处时整段省略（占位符替换为空串，避免出现「主要用于无」）。');
  putGroup('办公用房租用', '在用办公用房中租用', officeRentIn, totalArea);
  put('办公用房租用用途', '租用办公用房用途短语', usagePhrase(officeRentIn, 'purpose'),
    '租用办公用房按「资产用途」出现频次取前 3 项，拼成「，主要用于××」；为 0 处时整段省略。');

  const otherUse = list.filter(isOtherRoom);
  putGroup('在用其他用房', '在用其他用房', otherUse, totalArea);
  put('在用其他用房用途', '在用其他用房用途短语', usagePhrase(otherUse, 'purpose'),
    '在用其他用房（在用且非办公用房、非土地）按「资产用途」出现频次取前 3 项，拼成「，主要用于××」；为 0 处时整段省略。');
  putGroup('其他用房借用', '在用其他用房中借用', otherUse.filter(isBorrow), totalArea);
  put('其他用房借用用途', '借用其他用房用途短语', usagePhrase(otherUse.filter(isBorrow), 'purpose'),
    '借用其他用房按「资产用途」出现频次取前 3 项，拼成「，主要用于××」；为 0 处时整段省略。');
  putGroup('其他用房租用', '在用其他用房中租用', otherUse.filter(isRentIn), totalArea);
  put('其他用房租用用途', '租用其他用房用途短语', usagePhrase(otherUse.filter(isRentIn), 'purpose'),
    '租用其他用房按「资产用途」出现频次取前 3 项，拼成「，主要用于××」；为 0 处时整段省略。');

  const rented = list.filter(isRentedOut);
  const lent = list.filter(isLentOut);
  putGroup('出租', '出租房产', rented, totalArea);
  put('出租对象', '主要出租对象', targetSentence(rented, '出租', '暂无出租对象'),
    '出租房产按「使用单位（使用人）」出现频次取前 3 项、每项截断 24 字并去掉句首的「出租给」，拼成「主要出租给××使用」；无出租房产时输出「暂无出租对象」。');
  putGroup('出借', '出借房产', lent, totalArea);
  put('出借对象', '主要出借对象', targetSentence(lent, '出借', '暂无出借对象'),
    '出借房产按「使用单位（使用人）」出现频次取前 3 项、每项截断 24 字并去掉句首的「出借给」，拼成「主要出借给××使用」；无出借房产时输出「暂无出借对象」。');

  putGroup('闲置', '闲置房产', list.filter(isIdle), totalArea);

  const legacy = list.filter(isLegacy);
  putGroup('历史遗留', '历史遗留问题房产', legacy, totalArea);
  put('历史遗留原因', '历史遗留主要原因', joinTxt(topValues(legacy, 'titleType', 3, 24), '待进一步核实'),
    '历史遗留房产按「产权形式」出现频次取前 3 项，每项截断 24 字；全空时显示「待进一步核实」。');

  /* ---- 二、自有按资产分类 ---- */
  const asOfCfg = (params.asOf === undefined || params.asOf === null || params.asOf === '') ? cfg.asOf : params.asOf;
  const d = asOfCfg ? new Date(String(asOfCfg)) : new Date();
  const asOf = Number.isNaN(d.getTime())
    ? new Date().toLocaleDateString('zh-CN')
    : `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
  put('截止日期', '报告截止日期', asOf,
    '取「系统设置 → 报告参数」的报告截止日期（YYYY-MM-DD），未设置时取系统当天，格式化为「××××年×月×日」。');

  const ownRooms = own.filter((a) => a.category !== '土地');
  const ownLand = own.filter((a) => a.category === '土地');
  const ownAreaRooms = sumArea(ownRooms);
  put('房产处数', '自有房产处数', ownRooms.length, '自有资产中「资产分类」≠土地的条数。');
  put('房产面积', '自有房产面积', nTxt(ownAreaRooms), '自有房产「产权面积」合计（㎡）。');
  put('房产占比', '自有房产面积占比', pct(ownAreaRooms, ownArea), '自有房产面积 ÷ 自有资产面积合计。');
  put('土地处数', '自有土地处数', ownLand.length, '自有资产中「资产分类」=土地的条数。');
  put('土地面积', '自有土地面积', nTxt(sumArea(ownLand)), '自有土地「产权面积」合计（㎡）。');
  put('土地占比', '自有土地面积占比', pct(sumArea(ownLand), ownArea), '自有土地面积 ÷ 自有资产面积合计。');

  [
    ['自办公用房', '自有办公用房', (a) => a.category === '办公用房'],
    ['自住宅', '自有住宅', (a) => a.category === '住宅'],
    ['自车库', '自有车库', (a) => a.category === '车库'],
    ['自其他房产', '自有其他房产', (a) => ['其他用房', '周转房', '其他'].indexOf(a.category) >= 0],
  ].forEach(([prefix, label, fn]) => putGroup(prefix, label, own.filter(fn), ownArea));

  /* ---- 三、自有按权属 ---- */
  TITLE_KINDS.forEach((k) => {
    const sub = own.filter(k.match);
    putGroup(k.key, `自有${k.key}`, sub, ownArea);
  });

  /* ---- 四、自有房产按房龄 ---- */
  const ownWithAge = ownRooms.filter((a) => Number.isFinite(Number(a.age)));
  const avgAge = ownWithAge.length
    ? r1(ownWithAge.reduce((s, a) => s + num(a.age), 0) / ownWithAge.length)
    : 0;
  put('自有房产处数', '自有房产处数（同第二部分）', ownRooms.length, '同「自有房产处数」，用于第四、五部分的表述。');
  put('平均房龄', '自有房产平均房龄', nTxt(avgAge, 1),
    '自有房产「房龄（年）」的算术平均，保留一位小数；无房龄数据时为 0。');
  AGE_BUCKETS.forEach((b) => {
    const sub = ownRooms.filter((a) => Number.isFinite(Number(a.age)) && num(a.age) >= b.min && num(a.age) < b.max);
    putGroup(b.key, b.label, sub, ownArea);
    V[b.key + '处数'].rule = `自有房产中房龄落在「${b.label}」区间的条数（含下限、不含上限，最后一段为 50 年及以上）。`;
  });

  /* ---- 五、自有房产按建筑结构 ---- */
  STRUCTURES.forEach((s) => {
    const sub = ownRooms.filter((a) => s.match.test(String(a.structure || '')));
    putGroup(s.key, s.key, sub, ownArea);
    V[s.key + '处数'].rule = `自有房产中「建筑结构」字段匹配「${s.key}」的条数；台账未填写建筑结构时计为 0。`;
  });

  /* ---- 数据完整性提示 ----
   * 缺失的面积/人数字段会被 num() 静默转成 0，读者会误以为数据完整，
   * 因此把影响本次计算的缺口显式写在报告末尾。 */
  const notes = [];

  const officeNoUsage = officeUse.filter((a) => !num(a.officeArea));
  if (officeNoUsage.length) {
    const missArea = sumArea(officeNoUsage);
    const nm = officeNoUsage.slice(0, 3).map((a) => cut(a.name, 24)).join('、');
    notes.push(`在用办公用房 ${officeUse.length} 处中有 ${officeNoUsage.length} 处未填写「办公用房使用面积」`
      + `（${nm}${officeNoUsage.length > 3 ? ' 等' : ''}），涉及产权面积 ${nTxt(missArea)} ㎡、`
      + `占用办公用房面积的 ${pct(missArea, officeUseArea)}（已填写部分合计仅 ${nTxt(officeUseInner)} ㎡）。`
      + `为避免因该字段缺失而低估，本报告的「人均占用办公用房」按**产权面积（建筑面积）**口径计算。`);
  }

  const rawStaff = list.reduce((s, a) => s + num(a.actualStaff), 0);
  if (staffN > 0 && rawStaff > staffN * 1.2) {
    notes.push(`台账「实际人数」按房产逐条填写，同一办公区的多处房产会重复填写同一个人数`
      + `（逐条求和为 ${rawStaff} 人）。本报告按办公区去重后为 ${staffN} 人；`
      + `若两个办公区人数恰好相同会被合并，精确人数请在「系统设置 → 报告参数」维护。`);
  }

  if (!num(cfgOf('approvedStaff')) && !list.some((a) => num(a.approvedStaff) > 0)) {
    notes.push(`台账「所在单位编制人数」全部为空，「人均占用办公用房」的分母改用现有干部职工人数 `
      + `${staffN} 人（模板表述为「按编制人数计算」）。准确编制数请在「系统设置 → 报告参数」维护。`);
  }

  const noAge = ownRooms.filter((a) => !Number.isFinite(Number(a.age))).length;
  if (noAge) {
    notes.push(`自有房产中有 ${noAge} 处未填写「房龄」，第四部分的房龄分段与平均房龄未包含这 ${noAge} 处。`);
  }
  const noStruct = ownRooms.filter((a) => !String(a.structure || '').trim()).length;
  if (noStruct) {
    notes.push(`自有房产中有 ${noStruct} 处未填写「建筑结构」，第五部分的结构分布未包含这 ${noStruct} 处。`);
  }

  /* ---- 渲染 ---- */
  const tpl = readTemplate();
  const missing = [];
  let markdown = tpl.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (m, token) => {
    const t = String(token).trim();
    if (t in V) return V[t].value;
    missing.push(t);
    return '—';
  });

  if (notes.length) {
    markdown += '\n### 附：数据完整性提示\n\n'
      + notes.map((t) => '- ' + t).join('\n') + '\n';
  }

  const used = [];
  const re = /\{\{\s*([^{}]+?)\s*\}\}/g;
  let mm;
  while ((mm = re.exec(tpl))) {
    const t = mm[1].trim();
    if (used.indexOf(t) < 0) used.push(t);
  }

  const values = used.map((t) => V[t] || { token: t, label: t, value: '—', rule: '（模板中的占位符未匹配到汇总规则）' });

  return {
    markdown,
    html: mdToHtml(markdown),
    values,
    missing,
    notes,
    meta: {
      total: list.length,
      totalArea,
      own: own.length,
      borrow: borrow.length,
      rentIn: rentIn.length,
      ownArea,
      asOf,
      scopeLabel: c.scopeLabel || '',
      unitNames: names,
    },
  };
}

module.exports = { build, mdToHtml, splitUnitName, staffNow, deptCount, officeCount, sourceOf, isLegacy, AGE_BUCKETS, STRUCTURES };

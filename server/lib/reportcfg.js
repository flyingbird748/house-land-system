'use strict';
/**
 * reportcfg —— 分析报告参数。
 *
 * 报告里有一小撮数字在资产台账里根本不存在（编制人数、内设科室数、税务所数等），
 * 这些数据只能由本单位人事/财务口径提供，因此单独放在「系统设置 → 报告参数」里，
 * 由系统管理员维护；留空时报告引擎按各自的兜底规则自动推算（见 lib/report.js）。
 */
const store = require('./store.js');
const repo = require('./repo.js');

/** 参数定义：key / 名称 / 单位 / 说明 / 兜底规则文字（设置页与规则说明共用） */
const PARAMS = [
  {
    key: 'approvedStaff',
    label: '编制干部职工人数',
    unit: '人',
    hint: '人事口径的编制数，用于「人均占用办公用房」的分母。',
    fallback: '留空时取台账中「编制人数」的最大值；台账也没有则用「现有干部职工人数」代替。',
  },
  {
    key: 'actualStaff',
    label: '现有干部职工人数',
    unit: '人',
    hint: '在岗实有人数。台账每条记录填的是该房产内人数，同址会重复，不能直接求和。',
    fallback: '留空时取台账「实际人数」的**不同取值**去重后求和——同一办公区多处房产会重复填写同一个人数，直接求和会成倍虚高。',
  },
  {
    key: 'deptCount',
    label: '内设科室（组、中心）数',
    unit: '个',
    hint: '内设机构数量，台账无此字段，需手工维护。',
    fallback: '留空时按标点切分资产「使用单位（使用人）」，取以「科/组/中心/办公室/部/党委/纪检组」结尾且不含「税务所」的名称去重计数。',
  },
  {
    key: 'officeCount',
    label: '税务所数',
    unit: '个',
    hint: '下属税务所数量，台账无此字段，需手工维护。',
    fallback: '留空时取资产「使用单位（使用人）」中「××税务所」名称的去重数。',
  },
  {
    key: 'asOf',
    label: '报告截止日期',
    unit: '',
    hint: '报告口径的截止时间，会写进第二、三、四部分（「截止××××」）。',
    fallback: '留空时取系统当天日期。',
  },
];

const PARAM_MAP = new Map(PARAMS.map((p) => [p.key, p]));

const DEFAULT_REPORT = () => ({
  approvedStaff: '',
  actualStaff: '',
  deptCount: '',
  officeCount: '',
  asOf: '',
});

async function get() {
  const cur = (await repo.settings.get('report')) || {};
  const out = DEFAULT_REPORT();
  PARAMS.forEach((p) => {
    const v = cur[p.key];
    if (v === undefined || v === null) return;
    if (p.key === 'asOf') { out.asOf = String(v).slice(0, 20); return; }
    const n = Number(v);
    out[p.key] = v === '' ? '' : (Number.isFinite(n) ? n : '');
  });
  return out;
}

async function set(patch) {
  const cur = await get();
  const next = Object.assign({}, cur);
  (patch || {});
  PARAMS.forEach((p) => {
    if (!patch || !(p.key in patch)) return;
    const raw = patch[p.key];
    if (p.key === 'asOf') {
      next.asOf = raw == null ? '' : String(raw).trim().slice(0, 20);
      return;
    }
    if (raw === '' || raw === null || raw === undefined) { next[p.key] = ''; return; }
    const n = Number(raw);
    next[p.key] = Number.isFinite(n) && n >= 0 ? Math.round(n) : '';
  });
  await repo.settings.set('report', next);
  return next;
}

/** 设置页用：参数定义 + 当前值 */
async function view() {
  return { params: PARAMS, values: await get() };
}

module.exports = { PARAMS, PARAM_MAP, get, set, view };

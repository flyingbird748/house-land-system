'use strict';
/**
 * 房屋土地数据字典
 *  - importAliases: 用于 Excel 表头自动匹配（去空格/括号后比较）
 *  - type: text | number | date | enum
 *  - group: 表单分组
 */

const GROUPS = [
  { key: 'basic', label: '基础信息', icon: '▤' },
  { key: 'title', label: '产权信息', icon: '▣' },
  { key: 'area', label: '面积与人员', icon: '▦' },
  { key: 'value', label: '价值与年限', icon: '◈' },
  { key: 'usage', label: '使用与处置', icon: '◍' },
  { key: 'geo', label: '地图标注', icon: '⊕' },
];

const FIELDS = [
  // ---------- 基础信息 ----------
  { key: 'rowNo', label: '行次', group: 'basic', type: 'number', width: 70, importAliases: ['行次', '序号'] },
  { key: 'unit', label: '所属单位', group: 'basic', type: 'enum', width: 160, options: [], importAliases: ['所属单位', '单位', '主管单位'] },
  { key: 'name', label: '资产名称', group: 'basic', type: 'text', width: 260, required: true, importAliases: ['资产名称'] },
  { key: 'sysName', label: '资产系统内资产名称', group: 'basic', type: 'text', width: 240, importAliases: ['资产系统内资产名称', '系统内资产名称'] },
  { key: 'useUnit', label: '使用单位（使用人）', group: 'basic', type: 'text', width: 220, importAliases: ['使用单位（使用人）', '使用单位(使用人)', '使用单位', '使用人'] },
  { key: 'useStatus', label: '当前使用状态', group: 'basic', type: 'enum', width: 150, options: ['自用', '出借', '出租', '闲置', '借用', '已拆除', '其他'], importAliases: ['当前使用状态', '使用状态'] },
  { key: 'assetNo', label: '资产编号', group: 'basic', type: 'text', width: 130, importAliases: ['资产编号'] },
  { key: 'category', label: '资产分类', group: 'basic', type: 'enum', width: 110, options: ['办公用房', '其他用房', '住宅', '车库', '周转房', '土地', '其他'], importAliases: ['资产分类'] },
  { key: 'purpose', label: '资产用途', group: 'basic', type: 'enum', width: 110, options: ['办公', '周转房', '住宅', '其他', '商业'], importAliases: ['资产用途', '用途'] },
  { key: 'structure', label: '建筑结构', group: 'basic', type: 'enum', width: 130, options: ['钢筋混凝土结构', '砖混结构', '钢结构', '木结构', '其他'], importAliases: ['建筑结构', '结构'] },
  { key: 'location', label: '坐落位置', group: 'basic', type: 'text', width: 300, importAliases: ['坐落位置', '坐落', '地址'] },

  // ---------- 产权信息 ----------
  { key: 'hasTitle', label: '是否有产权', group: 'title', type: 'enum', width: 100, options: ['有产权', '无产权'], importAliases: ['是否有产权'] },
  { key: 'titleType', label: '产权形式', group: 'title', type: 'enum', width: 150, options: ['不动产权证', '房屋所有权证', '从政府借用', '待拆除', '已拆除', '其他'], importAliases: ['产权形式'] },
  { key: 'titleNo', label: '产权证号', group: 'title', type: 'text', width: 240, importAliases: ['产权证号'] },
  { key: 'multiShareTitle', label: '多处房产共有同一产权证', group: 'title', type: 'enum', width: 170, options: ['是', '否'], importAliases: ['是否存在多处房产共有同一产权证的情况', '多处房产共有同一产权证'] },
  { key: 'multiShareTitleNo', label: '共有产权证号', group: 'title', type: 'text', width: 200, importAliases: ['共有产权证号', '产权证号（如有）', '产权证号(如有)'] },
  { key: 'splitTitle', label: '一处房产划分为多个房产证', group: 'title', type: 'enum', width: 170, options: ['是', '否'], importAliases: ['是否存在一处房产划分为多个房产证的情况', '一处房产划分为多个房产证'] },
  { key: 'splitTitleNo', label: '分拆产权证号', group: 'title', type: 'text', width: 200, importAliases: ['分拆产权证号', '产权证号（如有）', '产权证号(如有)'] },

  // ---------- 面积与人员 ----------
  { key: 'area', label: '产权面积（㎡）', group: 'area', type: 'number', width: 130, unit: '㎡', importAliases: ['产权面积'] },
  { key: 'officeArea', label: '办公用房使用面积（㎡）', group: 'area', type: 'number', width: 160, unit: '㎡', importAliases: ['办公用房使用面积'] },
  { key: 'perCapitaArea', label: '人均办公面积（㎡）', group: 'area', type: 'number', width: 150, unit: '㎡', importAliases: ['人均办公面积'] },
  { key: 'actualStaff', label: '实际人数', group: 'area', type: 'number', width: 100, importAliases: ['所在单位实际人数', '实际人数'] },
  { key: 'approvedStaff', label: '编制人数', group: 'area', type: 'number', width: 100, importAliases: ['所在单位编制人数', '编制人数'] },
  { key: 'tempStaff', label: '临聘人员人数', group: 'area', type: 'number', width: 110, importAliases: ['所在单位临聘人员人数', '临聘人员人数', '临聘人员'] },

  // ---------- 价值与年限 ----------
  { key: 'originalValue', label: '原值（元）', group: 'value', type: 'number', width: 150, unit: '元', importAliases: ['原值'] },
  { key: 'useDate', label: '投入使用日期', group: 'value', type: 'date', width: 130, importAliases: ['投入使用日期'] },
  { key: 'acquireDate', label: '取得日期', group: 'value', type: 'date', width: 130, importAliases: ['取得日期'] },
  { key: 'age', label: '房龄（年）', group: 'value', type: 'number', width: 100, unit: '年', importAliases: ['房龄'] },
  { key: 'overhauled', label: '是否大修', group: 'value', type: 'enum', width: 100, options: ['是', '否'], importAliases: ['是否大修'] },
  { key: 'overhaulDate', label: '大修时间', group: 'value', type: 'text', width: 120, importAliases: ['大修时间'] },
  { key: 'overhaulAmount', label: '大修金额（元）', group: 'value', type: 'number', width: 130, unit: '元', importAliases: ['大修金额'] },

  // ---------- 使用与处置 ----------
  { key: 'idleLong', label: '是否长期闲置', group: 'usage', type: 'enum', width: 120, options: ['是', '否'], importAliases: ['是否长期闲置'] },
  { key: 'idleStage', label: '是否阶段性闲置', group: 'usage', type: 'enum', width: 130, options: ['是', '否'], importAliases: ['是否阶段性闲置'] },
  { key: 'rentedOut', label: '是否出租出借', group: 'usage', type: 'enum', width: 120, options: ['是', '否', '出租', '出借'], importAliases: ['是否出租出借'] },
  { key: 'rentTerm', label: '出租出借期限', group: 'usage', type: 'text', width: 220, importAliases: ['出租出借期限'] },
  { key: 'rentIncome', label: '出租收益（元）', group: 'usage', type: 'number', width: 130, unit: '元', importAliases: ['出租收益'] },
  { key: 'leasedIn', label: '是否租入借入', group: 'usage', type: 'enum', width: 120, options: ['是', '否', '借入', '租入'], importAliases: ['是否租入借入'] },
  { key: 'leaseTerm', label: '租入借入期限', group: 'usage', type: 'text', width: 200, importAliases: ['租入借入期限'] },
  { key: 'leaseRent', label: '租入租金（元）', group: 'usage', type: 'number', width: 130, unit: '元', importAliases: ['租入租金'] },
  { key: 'remark', label: '备注', group: 'usage', type: 'textarea', width: 220, importAliases: ['备注'] },

  // ---------- 地图标注 ----------
  { key: 'lng', label: '经度', group: 'geo', type: 'number', width: 120, importAliases: ['经度', 'lng', 'longitude'] },
  { key: 'lat', label: '纬度', group: 'geo', type: 'number', width: 120, importAliases: ['纬度', 'lat', 'latitude'] },
];

const FIELD_MAP = new Map(FIELDS.map((f) => [f.key, f]));

/** 表头归一化：去掉空白、中英文括号、星号等 */
function normalizeHeader(s) {
  return String(s == null ? '' : s)
    .replace(/[\s\u3000]/g, '')
    .replace(/[（）()【】\[\]]/g, '')
    .replace(/[*:：·、,，.。/-]/g, '')
    .toLowerCase();
}

const ALIAS_INDEX = new Map();
for (const f of FIELDS) {
  for (const a of f.importAliases || []) {
    const n = normalizeHeader(a);
    if (n && !ALIAS_INDEX.has(n)) ALIAS_INDEX.set(n, f.key);
  }
  ALIAS_INDEX.set(normalizeHeader(f.label), f.key);
}

/** 依据表头文本猜测字段 key */
function matchField(header) {
  const n = normalizeHeader(header);
  if (!n) return null;
  if (ALIAS_INDEX.has(n)) return ALIAS_INDEX.get(n);
  for (const [alias, key] of ALIAS_INDEX) {
    if (alias.length >= 3 && (n.includes(alias) || alias.includes(n))) return key;
  }
  return null;
}

/** 宽松数值解析：支持「约1000」「入驻干部95人」「1,234.5」「120平方米」 */
function toNumber(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  if (!s) return null;
  if (/^(是|否|无|无产权|有产权)$/.test(s)) return null;
  const m = s.replace(/,/g, '').match(/-?\d+(\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

/** 日期归一化为 YYYY-MM-DD */
function toDate(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'string') {
    const s = v.trim();
    const m = s.match(/(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})/);
    if (m) {
      return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
    }
    const ym = s.match(/^(\d{4})[-/.](\d{1,2})$/);
    if (ym) return `${ym[1]}-${String(ym[2]).padStart(2, '0')}-01`;
    if (/^\d{4}$/.test(s)) return `${s}-01-01`;
    return s.slice(0, 40);
  }
  if (typeof v === 'number' && Number.isFinite(v)) {
    // Excel 日期序列号兜底
    const ms = Math.round((v - 25569) * 86400 * 1000);
    const d = new Date(ms);
    if (!Number.isNaN(d.getTime()) && d.getUTCFullYear() > 1900 && d.getUTCFullYear() < 2200) {
      return d.toISOString().slice(0, 10);
    }
  }
  return null;
}

/** 按字段类型归一化单元格值 */
function coerce(key, value) {
  const f = FIELD_MAP.get(key);
  if (!f) return value == null ? null : String(value).trim();
  switch (f.type) {
    case 'number':
      return toNumber(value);
    case 'date':
      return toDate(value);
    case 'enum': {
      if (value == null) return null;
      const s = String(value).trim();
      if (!s) return null;
      if (f.options && f.options.length) {
        const hit = f.options.find((o) => o === s);
        if (hit) return hit;
        const part = f.options.find((o) => s.includes(o) || o.includes(s));
        return part || s.slice(0, 60);
      }
      return s.slice(0, 60);
    }
    default: {
      if (value == null) return null;
      const s = typeof value === 'string' ? value.trim() : String(value);
      return s === '' ? null : s;
    }
  }
}

/**
 * 构建「列序号 -> 字段 key」映射。
 * 处理原表中重复表头（如两列都叫「产权证号（如有）」）：已占用的 key 会让位给同别名的下一个字段。
 */
function buildHeaderMap(headers) {
  const used = new Set();
  const map = new Array(headers.length).fill(null);
  headers.forEach((h, i) => {
    let key = matchField(h);
    if (!key) return;
    if (used.has(key)) {
      const norm = normalizeHeader(h);
      const alt = FIELDS.find(
        (f) => !used.has(f.key) && (f.importAliases || []).some((a) => normalizeHeader(a) === norm)
      );
      key = alt ? alt.key : null;
    }
    if (!key) return;
    used.add(key);
    map[i] = key;
  });
  return map;
}

module.exports = { FIELDS, FIELD_MAP, GROUPS, matchField, buildHeaderMap, toNumber, toDate, coerce, normalizeHeader };

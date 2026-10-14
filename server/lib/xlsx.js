'use strict';
/**
 * 零依赖 .xlsx 解析器
 * 仅依赖 Node 内置模块：zlib
 * 支持：sharedStrings、inlineStr、数字/布尔/错误、日期格式识别（numFmt）、合并单元格尺寸
 */
const zlib = require('zlib');

/* ------------------------------ ZIP 读取 ------------------------------ */

function readZip(buf) {
  // 定位 End Of Central Directory 记录
  let eocd = -1;
  const maxScan = Math.min(buf.length, 65557);
  for (let i = buf.length - 22; i >= buf.length - maxScan && i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 xlsx 文件（未找到 ZIP 尾部记录）');

  const total = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const files = new Map();

  for (let n = 0; n < total; n++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buf.readUInt16LE(offset + 10);
    const compSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localPos = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLen);
    offset += 46 + nameLen + extraLen + commentLen;

    // 读取本地文件头，定位真实数据起点
    const lNameLen = buf.readUInt16LE(localPos + 26);
    const lExtraLen = buf.readUInt16LE(localPos + 28);
    const dataStart = localPos + 30 + lNameLen + lExtraLen;
    files.set(name, { method, dataStart, compSize });
  }
  return files;
}

function readEntry(buf, entry) {
  const raw = buf.subarray(entry.dataStart, entry.dataStart + entry.compSize);
  if (entry.method === 0) return raw;
  if (entry.method === 8) return zlib.inflateRawSync(raw);
  throw new Error('不支持的压缩方式: ' + entry.method);
}

/* ------------------------------ 轻量 XML ------------------------------ */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };

function decodeXml(s) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, code) => {
    if (code[0] === '#') {
      const cp = code[1] === 'x' || code[1] === 'X'
        ? parseInt(code.slice(2), 16)
        : parseInt(code.slice(1), 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
    }
    return ENTITIES[code] !== undefined ? ENTITIES[code] : m;
  });
}

/** 把一段 XML 文本解析为扁平的标签流（够用且高效，不构建完整 DOM） */
function parseTags(xml) {
  const out = [];
  let i = 0;
  const len = xml.length;
  while (i < len) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) break;
    if (lt > i) out.push({ type: 'text', value: decodeXml(xml.slice(i, lt)) });
    if (xml.startsWith('<!--', lt)) { const end = xml.indexOf('-->', lt); i = end < 0 ? len : end + 3; continue; }
    if (xml.startsWith('<![CDATA[', lt)) { const end = xml.indexOf(']]>', lt); out.push({ type: 'text', value: xml.slice(lt + 9, end < 0 ? len : end) }); i = end < 0 ? len : end + 3; continue; }
    if (xml[lt + 1] === '?') { const end = xml.indexOf('?>', lt); i = end < 0 ? len : end + 2; continue; }
    const gt = xml.indexOf('>', lt);
    if (gt < 0) break;
    const body = xml.slice(lt + 1, gt);
    i = gt + 1;
    if (body[0] === '/') { out.push({ type: 'close', name: body.slice(1).trim() }); continue; }
    const selfClose = body.endsWith('/');
    let name = body, attrs = null;
    if (selfClose) name = body.slice(0, -1);
    const sp = name.search(/[\s"'/]/);
    let attrStr = '';
    if (sp > 0) { attrStr = name.slice(sp); name = name.slice(0, sp); }
    else if (sp === 0) { continue; }
    if (attrStr.trim()) {
      attrs = {};
      const re = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
      let m;
      while ((m = re.exec(attrStr))) attrs[m[1]] = m[3] !== undefined ? m[3] : m[4];
    }
    out.push({ type: selfClose ? 'self' : 'open', name, attrs: attrs || {} });
  }
  return out;
}

/* ------------------------------ 列号转换 ------------------------------ */

function colToIndex(ref) {
  let n = 0;
  for (const ch of ref) {
    const c = ch.charCodeAt(0);
    if (c >= 65 && c <= 90) n = n * 26 + (c - 64);
    else if (c >= 97 && c <= 122) n = n * 26 + (c - 96);
    else break;
  }
  return n - 1;
}

/* ------------------------------ 日期识别 ------------------------------ */

const BUILTIN_DATE_FMT = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);

function parseStyles(xml) {
  // 返回: (numFmtId) => boolean 是否为日期格式
  const custom = new Map();
  const tags = parseTags(xml);
  let inNumFmt = false;
  for (const t of tags) {
    if (t.type === 'open' && t.name === 'numFmts') inNumFmt = true;
    else if (t.type === 'close' && t.name === 'numFmts') inNumFmt = false;
    else if (inNumFmt && (t.type === 'self' || t.type === 'open') && t.name === 'numFmt') {
      custom.set(Number(t.attrs.numFmtId), t.attrs.formatCode || '');
    }
  }
  const xfs = [];
  let inCellXfs = false;
  for (const t of tags) {
    if (t.type === 'open' && t.name === 'cellXfs') inCellXfs = true;
    else if (t.type === 'close' && t.name === 'cellXfs') inCellXfs = false;
    else if (inCellXfs && (t.type === 'self' || t.type === 'open') && t.name === 'xf') {
      xfs.push(Number(t.attrs.numFmtId) || 0);
    }
  }
  const isDateCode = (code) => {
    if (!code) return false;
    const clean = code.replace(/\[[^\]]*\]/g, '').replace(/"[^"]*"/g, '');
    return /[ymdhs]/i.test(clean) && !/^General$/i.test(clean);
  };
  return (xfIndex) => {
    const id = xfs[xfIndex];
    if (id === undefined) return false;
    if (BUILTIN_DATE_FMT.has(id)) return true;
    return custom.has(id) && isDateCode(custom.get(id));
  };
}

function serialToISODate(n) {
  // Excel 1900 日期系统（含 1900 闰年 bug），25569 = 1970-01-01
  const ms = Math.round((n - 25569) * 86400 * 1000);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  const p = (v) => String(v).padStart(2, '0');
  const hasTime = Math.abs(n - Math.round(n)) > 1e-9 || (ms % 86400000) !== 0;
  const date = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
  return hasTime ? `${date} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}` : date;
}

/* ------------------------------ 工作表 ------------------------------ */

function parseSharedStrings(xml) {
  const strings = [];
  const tags = parseTags(xml);
  let i = 0;
  while (i < tags.length) {
    if (tags[i].type === 'open' && tags[i].name === 'si') {
      let buf = '';
      let depth = 1;
      let skipAt = 0; // <rPh>（拼音注音）内容需要忽略
      let j = i + 1;
      while (j < tags.length) {
        const c = tags[j];
        if (c.type === 'open') {
          depth++;
          if (c.name === 'rPh') skipAt = depth;
        } else if (c.type === 'close') {
          if (skipAt && depth === skipAt) skipAt = 0;
          depth--;
          if (depth === 0) break;
        } else if (c.type === 'text' && !skipAt) {
          buf += c.value;
        }
        j++;
      }
      strings.push(buf);
      i = j + 1;
      continue;
    }
    i++;
  }
  return strings;
}

function parseMerges(xml) {
  const refs = [];
  const tags = parseTags(xml);
  let inMerge = false;
  for (const t of tags) {
    if (t.type === 'open' && t.name === 'mergeCells') inMerge = true;
    else if (t.type === 'close' && t.name === 'mergeCells') inMerge = false;
    else if (inMerge && (t.type === 'self' || t.type === 'open') && t.name === 'mergeCell' && t.attrs.ref) {
      refs.push(t.attrs.ref);
    }
  }
  return refs.map((ref) => {
    const [a, b] = ref.split(':');
    const m1 = /^([A-Z]+)(\d+)$/.exec(a);
    const m2 = /^([A-Z]+)(\d+)$/.exec(b || a);
    if (!m1 || !m2) return null;
    return {
      c1: colToIndex(m1[1]), r1: Number(m1[2]) - 1,
      c2: colToIndex(m2[1]), r2: Number(m2[2]) - 1,
    };
  }).filter(Boolean);
}

/** 合并单元格只在左上角存值，向下/向右填充，保证每行数据完整 */
function fillMerged(rows, merges) {
  for (const m of merges) {
    const v = rows[m.r1] ? rows[m.r1][m.c1] : null;
    if (v === null || v === undefined || v === '') continue;
    for (let r = m.r1; r <= m.r2; r++) {
      if (!rows[r]) continue;
      for (let c = m.c1; c <= m.c2; c++) rows[r][c] = v;
    }
  }
  return rows;
}

/** 解析 <cols>，把按区间声明的列宽展开成按列下标排列的宽度数组（Excel 字符单位） */
function parseCols(xml) {
  const widths = [];
  const tags = parseTags(xml);
  let inCols = false;
  for (const t of tags) {
    if (t.type === 'open' && t.name === 'cols') { inCols = true; continue; }
    if (t.type === 'close' && t.name === 'cols') { inCols = false; continue; }
    if (!inCols) continue;
    if ((t.type === 'self' || t.type === 'open') && t.name === 'col' && t.attrs.width) {
      const min = Number(t.attrs.min) || 1;
      const max = Number(t.attrs.max) || min;
      const w = Number(t.attrs.width);
      if (!Number.isFinite(w)) continue;
      for (let c = min; c <= max; c++) widths[c - 1] = w;
    }
  }
  return widths;
}

/** 解析行高（0 基下标 -> 磅值） */
function parseRowHeights(xml) {
  const heights = [];
  const tags = parseTags(xml);
  for (const t of tags) {
    if ((t.type === 'self' || t.type === 'open') && t.name === 'row' && t.attrs.r && t.attrs.ht) {
      const r = Number(t.attrs.r);
      const h = Number(t.attrs.ht);
      if (Number.isFinite(r) && Number.isFinite(h)) heights[r - 1] = h;
    }
  }
  return heights;
}

function parseSheet(xml, shared, isDateFmt) {
  const rows = [];
  const tags = parseTags(xml);
  let curRow = null, curCell = null, inInline = false, inValue = false;

  const ensureRow = (r) => {
    while (rows.length < r) rows.push([]);
    return rows[r - 1];
  };

  for (const t of tags) {
    if (t.type === 'open' && t.name === 'row') {
      const r = Number(t.attrs.r) || rows.length + 1;
      curRow = ensureRow(r);
      continue;
    }
    if (t.type === 'open' && t.name === 'c') {
      const ref = t.attrs.r || '';
      const ci = colToIndex(ref);
      curCell = { ci, t: t.attrs.t || 'n', s: Number(t.attrs.s) || 0, v: '' };
      if (curRow) curRow[ci] = curCell;
      continue;
    }
    if (t.type === 'close' && t.name === 'c') { curCell = null; continue; }
    if (t.type === 'open' && t.name === 'is') { inInline = true; continue; }
    if (t.type === 'close' && t.name === 'is') { inInline = false; continue; }
    if (t.type === 'open' && t.name === 'v') { inValue = true; continue; }
    if (t.type === 'close' && t.name === 'v') { inValue = false; continue; }
    if (t.type === 'text' && curCell) {
      if (inInline || inValue) curCell.v += t.value;
      continue;
    }
    if (t.type === 'close' && t.name === 'row') { curRow = null; }
  }

  const maxCols = rows.reduce((m, r) => Math.max(m, r.length), 0);
  const matrix = rows.map((row) => {
    const arr = new Array(maxCols).fill(null);
    for (let i = 0; i < maxCols; i++) {
      const c = row[i];
      arr[i] = c ? cellValue(c, shared, isDateFmt) : null;
    }
    return arr;
  });
  return {
    rows: fillMerged(matrix, parseMerges(xml)),
    merges: parseMerges(xml),
    colWidths: parseCols(xml),
    rowHeights: parseRowHeights(xml),
  };
}

function cellValue(c, shared, isDateFmt) {
  switch (c.t) {
    case 's': {
      const i = Number(c.v);
      return Number.isFinite(i) && shared[i] !== undefined ? shared[i] : null;
    }
    case 'inlineStr':
    case 'str':
      return c.v === '' ? null : c.v;
    case 'b':
      return c.v === '1' || c.v === 'true';
    case 'e':
      return null; // #N/A、#DIV/0! 等错误值视为空
    default: {
      if (c.v === '' || c.v === undefined) return null;
      const num = Number(c.v);
      if (!Number.isFinite(num)) return c.v;
      if (isDateFmt(c.s) && num > 0) return serialToISODate(num);
      return num;
    }
  }
}

/* ------------------------------ 对外接口 ------------------------------ */

/**
 * 解析 xlsx，返回 { sheetNames, sheets: { name: rows[][] } }
 */
function parseXlsx(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const files = readZip(buf);

  const shared = files.has('xl/sharedStrings.xml')
    ? parseSharedStrings(readEntry(buf, files.get('xl/sharedStrings.xml')).toString('utf8'))
    : [];

  const isDateFmt = files.has('xl/styles.xml')
    ? parseStyles(readEntry(buf, files.get('xl/styles.xml')).toString('utf8'))
    : () => false;

  // 读取工作表名称与顺序
  const wbXml = files.has('xl/workbook.xml')
    ? readEntry(buf, files.get('xl/workbook.xml')).toString('utf8')
    : '';
  const wbTags = parseTags(wbXml);
  const relsXml = files.has('xl/_rels/workbook.xml.rels')
    ? readEntry(buf, files.get('xl/_rels/workbook.xml.rels')).toString('utf8')
    : '';
  const relTarget = new Map();
  for (const t of parseTags(relsXml)) {
    if ((t.type === 'self' || t.type === 'open') && t.name === 'Relationship' && t.attrs.Id && t.attrs.Target) {
      relTarget.set(t.attrs.Id, t.attrs.Target.replace(/^\/?xl\//, '').replace(/^\//, ''));
    }
  }

  const wanted = [];
  for (const t of wbTags) {
    if ((t.type === 'self' || t.type === 'open') && t.name === 'sheet') {
      wanted.push({
        name: t.attrs.name || 'Sheet',
        path: relTarget.get(t.attrs['r:id']) || null,
      });
    }
  }
  if (wanted.length === 0) wanted.push({ name: 'Sheet1', path: 'worksheets/sheet1.xml' });

  const sheets = {};
  const meta = {};
  const sheetNames = [];
  for (const w of wanted) {
    let path = w.path || '';
    if (!files.has('xl/' + path)) {
      const found = [...files.keys()].find((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k));
      if (!found) continue;
      path = found.slice(3);
    }
    const xml = readEntry(buf, files.get('xl/' + path)).toString('utf8');
    let name = w.name;
    if (sheets[name]) name = `${w.name}(${Object.keys(sheets).length + 1})`;
    const res = parseSheet(xml, shared, isDateFmt);
    sheets[name] = res.rows;
    meta[name] = { merges: res.merges, colWidths: res.colWidths, rowHeights: res.rowHeights };
    sheetNames.push(name);
  }

  return { sheetNames, sheets, meta };
}

module.exports = { parseXlsx, colToIndex, serialToISODate };

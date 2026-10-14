'use strict';
/**
 * 零依赖 .xlsx 写出器（仅使用 Node 内置模块）
 * 生成内容：[Content_Types].xml / _rels / workbook / styles / worksheet
 * 字符串用 inlineStr 内联；支持样式、合并单元格、行高、列宽、冻结窗格。
 *
 * sheet 结构：
 * {
 *   name: '汇总',
 *   rows: [[值 | {v, s}]],            // s = styles 数组下标
 *   colWidths: [number],              // 默认按字符宽度（Excel 单位）；colWidthUnit:'px' 时按像素换算
 *   colWidthUnit: 'char' | 'px',
 *   rowHeights: [number],             // 0 基，Excel 磅值
 *   merges: ['A1:A4', ...],
 *   freeze: { row: 6, col: 2 },       // 冻结前 6 行、前 2 列
 *   styles: [{ font:{bold,size,color,name}, fill:'FFD9E1F2', border:true, align:{h,v,wrap}, numFmt:'date' }]
 * }
 */

/* ------------------------------ CRC32 ------------------------------ */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

/* ------------------------------ ZIP（store 模式，不压缩） ------------------------------ */
function dosDateTime(d = new Date()) {
  const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() / 2) & 31);
  const date = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
  return { time, date };
}

function buildZip(entries) {
  const { time, date } = dosDateTime();
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, 'utf8');
    const crc = crc32(data);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6); // UTF-8 文件名
    lh.writeUInt16LE(0, 8);      // store
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, name, data);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(time, 12);
    ch.writeUInt16LE(date, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);

    offset += 30 + name.length + data.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, centralBuf, eocd]);
}

/* ------------------------------ XML 工具 ------------------------------ */

const ESC_MAP = [[/&/g, '&#38;'], [/</g, '&#60;'], [/>/g, '&#62;'], [/"/g, '&#34;'], [/'/g, '&#39;']];

function esc(s) {
  let out = String(s);
  for (const [re, to] of ESC_MAP) out = out.replace(re, to);
  return out;
}

/** 过滤 Excel 不允许的控制字符 */
function clean(s) {
  // eslint-disable-next-line no-control-regex
  return String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

function colName(n) {
  let s = '';
  n += 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/* ------------------------------ 样式表 ------------------------------ */

const NUM_FMTS = {
  date: { id: 164, code: 'yyyy-mm-dd' },
  datetime: { id: 165, code: 'yyyy-mm-dd\\ hh:mm' },
  int: { id: 166, code: '0' },
  num2: { id: 167, code: '#,##0.00' },
};

/** 样式注册表：去重收集 fonts / fills / borders / xfs */
function createStyleRegistry() {
  const fonts = [];
  const fills = [];
  const borders = [];
  const xfs = [];
  const numFmtUsed = new Map();
  const map = { font: new Map(), fill: new Map(), border: new Map(), xf: new Map() };

  // Excel 要求 fonts 至少有一项、fills 前两项固定为 none / gray125
  const DEFAULT_FONT_KEY = JSON.stringify([false, 11, '', '宋体']);
  fonts.push('<font><sz val="11"/><color theme="1"/><name val="宋体"/><charset val="134"/></font>');
  map.font.set(DEFAULT_FONT_KEY, 0);
  fills.push('<fill><patternFill patternType="none"/></fill>');
  fills.push('<fill><patternFill patternType="gray125"/></fill>');
  map.fill.set('none', 0);
  map.fill.set('gray125', 1);

  borders.push('<border><left/><right/><top/><bottom/><diagonal/></border>');
  map.border.set('none', 0);

  // cellXfs 至少保留一项默认样式（0），其余样式从 1 开始
  xfs.push('<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>');
  map.xf.set('0|0|0|0|||0', 0);

  function fontId(d) {
    const f = d || {};
    const key = JSON.stringify([!!f.bold, f.size || 11, f.color || '', f.name || '宋体']);
    if (map.font.has(key)) return map.font.get(key);
    const id = fonts.length;
    fonts.push('<font>'
      + (f.bold ? '<b/>' : '')
      + `<sz val="${f.size || 11}"/>`
      + (f.color ? `<color rgb="${f.color}"/>` : '')
      + `<name val="${esc(f.name || '宋体')}"/><charset val="134"/>`
      + '</font>');
    map.font.set(key, id);
    return id;
  }

  function fillId(color) {
    if (!color) return 0;
    const key = String(color).toUpperCase();
    if (map.fill.has(key)) return map.fill.get(key);
    const id = fills.length;
    fills.push(`<fill><patternFill patternType="solid"><fgColor rgb="${key}"/><bgColor indexed="64"/></patternFill></fill>`);
    map.fill.set(key, id);
    return id;
  }

  function borderId(b) {
    if (!b) return 0;
    const color = (b && b.color) || 'FFBFBFBF';
    const key = 'thin' + color;
    if (map.border.has(key)) return map.border.get(key);
    const id = borders.length;
    const mk = (tag) => `<${tag} style="thin"><color rgb="${color}"/></${tag}>`;
    borders.push(`<border>${mk('left')}${mk('right')}${mk('top')}${mk('bottom')}<diagonal/></border>`);
    map.border.set(key, id);
    return id;
  }

  function numFmtId(name) {
    if (!name) return 0;
    const f = NUM_FMTS[name];
    if (!f) return 0;
    numFmtUsed.set(f.id, f.code);
    return f.id;
  }

  /** 注册一个样式描述符，返回 cellXfs 下标 */
  function xfId(d) {
    const desc = d || {};
    const fi = fontId(desc.font);
    const pi = fillId(desc.fill);
    const bi = borderId(desc.border);
    const ni = numFmtId(desc.numFmt);
    const al = desc.align || {};
    const key = [fi, pi, bi, ni, al.h || '', al.v || '', al.wrap ? 1 : 0].join('|');
    if (map.xf.has(key)) return map.xf.get(key);
    const id = xfs.length;
    let align = '';
    if (al.h || al.v || al.wrap) {
      align = '<alignment'
        + (al.h ? ` horizontal="${al.h}"` : '')
        + (al.v ? ` vertical="${al.v}"` : '')
        + (al.wrap ? ' wrapText="1"' : '')
        + '/>';
    }
    xfs.push(`<xf numFmtId="${ni}" fontId="${fi}" fillId="${pi}" borderId="${bi}" xfId="0"`
      + (ni ? ' applyNumberFormat="1"' : '')
      + ' applyFont="1" applyFill="1"'
      + (bi ? ' applyBorder="1"' : '')
      + (align ? ' applyAlignment="1"' : '')
      + '>'
      + align
      + '</xf>');
    map.xf.set(key, id);
    return id;
  }

  function toXml() {
    const nf = [...numFmtUsed.entries()].sort((a, b) => a[0] - b[0]);
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
      + (nf.length ? `<numFmts count="${nf.length}">${nf.map(([id, code]) => `<numFmt numFmtId="${id}" formatCode="${esc(code)}"/>`).join('')}</numFmts>` : '')
      + `<fonts count="${fonts.length}">${fonts.join('')}</fonts>`
      + `<fills count="${fills.length}">${fills.join('')}</fills>`
      + `<borders count="${borders.length}">${borders.join('')}</borders>`
      + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
      + `<cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs>`
      + '<cellStyles count="1"><cellStyle name="常规" xfId="0" builtinId="0"/></cellStyles>'
      + '</styleSheet>';
  }

  return { xfId, toXml };
}

/* ------------------------------ 生成工作表 ------------------------------ */

function sheetXml(sheet, styleMap) {
  const parts = [];
  const rows = sheet.rows || [];
  const nCols = rows.reduce((m, r) => Math.max(m, (r || []).length), 0);

  parts.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>');
  parts.push('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">');
  parts.push(`<dimension ref="A1:${colName(Math.max(0, nCols - 1))}${Math.max(1, rows.length)}"/>`);

  const fz = sheet.freeze;
  if (fz && (fz.row || fz.col)) {
    const y = fz.row || 0;
    const x = fz.col || 0;
    const topLeft = `${colName(x)}${y + 1}`;
    parts.push('<sheetViews><sheetView workbookViewId="0">'
      + `<pane ${x ? `xSplit="${x}" ` : ''}${y ? `ySplit="${y}" ` : ''}topLeftCell="${topLeft}" activePane="${y ? (x ? 'bottomRight' : 'bottomLeft') : 'topRight'}" state="frozen"/>`
      + '</sheetView></sheetViews>');
  } else if (sheet.freezeHeader !== false) {
    parts.push('<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>');
  }
  parts.push('<sheetFormatPr defaultRowHeight="15"/>');

  if (sheet.colWidths && sheet.colWidths.length) {
    const px = sheet.colWidthUnit !== 'char'; // 默认按像素换算（兼容既有调用）
    const cols = sheet.colWidths
      .map((w, i) => {
        const v = px ? Math.round(w / 7) : w;
        const cs = sheet.colStyles && sheet.colStyles[i];
        const st = cs != null && styleMap && styleMap[cs] != null ? ` style="${styleMap[cs]}"` : '';
        return `<col min="${i + 1}" max="${i + 1}" width="${Math.min(80, Math.max(4, v))}" customWidth="1"${st}/>`;
      })
      .join('');
    parts.push(`<cols>${cols}</cols>`);
  }

  parts.push('<sheetData>');
  rows.forEach((row, r) => {
    const cells = [];
    (row || []).forEach((cell, c) => {
      let v = cell;
      let s = -1;
      if (cell && typeof cell === 'object' && !Array.isArray(cell) && ('v' in cell || 's' in cell)) {
        v = cell.v;
        s = typeof cell.s === 'number' ? cell.s : -1;
      }
      if (v === null || v === undefined) return;
      const ref = `${colName(c)}${r + 1}`;
      const st = s >= 0 && styleMap && styleMap[s] != null ? ` s="${styleMap[s]}"` : '';
      if (v === '' ) { if (st) cells.push(`<c r="${ref}"${st}/>`); return; }
      if (typeof v === 'number' && Number.isFinite(v)) {
        cells.push(`<c r="${ref}"${st}><v>${v}</v></c>`);
      } else {
        cells.push(`<c r="${ref}"${st} t="inlineStr"><is><t xml:space="preserve">${esc(clean(v))}</t></is></c>`);
      }
    });
    const h = sheet.rowHeights && sheet.rowHeights[r];
    const attr = h ? ` ht="${h}" customHeight="1"` : '';
    parts.push(`<row r="${r + 1}"${attr}>${cells.join('')}</row>`);
  });
  parts.push('</sheetData>');

  if (sheet.merges && sheet.merges.length) {
    parts.push(`<mergeCells count="${sheet.merges.length}">`
      + sheet.merges.map((m) => `<mergeCell ref="${m}"/>`).join('')
      + '</mergeCells>');
  }

  parts.push('</worksheet>');
  return parts.join('');
}

/**
 * @param {Array<{name:string, rows:Array<Array>, colWidths?:number[], merges?:string[], rowHeights?:number[], freeze?:{row:number,col:number}, styles?:Array}>} sheets
 */
function buildXlsx(sheets) {
  const list = Array.isArray(sheets) ? sheets : [sheets];
  const reg = createStyleRegistry();
  const entries = [];

  const contentTypes = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
  ];
  list.forEach((s, i) => {
    contentTypes.push(`<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`);
  });
  contentTypes.push('<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>');
  contentTypes.push('</Types>');
  entries.push({ name: '[Content_Types].xml', data: contentTypes.join('') });

  entries.push({
    name: '_rels/.rels',
    data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
      + '</Relationships>',
  });

  entries.push({
    name: 'xl/workbook.xml',
    data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
      + '<sheets>'
      + list.map((s, i) => `<sheet name="${esc(clean(s.name).slice(0, 31) || 'Sheet' + (i + 1))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')
      + '</sheets></workbook>',
  });

  const relId = list.length + 1;
  entries.push({
    name: 'xl/_rels/workbook.xml.rels',
    data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + list.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
      + `<Relationship Id="rId${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`
      + '</Relationships>',
  });

  // 先把各 sheet 的样式描述符注册到全局，得到下标映射
  list.forEach((s) => {
    s.__styleMap = (s.styles || []).map((d) => reg.xfId(d));
  });

  entries.push({ name: 'xl/styles.xml', data: reg.toXml() });

  list.forEach((s, i) => {
    entries.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s, s.__styleMap) });
  });

  return buildZip(entries);
}

function buildCsv(rows) {
  const out = [];
  for (const row of rows) {
    out.push((row || []).map((v) => {
      if (v === null || v === undefined) return '';
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(','));
  }
  // 带 BOM，避免 Excel 打开中文乱码
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(out.join('\r\n'), 'utf8')]);
}

module.exports = { buildXlsx, buildCsv, crc32, colName };

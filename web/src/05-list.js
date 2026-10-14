'use strict';
/* ============================================================
 *  list —— 资产台账（搜索 / 筛选 / 排序 / 分页 / 批量 / 列设置）
 *  列定义覆盖源表 37 个业务字段 + 地图标注 + 系统元数据
 * ============================================================ */

const ListState = {
  q: '', category: [], useStatus: [], hasTitle: [], unit: [],
  marked: '', areaMin: '', areaMax: '',
  sort: 'rowNo', order: 'asc',
  page: 1, pageSize: 20,
  total: 0, rows: [], selected: new Set(),
};

/* ------------------------------ 列定义 ------------------------------ */

const COL_GROUPS = [
  { k: 'basic', t: '基础信息' },
  { k: 'title', t: '产权信息' },
  { k: 'area', t: '面积与人员' },
  { k: 'value', t: '价值与年限' },
  { k: 'usage', t: '使用与处置' },
  { k: 'geo', t: '地图标注' },
  { k: 'sys', t: '系统信息' },
];

/** 单元格默认渲染 */
function defCell(a, c) {
  const v = a[c.k];
  if (v === null || v === undefined || v === '') return '<span class="muted">-</span>';
  if (c.type === 'number') {
    if (c.money) return '<span class="mono">' + fmt.moneyPlain(v) + '</span>';
    if (c.area) return '<span class="mono">' + fmt.area(v) + '</span>';
    return '<span class="mono">' + esc(fmt.n(v)) + '</span>';
  }
  if (c.type === 'date') return '<span class="nowrap">' + esc(fmt.date(v)) + '</span>';
  const s = String(v);
  return `<div class="ellip" style="max-width:${c.w - 18}px" title="${esc(s)}">${esc(s)}</div>`;
}

/** 枚举值着色标签 */
function tagCell(a, c, map) {
  const v = a[c.k];
  if (v === null || v === undefined || v === '') return '<span class="muted">-</span>';
  const s = String(v);
  const known = { 自用: 'g', 出租: 'c', 出借: 'c', 借用: 'c', 闲置: 'r', 已拆除: 'n', 办公用房: 'b', 住宅: 'g', 周转房: 'g', 车库: 'o', 其他用房: 'n', 土地: 'n', 有产权: 'g', 无产权: 'r', 是: 'o', 否: 'n' };
  const cls = (map && map[s]) || known[s] || 'n';
  return `<span class="tag ${cls}">${esc(s)}</span>`;
}

const COL_DEFS = [
  // ---------- 基础信息 ----------
  { k: 'rowNo', t: '行次', g: 'basic', w: 58, type: 'number', right: true, sort: 'rowNo', freeze: true },
  { k: 'name', t: '资产名称', g: 'basic', w: 250, sort: 'name', freeze: true, cell: (a) => `<div class="ellip link" style="max-width:238px;font-weight:500" data-act="view" data-id="${a.id}" title="${esc(a.name || '')}">${esc(a.name || '未命名资产')}</div>`
    + (a.sysName ? `<div class="muted" style="font-size:11px;max-width:238px" title="${esc(a.sysName)}">${esc(fmt.cut(a.sysName, 20))}</div>` : '') },
  { k: 'unit', t: '所属单位', g: 'basic', w: 180 },
  { k: 'sysName', t: '资产系统内名称', g: 'basic', w: 200 },
  { k: 'useUnit', t: '使用单位（使用人）', g: 'basic', w: 200 },
  { k: 'useStatus', t: '当前使用状态', g: 'basic', w: 100, type: 'enum', sort: 'useStatus', cell: (a) => tagCell(a, { k: 'useStatus' }) },
  { k: 'assetNo', t: '资产编号', g: 'basic', w: 110, mono: true },
  { k: 'category', t: '资产分类', g: 'basic', w: 92, type: 'enum', sort: 'category', cell: (a) => tagCell(a, { k: 'category' }) },
  { k: 'purpose', t: '资产用途', g: 'basic', w: 90 },
  { k: 'structure', t: '建筑结构', g: 'basic', w: 110, type: 'enum', sort: 'structure', cell: (a) => tagCell(a, { k: 'structure' }) },
  { k: 'location', t: '坐落位置', g: 'basic', w: 220 },

  // ---------- 产权信息 ----------
  { k: 'hasTitle', t: '是否有产权', g: 'title', w: 92, type: 'enum', sort: 'hasTitle', cell: (a) => tagCell(a, { k: 'hasTitle' }) },
  { k: 'titleType', t: '产权形式', g: 'title', w: 200 },
  { k: 'titleNo', t: '产权证号', g: 'title', w: 180, mono: true },
  { k: 'multiShareTitle', t: '多处共有同一证', g: 'title', w: 130, type: 'enum', cell: (a) => tagCell(a, { k: 'multiShareTitle' }) },
  { k: 'multiShareTitleNo', t: '共有产权证号', g: 'title', w: 160, mono: true },
  { k: 'splitTitle', t: '一处划分多证', g: 'title', w: 120, type: 'enum', cell: (a) => tagCell(a, { k: 'splitTitle' }) },
  { k: 'splitTitleNo', t: '分拆产权证号', g: 'title', w: 160, mono: true },

  // ---------- 面积与人员 ----------
  { k: 'area', t: '产权面积(㎡)', g: 'area', w: 104, type: 'number', area: true, right: true, sort: 'area' },
  { k: 'officeArea', t: '办公用房面积(㎡)', g: 'area', w: 128, type: 'number', area: true, right: true, sort: 'officeArea' },
  { k: 'perCapitaArea', t: '人均办公面积(㎡)', g: 'area', w: 128, type: 'number', area: true, right: true, sort: 'perCapitaArea' },
  { k: 'actualStaff', t: '实际人数', g: 'area', w: 88, type: 'number', right: true, sort: 'actualStaff' },
  { k: 'approvedStaff', t: '编制人数', g: 'area', w: 88, type: 'number', right: true, sort: 'approvedStaff' },
  { k: 'tempStaff', t: '临聘人数', g: 'area', w: 88, type: 'number', right: true, sort: 'tempStaff' },

  // ---------- 价值与年限 ----------
  { k: 'originalValue', t: '原值(元)', g: 'value', w: 130, type: 'number', money: true, right: true, sort: 'originalValue' },
  { k: 'useDate', t: '投入使用日期', g: 'value', w: 116, type: 'date', sort: 'useDate' },
  { k: 'acquireDate', t: '取得日期', g: 'value', w: 110, type: 'date', sort: 'acquireDate' },
  { k: 'age', t: '房龄(年)', g: 'value', w: 84, type: 'number', right: true, sort: 'age' },
  { k: 'overhauled', t: '是否大修', g: 'value', w: 84, type: 'enum', cell: (a) => tagCell(a, { k: 'overhauled' }) },
  { k: 'overhaulDate', t: '大修时间', g: 'value', w: 104 },
  { k: 'overhaulAmount', t: '大修金额(元)', g: 'value', w: 118, type: 'number', money: true, right: true, sort: 'overhaulAmount' },

  // ---------- 使用与处置 ----------
  { k: 'idleLong', t: '长期闲置', g: 'usage', w: 84, type: 'enum', cell: (a) => tagCell(a, { k: 'idleLong' }) },
  { k: 'idleStage', t: '阶段性闲置', g: 'usage', w: 96, type: 'enum', cell: (a) => tagCell(a, { k: 'idleStage' }) },
  { k: 'rentedOut', t: '出租出借', g: 'usage', w: 84, type: 'enum', cell: (a) => tagCell(a, { k: 'rentedOut' }) },
  { k: 'rentTerm', t: '出租出借期限', g: 'usage', w: 170 },
  { k: 'rentIncome', t: '出租收益(元)', g: 'usage', w: 118, type: 'number', money: true, right: true, sort: 'rentIncome' },
  { k: 'leasedIn', t: '租入借入', g: 'usage', w: 84, type: 'enum', cell: (a) => tagCell(a, { k: 'leasedIn' }) },
  { k: 'leaseTerm', t: '租入借入期限', g: 'usage', w: 160 },
  { k: 'leaseRent', t: '租入租金(元)', g: 'usage', w: 118, type: 'number', money: true, right: true, sort: 'leaseRent' },
  { k: 'remark', t: '备注', g: 'usage', w: 200 },

  // ---------- 地图标注 ----------
  { k: 'marked', t: '地图标注', g: 'geo', w: 88, cell: (a) => (Number.isFinite(a.lng) && Number.isFinite(a.lat)
    ? '<span class="tag g">已标注</span>' : '<span class="tag n">未标注</span>') },
  { k: 'geoAddress', t: '标注地址', g: 'geo', w: 200 },
  { k: 'lng', t: '经度', g: 'geo', w: 104, type: 'number', mono: true, right: true, cell: (a) => (Number.isFinite(a.lng) ? `<span class="mono">${a.lng.toFixed(6)}</span>` : '<span class="muted">-</span>') },
  { k: 'lat', t: '纬度', g: 'geo', w: 104, type: 'number', mono: true, right: true, cell: (a) => (Number.isFinite(a.lat) ? `<span class="mono">${a.lat.toFixed(6)}</span>` : '<span class="muted">-</span>') },
  { k: 'geoBy', t: '标注人', g: 'geo', w: 96 },
  { k: 'geoAt', t: '标注时间', g: 'geo', w: 110, cell: (a) => `<span class="nowrap muted">${esc(fmt.date(a.geoAt))}</span>` },

  // ---------- 系统信息 ----------
  { k: 'createdBy', t: '创建人', g: 'sys', w: 100 },
  { k: 'createdAt', t: '创建时间', g: 'sys', w: 110, cell: (a) => `<span class="nowrap muted">${esc(fmt.date(a.createdAt))}</span>` },
  { k: 'updatedBy', t: '更新人', g: 'sys', w: 100 },
  { k: 'updatedAt', t: '更新时间', g: 'sys', w: 110, sort: 'updatedAt', cell: (a) => `<span class="nowrap muted">${esc(fmt.rel(a.updatedAt))}</span>` },
];

const COL_MAP = new Map(COL_DEFS.map((c) => [c.k, c]));

/** 源表全部业务字段（不含地图/系统元数据） */
const SRC_KEYS = COL_DEFS.filter((c) => c.g !== 'geo' && c.g !== 'sys' || c.k === 'marked').map((c) => c.k);

/** 核心精简视图 */
const CORE_KEYS = ['rowNo', 'name', 'category', 'useStatus', 'useUnit', 'location', 'area', 'originalValue', 'marked', 'updatedAt'];

const ALL_KEYS = COL_DEFS.map((c) => c.k);

const LS_COLS = 'listCols';

function loadCols() {
  try {
    const v = JSON.parse(localStorage.getItem(LS_COLS) || 'null');
    if (Array.isArray(v) && v.length) return v.filter((k) => COL_MAP.has(k));
  } catch (e) { /* 忽略损坏的存储 */ }
  return SRC_KEYS.slice();
}

function saveCols(keys) {
  try { localStorage.setItem(LS_COLS, JSON.stringify(keys)); } catch (e) { /* 隐私模式下忽略 */ }
}

let VISIBLE_COLS = loadCols();

Pages.assets = {
  title: '资产台账',
  render(root) {
    VISIBLE_COLS = loadCols();
    const wrap = h('<div class="card"></div>');
    root.appendChild(wrap);
    buildToolbar(wrap);
    const bodyWrap = h('<div class="card-b tight"><div class="tbl-wrap lst"></div></div>');
    wrap.appendChild(bodyWrap);
    const pager = h('<div class="pager"></div>');
    wrap.appendChild(pager);
    load();

    async function load() {
      const tblWrap = $('.tbl-wrap', bodyWrap);
      tblWrap.innerHTML = '<div class="empty">加载中…</div>';
      // 全局单位（左侧单位树）与列表内「单位」筛选取交集
      let unitFilter = ListState.unit;
      if (Scope.unit) {
        // 全局单位按「含下级」口径，列表内单位筛选只要落在该子树内即保留
        const scope = new Set(Scope.subtreeNames(Scope.unit));
        unitFilter = ListState.unit.length ? ListState.unit.filter((u) => scope.has(u)) : [Scope.unit];
        if (!unitFilter.length) {           // 交集为空：不请求，直接显示空表
          ListState.total = 0;
          ListState.rows = [];
          renderTable(tblWrap);
          renderPager(pager);
          return;
        }
      }
      try {
        const r = await API.getQ('/api/assets', {
          q: ListState.q,
          category: ListState.category,
          useStatus: ListState.useStatus,
          hasTitle: ListState.hasTitle,
          unit: unitFilter,
          marked: ListState.marked,
          areaMin: ListState.areaMin,
          areaMax: ListState.areaMax,
          sort: ListState.sort,
          order: ListState.order,
          page: ListState.page,
          pageSize: ListState.pageSize,
        });
        ListState.total = r.total;
        ListState.rows = r.rows;
        renderTable(tblWrap);
        renderPager(pager);
      } catch (e) {
        tblWrap.innerHTML = `<div class="empty"><div class="ic">⚠</div><div>${esc(e.message)}</div></div>`;
      }
    }

    function renderTable(box) {
      clear(box);
      if (!ListState.rows.length) {
        box.appendChild(h('<div class="empty"><div class="ic">▤</div><div>没有符合条件的资产记录</div></div>'));
        return;
      }
      const cols = VISIBLE_COLS.map((k) => COL_MAP.get(k)).filter(Boolean);
      const ACT_W = 168;              // 操作列宽（冻结在右侧）
      const totalW = cols.reduce((s, c) => s + c.w, 0) + 34 + ACT_W;

      // 固定布局 + 精确宽度：列宽不再被拉伸，冻结列的 left 偏移才能严格对齐
      const tbl = h(`<table class="tbl fixed" style="width:${totalW}px"><thead><tr></tr></thead><tbody></tbody></table>`);
      const tr = $('thead tr', tbl);

      const allOn = ListState.rows.length && ListState.rows.every((r) => ListState.selected.has(r.id));
      tr.appendChild(h(`<th class="fx" style="left:0;width:34px"><input type="checkbox" id="ck-all" ${allOn ? 'checked' : ''}></th>`));

      // 最后一个冻结列需要分隔阴影
      let lastFx = -1;
      cols.forEach((c, i) => { if (c.freeze) lastFx = i; });

      // 冻结列左侧偏移：34(选择框) + 前面各列宽度
      let left = 34;
      cols.forEach((c, i) => {
        const isSort = c.sort && c.sort === ListState.sort;
        const th = h(`<th class="${c.sort ? 'sortable' : ''} ${c.right ? 'right' : ''} ${c.freeze ? 'fx' : ''} ${i === lastFx ? 'fx-last' : ''}" style="width:${c.w}px${c.freeze ? `;left:${left}px` : ''}">${esc(c.t)}${c.sort ? `<span class="arw">${isSort ? (ListState.order === 'asc' ? ' ▲' : ' ▼') : ' ⇅'}</span>` : ''}</th>`);
        if (c.sort) {
          on(th, 'click', () => {
            if (ListState.sort === c.sort) ListState.order = ListState.order === 'asc' ? 'desc' : 'asc';
            else { ListState.sort = c.sort; ListState.order = 'desc'; }
            load();
          });
        }
        tr.appendChild(th);
        left += c.w;
      });
      tr.appendChild(h(`<th class="fxr" style="width:${ACT_W}px">操作</th>`));

      const tb = $('tbody', tbl);
      ListState.rows.forEach((a, i) => {
        const tds = cols.map((c, i) => {
          const cls = [c.right ? 'right' : '', c.freeze ? 'fx' : '', c.mono ? 'mono' : '', i === lastFx ? 'fx-last' : ''].filter(Boolean).join(' ');
          const inner = c.cell ? c.cell(a) : defCell(a, c);
          return `<td class="${cls}" style="width:${c.w}px${c.freeze ? `;left:${leftOffset(cols, c)}px` : ''}">${inner}</td>`;
        }).join('');
        const row = h(`<tr class="${ListState.selected.has(a.id) ? 'sel' : ''}">
          <td class="fx" style="left:0"><input type="checkbox" class="ck" data-id="${a.id}" ${ListState.selected.has(a.id) ? 'checked' : ''}></td>
          ${tds}
          <td class="act fxr" style="width:${ACT_W}px">
            ${Session.canWriteAsset(a)
              ? `<span class="link" data-act="edit" data-id="${a.id}">编辑</span>`
              : `<span class="link" data-act="view" data-id="${a.id}">查看</span>`}
            <span class="link" data-act="map" data-id="${a.id}">定位</span>
            ${Session.can('delete') && Session.canWriteAsset(a) ? `<span class="link dg" data-act="del" data-id="${a.id}">删除</span>` : ''}
          </td>
        </tr>`);
        tb.appendChild(row);
      });
      box.appendChild(tbl);

      on($('#ck-all', box), 'change', (e) => {
        const on2 = e.target.checked;
        ListState.rows.forEach((r) => { if (on2) ListState.selected.add(r.id); else ListState.selected.delete(r.id); });
        renderTable(box);
        renderPager(pager);
      });
      $$('.ck', box).forEach((ck) => on(ck, 'change', (e) => {
        const id = ck.dataset.id;
        if (e.target.checked) ListState.selected.add(id); else ListState.selected.delete(id);
        renderPager(pager);
      }));
      $$('[data-act]', box).forEach((n) => on(n, 'click', () => {
        const id = n.dataset.id;
        const a = ListState.rows.find((x) => x.id === id);
        const act = n.dataset.act;
        if (act === 'view') AssetForm.view(a);
        else if (act === 'edit') AssetForm.edit(a, () => load());
        else if (act === 'map') { location.hash = '#/map'; setTimeout(() => MapPage.focus(id), 260); }
        else if (act === 'del') delOne(a, () => load());
      }));
    }

    function renderPager(box) {
      clear(box);
      const total = ListState.total;
      const pages = Math.max(1, Math.ceil(total / ListState.pageSize));
      const sel = ListState.selected.size;
      const from = total ? (ListState.page - 1) * ListState.pageSize + 1 : 0;
      const to = Math.min(total, ListState.page * ListState.pageSize);

      box.appendChild(h(`<div class="info">共 ${fmt.n(total)} 条，当前 ${from}-${to} 条${sel ? `，已选 ${sel} 条` : ''}</div>`));
      box.appendChild(h('<div class="spacer"></div>'));

      if (Session.can('export')) {
        const ex = h('<button class="btn sm">导出当前结果</button>');
        on(ex, 'click', () => downloadExport());
        box.appendChild(ex);
      }
      // 下级单位数据只读：只统计有写权限的选中条数
      const writableSel = ListState.rows.filter((r) => ListState.selected.has(r.id) && Session.canWriteAsset(r)).length;
      if (writableSel && Session.can('delete')) {
        const bd = h(`<button class="btn sm danger">批量删除 (${writableSel})</button>`);
        on(bd, 'click', async () => {
          if (!await confirmDlg(`确定删除选中的 <b>${writableSel}</b> 条资产记录吗？此操作不可恢复。`)) return;
          try {
            const r = await API.post('/api/assets/batch-delete', { ids: [...ListState.selected] });
            toast(`已删除 ${r.removed} 条${r.denied ? `，${r.denied} 条无权限` : ''}`, 'ok');
            ListState.selected.clear();
            load();
          } catch (e) { toast(e.message, 'err'); }
        });
        box.appendChild(bd);
      }

      const pb = h('<div style="display:flex;gap:6px;align-items:center"></div>');
      const mk = (t, p, dis) => {
        const b = h(`<button class="btn sm" ${dis ? 'disabled' : ''}>${t}</button>`);
        if (!dis) on(b, 'click', () => { ListState.page = p; load(); });
        pb.appendChild(b);
      };
      mk('首页', 1, ListState.page <= 1);
      mk('上一页', ListState.page - 1, ListState.page <= 1);
      pb.appendChild(h(`<span class="muted" style="padding:0 6px">${ListState.page} / ${pages}</span>`));
      mk('下一页', ListState.page + 1, ListState.page >= pages);
      mk('末页', pages, ListState.page >= pages);
      const sz = h('<select class="sel" style="width:88px"></select>');
      [20, 50, 100, 200].forEach((n) => sz.appendChild(h(`<option value="${n}" ${n === ListState.pageSize ? 'selected' : ''}>${n} 条/页</option>`)));
      on(sz, 'change', () => { ListState.pageSize = Number(sz.value); ListState.page = 1; load(); });
      pb.appendChild(sz);
      box.appendChild(pb);
    }

    async function downloadExport() {
      const p = new URLSearchParams();
      if (ListState.q) p.set('q', ListState.q);
      if (ListState.category.length) p.set('category', ListState.category.join(','));
      if (ListState.useStatus.length) p.set('useStatus', ListState.useStatus.join(','));
      if (ListState.hasTitle.length) p.set('hasTitle', ListState.hasTitle.join(','));
      // 与列表筛选取交集；交集为空则无可导出记录
      let unitParam = ListState.unit;
      if (Scope.unit) {
        unitParam = ListState.unit.length ? ListState.unit.filter((u) => u === Scope.unit) : [Scope.unit];
        if (!unitParam.length) { toast('当前筛选条件下没有可导出的记录', 'warn'); return; }
      }
      if (unitParam.length) p.set('unit', unitParam.join(','));
      if (ListState.marked) p.set('marked', ListState.marked);
      if (ListState.selected.size) p.set('ids', [...ListState.selected].join(','));
      else {
        if (ListState.areaMin) p.set('areaMin', ListState.areaMin);
        if (ListState.areaMax) p.set('areaMax', ListState.areaMax);
        p.set('sort', ListState.sort);
        p.set('order', ListState.order);
        p.set('pageSize', 'all');
      }
      try {
        await downloadAuth('/api/export?format=xlsx&' + p.toString(), `房屋土地台账-${new Date().toISOString().slice(0, 10)}.xlsx`);
        toast('已导出 Excel', 'ok');
      } catch (e) { toast(e.message, 'err'); }
    }
  },
};

/** 冻结列的左偏移：34(选择框) + 之前所有列宽度之和 */
function leftOffset(cols, target) {
  let x = 34;
  for (const c of cols) {
    if (c === target) return x;
    x += c.w;
  }
  return x;
}

/* ------------------------------ 工具栏 ------------------------------ */

function buildToolbar(wrap) {
  const tb = h('<div class="toolbar"></div>');
  wrap.appendChild(tb);

  const search = h(`<div class="search"><span class="si">⌕</span><input class="inp" placeholder="搜索名称/编号/坐落/证号/单位"></div>`);
  const si = $('.inp', search);
  si.value = ListState.q;
  let timer;
  on(si, 'input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => { ListState.q = si.value.trim(); ListState.page = 1; reloadList(wrap); }, 260);
  });
  tb.appendChild(search);

  const mkSel = (label, key, opts, multi) => {
    const box = h(`<div style="display:flex;align-items:center;gap:5px"><span class="muted" style="font-size:12px">${label}</span></div>`);
    const sel = h('<select class="sel w"></select>');
    sel.appendChild(h(`<option value="">全部</option>`));
    opts.forEach((o) => sel.appendChild(h(`<option value="${esc(o)}">${esc(o)}</option>`)));
    const cur = ListState[key];
    sel.value = Array.isArray(cur) ? (cur[0] || '') : (cur || '');
    on(sel, 'change', () => {
      ListState[key] = multi ? (sel.value ? [sel.value] : []) : sel.value;
      ListState.page = 1;
      reloadList(wrap);
    });
    box.appendChild(sel);
    tb.appendChild(box);
    return sel;
  };

  const opts = Session.options || {};
  const F = (k) => (opts.fields || []).find((x) => x.key === k);
  mkSel('分类', 'category', (F('category') || {}).options || []);
  mkSel('状态', 'useStatus', (F('useStatus') || {}).options || []);
  mkSel('产权', 'hasTitle', (F('hasTitle') || {}).options || []);
  // 已通过左侧单位树限定单位时，工具栏不再重复提供单位筛选
  if (!Scope.unit) mkSel('单位', 'unit', (opts.units || []));
  else ListState.unit = [];

  const mk = h('<select class="sel w2"></select>');
  mk.appendChild(h('<option value="">全部</option>'));
  mk.appendChild(h('<option value="yes">已标注</option>'));
  mk.appendChild(h('<option value="no">未标注</option>'));
  mk.value = ListState.marked;
  on(mk, 'change', () => { ListState.marked = mk.value; ListState.page = 1; reloadList(wrap); });
  const mkBox = h('<div style="display:flex;align-items:center;gap:5px"><span class="muted" style="font-size:12px">标注</span></div>');
  mkBox.appendChild(mk);
  tb.appendChild(mkBox);

  tb.appendChild(h('<div class="spacer"></div>'));

  // 列设置
  const colBtn = h(`<button class="btn">列设置 ${VISIBLE_COLS.length}/${ALL_KEYS.length}</button>`);
  on(colBtn, 'click', () => openColPicker(wrap));
  tb.appendChild(colBtn);

  if (Session.can('write')) {
    const add = h('<button class="btn pri">＋ 新增资产</button>');
    on(add, 'click', () => AssetForm.create(() => reloadList(wrap)));
    tb.appendChild(add);
  }
  const rst = h('<button class="btn">重置筛选</button>');
  on(rst, 'click', () => {
    Object.assign(ListState, { q: '', category: [], useStatus: [], hasTitle: [], unit: [], marked: '', areaMin: '', areaMax: '', page: 1, sort: 'rowNo', order: 'asc' });
    ListState.selected.clear();
    Pages.assets.render(wrap.closest('.content') || wrap.parentNode);
  });
  tb.appendChild(rst);
}

/* ------------------------------ 列设置弹窗 ------------------------------ */

function openColPicker(wrap) {
  const draft = new Set(VISIBLE_COLS);
  const root = h('<div class="colpick"></div>');

  const bar = h(`<div class="bar">
    <input class="inp" id="cp-q" placeholder="搜索字段名" style="width:180px">
    <div class="spacer" style="flex:1"></div>
    <button class="btn sm" data-p="core">核心视图</button>
    <button class="btn sm" data-p="src">源表全字段</button>
    <button class="btn sm" data-p="all">全部字段</button>
    <button class="btn sm" data-p="none">清空</button>
    <span class="muted" id="cp-n" style="font-size:12px"></span>
  </div>`);
  root.appendChild(bar);

  const grid = h('<div class="grp-wrap"></div>');
  root.appendChild(grid);

  const boxes = [];
  COL_GROUPS.forEach((g) => {
    const items = COL_DEFS.filter((c) => c.g === g.k);
    if (!items.length) return;
    const sec = h(`<div class="grp" data-g="${g.k}">
      <div class="grp-h"><span>${esc(g.t)}</span><span class="muted" style="font-weight:400">${items.length} 项</span>
        <span class="link" data-all="${g.k}" style="font-weight:400;margin-left:4px">全选</span>
        <span class="link" data-none="${g.k}" style="font-weight:400">清空</span>
      </div>
      <div class="ci-wrap"></div>
    </div>`);
    const cw = $('.ci-wrap', sec);
    items.forEach((c) => {
      const lb = h(`<label class="ci" title="${esc(c.t)}"><input type="checkbox" data-k="${c.k}" ${draft.has(c.k) ? 'checked' : ''}><span>${esc(c.t)}</span></label>`);
      const ck = $('input', lb);
      on(ck, 'change', () => { if (ck.checked) draft.add(c.k); else draft.delete(c.k); updateN(); });
      boxes.push({ el: lb, ck, c });
      cw.appendChild(lb);
    });
    grid.appendChild(sec);
  });

  const nEl = $('#cp-n', bar);
  function updateN() { nEl.textContent = `已选 ${draft.size} 列`; }
  updateN();

  on($('#cp-q', bar), 'input', (e) => {
    const kw = String(e.target.value || '').trim().toLowerCase();
    boxes.forEach(({ el, c }) => {
      el.style.display = (!kw || c.t.toLowerCase().includes(kw) || c.k.toLowerCase().includes(kw)) ? '' : 'none';
    });
    $$('.grp', grid).forEach((g) => {
      const vis = $$('.ci', g).some((x) => x.style.display !== 'none');
      g.style.display = vis ? '' : 'none';
    });
  });

  $$('[data-p]', bar).forEach((b) => on(b, 'click', () => {
    const p = b.dataset.p;
    let keys = [];
    if (p === 'core') keys = CORE_KEYS.slice();
    else if (p === 'src') keys = SRC_KEYS.slice();
    else if (p === 'all') keys = ALL_KEYS.slice();
    draft.clear();
    keys.forEach((k) => draft.add(k));
    boxes.forEach(({ ck, c }) => { ck.checked = draft.has(c.k); });
    updateN();
  }));

  $$('[data-all]', grid).forEach((b) => on(b, 'click', () => {
    COL_DEFS.filter((c) => c.g === b.dataset.all).forEach((c) => { draft.add(c.k); });
    boxes.forEach(({ ck, c }) => { ck.checked = draft.has(c.k); });
    updateN();
  }));
  $$('[data-none]', grid).forEach((b) => on(b, 'click', () => {
    const gk = b.dataset.none;
    const keep = ['name'];
    COL_DEFS.filter((c) => c.g === gk && keep.indexOf(c.k) < 0).forEach((c) => draft.delete(c.k));
    boxes.forEach(({ ck, c }) => { ck.checked = draft.has(c.k); });
    updateN();
  }));

  modal({
    title: '列设置',
    size: 'wide',
    bodyNode: root,
    buttons: [
      { text: '取消' },
      {
        text: '应用',
        cls: 'pri',
        onClick: (c) => {
          const keys = ALL_KEYS.filter((k) => draft.has(k));
          if (!keys.length) { toast('至少保留一列', 'err'); return; }
          saveCols(keys);
          VISIBLE_COLS = keys;
          reloadList(wrap);
          c();
        },
      },
    ],
  });
}

function reloadList(wrap) {
  const content = wrap.closest('.content');
  if (content) { clear(content); Pages.assets.render(content); }
}

async function delOne(a, done) {
  if (!await confirmDlg(`确定删除资产 <b>${esc(a.name || a.id)}</b> 吗？此操作不可恢复。`)) return;
  try {
    await API.del('/api/assets/' + a.id);
    toast('已删除', 'ok');
    done && done();
  } catch (e) { toast(e.message, 'err'); }
}

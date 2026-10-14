'use strict';
/* ============================================================
 *  admin —— 用户管理 / 单位管理 / 操作日志
 * ============================================================ */

function guard(root, perm) {
  if (Session.can(perm)) return false;
  root.appendChild(h('<div class="empty"><div class="ic">⛔</div><div>当前角色无权访问此页面</div></div>'));
  return true;
}

/* ------------------------------ 单位 ↔ 用户 通用工具 ------------------------------ */

/** 当前用户是否有权管理目标用户：系统管理员全部；其余仅本单位及下级单位的非管理员账号 */
function canManageUser(u) {
  if (Session.isSysAdmin()) return true;
  if (!u || u.role === 'admin') return false;
  if (!Session.myUnit()) return true;
  return Scope.units.indexOf(u.unit || '') >= 0;
}

/** 可分配的单位（系统管理员可留空 = 全部单位；其余为本单位及下级），带层级缩进 */
function unitOptions(selected, allowEmpty) {
  const out = [];
  if (allowEmpty) {
    out.push(`<option value="" ${!selected ? 'selected' : ''}>（全部单位 · 仅系统管理员）</option>`);
  }
  const walk = (arr, depth) => (arr || []).forEach((n) => {
    const pad = depth ? '　'.repeat(depth) + '└ ' : '';
    out.push(`<option value="${esc(n.name)}" ${n.name === selected ? 'selected' : ''}>${pad}${esc(n.name)}</option>`);
    walk(n.children || [], depth + 1);
  });
  walk(Scope.tree, 0);
  if (!out.length) out.push('<option value="">（暂无可选单位）</option>');
  return out.join('');
}

/* ------------------------------ 用户管理 ------------------------------ */

Pages.users = {
  title: '用户管理',
  render(root) {
    if (guard(root, 'user')) return;
    const wrap = h('<div class="card"><div class="card-h"><h3>系统用户</h3><div class="spacer"></div><div class="acts"></div></div><div class="card-b tight"><div class="tbl-wrap"></div></div></div>');
    root.appendChild(wrap);
    const box = $('.tbl-wrap', wrap);

    const add = h('<button class="btn pri sm">＋ 新增用户</button>');
    on(add, 'click', () => editUser(null, load));
    $('.acts', wrap).appendChild(add);

    async function load() {
      box.innerHTML = '<div class="empty">加载中…</div>';
      try {
        const r = await API.get('/api/users');
        render(r.rows, r.roles);
      } catch (e) {
        box.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
      }
    }

    function render(rows, roles) {
      clear(box);
      const tbl = h(`<table class="tbl"><thead><tr>
        <th>用户名</th><th>姓名</th><th>角色</th><th>所属单位</th><th>数据范围</th><th>最后登录</th><th>状态</th><th class="right">操作</th>
      </tr></thead><tbody></tbody></table>`);
      const tb = $('tbody', tbl);
      rows.forEach((u) => {
        const sys = u.role === 'admin';
        const scopeTxt = sys ? '全部单位' : (u.unit ? `本单位 + 下级（下级只读）` : '未绑定（全部单位）');
        tb.appendChild(h(`<tr>
          <td class="mono">${esc(u.username)}</td>
          <td>${esc(u.name)}</td>
          <td><span class="tag ${sys ? 'b' : u.role === 'unitadmin' ? 'c' : u.role === 'editor' ? 'g' : 'n'}">${esc(u.roleLabel || u.role)}</span></td>
          <td>${esc(u.unit || '-')}</td>
          <td class="muted">${esc(scopeTxt)}</td>
          <td class="muted">${esc(u.lastLoginAt ? fmt.rel(u.lastLoginAt) : '从未登录')}</td>
          <td>${u.disabled ? '<span class="tag r">已停用</span>' : '<span class="tag g">正常</span>'}</td>
          <td class="right act">
            ${canManageUser(u) ? `<span class="link" data-e="${u.id}">编辑</span>` : '<span class="muted">无权管理</span>'}
            ${canManageUser(u) ? `<span class="link" data-p="${u.id}">重置密码</span>` : ''}
            ${canManageUser(u) && u.id !== Session.user.id ? `<span class="link ${u.disabled ? '' : 'dg'}" data-d="${u.id}">${u.disabled ? '启用' : '停用'}</span>` : ''}
            ${canManageUser(u) && u.id !== Session.user.id ? `<span class="link dg" data-x="${u.id}">删除</span>` : ''}
          </td>
        </tr>`));
      });
      box.appendChild(tbl);
      $$('[data-e]', box).forEach((n) => on(n, 'click', () => editUser(rows.find((x) => x.id === n.dataset.e), load)));
      $$('[data-p]', box).forEach((n) => on(n, 'click', () => resetPwd(rows.find((x) => x.id === n.dataset.p))));
      $$('[data-d]', box).forEach((n) => on(n, 'click', async () => {
        const u = rows.find((x) => x.id === n.dataset.d);
        try { await API.put('/api/users/' + u.id, { disabled: !u.disabled }); toast('已更新状态', 'ok'); load(); }
        catch (e) { toast(e.message, 'err'); }
      }));
      $$('[data-x]', box).forEach((n) => on(n, 'click', async () => {
        const u = rows.find((x) => x.id === n.dataset.x);
        if (!await confirmDlg(`确定删除用户 <b>${esc(u.username)}</b> 吗？`)) return;
        try { await API.del('/api/users/' + u.id); toast('已删除', 'ok'); load(); }
        catch (e) { toast(e.message, 'err'); }
      }));
    }
    load();
  },
};

function editUser(u, done) {
  const isNew = !u;
  const roles = (Session.options && Session.options.roles) || {};
  const sysOnly = (Session.options && Session.options.systemOnlyRoles) || ['admin'];
  const isSys = Session.isSysAdmin();
  // 非系统管理员不能授予 / 变更系统管理员角色
  const roleKeys = Object.keys(roles).filter((k) => isSys || sysOnly.indexOf(k) < 0);
  const allowEmpty = isSys && (isNew || u.role === 'admin');
  modal({
    title: isNew ? '新增用户' : '编辑用户：' + u.username,
    body: `
      <div class="field"><label>用户名</label><input class="inp" id="eu-u" value="${esc(u ? u.username : '')}" ${isNew ? '' : 'disabled'}></div>
      <div class="field"><label>姓名</label><input class="inp" id="eu-n" value="${esc(u ? u.name : '')}"></div>
      <div class="field"><label>角色</label><select class="sel" id="eu-r">
        ${roleKeys.map((k) => `<option value="${k}" ${u && u.role === k ? 'selected' : ''}>${esc(roles[k].label)}</option>`).join('')}
      </select>
        <div class="muted" style="font-size:11.5px;margin-top:4px" id="eu-rt"></div>
      </div>
      <div class="field"><label>所属单位（决定可见范围：本单位可改，下级单位只读）</label>
        <select class="sel" id="eu-t">${unitOptions(u ? (u.unit || '') : Session.myUnit(), allowEmpty)}</select>
      </div>
      <div class="field"><label>${isNew ? '初始密码' : '重置密码（留空不修改）'}</label><input class="inp" id="eu-p" type="text" value="${isNew ? '123456' : ''}"></div>
      <div class="err" style="color:var(--danger);font-size:12px;min-height:16px" id="eu-err"></div>`,
    buttons: [
      { text: '取消' },
      {
        text: '保存', cls: 'pri', onClick: async (close) => {
          const data = { name: $('#eu-n').value.trim(), role: $('#eu-r').value, unit: $('#eu-t').value };
          if (isNew) { data.username = $('#eu-u').value.trim(); data.password = $('#eu-p').value.trim(); }
          else if ($('#eu-p').value.trim()) data.password = $('#eu-p').value.trim();
          try {
            if (isNew) await API.post('/api/users', data);
            else await API.put('/api/users/' + u.id, data);
            toast('已保存', 'ok'); close(); done && done();
          } catch (e) { $('#eu-err').textContent = e.message; }
        },
      },
    ],
  });
  const syncRoleTip = () => {
    const r = $('#eu-r').value;
    const el = $('#eu-rt');
    if (!el) return;
    el.textContent = r === 'admin'
      ? '系统管理员：可见并可修改全部单位数据，可管理用户与单位层级。'
      : '单位管理员 / 普通用户：本单位可查看修改，下级单位仅可查看（只读）。';
  };
  on($('#eu-r'), 'change', syncRoleTip);
  syncRoleTip();
}

function resetPwd(u) {
  modal({
    title: '重置密码：' + u.username,
    body: `<div class="field"><label>新密码（至少 6 位）</label><input class="inp" id="rp-p" value="123456"></div>
      <div class="err" style="color:var(--danger);font-size:12px;min-height:16px" id="rp-err"></div>`,
    buttons: [
      { text: '取消' },
      {
        text: '确定', cls: 'pri', onClick: async (close) => {
          const p = $('#rp-p').value.trim();
          if (p.length < 6) { $('#rp-err').textContent = '密码至少 6 位'; return; }
          try {
            await API.put('/api/users/' + u.id, { password: p });
            toast('密码已重置', 'ok'); close();
          } catch (e) { $('#rp-err').textContent = e.message; }
        },
      },
    ],
  });
}

/* ------------------------------ 单位管理 ------------------------------ */

Pages.units = {
  title: '单位管理',
  render(root) {
    if (guard(root, 'unit')) return;
    const wrap = h('<div class="card"><div class="card-h"><h3>单位层级（上级 / 下级）</h3><div class="spacer"></div><div class="acts"></div></div><div class="card-b tight"><div class="tbl-wrap"></div></div></div>');
    root.appendChild(wrap);
    const box = $('.tbl-wrap', wrap);
    let rows = [];

    const add = h('<button class="btn pri sm">＋ 新增单位</button>');
    on(add, 'click', () => editUnit(null, rows, load));
    $('.acts', wrap).appendChild(add);

    async function load() {
      box.innerHTML = '<div class="empty">加载中…</div>';
      try {
        const us = await API.get('/api/units');
        rows = us.rows || [];
        render(rows);
        // 单位有增删 / 层级变动时同步左侧单位树
        await Scope.refresh();
        if (Scope.unit && Scope.units.indexOf(Scope.unit) < 0) Scope.set('');
        else renderUnitTree();
      } catch (e) { box.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
    }

    /** 由扁平行构建「本单位 + 全部下级」的合计条数 */
    function subtreeCount(list) {
      const kids = new Map();
      list.forEach((u) => {
        const p = u.parent || '';
        if (!kids.has(p)) kids.set(p, []);
        kids.get(p).push(u);
      });
      const total = {};
      const walk = (u) => {
        let s = u.assetCount || 0;
        (kids.get(u.id) || []).forEach((c) => { s += walk(c); });
        total[u.id] = s;
        return s;
      };
      list.filter((u) => !u.parent).forEach(walk);
      list.forEach((u) => { if (total[u.id] === undefined) total[u.id] = u.assetCount || 0; });
      return total;
    }

    function render(list) {
      clear(box);
      if (!list.length) { box.appendChild(h('<div class="empty"><div class="ic">⚑</div><div>尚未登记任何单位</div></div>')); return; }
      const sums = subtreeCount(list);
      const byId = {};
      list.forEach((u) => { byId[u.id] = u; });
      // 按层级排序输出：父在前、子紧随其后
      const ordered = [];
      const walk = (parentId, depth) => list.filter((u) => (u.parent || '') === parentId)
        .sort((a, b) => (a.sort || 0) - (b.sort || 0) || String(a.name).localeCompare(String(b.name), 'zh-CN'))
        .forEach((u) => { ordered.push({ u, depth }); walk(u.id, depth + 1); });
      walk('', 0);

      const tbl = h(`<table class="tbl"><thead><tr><th style="width:52px">序</th><th>单位名称</th><th>上级单位</th><th>代码</th>
        <th class="right">本单位</th><th class="right">含下级</th><th class="right">操作</th></tr></thead><tbody></tbody></table>`);
      const tb = $('tbody', tbl);
      ordered.forEach(({ u, depth }, i) => {
        const hasKid = list.some((x) => x.parent === u.id);
        tb.appendChild(h(`<tr>
          <td class="muted mono">${i + 1}</td>
          <td style="padding-left:${10 + depth * 16}px">${depth ? '<span class="muted">└ </span>' : ''}${esc(u.name)}${hasKid ? ' <span class="tag n">上级</span>' : ''}</td>
          <td class="muted">${esc(u.parentName || '—（顶级单位）')}</td>
          <td class="muted mono">${esc(u.code || '-')}</td>
          <td class="right mono">${fmt.n(u.assetCount || 0)}</td>
          <td class="right mono">${fmt.n(sums[u.id] || 0)}</td>
          <td class="right">
            <span class="link" data-e="${u.id}">编辑</span>
            <span class="link dg" data-x="${u.id}">删除</span>
          </td>
        </tr>`));
      });
      box.appendChild(tbl);

      $$('[data-e]', box).forEach((n) => on(n, 'click', () => editUnit(list.find((x) => x.id === n.dataset.e), list, load)));
      $$('[data-x]', box).forEach((n) => on(n, 'click', async () => {
        const u = list.find((x) => x.id === n.dataset.x);
        if (!await confirmDlg(`确定删除单位 <b>${esc(u.name)}</b> 吗？`)) return;
        try { await API.del('/api/units/' + u.id); toast('已删除', 'ok'); await Session.loadOptions(true); load(); }
        catch (e) { toast(e.message, 'err'); }
      }));
    }
    load();
  },
};

/** 新增 / 编辑单位（含上级单位层级） */
function editUnit(u, allRows, done) {
  const isNew = !u;
  // 上级候选排除自己及其所有下级，避免把上级设成自己的下级（成环）
  const banned = new Set();
  if (u) {
    banned.add(u.id);
    const collect = (id) => (allRows || []).filter((x) => x.parent === id).forEach((c) => { banned.add(c.id); collect(c.id); });
    collect(u.id);
  }
  const opts = (allRows || []).filter((x) => !banned.has(x.id))
    .sort((a, b) => (a.sort || 0) - (b.sort || 0) || String(a.name).localeCompare(String(b.name), 'zh-CN'))
    .map((x) => `<option value="${esc(x.id)}" ${u && u.parent === x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('');

  modal({
    title: isNew ? '新增单位' : '编辑单位：' + u.name,
    body: `<div class="field"><label>单位全称</label><input class="inp" id="nu-n" value="${esc(u ? u.name : '')}" placeholder="例如：国家税务总局重庆市江北区税务局"></div>
           <div class="field"><label>上级单位（留空则为顶级单位）</label>
             <select class="sel" id="nu-p"><option value="">— 顶级单位 —</option>${opts}</select>
             <div class="muted" style="font-size:11.5px;margin-top:4px">上级单位的用户可查看本单位（下级）数据，但不能修改。</div>
           </div>
           <div class="field"><label>单位代码（可选）</label><input class="inp" id="nu-c" value="${esc(u ? (u.code || '') : '')}"></div>
           <div class="err" style="color:var(--danger);font-size:12px;min-height:16px" id="nu-err"></div>`,
    buttons: [
      { text: '取消' },
      {
        text: '保存', cls: 'pri', onClick: async (close) => {
          try {
            const data = { name: $('#nu-n').value.trim(), code: $('#nu-c').value.trim(), parent: $('#nu-p').value };
            if (isNew) await API.post('/api/units', data);
            else await API.put('/api/units/' + u.id, data);
            toast('已保存', 'ok'); close(); await Session.loadOptions(true); done && done();
          } catch (e) { $('#nu-err').textContent = e.message; }
        },
      },
    ],
  });
}

/* ------------------------------ 操作日志 ------------------------------ */

Pages.logs = {
  title: '操作日志',
  render(root) {
    if (guard(root, 'user')) return;
    const wrap = h(`<div class="card"><div class="card-h"><h3>操作日志</h3><div class="spacer"></div>
      <input class="inp" id="lg-q" placeholder="搜索操作/对象/用户" style="width:220px"></div>
      <div class="card-b tight"><div class="tbl-wrap" style="max-height:calc(100vh - 190px);overflow:auto"></div></div></div>`);
    root.appendChild(wrap);
    const box = $('.tbl-wrap', wrap);
    let rows = [];

    async function load() {
      box.innerHTML = '<div class="empty">加载中…</div>';
      try {
        const r = await API.get('/api/logs');
        rows = r.rows;
        render();
      } catch (e) { box.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
    }

    function render() {
      const q = ($('#lg-q').value || '').trim().toLowerCase();
      const list = q ? rows.filter((r) => (r.user + r.action + r.target + r.detail).toLowerCase().includes(q)) : rows;
      clear(box);
      if (!list.length) { box.appendChild(h('<div class="empty">没有匹配的日志</div>')); return; }
      const tbl = h(`<table class="tbl"><thead><tr>
        <th style="width:150px">时间</th><th style="width:110px">操作人</th><th style="width:110px">动作</th>
        <th style="width:220px">对象</th><th>详情</th></tr></thead><tbody></tbody></table>`);
      const tb = $('tbody', tbl);
      list.forEach((r) => {
        const color = /删除|清空/.test(r.action) ? 'r' : /导入|新增/.test(r.action) ? 'b' : /修改|标注/.test(r.action) ? 'c' : 'n';
        tb.appendChild(h(`<tr>
          <td class="muted mono">${esc(r.ts ? r.ts.slice(0, 19).replace('T', ' ') : '')}</td>
          <td>${esc(r.user)}</td>
          <td><span class="tag ${color}">${esc(r.action)}</span></td>
          <td class="ellip" style="max-width:220px">${esc(r.target)}</td>
          <td class="muted">${esc(r.detail)}</td>
        </tr>`));
      });
      box.appendChild(tbl);
    }
    let t;
    on($('#lg-q', wrap), 'input', () => { clearTimeout(t); t = setTimeout(render, 200); });
    load();
  },
};

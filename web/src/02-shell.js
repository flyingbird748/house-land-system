'use strict';
/* ============================================================
 *  shell —— 登录页 / 主框架 / 侧边导航 / 路由
 * ============================================================ */

const Pages = {};

/** 当前渲染的页面 key，用于切换/登出时通知上一页做清理（如销毁地图实例） */
let curPageKey = null;

function leavePage(key) {
  if (!key || !Pages[key] || typeof Pages[key].leave !== 'function') return;
  try { Pages[key].leave(); } catch (e) { console.error(e); }
}

const NAV = [
  { g: '数据应用', items: [
    { k: 'report', t: '分析报告', ic: '✎' },
    { k: 'dashboard', t: '数据看板', ic: '◱' },
    { k: 'assets', t: '资产台账', ic: '▤' },
    { k: 'preview', t: '房产预览', ic: '⌂' },
    { k: 'map', t: '地图标注', ic: '⊕' },
  ] },
  { g: '数据维护', items: [
    { k: 'import', t: 'Excel 导入', ic: '⇪', perm: 'import' },
  ] },
  { g: '系统管理', items: [
    { k: 'users', t: '用户管理', ic: '☺', perm: 'user' },
    { k: 'units', t: '单位管理', ic: '⚑', perm: 'unit' },
    { k: 'logs', t: '操作日志', ic: '≡', perm: 'user' },
    { k: 'settings', t: '系统设置', ic: '⚙', sysAdmin: true },
  ] },
];

function navVisible(item) {
  if (item.sysAdmin && !Session.isSysAdmin()) return false;
  return !item.perm || Session.can(item.perm);
}

/* ------------------------------ 登录 ------------------------------ */

function renderLogin(msg) {
  leavePage(curPageKey);
  curPageKey = null;
  clear($('#app'));
  $('#app').appendChild(h(`
    <div class="login-wrap">
      <div class="login-card">
        <div class="lg">
          <div class="logo">房</div>
          <div>
            <h1>房屋土地信息系统</h1>
            <div class="sub" style="margin:0">各单位房屋土地资产台账一体化管理平台</div>
          </div>
        </div>
        <div style="height:16px"></div>
        <div class="field">
          <label>用户名</label>
          <input class="inp" id="lg-u" autocomplete="username" placeholder="请输入用户名">
        </div>
        <div class="field">
          <label>密码</label>
          <input class="inp" id="lg-p" type="password" autocomplete="current-password" placeholder="请输入密码">
        </div>
        <div class="err" id="lg-err">${esc(msg || '')}</div>
        <button class="btn pri lg" id="lg-btn" style="width:100%;justify-content:center">登 录</button>
        <div class="tip">
          <b>初始账号</b><br>
          系统管理员 admin / admin123 —— 可见并管理<b>全部单位</b><br>
          <span style="color:var(--text-3)">系统初始不含单位与资产数据：登录后先到「系统设置 → 单位管理」建立单位，
          再录入资产、按需新建用户；地图功能需到「系统设置 → 地图服务」填写服务商 Key。</span>
        </div>
      </div>
    </div>
  `));

  const u = $('#lg-u'), p = $('#lg-p');
  const submit = async () => {
    const btn = $('#lg-btn');
    btn.disabled = true;
    btn.textContent = '登录中…';
    try {
      const r = await API.post('/api/auth/login', { username: u.value.trim(), password: p.value });
      Session.save(r.token, r.user);
      await Session.loadOptions(true);
      location.hash = '#/report';
      boot();
    } catch (e) {
      btn.disabled = false;
      btn.textContent = '登 录';
      $('#lg-err').textContent = e.message;
      p.select();
    }
  };
  on($('#lg-btn'), 'click', submit);
  [u, p].forEach((x) => on(x, 'keydown', (e) => { if (e.key === 'Enter') submit(); }));
  setTimeout(() => (u.value ? p : u).focus(), 60);
}

/* ------------------------------ 主框架 ------------------------------ */

function renderApp() {
  const me = Session.user || {};
  leavePage(curPageKey); // 重建主框架时旧页面 DOM 已移除，同步释放其资源
  curPageKey = null;
  clear($('#app'));
  $('#app').appendChild(h(`
    <div class="layout">
      <aside class="sidebar">
        <div class="brand">
          <div class="logo">房</div>
          <div>
            <div class="t">房屋土地信息系统</div>
            <div class="s">House & Land Info System</div>
          </div>
        </div>
        <div class="utree" id="utree"></div>
        <nav class="nav" id="nav"></nav>
        <div class="foot">
          <div id="srv">服务 ${esc(API.base || '同源')}</div>
        </div>
      </aside>
      <div class="main">
        <header class="topbar">
          <button class="icon-btn" id="nav-toggle" title="打开菜单" aria-label="打开菜单">☰</button>
          <div class="title" id="pg-title">数据看板</div>
          <div class="crumb" id="pg-crumb"></div>
          <div class="spacer"></div>
          <div class="user-menu" id="um">
            <div class="user-btn" id="um-btn">
              <div class="avatar">${esc((me.name || 'U').slice(0, 1))}</div>
              <div>
                <div class="nm">${esc(me.name || '')}</div>
                <div class="rl">${esc(me.roleLabel || '')}${me.unit ? ' · ' + esc(me.unit) : ''}</div>
              </div>
              <div style="color:#8b93a7">▾</div>
            </div>
            <div class="dropdown" id="um-dd">
              <div class="item" id="mi-pwd">修改密码</div>
              <div class="item" id="mi-api">后端地址设置</div>
              <div class="sep"></div>
              <div class="item" id="mi-out" style="color:var(--danger)">退出登录</div>
            </div>
          </div>
        </header>
        <div class="content" id="content"></div>
      </div>
      <div class="nav-mask" id="nav-mask"></div>
    </div>
  `));

  /* 移动端抽屉侧栏：汉堡开关 + 遮罩 + 切页/退出时收起 */
  on($('#nav-toggle'), 'click', () => document.body.classList.toggle('nav-open'));
  on($('#nav-mask'), 'click', () => document.body.classList.remove('nav-open'));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') document.body.classList.remove('nav-open');
  });

  renderNav();
  renderUnitTree();

  const dd = $('#um-dd');
  on($('#um-btn'), 'click', (e) => { e.stopPropagation(); dd.classList.toggle('on'); });
  // 退出登录后该监听器仍在，#um 可能已被移除，需先判空
  on(document, 'click', (e) => { const um = $('#um'); if (!um || !um.contains(e.target)) dd.classList.remove('on'); });
  on($('#mi-out'), 'click', async () => {
    try { await API.post('/api/auth/logout'); } catch (e) { /* 忽略 */ }
    Session.clear();
    Scope.reset();
    document.body.classList.remove('nav-open');
    renderLogin();
  });
  on($('#mi-pwd'), 'click', () => { dd.classList.remove('on'); changePassword(); });
  on($('#mi-api'), 'click', () => { dd.classList.remove('on'); setApiBase(); });
}

function renderNav() {
  const nav = $('#nav');
  if (!nav) return;
  clear(nav);
  NAV.forEach((grp) => {
    const items = grp.items.filter(navVisible);
    if (!items.length) return;
    nav.appendChild(h(`<div class="nav-group">${esc(grp.g)}</div>`));
    items.forEach((it) => {
      const a = h(`<a data-k="${it.k}"><span class="ic">${it.ic}</span><span>${esc(it.t)}</span></a>`);
      on(a, 'click', () => { location.hash = '#/' + it.k; });
      nav.appendChild(a);
    });
  });
}

/* ------------------------------ 单位树 ------------------------------ */

/**
 * 左侧「单位范围」树：
 *   · 系统管理员 / 未绑定单位：根节点「全部单位」+ 完整单位层级（上级 → 下级）
 *   · 单位管理员等绑定单位的用户：以其所属单位为根，可切换到任意下级单位（下级只读）
 * 父节点条数为「本单位 + 全部下级」的合计，便于查看汇总。
 */
function renderUnitTree() {
  const box = $('#utree');
  if (!box) return;
  clear(box);

  const canAll = Scope.canAll();
  const arrow = Scope.collapsed ? '▸' : '▾';

  const nodeHtml = (n, depth) => {
    const kids = n.children || [];
    const open = !Scope.fold[n.id] && !Scope.collapsed;
    const cnt = Scope.countTree(n.name);
    const own = Scope.countOf(n.name);
    const readonly = !Session.canWriteUnit(n.name);
    const tip = `${n.path || n.name}${kids.length ? `\n含下级合计 ${cnt} 条（本单位 ${own} 条）` : `\n${own} 条`}${readonly ? '\n下级单位：只读' : ''}`;
    return `
      <div class="ut-node kid ${Scope.unit === n.name ? 'on' : ''}" data-u="${esc(n.name)}"
           style="padding-left:${4 + depth * 13}px" title="${esc(tip)}">
        <span class="ut-arw ${kids.length ? '' : 'blank'}" ${kids.length ? `data-fold="${esc(n.id)}"` : ''}>${kids.length ? (open ? '▾' : '▸') : '•'}</span>
        <span class="ut-ic dot" style="background:${esc(colorOf(CAT_COLOR, n.name, depth))}"></span>
        <span class="ut-nm ellip">${esc(n.name)}</span>
        ${readonly ? '<span class="ut-ro">只读</span>' : ''}
        <span class="ut-ct">${cnt}</span>
      </div>
      ${kids.length && open ? kids.map((c) => nodeHtml(c, depth + 1)).join('') : ''}`;
  };

  const roots = Scope.tree;
  // 注意：h() 只返回模板的第一个根元素，整棵树必须包在单个节点里
  box.appendChild(h(`<div>
    <div class="ut-hd">
      <span>单位范围</span>
      <span class="muted" style="font-size:11px">${canAll ? '点击切换' : '已锁定'}</span>
    </div>
    <div class="ut-body">
      ${canAll ? `
      <div class="ut-node ${Scope.unit === '' ? 'on' : ''}" data-u="">
        <span class="ut-arw" id="ut-arw" title="展开 / 收起">${arrow}</span>
        <span class="ut-ic">⌸</span>
        <span class="ut-nm">全部单位</span>
        <span class="ut-ct">${Scope.total}</span>
      </div>` : ''}
      <div class="ut-kids" style="${Scope.collapsed ? 'display:none' : ''}">
        ${roots.map((n) => nodeHtml(n, canAll ? 0 : 0)).join('')}
        ${roots.length ? '' : '<div class="ut-empty">暂无单位数据</div>'}
      </div>
    </div>
  </div>`));

  const arw = $('#ut-arw', box);
  if (arw) on(arw, 'click', (e) => { e.stopPropagation(); Scope.toggle(); });

  $$('[data-fold]', box).forEach((n) => on(n, 'click', (e) => {
    e.stopPropagation();
    Scope.toggleNode(n.dataset.fold);
  }));

  $$('.ut-node', box).forEach((n) => {
    on(n, 'click', () => {
      const u = n.dataset.u == null ? '' : n.dataset.u;
      if (n.classList.contains('dis')) return;
      if (Scope.unit === u) return;
      Scope.set(u); // set() 内部按可见范围校验，越权选择会被忽略
    });
  });

  updateCrumb();
}

function updateCrumb() {
  const el = $('#pg-crumb');
  if (!el) return;
  const readonly = Scope.unit && !Session.canWriteUnit(Scope.unit);
  const me = Session.user || {};
  const role = esc(me.roleLabel || '');
  el.innerHTML = `${role ? esc(role) + ' ｜ ' : ''}单位：<b>${esc(Scope.label())}</b>${readonly ? ' <span class="tag n">下级单位 · 只读</span>' : ''}`;
}

function go(pageKey, params) {
  if (curPageKey && curPageKey !== pageKey) leavePage(curPageKey);
  curPageKey = pageKey;
  document.body.classList.remove('nav-open'); // 移动端：切页即收起抽屉
  const page = Pages[pageKey] || Pages.dashboard;
  $$('#nav a').forEach((a) => a.classList.toggle('on', a.dataset.k === pageKey));
  updateCrumb();
  const titleEl = $('#pg-title');
  if (titleEl) titleEl.textContent = page.title;
  const content = $('#content');
  clear(content);
  content.scrollTop = 0;
  try {
    page.render(content, params || {});
  } catch (e) {
    console.error(e);
    content.appendChild(h(`<div class="empty"><div class="ic">⚠</div><div>页面加载失败：${esc(e.message)}</div></div>`));
  }
}

function currentPage() {
  const m = /^#\/(\w+)/.exec(location.hash || '');
  let k = m ? m[1] : 'report';
  if (!Pages[k]) k = 'report';
  const item = NAV.reduce((acc, g) => acc || g.items.find((i) => i.k === k), null);
  if (item && !navVisible(item)) k = 'report';
  return k;
}

/* ------------------------------ 启动 ------------------------------ */

let booting = false;

/**
 * 单位切换后：刷新树高亮并重新渲染当前页面（各页面自行读取 Scope.unit）。
 * 注意：退登 / 重登会调用 Scope.reset() 清空订阅，因此这里以「订阅是否存在」为准，
 * 不能用一个只增不减的标志位判断，否则第二次登录后切换单位页面不再刷新。
 */
function bindScope() {
  if (Scope._subs.length) return;
  Scope.onChange(() => {
    renderUnitTree();
    if (curPageKey) go(curPageKey);
  });
}

async function boot() {
  if (booting) return;
  booting = true;
  try {
    if (!Session.token) { renderLogin(); return; }
    if (!Session.user) {
      const r = await API.get('/api/auth/me');
      Session.user = r.user;
    }
    await Session.loadOptions(true);
    Session.user = Session.options.me || Session.user;
    // 预取地图配置（服务商 / 密钥 / 默认视野），地图页与设置页进入时即可直接使用
    try { await Geo.config(true); } catch (e) { /* 地图配置失败不阻断登录 */ }
    await Scope.init();
    bindScope();
    renderApp();
    go(currentPage());
  } catch (e) {
    Session.clear();
    Scope.reset();
    renderLogin(e.message);
  } finally {
    booting = false;
  }
}

on(window, 'hashchange', () => {
  if (Session.token && $('#nav')) go(currentPage());
});

/* ------------------------------ 用户菜单功能 ------------------------------ */

function changePassword() {
  const body = `
    <div class="field"><label>原密码</label><input class="inp" id="cp-o" type="password"></div>
    <div class="field"><label>新密码（至少 6 位）</label><input class="inp" id="cp-n" type="password"></div>
    <div class="field"><label>确认新密码</label><input class="inp" id="cp-n2" type="password"></div>
    <div class="err muted" id="cp-err" style="color:var(--danger);min-height:16px"></div>`;
  modal({
    title: '修改密码',
    body,
    buttons: [
      { text: '取消' },
      {
        text: '保存', cls: 'pri', onClick: async (close) => {
          const o = $('#cp-o').value, n = $('#cp-n').value, n2 = $('#cp-n2').value;
          if (n.length < 6) { $('#cp-err').textContent = '新密码至少 6 位'; return; }
          if (n !== n2) { $('#cp-err').textContent = '两次输入的新密码不一致'; return; }
          try {
            await API.post('/api/auth/change-password', { oldPassword: o, newPassword: n });
            toast('密码已修改，请重新登录', 'ok');
            close();
            Session.clear();
            renderLogin();
          } catch (e) { $('#cp-err').textContent = e.message; }
        },
      },
    ],
  });
}

function setApiBase() {
  modal({
    title: '后端服务地址',
    body: `<div class="field"><label>API 地址（留空表示与页面同源）</label>
      <input class="inp" id="ab-v" value="${esc(API.base)}" placeholder="http://127.0.0.1:8787"></div>
      <div class="muted" style="font-size:12px">页面通过浏览器预览打开时，后端需单独运行：<code>node server/server.js</code></div>`,
    buttons: [
      { text: '取消' },
      { text: '保存并刷新', cls: 'pri', onClick: (close) => { API.setBase($('#ab-v').value.trim()); close(); location.reload(); } },
    ],
  });
}

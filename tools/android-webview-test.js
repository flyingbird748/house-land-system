'use strict';
/*
 * android-webview-test.js —— 通过页面级 CDP WebSocket 驱动真机/模拟器 WebView，
 * 验证 APK 内的完整 UI 流程（登录、缩放、地图页、位置搜索、控制台错误）。
 *
 * 前置：
 *   1. APK 为 debug 版（MainActivity 里 BuildConfig.DEBUG 开启 WebContentsDebuggingEnabled）
 *   2. 模拟器/手机已 adb 连接，应用已启动且页面加载完成
 *   3. 自动 adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>
 *
 * 用法：
 *   node tools/android-webview-test.js
 */
const { execSync } = require('child_process');
const fs = require('fs');

const ADB = 'D:/AI/workbuddy/2026-10-11-14-34-09/.android/sdk/platform-tools/adb.exe';
const PKG = 'com.house.land';

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 最小 CDP 客户端（Node 22 全局 WebSocket） ---------------- */
class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    this.ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result);
      } else if (m.method) {
        this.events.push(m);
      }
    };
    this.ready = new Promise((res, rej) => {
      this.ws.onopen = res;
      this.ws.onerror = (e) => rej(new Error('ws error: ' + (e.message || 'connect failed')));
    });
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => { if (this.pending.delete(id)) reject(new Error('timeout ' + method)); }, 30000);
    });
  }
  /** 执行 JS，返回 result.value（byValue） */
  async eval(expression, awaitPromise = true) {
    const r = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise, userGesture: true,
    });
    if (r.exceptionDetails) {
      throw new Error('eval: ' + (r.exceptionDetails.exception
        ? r.exceptionDetails.exception.description : r.exceptionDetails.text));
    }
    return r.result.value;
  }
  async shot(path) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path, Buffer.from(r.data, 'base64'));
  }
  close() { try { this.ws.close(); } catch (e) { /* ignore */ } }
}

(async () => {
  const pid = execSync(`"${ADB}" shell pidof ${PKG}`).toString().trim().split('\n')[0];
  if (!pid) throw new Error('应用进程未运行，请先启动 App');
  execSync(`"${ADB}" forward tcp:9222 localabstract:webview_devtools_remote_${pid}`);
  const list = JSON.parse(execSync('curl -s -m 5 http://127.0.0.1:9222/json/list').toString());
  const pg = list.find((p) => p.type === 'page');
  if (!pg) throw new Error('CDP 未发现页面目标');
  console.log('WebView pid=' + pid + '，连接 ' + pg.url + '\n');

  const cdp = new CDP(pg.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  /* ---- 1. 登录（已登录则跳过） ---- */
  let loggedIn = await cdp.eval(`!!document.querySelector('#nav')`);
  if (!loggedIn) {
    await cdp.eval(`new Promise(r=>{
      const t=setInterval(()=>{
        const u=document.querySelector('#lg-u'), p=document.querySelector('#lg-p');
        if(!u||!p) return;
        clearInterval(t);
        const set=(el,v)=>{el.value=v;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));};
        set(u,'admin'); set(p,'admin123');
        r(true);
      },200);
    })`);
    await cdp.eval(`document.querySelector('#lg-btn').click(), true`);
    await sleep(2500);
    loggedIn = await cdp.eval(`!!document.querySelector('#nav')`);
  }
  ok(loggedIn, 'UI 登录成功（CDP 驱动，已登录则复用会话）');

  /* ---- 2. 缩放 / 视口 ---- */
  const zoomInfo = await cdp.eval(`(()=>({
    innerW: window.innerWidth,
    scrollW: document.documentElement.scrollWidth,
    meta: (document.querySelector('meta[name=viewport]')||{}).content||'',
    pinchZoom: window.visualViewport ? window.visualViewport.scale : 1
  }))()`);
  console.log('  视口: ' + JSON.stringify(zoomInfo));
  ok(zoomInfo.scrollW <= zoomInfo.innerW + 2, '页面无横向溢出（wide viewport 生效）',
    `scrollW=${zoomInfo.scrollW} innerW=${zoomInfo.innerW}`);

  /* ---- 2b. 移动端抽屉侧栏 ---- */
  const drawer = await cdp.eval(`(()=>{
    const btn = document.querySelector('#nav-toggle');
    const sb = document.querySelector('.sidebar');
    const vis = (el) => !!(el && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0);
    return {
      toggleVisible: vis(btn),
      sidebarFixed: sb ? getComputedStyle(sb).position : '',
      closedLeft: sb ? Math.round(sb.getBoundingClientRect().left) : 0,
    };
  })()`);
  console.log('  抽屉: ' + JSON.stringify(drawer));
  ok(drawer.toggleVisible, '小屏显示汉堡按钮');
  ok(drawer.sidebarFixed === 'fixed' && drawer.closedLeft < 0, '侧栏默认收起（translateX(-102%)）',
    JSON.stringify(drawer));
  await cdp.eval(`document.querySelector('#nav-toggle').click(), true`);
  await sleep(2500); // 无窗口模拟器 vsync 异常，transition 推进极慢，多等
  const open = await cdp.eval(`(()=>{
    const sb = document.querySelector('.sidebar');
    return { left: Math.round(sb.getBoundingClientRect().left), mask: getComputedStyle(document.querySelector('.nav-mask')).display };
  })()`);
  ok(open.left >= -2 && open.mask === 'block', '点击汉堡侧栏滑出且遮罩出现', JSON.stringify(open));
  await cdp.eval(`document.querySelector('.nav-mask').click(), true`);
  await sleep(500);
  const closed = await cdp.eval(`Math.round(document.querySelector('.sidebar').getBoundingClientRect().left)`);
  ok(closed < 0, '点遮罩侧栏收回');

  /* ---- 3. 地图页 ---- */
  await cdp.eval(`(document.querySelector('#nav a[data-k="map"]')||{}).click && document.querySelector('#nav a[data-k="map"]').click(), true`);
  await sleep(7000);
  const mapState = await cdp.eval(`(()=>{
    // 注意：单文件内联后顶层 const 不挂 window，必须直接按标识符引用（词法作用域）
    let mp = null;
    try { mp = MapPage; } catch (e) { /* 未定义 */ }
    return {
      hasTMap: !!window.TMap,
      hasMapObj: !!(mp && mp.map),
      assets: mp ? (mp.assets || []).length : -1,
      canvases: document.querySelectorAll('#map canvas').length,
      box: (()=>{const w=document.querySelector('#map');if(!w)return null;const r=w.getBoundingClientRect();return {w:Math.round(r.width),h:Math.round(r.height)};})(),
      webgl: (()=>{try{return !!(document.createElement('canvas').getContext('webgl'))}catch(e){return false}})(),
      text: (document.querySelector('.map-page')||document.body).innerText.slice(0,150)
    };
  })()`);
  console.log('  地图状态: ' + JSON.stringify(mapState));
  ok(mapState.webgl, 'WebView 支持 WebGL（地图渲染前提）');
  ok(mapState.box && mapState.box.h > 100, '地图容器有实际尺寸', JSON.stringify(mapState.box));
  ok(mapState.box && mapState.box.w > zoomInfo.innerW * 0.85,
    '地图容器接近全宽（抽屉侧栏不占内容区）', JSON.stringify(mapState.box));
  ok(mapState.hasTMap, '腾讯地图 SDK 已加载（window.TMap）');
  ok(mapState.canvases > 0, '地图 canvas 已渲染（WebGL 画布存在）', 'canvases=' + mapState.canvases);
  ok(mapState.hasMapObj, '地图实例已创建（MapPage.map）');
  await cdp.shot('data/shots/android-map.png');

  /* ---- 4. 位置搜索 ---- */
  const seaBox = await cdp.eval(`!!document.querySelector('#mp-sea')`);
  if (seaBox) {
    await cdp.eval(`(()=>{const el=document.querySelector('#mp-sea');el.value='洋河一村';el.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
    await sleep(5000);
    const sea = await cdp.eval(`({
      items: document.querySelectorAll('.mp-sea-item').length,
      tip: ((document.querySelector('#mp-sea-res')||{}).innerText||'').slice(0,100)
    })`);
    console.log('  搜索: ' + JSON.stringify(sea));
    ok(sea.items > 0 || /额度|上限|失败|没有/.test(sea.tip),
      '位置搜索可用（有候选或友好提示）', sea.tip);
  }

  /* ---- 5. 控制台错误 ---- */
  const errs = cdp.events
    .filter((e) => e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error')
    .map((e) => (e.params.args || []).map((a) => a.value || a.description || '').join(' '))
    .filter((e) => !/favicon|Failed to load resource|net::ERR/.test(e));
  const exs = cdp.events
    .filter((e) => e.method === 'Runtime.exceptionThrown')
    .map((e) => (e.params.exceptionDetails.exception || {}).description || e.params.exceptionDetails.text);
  ok(errs.length + exs.length === 0, '无 JS 控制台错误',
    [...errs, ...exs].slice(0, 2).join(' | '));

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  cdp.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });

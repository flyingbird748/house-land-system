'use strict';
/**
 * build-android.js —— 把后端服务、单文件前端、种子数据打包进 Android assets
 *
 * 产物：android/app/src/main/assets/app/
 *   server/   后端源码（排除 node.exe，那是 Windows 分发运行时，APK 里不需要）
 *   web/      单文件前端（tools/build.js 产物）
 *   data/     种子 db.json（仅首次安装落盘，升级时保留用户数据）
 *
 * 用法：node tools/build-android.js
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ANDROID_ASSETS = path.join(ROOT, 'android', 'app', 'src', 'main', 'assets', 'app');

const SKIP_FILES = new Set(['node.exe']); // Windows 版 Node 运行时，不进 APK

function rmrf(p) {
  if (!fs.existsSync(p)) return;
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const fp = path.join(p, e.name);
    if (e.isDirectory()) rmrf(fp);
    else fs.unlinkSync(fp);
  }
  fs.rmdirSync(p);
}

function copyDir(src, dest, label) {
  let files = 0, bytes = 0;
  const walk = (s, d) => {
    fs.mkdirSync(d, { recursive: true });
    for (const e of fs.readdirSync(s, { withFileTypes: true })) {
      const sp = path.join(s, e.name);
      const dp = path.join(d, e.name);
      if (e.isDirectory()) { walk(sp, dp); continue; }
      if (SKIP_FILES.has(e.name)) continue;
      fs.copyFileSync(sp, dp);
      files++; bytes += fs.statSync(dp).size;
    }
  };
  walk(src, dest);
  console.log(`  ${label}: ${files} 个文件, ${(bytes / 1024).toFixed(0)} KB`);
}

function main() {
  console.log('== 1/4 构建单文件前端 ==');
  execSync(`node "${path.join(ROOT, 'tools', 'build.js')}"`, { stdio: 'inherit' });

  const idx = path.join(ROOT, 'web', 'index.html');
  if (!fs.existsSync(idx)) { console.error('web/index.html 不存在，构建失败'); process.exit(1); }

  console.log('== 2/4 清理 assets/app ==');
  rmrf(ANDROID_ASSETS);
  fs.mkdirSync(ANDROID_ASSETS, { recursive: true });

  console.log('== 3/4 拷贝资产 ==');
  copyDir(path.join(ROOT, 'server'), path.join(ANDROID_ASSETS, 'server'), 'server/');
  // web 只带单文件产物 index.html（shell.html/src 是开发源，不进 APK）
  const webDest = path.join(ANDROID_ASSETS, 'web');
  fs.mkdirSync(webDest, { recursive: true });
  fs.copyFileSync(idx, path.join(webDest, 'index.html'));
  console.log(`  web/: index.html, ${(fs.statSync(idx).size / 1024).toFixed(0)} KB`);
  // data 只带种子数据与签名密钥（server.key 与 db.json 里的令牌配套，必须同源）；
  // images/ 由用户上传后自动创建，shots/server.log 不进包
  const dataDest = path.join(ANDROID_ASSETS, 'data');
  fs.mkdirSync(dataDest, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'data', 'db.json'), path.join(dataDest, 'db.json'));
  const keyFile = path.join(ROOT, 'data', 'server.key');
  if (fs.existsSync(keyFile)) fs.copyFileSync(keyFile, path.join(dataDest, 'server.key'));
  const seedBytes = fs.statSync(path.join(dataDest, 'db.json')).size;
  console.log(`  data/: db.json + server.key, ${(seedBytes / 1024).toFixed(0)} KB`);

  console.log('== 4/4 写入版本标记与拷贝清单 ==');
  let ver = 'dev';
  try { ver = require(path.join(ROOT, 'package.json')).version; } catch (e) { /* 无 package.json */ }
  fs.writeFileSync(path.join(ANDROID_ASSETS, 'VERSION'),
    new Date().toISOString() + '\n' + ver + '\n', 'utf8');

  // file.list / dir.list：Android 端按清单解压（AssetManager.list() 在大资产树
  // 与部分机型上不可靠，nodejs-mobile 官方同样改用清单）
  const relFiles = [];
  const relDirs = [];
  const walk = (abs, rel) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) { relDirs.push(r); walk(path.join(abs, e.name), r); }
      else relFiles.push(r);
    }
  };
  walk(ANDROID_ASSETS, '');
  fs.writeFileSync(path.join(ANDROID_ASSETS, 'file.list'), relFiles.join('\n') + '\n', 'utf8');
  fs.writeFileSync(path.join(ANDROID_ASSETS, 'dir.list'), relDirs.join('\n') + '\n', 'utf8');
  console.log(`  清单: ${relFiles.length} 文件 / ${relDirs.length} 目录`);

  const total = (() => {
    let t = 0;
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const fp = path.join(d, e.name);
        if (e.isDirectory()) walk(fp); else t += fs.statSync(fp).size;
      }
    };
    walk(ANDROID_ASSETS);
    return t;
  })();
  console.log(`assets 合计 ${(total / 1024 / 1024).toFixed(2)} MB -> android/app/src/main/assets/app/`);
  console.log('完成。下一步：node tools/build-apk.js');
}

main();

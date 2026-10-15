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

  // mysql2 驱动：APK 里的服务要连数据库，必须带上（纯 JS 依赖，可在手机上跑）
  const nmDir = path.join(ROOT, 'node_modules');
  if (fs.existsSync(nmDir)) {
    copyDir(nmDir, path.join(ANDROID_ASSETS, 'node_modules'), 'node_modules/');
  } else {
    console.error('  ! 缺少 node_modules，请先执行 npm install，否则 APK 内服务连不上数据库');
  }

  // web 只带单文件产物 index.html（shell.html/src 是开发源，不进 APK）
  const webDest = path.join(ANDROID_ASSETS, 'web');
  fs.mkdirSync(webDest, { recursive: true });
  fs.copyFileSync(idx, path.join(webDest, 'index.html'));
  console.log(`  web/: index.html, ${(fs.statSync(idx).size / 1024).toFixed(0)} KB`);

  // data：数据库版只带连接配置。业务数据在 MySQL 服务器上，
  // 手机端通过内网访问它，因此不再需要种子 db.json 与签名密钥文件
  // （签名盐值也存在数据库的 settings 表里）。
  const dataDest = path.join(ANDROID_ASSETS, 'data');
  fs.mkdirSync(dataDest, { recursive: true });
  const cfgFile = path.join(ROOT, 'data', 'dbconfig.json');
  if (fs.existsSync(cfgFile)) {
    fs.copyFileSync(cfgFile, path.join(dataDest, 'dbconfig.json'));
    console.log('  data/: dbconfig.json（数据库连接配置）');
  } else {
    console.log('  ! 未找到 data/dbconfig.json，APK 首次启动将生成默认配置模板，需连电脑改配置');
  }

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

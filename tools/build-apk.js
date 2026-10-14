'use strict';
/**
 * build-apk.js —— 一键构建 Android APK
 *
 * 步骤：前端单文件 -> assets 打包 -> gradle assembleDebug(分架构) -> 拷贝到 dist/android/
 *
 * 前置环境（首次）：
 *   1. JDK 17           https://adoptium.net/ （设 JAVA_HOME）
 *   2. Android SDK      https://developer.android.com/studio#command-tools
 *                        sdkmanager "platform-tools" "platforms;android-34" "build-tools;34.0.0"
 *                        "ndk;26.3.11579264" "cmake;3.22.1"
 *   3. android/local.properties 写 sdk.dir=...（或用 ANDROID_HOME 环境变量）
 *
 * 用法：node tools/build-apk.js
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ANDROID = path.join(ROOT, 'android');
const DIST = path.join(ROOT, 'dist', 'android');

const isWin = process.platform === 'win32';
const gradlew = isWin ? path.join(ANDROID, 'gradlew.bat') : path.join(ANDROID, 'gradlew');

function main() {
  console.log('== 1/3 打包 assets ==');
  execSync(`node "${path.join(__dirname, 'build-android.js')}"`, { stdio: 'inherit' });

  console.log('== 2/3 Gradle 构建 APK（首次会下载依赖，约几分钟） ==');
  const env = Object.assign({}, process.env);
  const gradle = path.join(ROOT, '..', '..', '.android', 'gradle-8.7', 'bin', 'gradle');
  let cmd;
  if (fs.existsSync(gradlew)) {
    cmd = `"${gradlew}" -p "${ANDROID}" assembleDebug assembleRelease --stacktrace`;
  } else {
    // 无 wrapper 时回退到系统 gradle
    cmd = `"${gradle}" -p "${ANDROID}" assembleDebug assembleRelease --stacktrace`;
  }
  execSync(cmd, { stdio: 'inherit', env, cwd: ANDROID });

  console.log('== 3/3 收集 APK ==');
  const outDir = path.join(ANDROID, 'app', 'build', 'outputs', 'apk');
  fs.mkdirSync(DIST, { recursive: true });
  const found = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const fp = path.join(d, e.name);
      if (e.isDirectory()) walk(fp);
      else if (e.name.endsWith('.apk')) found.push(fp);
    }
  };
  walk(outDir);

  if (!found.length) { console.error('未找到 APK 产物'); process.exit(1); }
  for (const apk of found) {
    const dest = path.join(DIST, path.basename(apk));
    fs.copyFileSync(apk, dest);
    const mb = (fs.statSync(dest).size / 1024 / 1024).toFixed(1);
    console.log(`  ${path.basename(apk)}  ${mb} MB  -> dist/android/`);
  }
  console.log('\n构建完成，APK 在 dist/android/ 下：');
  found.forEach((a) => console.log('  - ' + path.basename(a)));
  console.log('\n安装：adb install -r dist/android/app-arm64-v8a-debug.apk');
  console.log('或把 APK 传到手机，点开允许「未知来源」后安装。');
}

main();

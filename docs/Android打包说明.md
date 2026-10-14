# Android APK 打包说明

房屋土地信息系统已打包为 Android 安装包（APK）。APK 内内置完整后端服务
（Node.js 运行时 + SQLite 同源的单文件 JSON 数据库）与前端页面，**安装后完全离线可用**，
不依赖任何外部服务器。

## 一、安装

| 文件 | 适用设备 |
| --- | --- |
| `app-arm64-v8a-release.apk` | 2017 年后的主流 Android 手机（推荐，体积最小） |
| `app-armeabi-v7a-release.apk` | 较老的 32 位手机 |
| `app-universal-release.apk` | 不确定架构时选它（含两种，体积约大一倍） |
| `app-x86_64-release.apk` | 电脑上的 Android 模拟器（x86_64） |

（`dist/android/` 下同时提供 debug 与 release 两套，均使用 debug 签名、可直接安装；
日常使用装 release 版即可。）

1. 把 APK 传到手机（数据线 / 微信文件传输 / 网盘均可）；
2. 点击 APK，系统提示「未知来源应用」时允许安装（设置里临时允许即可）；
3. 打开「房屋土地信息系统」，首次启动需 3-10 秒解压内置服务，之后即进入登录页。

> 最低支持 Android 7.0（API 24），已在 Android 14 目标版本（targetSdk 34）下签名。

## 二、登录账号

与 PC 版一致（种子数据随包内置）：

| 账号 | 密码 | 说明 |
| --- | --- | --- |
| `admin` | `admin123` | 系统管理员，可见全部单位数据 |
| `unitadmin` | `unitadmin123` | 单位管理员，仅本单位 |
| `editor` / `viewer` | `editor123` / `viewer123` | 编辑 / 只读 |

## 三、数据存放在哪（重要）

- 应用数据位于手机私有目录 `/data/data/com.house.land/files/app/data/db.json`；
- **卸载应用会清除全部数据**，卸载前请先在「系统里导出备份」或用页面内的导出功能留存；
- **覆盖安装（升级）不会丢数据**：升级只更新服务与页面代码，`data/` 目录原样保留；
- 备份/恢复方法：把上面路径的 `db.json` 与 `images/` 目录整体拷出即可。

## 四、功能说明

- 登录后默认进入「分析报告」，左侧导航可切换看板 / 台账 / 地图标注 / 房产预览 / 导入导出 / 系统设置；
- **手机上的界面适配**：屏幕较窄时左侧导航自动收起为抽屉——点左上角「☰」滑出，
  点右侧遮罩或切换页面即收回；页面支持双指捏合缩放，双指拖动可平移地图；
- 地图标注页右上角支持**位置搜索**（输入地址或「经度,纬度」直接定位）；
  地图底图需要地图服务 Key，在「系统设置 → 地图服务」里配置（内置注册指引）。
  未配置时页面会给出引导，不影响其他功能；
- 房产图片上传：编辑界面每条最多 3 张、单张 ≤2MB，会调起系统相册选择器；
- 导入导出（Excel 模板）、单位树、用户管理、报告参数均与 PC 版一致。

## 五、开发者：如何重新构建

环境要求（一次性安装）：

1. **JDK 17** —— https://adoptium.net/ ，装完设 `JAVA_HOME`；
2. **Android SDK** —— https://developer.android.com/studio#command-tools ，
   用 `sdkmanager` 安装：
   ```
   sdkmanager "platform-tools" "platforms;android-34" "build-tools;34.0.0" "ndk;26.3.11579264" "cmake;3.22.1"
   ```
3. 在 `android/local.properties` 里写 `sdk.dir=<你的SDK路径>`（或用 `ANDROID_HOME` 环境变量）。

一键构建（在 `house-land-system/` 目录下）：

```bash
node tools/build-apk.js        # 前端打包 -> assets 打包 -> gradle 构建 -> 输出到 dist/android/
```

等价的手动步骤：

```bash
node tools/build.js            # 生成单文件前端 web/index.html
node tools/build-android.js    # 把 server/ web/ data/ 打包进 android assets
cd android && ./gradlew assembleDebug assembleRelease
```

产物在 `android/app/build/outputs/apk/` 与 `dist/android/`。

### 工程结构

```
android/
  app/src/main/
    java/com/estate/admin/
      MainActivity.java    启动页 + WebView + 系统文件选择器（图片上传）
      NodeRuntime.java     assets 解压 + 进程内启动 Node（nodejs-mobile 方案）
    jni/
      node-jni.cpp         JNI 桥：Java -> node::Start(argc, argv)
      libnode.so 所在 jniLibs/<abi>/   Node 18.20.4 运行时（arm64 + armv7）
    assets/app/            构建时生成：server/ + web/ + data/（种子 db.json）
```

### 已知边界

- 只打了 `arm64-v8a` / `armeabi-v7a`（真机）与 `x86_64`（模拟器）三个架构；
  换手机架构时改 `android/app/build.gradle` 的 `abiFilters` 与 `splits.abi.include`，
  并到 https://github.com/nodejs-mobile/nodejs-mobile/releases 下载对应 ABI 的
  `libnode.so` 放入 `jniLibs/<abi>/`；
- 内置的腾讯地图 Key 若日调用额度用尽，位置搜索会提示「每日调用量已达上限」，
  在「系统设置 → 地图服务」换 Key 即可（或直接输「经度,纬度」定位，不走搜索服务）；
- 服务端只使用 Node 内置模块，Android 上的 Node 18 运行时不带 `fetch`，
  已改用内置 `http/https` 实现地理编码代理（`server/lib/mapconfig.js`）。

### 移动端 WebView 适配要点（改动前先读）

以下几处是踩坑后固化的实现，改动 WebView 设置或地图页时勿破坏：

1. **侧栏小屏抽屉**（`styles.css` `@media (max-width:860px)`）：侧栏 `position:fixed`
   + `translateX(-102%)` 收起，`body.nav-open` 滑出；汉堡按钮 `#nav-toggle` 与遮罩
   `.nav-mask` 在 `02-shell.js` 的 `renderShell()` 里绑定，切页/登出时移除 `nav-open`。
2. **WebView 缩放三件套**（`MainActivity.setupWebView`）：`setUseWideViewPort(true)` +
   `setLoadWithOverviewMode(true)` + `setSupportZoom/setBuiltInZoomControls`，
   否则小屏上页面按固定 CSS 宽度渲染、无法双指缩放。
3. **UA 去掉 `; wv`**：腾讯地图 gljs 对 WebView UA 走特殊分支，会导致底图不渲染。
4. **地图容器高度兜底**（`09-map.js` 的 `fixMapHeight` + CSS `max-height:100dvh`）：
   WebView 的 overview 模式下 `height:100%` 链会塌陷成内容高度（实测 8192px），
   WebGL 纹理超限后地图整块白屏；`fixMapHeight` 在 `initMap`/`refresh` 时按视口高度
   显式设像素值。两个地图页（`#map` / `#pv-map`）都调用了它。
5. **InfoWindow 容错**（`00-geo.js` `createInfoWindow`）：部分环境下构造即抛错，
   已包 try/catch + 惰性代理，失败时静默降级，不阻断地图初始化。

### 真机 / 模拟器验证

```bash
node tools/android-webview-test.js   # CDP 驱动 WebView：登录/抽屉/地图/搜索/控制台错误
```

要求 APK 为 debug 版（`BuildConfig.DEBUG` 开启 WebContentsDebuggingEnabled），
应用已启动。脚本内部自动 `adb forward` 并连接页面级 CDP WebSocket。
⚠️ 无窗口模拟器（`-no-window`）下 rAF 仅约 3fps，地图 fitBounds 动画与 CSS
transition 推进极慢，验证时需多等待；这是模拟器环境限制，真机（正常 vsync）不受影响。

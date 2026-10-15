# 房屋土地信息系统

各单位房屋土地资产台账一体化管理平台。**初始为空库**：不含任何单位、资产与用户数据，
由使用者自行录入。系统内置后端服务（Node 运行时），安装/解压后即可离线运行。

> **⚠️ 安全提示**：本项目源码中包含初始化账号 `admin / admin123`（用于首次登录）。
> 部署到真实环境后，请**立即**在「系统设置 → 用户管理」中修改默认密码，
> 并妥善保管 `data/db.json` 与 `data/server.key`（这两个文件已在 `.gitignore` 中排除，不会上传仓库）。

---

## 一、快速开始

### 环境要求

| 依赖 | 版本 | 说明 |
| --- | --- | --- |
| Node.js | 18 及以上 | 仅用内置模块，无需编译 |
| MySQL | 8.0 及以上 | 数据存储；也可连到局域网内的数据库服务器 |
| npm 包 | mysql2 | **唯一的第三方依赖**，执行 `npm install` 安装 |

### 电脑上使用（首次）

```bash
npm install          # 安装数据库驱动（只需一次）
npm run db:init      # 建库建表（只需一次；会读 data/dbconfig.json 里的连接信息）
node server/server.js
# 浏览器打开 http://127.0.0.1:8789
```

数据库连接信息在 **`data/dbconfig.json`**（首次启动自动生成模板）：

```json
{ "host": "127.0.0.1", "port": 3306, "user": "root", "password": "", "database": "house_land" }
```

也可以用环境变量覆盖：`DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_NAME`。

### 日常使用

双击 **`启动系统.bat`** 即可，浏览器会自动打开 <http://127.0.0.1:8789>。
脚本会检查依赖与前端产物，缺什么补什么。

> 服务启动时会先连数据库，连不上会直接给出排查提示（不会带着一堆驱动报错退出）。

### 手机上使用

把 `dist/android/` 里的 APK 传到手机安装（详见 `docs/Android打包说明.md`）：

| 文件 | 适用设备 |
| --- | --- |
| `app-arm64-v8a-release.apk` | 2017 年后的主流手机（推荐） |
| `app-armeabi-v7a-release.apk` | 较老的 32 位手机 |
| `app-universal-release.apk` | 不确定架构时用 |

> APK 的应用标识为 `com.house.land`，与旧版「房产土地信息管理系统」的 APK 可以同时安装、
> 互不覆盖（两者端口也不同：本系统 8789，旧版 8787）。

> **手机端怎么连数据库**：APK 内部同样跑着一个 Node 服务，它连的是
> `data/dbconfig.json` 里配置的 MySQL —— 手机上不会也不适合跑数据库服务。
> 因此手机需要和数据库服务器在同一个内网（单位 WiFi / VPN）里，
> 并把配置里的 `host` 填成数据库服务器的内网 IP（不能用 `127.0.0.1`，那是指手机自己）。
> 打包前改好 `data/dbconfig.json` 再执行 `npm run build:android`，配置会一起打进 APK。

### 初始账号

| 账号 | 密码 | 权限 |
| --- | --- | --- |
| `admin` | `admin123` | 系统管理员：可见并管理全部单位 |

> 首次登录后建议立即到「系统设置 → 用户管理」修改 admin 密码。

---

## 二、首次使用步骤（建议按顺序）

系统初始是**空库**（无单位、无资产、无用户、无地图密钥），按下面顺序建立数据：

1. **建单位** —— 「系统设置 → 单位管理」新增本单位（可建多级：上级单位选父级）。
   单位是数据权限的基础：用户只能看自己绑定的单位及其下级。
2. **建用户** —— 「系统设置 → 用户管理」按需新增账号：
   - `单位管理员`：本单位可增删改，下级只读；
   - `录入员`：本单位可录入编辑；
   - `浏览员`：只读。
   非系统管理员的账号**必须绑定单位**。
3. **配地图（可选）** —— 「系统设置 → 地图服务」选择服务商并填入 Key：
   腾讯地图 / 天地图，页面上有注册申请 Key 的详细步骤与测试按钮。
   *不配置也能用系统*，只是地图标注、房产预览的地图底图不可用。
4. **录入资产** —— 两种方式：
   - 手工：「资产台账 → 新增资产」逐条填写；
   - 批量：「Excel 导入」下载标准模板 → 填好后上传（支持合并单元格、日期、公式结果值）。
5. **地图打点（可选）** —— 「地图标注」页选资产 → 在地图上点选位置 →
   「确认标注位置」（也可先用「地址批量解析」或右上角位置搜索定位）。
6. **看图与报告** —— 「数据看板」看统计图表；「分析报告」按当前数据自动生成报告，
   报告中的编制人数、科室数等外部口径在「系统设置 → 报告参数」里维护。

---

## 三、数据存放位置

| 内容 | 存放位置 |
| --- | --- |
| 单位 / 用户 / 资产 / 日志 / 图片元信息 / 系统设置 | MySQL 数据库（`data/dbconfig.json` 里指定的库，默认 `house_land`） |
| 上传的图片文件 | 磁盘目录 `data/images/<资产ID>/`（库里只存元信息） |
| 数据库连接配置 | `data/dbconfig.json`（不入库，含密码，注意保管） |

**备份**：用 `mysqldump` 导出数据库，同时复制 `data/images/` 目录：

```bash
mysqldump -uroot -p house_land > backup-$(date +%F).sql
```

恢复：`mysql -uroot -p house_land < backup-2026-10-15.sql`，图片目录覆盖回原位置即可。

### 从旧版（JSON 存储）升级

旧版本的数据在 `data/db.json` 里，改版后用下面的命令迁到 MySQL：

```bash
npm run db:init                 # 先建库建表
npm run db:migrate              # 再导入 data/db.json
```

迁移是**幂等**的，可以反复执行补齐；确认无误后把 `db.json` 改名备份即可。

---

## 四、目录说明

```
house-land-system/
  server/            后端服务（零第三方依赖，Node 内置模块）
    server.js        入口：node server/server.js（默认端口 8789）
    lib/             权限、报告、Excel、地图配置等模块
    assets/          报告模板、Excel 导入模板
  web/               前端源码（src/）与构建产物（index.html 单文件）
  tools/             构建与测试脚本
    sql/schema.sql     数据库表结构（建库建表用）
    init-db.js         建库建表（npm run db:init）
    migrate-to-mysql.js  旧版 db.json 迁移到 MySQL（npm run db:migrate）
  android/           Android 壳工程（打包 APK 用）
  data/             数据库连接配置 dbconfig.json、图片目录 images/ ——**不入库**
  docs/             文档（Android 打包说明、报告占位符替代规则）
  dist/android/      已构建好的 APK（**不入库**，见 Release 附件）
```

> 从 GitHub 克隆的仓库不含 `data/`：首次启动会自动创建空库与随机签名密钥；
> 也不含 `dist/` 下的 APK，需要安装包请到本仓库 Releases 页面下载。

---

## 五、开发者：构建与测试

```bash
npm install                  # 安装数据库驱动（mysql2）
npm run db:init              # 建库建表
npm run db:migrate           # 把旧版 data/db.json 迁到 MySQL
node tools/fix-datetime.js   # 修正历史 DATETIME 的时区偏移（见下方说明，只需一次）
node tools/build.js          # 前端源码 -> 单文件 web/index.html
node tools/build-apk.js      # 一键构建 Android APK（需 JDK17 + Android SDK，见 docs）
node tools/build-template.js "源表.xlsx"   # 重新生成 Excel 导入模板
```

接口测试（先启动服务）：

```bash
node tools/mysql-smoke.js     # MySQL 版端到端自检：登录、单位、用户、资产、筛选排序分页、
                              # 统计、报告、图片上传、日志、系统设置（51 项）
node tools/time-check.js      # 操作日志时间正确性验收（7 项）
NODE_PATH="<playwright-core 所在 node_modules>" node tools/smoke.js   # 旧版测试（见下方说明）
```

环境变量可覆盖地址：`BASE` / `APIBASE` / `PREVIEW`（默认 `http://127.0.0.1:8789`）。

> 注：`tools/` 下的测试脚本沿用自本项目的前身（当时带示例数据），其中部分断言
> 依赖「55 条示例资产 / 演示账号」等数据。本系统初始为空库，这类断言会失败，
> 属预期；与业务逻辑无关的检查（登录、权限、模板、报告引擎等）仍可正常使用。

### 时间是怎么存的（改动时间字段前必读）

MySQL 的 `DATETIME` 不带时区，而 JS 的 `toISOString()` 返回的是 **UTC** —— 两者直接用会
整整差一个时区（东八区下差 8 小时，写一次读一次就是 16 小时）。本项目的统一约定在
`server/lib/time.js`，改任何时间字段前先看它：

| 位置 | 格式 | 例子 |
| --- | --- | --- |
| 数据库 `DATETIME` 列 | **服务器本地时间** `YYYY-MM-DD HH:mm:ss` | `2026-10-15 21:44:26` |
| 接口返回给前端 | **本地时间 + 时区偏移**的 ISO 串 | `2026-10-15T21:44:26+08:00` |
| 数据库 `DATE` 列 | 按本地时区取年月日 | `2026-10-15` |

前端既有 `slice(0,19).replace('T',' ')` 直接显示、也有 `new Date(v)` 计算相对时间两种用法，
带偏移的本地时间两者都正确；**不要**改回 `toISOString()`（UTC），那会让页面显示的时间
比真实时间慢 8 小时。

历史库（曾经用 UTC 写进去的旧数据）用下面的脚本一次性补回来，脚本幂等、可 `--dry-run` 预演：

```bash
node tools/fix-datetime.js --dry-run   # 先看会改什么
node tools/fix-datetime.js             # 执行修正（把旧数据 +本地时区偏移）
```

---

## 六、技术说明

- **依赖极简**：后端仅用 Node 内置 `http/fs/crypto` 等模块，前端为原生 JS 单文件；
  唯一的第三方依赖是数据库驱动 `mysql2`（`npm install` 一次即可）。
- **存储**：MySQL 8，数据访问集中在 `server/lib/repo.js`，列名 snake_case、业务对象 camelCase
  的映射在 `server/lib/mysql.js` 统一完成；资产列表的筛选、排序、分页与统计全部由 SQL 完成，
  不再把数据读进内存过滤（单位表很小，允许内存缓存）。
- **权限模型**：系统管理员不限；其余角色只能看到「本单位 + 全部下级」，且只有本单位可写。
- **地图**：服务商可切换（腾讯 / 天地图），坐标系统一存 GCJ-02，天地图底图自动换算。
- **报告**：模板占位符替代规则见 `docs/报告占位符替代规则.md`。

---

## 七、许可证

本项目以 [MIT License](LICENSE) 开源，可自由使用、修改与分发（含商业用途），
但不提供任何担保。

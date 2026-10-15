-- =============================================================================
-- 房屋土地信息系统 · MySQL 数据库结构
-- 适用：MySQL 8.0+（字符集 utf8mb4）
-- 用法：mysql -u<user> -p < tools/sql/schema.sql
--      或在系统设置里点「初始化数据库」（服务端调用 tools/sql/init-db.js 执行本文件）
--
-- 约定：
--   1. 列名用 snake_case，服务端数据层自动做 camelCase <-> snake_case 映射，
--      业务代码里仍然写 asset.officeArea，不需要感知数据库列名。
--   2. 业务主键 id 保留原 VARCHAR 字符串规则（asset_xxx / unit_xxx …），
--      这样从 db.json 迁移过来的老 id 不变；另设 sort_no 自增列保证排序稳定。
--   3. 枚举类字段一律用 VARCHAR 而非 ENUM：Excel 导入的数据脏（空串/异体词），
--      用 ENUM 会导致整行写入失败，校验放在应用层。
-- =============================================================================

CREATE DATABASE IF NOT EXISTS `house_land`
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_0900_ai_ci;

USE `house_land`;

-- ---------------------------------------------------------------------------
-- 单位（多级树）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `units` (
  `id`         VARCHAR(64)  NOT NULL COMMENT '业务主键 unit_xxx',
  `name`       VARCHAR(200) NOT NULL COMMENT '单位名称（全库唯一）',
  `code`       VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '单位编码（可选）',
  `parent`     VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '上级单位 id，空表示顶级',
  `sort`       INT          NOT NULL DEFAULT 0 COMMENT '同级排序',
  `created_at` DATETIME     NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_units_name` (`name`),
  KEY `idx_units_parent` (`parent`),
  KEY `idx_units_sort` (`sort`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='单位（多级树）';

-- ---------------------------------------------------------------------------
-- 用户
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `users` (
  `id`            VARCHAR(64)  NOT NULL,
  `username`      VARCHAR(64)  NOT NULL COMMENT '登录名',
  `name`          VARCHAR(100) NOT NULL DEFAULT '' COMMENT '显示名',
  `role`          VARCHAR(20)  NOT NULL DEFAULT 'viewer' COMMENT 'admin/unitadmin/editor/viewer',
  `unit`          VARCHAR(200) NOT NULL DEFAULT '' COMMENT '所属单位名称（冗余，便于显示与过滤）',
  `unit_id`       VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '所属单位 id',
  `salt`          VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '密码盐（每账号随机）',
  `hash`          VARCHAR(128) NOT NULL DEFAULT '' COMMENT 'HMAC-SHA256(password, salt)',
  `disabled`      TINYINT(1)   NOT NULL DEFAULT 0,
  `created_at`    DATETIME     NULL,
  `last_login_at` DATETIME     NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_users_username` (`username`),
  KEY `idx_users_unit_id` (`unit_id`),
  KEY `idx_users_role` (`role`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='用户与权限';

-- ---------------------------------------------------------------------------
-- 资产台账（37 个业务字段，与 web 端 schema.js 一一对应）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `assets` (
  -- 系统字段
  `id`          VARCHAR(64) NOT NULL COMMENT '业务主键 asset_xxx',
  `sort_no`     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '自增序号，保证列表排序稳定',
  `unit_id`     VARCHAR(64) NOT NULL DEFAULT '' COMMENT '所属单位 id（由 unit 名称同步维护）',
  `created_at`  DATETIME    NULL,
  `updated_at`  DATETIME    NULL,
  `created_by`  VARCHAR(100) NOT NULL DEFAULT '',
  `updated_by`  VARCHAR(100) NOT NULL DEFAULT '',

  -- 基础信息
  `row_no`      INT          NULL COMMENT '行次',
  `unit`        VARCHAR(200) NOT NULL DEFAULT '' COMMENT '所属单位（名称）',
  `name`        VARCHAR(300) NOT NULL DEFAULT '' COMMENT '资产名称',
  `sys_name`    VARCHAR(300) NOT NULL DEFAULT '' COMMENT '资产系统内资产名称',
  `use_unit`    VARCHAR(300) NOT NULL DEFAULT '' COMMENT '使用单位（使用人）',
  `use_status`  VARCHAR(32)  NOT NULL DEFAULT '' COMMENT '自用/出借/出租/闲置/借用/已拆除/其他',
  `asset_no`    VARCHAR(100) NOT NULL DEFAULT '' COMMENT '资产编号',
  `category`    VARCHAR(32)  NOT NULL DEFAULT '' COMMENT '办公用房/其他用房/住宅/车库/周转房/土地/其他',
  `purpose`     VARCHAR(32)  NOT NULL DEFAULT '' COMMENT '办公/周转房/住宅/其他/商业',
  `structure`   VARCHAR(32)  NOT NULL DEFAULT '' COMMENT '建筑结构',
  `location`    VARCHAR(500) NOT NULL DEFAULT '' COMMENT '坐落位置',

  -- 产权信息
  `has_title`            VARCHAR(16)  NOT NULL DEFAULT '' COMMENT '有产权/无产权',
  `title_type`           VARCHAR(32)  NOT NULL DEFAULT '' COMMENT '产权形式',
  `title_no`             VARCHAR(200) NOT NULL DEFAULT '' COMMENT '产权证号',
  `multi_share_title`    VARCHAR(8)   NOT NULL DEFAULT '' COMMENT '多处房产共有同一产权证 是/否',
  `multi_share_title_no` VARCHAR(200) NOT NULL DEFAULT '' COMMENT '共有产权证号',
  `split_title`          VARCHAR(8)   NOT NULL DEFAULT '' COMMENT '一处房产划分为多个房产证 是/否',
  `split_title_no`       VARCHAR(200) NOT NULL DEFAULT '' COMMENT '分拆产权证号',

  -- 面积与人员
  `area`            DECIMAL(16,2) NULL COMMENT '产权面积（㎡）',
  `office_area`     DECIMAL(16,2) NULL COMMENT '办公用房使用面积（㎡）',
  `per_capita_area` DECIMAL(16,2) NULL COMMENT '人均办公面积（㎡）',
  `actual_staff`    INT NULL COMMENT '实际人数',
  `approved_staff`  INT NULL COMMENT '编制人数',
  `temp_staff`      INT NULL COMMENT '临聘人员人数',

  -- 价值与年限
  `original_value`  DECIMAL(20,2) NULL COMMENT '原值（元）',
  `use_date`        DATE NULL COMMENT '投入使用日期',
  `acquire_date`    DATE NULL COMMENT '取得日期',
  `age`             INT NULL COMMENT '房龄（年）',
  `overhauled`      VARCHAR(8) NOT NULL DEFAULT '' COMMENT '是否大修',
  `overhaul_date`   VARCHAR(50) NOT NULL DEFAULT '' COMMENT '大修时间',
  `overhaul_amount` DECIMAL(20,2) NULL COMMENT '大修金额（元）',

  -- 使用与处置
  `idle_long`   VARCHAR(8)   NOT NULL DEFAULT '' COMMENT '是否长期闲置',
  `idle_stage`  VARCHAR(8)   NOT NULL DEFAULT '' COMMENT '是否阶段性闲置',
  `rented_out`  VARCHAR(16)  NOT NULL DEFAULT '' COMMENT '是否出租出借',
  `rent_term`   VARCHAR(200) NOT NULL DEFAULT '' COMMENT '出租出借期限',
  `rent_income` DECIMAL(20,2) NULL COMMENT '出租收益（元）',
  `leased_in`   VARCHAR(16)  NOT NULL DEFAULT '' COMMENT '是否租入借入',
  `lease_term`  VARCHAR(200) NOT NULL DEFAULT '' COMMENT '租入借入期限',
  `lease_rent`  DECIMAL(20,2) NULL COMMENT '租入租金（元）',
  `remark`      TEXT COMMENT '备注',

  -- 地图标注
  `lng`         DOUBLE NULL COMMENT '经度（GCJ-02）',
  `lat`         DOUBLE NULL COMMENT '纬度（GCJ-02）',
  `polygon`     JSON    NULL COMMENT '轮廓/多边形点位 [{lng,lat}]，可为空',
  `geo_address` VARCHAR(200) NULL COMMENT '标注时回写的地址描述',
  `geo_at`      DATETIME     NULL COMMENT '标注时间',
  `geo_by`      VARCHAR(100) NULL COMMENT '标注人',

  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_assets_sort_no` (`sort_no`),
  KEY `idx_assets_unit_id` (`unit_id`),
  KEY `idx_assets_unit` (`unit`),
  KEY `idx_assets_category` (`category`),
  KEY `idx_assets_use_status` (`use_status`),
  KEY `idx_assets_name` (`name`),
  KEY `idx_assets_asset_no` (`asset_no`),
  KEY `idx_assets_area` (`area`),
  KEY `idx_assets_updated_at` (`updated_at`),
  KEY `idx_assets_geo` (`lng`, `lat`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='资产台账';

-- ---------------------------------------------------------------------------
-- 图片元信息（二进制文件仍在 data/images/<资产ID>/ 下，库里只存元信息）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `images` (
  `id`          VARCHAR(64)  NOT NULL,
  `asset_id`    VARCHAR(64)  NOT NULL COMMENT '所属资产',
  `name`        VARCHAR(120) NOT NULL DEFAULT '图片',
  `label`       VARCHAR(20)  NOT NULL DEFAULT '其他' COMMENT '正面/侧面/室内/其他',
  `file`        VARCHAR(120) NOT NULL DEFAULT '' COMMENT '磁盘文件名',
  `mime`        VARCHAR(40)  NOT NULL DEFAULT '',
  `size`        INT          NOT NULL DEFAULT 0 COMMENT '字节数',
  `w`           INT          NOT NULL DEFAULT 0,
  `h`           INT          NOT NULL DEFAULT 0,
  `uploaded_at` DATETIME     NULL,
  `uploaded_by` VARCHAR(100) NOT NULL DEFAULT '',
  PRIMARY KEY (`id`),
  KEY `idx_images_asset_id` (`asset_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='房产图片元信息';

-- ---------------------------------------------------------------------------
-- 操作日志（只保留最近 5000 条，由应用层裁剪）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `logs` (
  `id`       VARCHAR(64) NOT NULL,
  `ts`       DATETIME    NOT NULL COMMENT '操作时间',
  `user`     VARCHAR(100) NOT NULL DEFAULT '' COMMENT '操作人显示名',
  `username` VARCHAR(64)  NOT NULL DEFAULT '',
  `unit`     VARCHAR(200) NOT NULL DEFAULT '' COMMENT '操作人所属单位（供单位管理员按范围查看）',
  `action`   VARCHAR(60)  NOT NULL DEFAULT '',
  `target`   VARCHAR(300) NOT NULL DEFAULT '',
  `detail`   VARCHAR(1000) NOT NULL DEFAULT '',
  PRIMARY KEY (`id`),
  KEY `idx_logs_ts` (`ts`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='操作日志';

-- ---------------------------------------------------------------------------
-- 系统设置（KV，值为 JSON 文本）
--   map     : 地图服务商与密钥
--   report  : 报告外部口径参数（编制人数、科室数等）
--   secret  : 服务端签名盐值
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `settings` (
  `k`          VARCHAR(64) NOT NULL,
  `v`          LONGTEXT    NULL COMMENT 'JSON 文本',
  `updated_at` DATETIME    NULL,
  PRIMARY KEY (`k`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='系统设置（KV）';

-- ---------------------------------------------------------------------------
-- 序列：生成 asset_xxx / user_xxx 这类业务主键的递增号段
-- 用 UPDATE ... LAST_INSERT_ID(val+1) 的方式取号，避免事务锁表
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `seq` (
  `kind` VARCHAR(20) NOT NULL,
  `val`  BIGINT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (`kind`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='业务主键序列';

INSERT IGNORE INTO `seq` (`kind`, `val`) VALUES
  ('asset', 0), ('user', 0), ('log', 0), ('unit', 0), ('image', 0);

-- ---------------------------------------------------------------------------
-- 结构版本（便于后续升级脚本判断）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `schema_meta` (
  `k` VARCHAR(40)  NOT NULL,
  `v` VARCHAR(100) NOT NULL DEFAULT '',
  PRIMARY KEY (`k`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT IGNORE INTO `schema_meta` (`k`, `v`) VALUES ('schema_version', '1');

@echo off
chcp 936 >nul
cd /d "%~dp0"
title 房屋土地信息系统

rem ============================================================
rem  本脚本做四件事：
rem    1. 确认 Node 可用
rem    2. 确认 MySQL 在运行（没开就自动拉起，等它就绪才往下走）
rem    3. 缺构建产物或缺依赖就自动补
rem    4. 启动 Web 服务并自动打开浏览器
rem  末尾传 --no-pause 可不停留（供其它脚本调用）
rem ============================================================

set "MYSQL_HOME=C:/Users/Rain_Drop/mysql/8.0.28"
set "MYSQL_INI=C:/Users/Rain_Drop/mysql/my.ini"
if not "%MYSQL_HOME_ENV%"=="" set "MYSQL_HOME=%MYSQL_HOME_ENV%"

rem ---------------- 1. Node ----------------
set "NODE_EXE=node"
where node >nul 2>nul
if errorlevel 1 (
  if exist "C:/Users/Rain_Drop/.workbuddy/binaries/node/versions/22.22.2-6/node.exe" (
    set "NODE_EXE=C:/Users/Rain_Drop/.workbuddy/binaries/node/versions/22.22.2-6/node.exe"
  ) else (
    echo [错误] 没找到 Node.js
    echo        请安装 Node 18 及以上版本：https://nodejs.org/
    echo        或改好本脚本里的 NODE_EXE 指向你的 node.exe
    pause
    exit /b 1
  )
)

rem ---------------- 2. 数据库配置 ----------------
if not exist "data\dbconfig.json" (
  echo [配置] 未找到 data\dbconfig.json，按默认值生成...
  if not exist "data" mkdir "data"
  (
    echo {
    echo   "host": "127.0.0.1",
    echo   "port": 3306,
    echo   "user": "root",
    echo   "password": "",
    echo   "database": "house_land",
    echo   "charset": "utf8mb4",
    echo   "connectionLimit": 10
    echo }
  ) > "data\dbconfig.json"
  echo        已生成，请确认里面的账号密码与你的 MySQL 一致。
)

rem ---------------- 3. 依赖 ----------------
if not exist "node_modules\mysql2" (
  echo [依赖] 首次运行，正在安装数据库驱动 mysql2...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo [错误] 依赖安装失败，请手动执行 npm install
    pause
    exit /b 1
  )
)

rem ---------------- 4. MySQL ----------------
netstat -ano | findstr ":3306" | findstr "LISTENING" >nul
if not errorlevel 1 goto mysql_ready

echo [数据库] MySQL 未运行，正在启动...
if not exist "%MYSQL_HOME%\bin\mysqld.exe" (
  echo.
  echo [错误] 找不到 MySQL：%MYSQL_HOME%\bin\mysqld.exe
  echo        请选择下面两种方式之一：
  echo          1. 手动启动你的 MySQL，再重新运行本脚本
  echo          2. 改本脚本开头的 MYSQL_HOME / MYSQL_INI 指向正确位置
  echo.
  pause
  exit /b 1
)
start "" /MIN "%MYSQL_HOME%\bin\mysqld.exe" --defaults-file=%MYSQL_INI% --console

echo [数据库] 等待就绪，最多 60 秒...
set /a TRY=0
:wait_mysql
set /a TRY+=1
if %TRY% gtr 60 (
  echo [错误] MySQL 启动超时，请查看日志 %MYSQL_HOME%\data\mysqld.err
  pause
  exit /b 1
)
ping -n 2 127.0.0.1 >nul
netstat -ano | findstr ":3306" | findstr "LISTENING" >nul
if errorlevel 1 goto wait_mysql
echo [数据库] MySQL 已就绪

:mysql_ready

rem ---------------- 5. 前端构建 ----------------
if not exist "web\index.html" (
  echo [构建] 正在生成前端页面...
  "%NODE_EXE%" tools\build.js
  if errorlevel 1 (
    echo [错误] 前端构建失败
    pause
    exit /b 1
  )
)

rem ---------------- 6. 启动服务 ----------------
echo.
echo ============================================
echo   房屋土地信息系统
echo   浏览器将自动打开 http://127.0.0.1:8789
echo   请留意控制台输出的初始账号
echo   关闭本窗口即停止服务
echo ============================================
echo.

start "" http://127.0.0.1:8789/

"%NODE_EXE%" server\server.js

echo.
echo 服务已停止。
if not "%~1"=="--no-pause" pause

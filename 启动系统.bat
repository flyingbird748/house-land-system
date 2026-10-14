@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 房屋土地信息系统

set "NODE_EXE=node"
where node >nul 2>nul
if errorlevel 1 (
  rem 系统未安装 Node 时，回退到随包附带的运行时（server\node.exe）
  if exist "%~dp0server\node.exe" (
    set "NODE_EXE=%~dp0server\node.exe"
  ) else (
    echo.
    echo [错误] 未找到 Node.js 运行环境。
    echo   请安装 Node.js 18 或更高版本：https://nodejs.org/
    echo   或把 node.exe 放到本目录的 server\ 文件夹下。
    echo.
    pause
    exit /b 1
  )
)

if not exist "web\index.html" (
  echo [构建] 正在生成前端页面...
  "%NODE_EXE%" tools\build.js
)

echo.
echo ============================================
echo   房屋土地信息系统
echo   浏览器将自动打开 http://127.0.0.1:8789
echo   默认账号: admin / admin123
echo   关闭本窗口即停止服务
echo ============================================
echo.

start "" http://127.0.0.1:8789/

"%NODE_EXE%" server\server.js

echo.
echo 服务已停止。
pause

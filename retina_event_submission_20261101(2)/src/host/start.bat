@echo off
chcp 65001 >nul
title RetinaEvent Host - start
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 goto NONODE
node "tools\launch.mjs" %*
echo.
echo 服务已停止，可以关闭本窗口。
pause
exit /b 0

:NONODE
echo.
echo  [错误] 未找到 Node.js，本程序需要它才能运行。
echo  请到 https://nodejs.org/ 下载 LTS 版并安装，然后重新双击本文件。
echo.
pause
exit /b 1

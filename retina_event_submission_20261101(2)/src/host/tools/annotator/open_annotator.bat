@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
rem 默认根目录 E:\workspace\FPGA_Comp\records，端口 8790，只监听 127.0.0.1
rem 传参示例：打开标注.bat --root D:\my_records --port 8791 --no-open
node server.mjs %*
if errorlevel 1 (
  echo.
  echo [打开标注] 启动失败，请检查上面的报错（node 是否在 PATH、端口是否被占用）。
  pause
)

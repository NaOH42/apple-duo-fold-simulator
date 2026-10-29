@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist "dist\index.html" (
  echo 请先构建游戏：npm run build
  pause
  exit /b 1
)
node scripts\serve.mjs --open
if errorlevel 1 pause

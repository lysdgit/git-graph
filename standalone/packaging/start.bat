@echo off
setlocal
set "APP_DIR=%~dp0"
node "%APP_DIR%standalone\out\standalone\src\main.js" %*
if errorlevel 1 pause

@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "NODE=node"
if exist ".runtime\node\node.exe" set "NODE=.runtime\node\node.exe"
if not exist "data\words.json" "%NODE%" scripts\build-content.js
"%NODE%" server\index.js
pause

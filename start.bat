@echo off
rem WorkBuddy 会把 electron 当 node 跑，清掉
set ELECTRON_RUN_AS_NODE=
cd /d "%~dp0"
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."

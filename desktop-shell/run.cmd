@echo off
rem DSH Desktop launcher - double-click to start
cd /d "%~dp0"
node launcher.mjs %*
if errorlevel 1 pause

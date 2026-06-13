@echo off
rem Visible-console variant for debugging. Normal use: "Open Mission Control.vbs".
cd /d "%~dp0"
start "" http://127.0.0.1:5599
node server.js
pause

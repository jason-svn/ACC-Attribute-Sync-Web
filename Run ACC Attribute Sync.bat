@echo off
cd /d "%~dp0"
echo Starting ACC Attribute Sync server on http://127.0.0.1:8080/ ...
start "ACC Attribute Sync Server (close this window to stop)" cmd /k python -m http.server 8080
timeout /t 1 /nobreak >nul
start http://127.0.0.1:8080/

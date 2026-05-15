@echo off
cd /d "%~dp0"
echo GitHubからオンライン版ツールの最新版を取得します...
git pull --ff-only origin main
pause

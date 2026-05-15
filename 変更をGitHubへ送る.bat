@echo off
cd /d "%~dp0"
echo 変更を確認します...
git status --short
echo.
set /p MSG=コミットメッセージを入力してください:
if "%MSG%"=="" set MSG=chore: online tool update
git add .
git commit -m "%MSG%"
git push origin main
pause

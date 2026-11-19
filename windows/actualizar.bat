@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "PYTHON=python"
if exist "%~dp0python.txt" set /p PYTHON=<"%~dp0python.txt"
echo ================================================== >> "%~dp0registro.txt"
"%PYTHON%" -u "%~dp0sincronizar.py" >> "%~dp0registro.txt" 2>&1

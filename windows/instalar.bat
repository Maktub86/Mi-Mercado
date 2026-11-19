@echo off
chcp 65001 >nul
title Instalar Mi Mercado
echo.
echo  ===== MI MERCADO: revision de precios desde este ordenador =====
echo.

set "DEST=%LOCALAPPDATA%\MiMercado"
if not exist "%DEST%" mkdir "%DEST%"
copy /y "%~dp0sincronizar.py" "%DEST%\" >nul
copy /y "%~dp0actualizar.bat" "%DEST%\" >nul

rem --- 1. Buscar Python
set "PY="
for /f "delims=" %%i in ('py -3 -c "import sys;print(sys.executable)" 2^>nul') do set "PY=%%i"
if not defined PY for /f "delims=" %%i in ('python -c "import sys;print(sys.executable)" 2^>nul') do set "PY=%%i"
if not defined PY for /d %%d in ("%LOCALAPPDATA%\Programs\Python\Python3*") do if exist "%%d\python.exe" set "PY=%%d\python.exe"
if not defined PY (
  echo  No encuentro Python en este ordenador.
  echo  Instalalo desde https://www.python.org/downloads/ y vuelve a abrir este archivo.
  pause
  exit /b 1
)
>"%DEST%\python.txt" echo %PY%
echo  Python encontrado: %PY%
echo.

rem --- 2. Clave de GitHub
if exist "%DEST%\token.txt" (
  set /p CAMBIAR=" Ya hay una clave guardada. Escribe S para cambiarla o pulsa Enter para mantenerla: "
) else (
  set "CAMBIAR=S"
)
if /i "%CAMBIAR%"=="S" (
  echo  Pega la clave de GitHub (clic derecho para pegar^) y pulsa Enter:
  set /p TOKEN=" > "
)
if /i "%CAMBIAR%"=="S" (
  >"%DEST%\token.txt" <nul set /p ="%TOKEN%"
)
echo.

rem --- 3. Tarea programada: cada dia a las 22:00, y al encender si se paso la hora
copy /y "%~dp0tarea.ps1" "%DEST%\" >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%DEST%\tarea.ps1"
if errorlevel 1 (
  echo  No se pudo crear la tarea programada.
) else (
  echo  Tarea programada creada: todos los dias a las 22:00.
  echo  Si a esa hora el ordenador esta apagado, se hara al encenderlo.
)

rem --- 4. Acceso directo en el escritorio para revisar cuando quieras
>"%USERPROFILE%\Desktop\Mi Mercado - revisar precios ahora.bat" (
  echo @echo off
  echo call "%DEST%\actualizar.bat"
  echo type "%DEST%\registro.txt" ^| more
  echo pause
)

echo.
echo  Hago una primera revision ahora (tarda unos minutos)...
call "%DEST%\actualizar.bat"
echo.
powershell -NoProfile -Command "Get-Content -Tail 45 -Encoding UTF8 -Path (Join-Path $env:LOCALAPPDATA 'MiMercado\registro.txt')"
echo.
echo  Listo. Puedes cerrar esta ventana.
pause

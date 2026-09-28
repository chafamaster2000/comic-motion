@echo off
REM ============================================================
REM  comic-motion - instalador para Windows
REM  Instala dependencias y deja la skill en
REM  %USERPROFILE%\.claude\skills\comic-motion
REM ============================================================
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul
title comic-motion - instalador

set "SRC=%~dp0"
if "%SRC:~-1%"=="\" set "SRC=%SRC:~0,-1%"
set "DEST=%USERPROFILE%\.claude\skills\comic-motion"

echo.
echo  comic-motion  ^|  motion comics con HTML, CSS y Motion para Claude Code
echo  ------------------------------------------------------------------
echo  Destino: %DEST%
echo.

REM ---------- winget ----------
where winget >nul 2>nul
if errorlevel 1 (
  echo [!] No encontre winget. Instala "App Installer" desde Microsoft Store,
  echo     o instala a mano Node.js LTS y ffmpeg, y volve a correr este script.
  set "NOWINGET=1"
)

REM ---------- Node.js ----------
where node >nul 2>nul
if errorlevel 1 (
  if defined NOWINGET goto :fail_node
  echo [1/6] Instalando Node.js LTS...
  winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
  call :refresh_path
) else (
  echo [1/6] Node.js ya instalado.
)
where node >nul 2>nul || goto :fail_node
for /f "tokens=1 delims=." %%v in ('node -p "process.versions.node"') do set "NODEMAJOR=%%v"
if !NODEMAJOR! LSS 20 (
  echo [!] Tenes Node !NODEMAJOR!; comic-motion necesita Node 20 o mas nuevo.
  echo     Actualiza con: winget upgrade OpenJS.NodeJS.LTS
  goto :fail
)

REM ---------- ffmpeg ----------
where ffmpeg >nul 2>nul
if errorlevel 1 (
  if defined NOWINGET goto :fail_ffmpeg
  echo [2/6] Instalando ffmpeg...
  winget install -e --id Gyan.FFmpeg --accept-source-agreements --accept-package-agreements
  call :refresh_path
) else (
  echo [2/6] ffmpeg ya instalado.
)
where ffmpeg >nul 2>nul || goto :fail_ffmpeg
where ffprobe >nul 2>nul || goto :fail_ffmpeg

REM ---------- Git (Claude Code en Windows usa Git Bash) ----------
where git >nul 2>nul
if errorlevel 1 (
  if not defined NOWINGET (
    echo [3/6] Instalando Git para Windows ^(Claude Code lo necesita^)...
    winget install -e --id Git.Git --accept-source-agreements --accept-package-agreements
    call :refresh_path
  )
) else (
  echo [3/6] Git ya instalado.
)

REM ---------- Claude Code ----------
where claude >nul 2>nul
if errorlevel 1 (
  echo.
  echo [4/6] No encontre Claude Code ^(el comando "claude"^).
  echo       La skill y el boton "Generar variantes" lo necesitan.
  set /p "INSTCLAUDE=      Instalarlo ahora con el instalador oficial? [S/n] "
  if /i not "!INSTCLAUDE!"=="n" (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://claude.ai/install.ps1 | iex"
    call :refresh_path
  ) else (
    echo       Salteado. Instalalo despues: https://docs.claude.com/claude-code
  )
) else (
  echo [4/6] Claude Code ya instalado.
)

REM ---------- copiar la skill ----------
echo [5/6] Copiando la skill a %DEST% ...
if /i "%SRC%"=="%DEST%" (
  echo       Ya estas en la carpeta de destino, no copio nada.
) else (
  if not exist "%USERPROFILE%\.claude\skills" mkdir "%USERPROFILE%\.claude\skills"
  robocopy "%SRC%" "%DEST%" /E /XD node_modules .git dist /XF install.bat install.sh *.local.md /NFL /NDL /NJH /NJS /NP >nul
  if errorlevel 8 (
    echo [!] Fallo la copia con robocopy.
    goto :fail
  )
  copy /y "%SRC%\install.bat" "%DEST%\install.bat" >nul
)

REM ---------- dependencias npm + build + Chromium ----------
echo [6/6] Instalando dependencias (puede tardar unos minutos)...
pushd "%DEST%"
call npm install --no-fund --no-audit
if errorlevel 1 ( popd & goto :fail )
call npm run build
if errorlevel 1 ( popd & goto :fail )
call npx playwright install chromium
if errorlevel 1 ( popd & goto :fail )

echo.
echo Verificando...
node bin\comic.js presets >nul
if errorlevel 1 ( popd & goto :fail )
popd

echo.
echo  ==================================================================
echo   Listo. comic-motion quedo instalada como skill de Claude Code.
echo.
echo   Abri una terminal NUEVA, entra a una carpeta de trabajo y corre:
echo       claude
echo   Despues pedile, por ejemplo:
echo       "hagamos un motion comic con estas imagenes: C:\ruta\a\mis\imagenes"
echo.
echo   CLI directa:  node "%DEST%\bin\comic.js" help
echo  ==================================================================
echo.
pause
exit /b 0

REM ---------- helpers ----------
:refresh_path
for /f "usebackq delims=" %%p in (`powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')"`) do set "PATH=%%p"
exit /b 0

:fail_node
echo [!] No hay Node.js. Instalalo desde https://nodejs.org ^(LTS^) y volve a correr este script.
goto :fail

:fail_ffmpeg
echo [!] No hay ffmpeg/ffprobe en el PATH. Instalalo ^(winget install Gyan.FFmpeg^),
echo     abri una terminal nueva y volve a correr este script.
goto :fail

:fail
echo.
echo  La instalacion no termino. Revisa el mensaje de arriba.
echo.
pause
exit /b 1

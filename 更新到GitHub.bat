@echo off
title Publish to GitHub

REM ============================================================
REM  Publish local changes to GitHub (Actions then deploys Pages)
REM ------------------------------------------------------------
REM  ASCII-ONLY FILE, CRLF line endings. Do NOT add non-ASCII text:
REM  cmd.exe reads .bat with the OEM codepage (GBK on zh-CN), and
REM  UTF-8 Chinese corrupts line parsing -> the window flashes and
REM  closes with no message. Same rule as start-admin.bat.
REM
REM  The real work lives in tools\publish.py, which:
REM    1. syncs notes/ + assets/uploads/ into docs/
REM    2. runs a local "mkdocs build --strict" as a pre-flight check
REM    3. commits with an auto-generated message
REM    4. pushes to origin/main with retries (this network is flaky)
REM    5. waits for the GitHub Actions deploy and prints the result
REM
REM  Flags are forwarded, e.g.:
REM    --dry-run    rehearse only: stage, no commit, no push
REM    --no-build   skip the local pre-flight build
REM    --no-wait    do not wait for the deploy to finish
REM    -m "msg"     custom commit message
REM ============================================================

cd /d "%~dp0"

if not exist "tools\publish.py" (
    echo [ERROR] tools\publish.py not found next to this script.
    pause
    exit /b 1
)

REM ---- force UTF-8 for every Python child process ----
REM Chinese Windows defaults to GBK (cp936) for console and pipes, and GBK cannot
REM encode emoji. publish.py prints emoji in its summary, so without this it dies
REM with UnicodeEncodeError before doing anything useful.
set "PYTHONIOENCODING=utf-8"
set "PYTHONUTF8=1"

REM ---- pick a Python interpreter (venv first, then the usual suspects) ----
set "PYEXE="
if exist ".venv\Scripts\python.exe" set "PYEXE=.venv\Scripts\python.exe"

if not defined PYEXE (
    where py >nul 2>nul
    if not errorlevel 1 set "PYEXE=py -3"
)

if not defined PYEXE (
    where python >nul 2>nul
    if not errorlevel 1 set "PYEXE=python"
)

if not defined PYEXE (
    if exist "%USERPROFILE%\.workbuddy\binaries\python\versions\3.13.12\python.exe" set "PYEXE=%USERPROFILE%\.workbuddy\binaries\python\versions\3.13.12\python.exe"
)

if not defined PYEXE (
    echo [ERROR] No Python interpreter found.
    echo         Tried: .venv ^| py -3 ^| python ^| managed 3.13.12
    echo         Install Python or add it to PATH, then run this again.
    pause
    exit /b 1
)

echo Publishing to GitHub
echo   interpreter : %PYEXE%
echo   repository  : deus-088/secnotes
echo   site        : https://deus-088.github.io/secnotes/
echo.

%PYEXE% "tools\publish.py" %*
set "RC=%ERRORLEVEL%"

echo.
if "%RC%"=="0" (
    echo Done.
) else (
    echo Failed with exit code %RC% - nothing was lost, rerun when ready.
)
echo Press any key to close this window.
pause >nul
exit /b %RC%

@echo off
rem PicJot Wi-Fi receiver: double-click to start it in the background (an icon by the clock).
rem With arguments (e.g. --to "E:\Photos") it runs in this window instead; close the window to stop.
if not "%~1"=="" (
  node "%~dp0receiver.js" %*
  if errorlevel 1 pause
  goto :eof
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0receiver-tray.ps1"
if errorlevel 1 pause

@echo off
rem PicJot Wi-Fi receiver: double-click, then pair or back up from the phone. Close this window to stop.
node "%~dp0receiver.js" %*
if errorlevel 1 pause

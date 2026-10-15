@echo off
rem PicJot backup: double-click to back up phone photos to your chosen folder.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0launcher.ps1" %*

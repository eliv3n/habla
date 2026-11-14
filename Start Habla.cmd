@echo off
rem Starts the local Habla server (in a minimized window) and opens the app in Microsoft Edge.
rem Optional arguments are passed on to the server, for example:  "Start Habla.cmd" -Port 9000
start "Habla server - close this window to stop" /min powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\serve.ps1" %*

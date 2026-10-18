@echo off
title Dex - AI Coding Agent Launcher
echo ====================================================
echo Starting Dex - AI Coding Agent Desktop (Tauri v2)...
echo ====================================================
cd /d "%~dp0"
npm run tauri dev
pause

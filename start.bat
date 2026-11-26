@echo off
setlocal
cd /d "%~dp0"
title Play Live
echo Iniciando Play Live...
echo.
node --env-file-if-exists=.env src/server.js
echo.
echo O servidor parou. Pressione qualquer tecla para fechar.
pause >nul

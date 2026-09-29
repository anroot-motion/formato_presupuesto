@echo off
rem Demo local del Generador de Propuestas en modo EN LINEA, con el mismo Worker que
rem se despliega en Cloudflare y D1/R2 emulados (SQLite + carpeta). Requiere Node 22.13+.
rem Los datos quedan en backend\.datos-locales (borrar esa carpeta = empezar de cero).
cd /d "%~dp0backend"
where node >nul 2>nul || (echo No encontre Node.js. Instala la version LTS desde nodejs.org y vuelve a intentar. & pause & exit /b 1)
start "" http://localhost:8080
node --no-warnings pruebas\emulador-cloudflare.mjs 8080
pause

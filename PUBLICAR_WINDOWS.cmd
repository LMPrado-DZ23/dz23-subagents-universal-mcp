@echo off
setlocal
pushd "%~dp0"
if errorlevel 1 (
    echo ERRO: nao foi possivel abrir a pasta deste pacote.
    pause
    exit /b 1
)
echo DZ23 Subagents MCP v3.0.0 - publicacao no GitHub
echo Requer Node.js 22+, Git e GitHub CLI autenticado neste computador.
echo Todos os testes e verificacoes precisam passar antes da publicacao.
echo.
node ".\scripts\publish-github.mjs" --public
set "RESULT=%ERRORLEVEL%"
echo.
if not "%RESULT%"=="0" echo INTERROMPIDO. Leia o erro acima. Nao apague repositorios nem desabilite testes.
if "%RESULT%"=="0" echo Confira PUBLISHED=TRUE e o endereco retornado pelo publicador acima.
popd
pause
exit /b %RESULT%

# Script para rodar a importação completa
# Uso: .\run-import.ps1
# Os dados já foram baixados e extraidos. Este script importa no MongoDB.

Write-Host "=============================================" -ForegroundColor Cyan
Write-Host "  Importação B2B Leads - Receita Federal" -ForegroundColor Cyan
Write-Host "=============================================" -ForegroundColor Cyan
Write-Host ""

Set-Location $PSScriptRoot

$env:SKIP_EXTRACT = "1"

Write-Host "Iniciando importação (pode levar várias horas)..." -ForegroundColor Yellow
Write-Host "Ctrl+C para pausar. Pode reiniciar sem perder progresso." -ForegroundColor DarkGray
Write-Host ""

node import.js

if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "=============================================" -ForegroundColor Green
    Write-Host "  Importação concluída com sucesso!" -ForegroundColor Green
    Write-Host "=============================================" -ForegroundColor Green
} else {
    Write-Host ""
    Write-Host "=============================================" -ForegroundColor Red
    Write-Host "  Importação interrompida. Rode novamente." -ForegroundColor Red
    Write-Host "  Os dados já importados estão salvos." -ForegroundColor Yellow
    Write-Host "=============================================" -ForegroundColor Red
}

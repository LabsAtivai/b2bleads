# Script para rodar a importação manual de um período.
# Uso: .\run-import.ps1 -Periodo 2026-11
# ATENÇÃO: o container "etl" já faz isso todo mês, de forma automática. Não rode os dois ao mesmo tempo.
param([Parameter(Mandatory = $true)][string]$Periodo)

Write-Host "=============================================" -ForegroundColor Cyan
Write-Host "  Importação B2B Leads - Receita Federal" -ForegroundColor Cyan
Write-Host "=============================================" -ForegroundColor Cyan
Write-Host ""

Set-Location $PSScriptRoot

$env:SKIP_EXTRACT = "1"

Write-Host "Iniciando importação (pode levar várias horas)..." -ForegroundColor Yellow
Write-Host "Ctrl+C para pausar. Pode reiniciar sem perder progresso." -ForegroundColor DarkGray
Write-Host ""

node etl/import.js $Periodo

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

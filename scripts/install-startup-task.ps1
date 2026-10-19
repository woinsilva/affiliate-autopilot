param([string]$ProjectPath = 'C:\Dev\affiliate-autopilot')
$ErrorActionPreference = 'Stop'
$compose = Join-Path $ProjectPath 'docker-compose.yml'
if (-not (Test-Path -LiteralPath $compose)) { throw "Projeto não encontrado em $ProjectPath" }
$action = New-ScheduledTaskAction -Execute 'docker.exe' -Argument 'compose up -d' -WorkingDirectory $ProjectPath
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 1)
Register-ScheduledTask -TaskName 'Affiliate Autopilot' -Description 'Inicia a plataforma Achadinhos no Docker ao entrar no Windows.' -Action $action -Trigger $trigger -Settings $settings -Force
Write-Host 'Tarefa Affiliate Autopilot instalada. Mantenha o Docker Desktop configurado para iniciar com o Windows.'

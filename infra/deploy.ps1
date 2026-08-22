<#
KINO Roll deployment operations for a Windows server (issue #88).

Wraps infra/docker-compose.prod.yml. Requires Docker with Compose v2 on the
server. PowerShell 5.1 compatible — runs on a stock Windows Server.

  powershell -ExecutionPolicy Bypass -File infra\deploy.ps1 init
  powershell -ExecutionPolicy Bypass -File infra\deploy.ps1 check
  powershell -ExecutionPolicy Bypass -File infra\deploy.ps1 up
  powershell -ExecutionPolicy Bypass -File infra\deploy.ps1 update
  powershell -ExecutionPolicy Bypass -File infra\deploy.ps1 status
  powershell -ExecutionPolicy Bypass -File infra\deploy.ps1 logs -Service api
  powershell -ExecutionPolicy Bypass -File infra\deploy.ps1 backup
  powershell -ExecutionPolicy Bypass -File infra\deploy.ps1 down

  -EnvName staging selects infra/.env.staging (default: production).

init  creates the environment file from its example and replaces every
      change-me placeholder with a freshly generated secret — the same token
      gets the same value everywhere, so DATABASE_URL/REDIS_URL stay
      consistent with POSTGRES_PASSWORD/REDIS_PASSWORD. You still edit
      KINO_SITE_ADDRESS and PUBLIC_BASE_URL by hand.
check validates docker, the env file, and the compose interpolation.
up    builds and starts the stack, then waits for the api and web
      containers to report healthy.
update = git pull --ff-only + up.
backup writes a pg_dump SQL file to infra\backups\. Object storage lives in
      the MinIO volume; see infra/scripts/backup.sh for the full drill.
down  stops the stack. Volumes are always preserved.
#>
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidateSet('init', 'check', 'up', 'update', 'status', 'logs', 'backup', 'down')]
  [string]$Action,

  [ValidateSet('production', 'staging')]
  [string]$EnvName = 'production',

  [string]$Service = ''
)

$ErrorActionPreference = 'Stop'
$infraDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $infraDir
$composeFile = Join-Path $infraDir 'docker-compose.prod.yml'
$envFile = Join-Path $infraDir (".env.$EnvName")
if ($EnvName -eq 'production') {
  $exampleFile = Join-Path $infraDir '.env.prod.example'
} else {
  $exampleFile = Join-Path $infraDir '.env.staging.example'
}

function Invoke-Compose {
  param([string[]]$ComposeArgs)
  & docker compose --env-file $envFile -f $composeFile @ComposeArgs
  if ($LASTEXITCODE -ne 0) { throw "docker compose $($ComposeArgs -join ' ') failed ($LASTEXITCODE)" }
}

function New-Secret {
  param([int]$Bytes = 32)
  $buffer = New-Object byte[] $Bytes
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  $rng.GetBytes($buffer)
  return (($buffer | ForEach-Object { $_.ToString('x2') }) -join '')
}

function Read-EnvValue {
  param([string]$Key, [string]$Fallback)
  if (Test-Path $envFile) {
    $line = Select-String -Path $envFile -Pattern ("^" + [regex]::Escape($Key) + "=(.+)$") | Select-Object -First 1
    if ($line) { return $line.Matches[0].Groups[1].Value.Trim() }
  }
  return $Fallback
}

function Assert-Ready {
  $null = & docker version --format '{{.Server.Version}}' 2>$null
  if ($LASTEXITCODE -ne 0) { throw 'Docker is not running or not installed on this server.' }
  $null = & docker compose version 2>$null
  if ($LASTEXITCODE -ne 0) { throw 'Docker Compose v2 is not available (docker compose).' }
  if (-not (Test-Path $envFile)) {
    throw "Missing $envFile - run: deploy.ps1 init -EnvName $EnvName"
  }
  $leftover = Select-String -Path $envFile -Pattern 'change-me'
  if ($leftover) {
    throw "$envFile still contains change-me placeholders on line(s): $(($leftover | ForEach-Object { $_.LineNumber }) -join ', ')"
  }
  Invoke-Compose @('config', '--quiet')
  Write-Host "OK: docker, $((Split-Path -Leaf $envFile)), compose interpolation." -ForegroundColor Green
}

function Wait-Healthy {
  param([string[]]$Services, [int]$TimeoutSec = 420)
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  foreach ($svc in $Services) {
    Write-Host "waiting for $svc to report healthy..."
    while ($true) {
      $id = (& docker compose --env-file $envFile -f $composeFile ps -q $svc) 2>$null
      if ($id) {
        $state = (& docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' $id) 2>$null
        if ($state -eq 'healthy') { Write-Host "  $svc healthy" -ForegroundColor Green; break }
        if ($state -eq 'exited' -or $state -eq 'dead') { throw "$svc exited during startup - check: deploy.ps1 logs -Service $svc" }
      }
      if ((Get-Date) -gt $deadline) { throw "$svc did not become healthy within $TimeoutSec s" }
      Start-Sleep -Seconds 5
    }
  }
}

switch ($Action) {
  'init' {
    if (Test-Path $envFile) {
      $leftover = Select-String -Path $envFile -Pattern 'change-me'
      Write-Host "$envFile already exists - not overwriting." -ForegroundColor Yellow
      if ($leftover) { Write-Host "It still contains change-me placeholders on line(s): $(($leftover | ForEach-Object { $_.LineNumber }) -join ', ')" -ForegroundColor Yellow }
      break
    }
    $content = [System.IO.File]::ReadAllText($exampleFile)
    # Each distinct placeholder gets one fresh secret used everywhere it
    # appears, keeping DATABASE_URL/REDIS_URL consistent with the passwords.
    $tokens = [regex]::Matches($content, 'change-me[a-z0-9-]*') | ForEach-Object { $_.Value } | Sort-Object -Unique
    foreach ($token in $tokens) {
      $content = $content.Replace($token, (New-Secret))
    }
    [System.IO.File]::WriteAllText($envFile, $content)
    Write-Host "Wrote $envFile with generated secrets." -ForegroundColor Green
    Write-Host 'Now edit it and set KINO_SITE_ADDRESS and PUBLIC_BASE_URL to the real hostname, then run: deploy.ps1 check'
  }
  'check' {
    Assert-Ready
  }
  'up' {
    Assert-Ready
    Invoke-Compose @('up', '-d', '--build')
    Wait-Healthy @('api', 'web')
    $site = Read-EnvValue 'KINO_SITE_ADDRESS' 'localhost'
    Write-Host "Stack is up. Verify externally: https://$site/api/healthz , https://$site/ , https://$site/studio/" -ForegroundColor Green
  }
  'update' {
    Push-Location $repoRoot
    try {
      & git pull --ff-only
      if ($LASTEXITCODE -ne 0) { throw 'git pull --ff-only failed - resolve the working tree first.' }
    } finally { Pop-Location }
    Assert-Ready
    Invoke-Compose @('up', '-d', '--build')
    Wait-Healthy @('api', 'web')
    Write-Host 'Updated and healthy.' -ForegroundColor Green
  }
  'status' {
    Invoke-Compose @('ps')
  }
  'logs' {
    if ($Service) { Invoke-Compose @('logs', '--tail', '200', '-f', $Service) }
    else { Invoke-Compose @('logs', '--tail', '200', '-f') }
  }
  'backup' {
    Assert-Ready
    $backupDir = Join-Path $infraDir 'backups'
    if (-not (Test-Path $backupDir)) { New-Item -ItemType Directory -Path $backupDir | Out-Null }
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $outFile = Join-Path $backupDir ("kino-$EnvName-$stamp.sql")
    $dbUser = Read-EnvValue 'POSTGRES_USER' 'kino'
    $dbName = Read-EnvValue 'POSTGRES_DB' 'kino'
    # cmd.exe redirection keeps the dump byte-faithful; PowerShell's own
    # redirection re-encodes text streams.
    & cmd /c "docker compose --env-file `"$envFile`" -f `"$composeFile`" exec -T postgres pg_dump -U $dbUser -d $dbName > `"$outFile`""
    if ($LASTEXITCODE -ne 0) { throw 'pg_dump failed - is the stack running?' }
    Write-Host "Database dump: $outFile" -ForegroundColor Green
    Write-Host 'Object storage (MinIO volume) is not in this dump - see infra/scripts/backup.sh for the full drill.'
  }
  'down' {
    Invoke-Compose @('down')
    Write-Host 'Stack stopped. Volumes (database, object storage, TLS certificates) are preserved.' -ForegroundColor Green
  }
}

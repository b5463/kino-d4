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
  -Relay   adds infra/relay/docker-compose.relay.yml to EVERY action.

-Relay is not optional decoration on a relay deployment. Without it `up`
renders the production file alone, which drops the frpc container and
republishes 80/443 on the host. On the operator's PC those ports are held by
the Bitnami `wordpressApache-1` service, so that `up` fails on a port
allocation error and the site stays down. Pass -Relay on every command for a
stack reached through infra/relay/, `down` and `logs` included.

init  creates the environment file from its example and replaces every
      change-me placeholder with a freshly generated secret — the same token
      gets the same value everywhere, so DATABASE_URL/REDIS_URL stay
      consistent with POSTGRES_PASSWORD/REDIS_PASSWORD. You still edit
      KINO_SITE_ADDRESS and PUBLIC_BASE_URL by hand.
check validates docker, the env file, and the compose interpolation.
up    builds and starts the stack, then waits for the api and web
      containers to report healthy.
update = git pull --ff-only + up.
backup writes a pg_dump SQL file to infra\backups\. That is a catalogue, not
      a photo library - the objects live in the MinIO volume. For the real
      thing, which mirrors both buckets alongside the dump, use
      infra\backup-task.ps1: register it once and it runs daily, and its
      `verify` answers whether last night's snapshot is fresh and non-empty.
down  stops the stack. Volumes are always preserved.
#>
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidateSet('init', 'check', 'up', 'update', 'status', 'logs', 'backup', 'down')]
  [string]$Action,

  [ValidateSet('production', 'staging')]
  [string]$EnvName = 'production',

  # Drive the PC-behind-a-relay-VPS stack (infra/relay/). See the note above:
  # every action needs it, not only `up`.
  [switch]$Relay,

  [string]$Service = ''
)

$ErrorActionPreference = 'Stop'
$infraDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $infraDir
$composeFile = Join-Path $infraDir 'docker-compose.prod.yml'
$relayFile = Join-Path $infraDir 'relay\docker-compose.relay.yml'
$envFile = Join-Path $infraDir (".env.$EnvName")

# One file list, built once, used by every docker compose call below. The relay
# overlay's bind mounts are written relative to infra/ on purpose, because
# Compose resolves relative paths against the FIRST -f file's directory.
$composeArgs = @('-f', $composeFile)
if ($Relay) {
  if (-not (Test-Path $relayFile)) { throw "Missing relay overlay: $relayFile" }
  $composeArgs += @('-f', $relayFile)
}
if ($EnvName -eq 'production') {
  $exampleFile = Join-Path $infraDir '.env.prod.example'
} else {
  $exampleFile = Join-Path $infraDir '.env.staging.example'
}

function Invoke-Compose {
  param([string[]]$ComposeArgs)
  & docker compose --env-file $envFile @composeArgs @ComposeArgs
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
  <#
    Only live assignments count. The shipped example carries a commented
    `#CLOUDFLARE_TUNNEL_TOKEN=change-me-...`, which is a documented value for a
    path this deployment does not use - matching it refused a correctly filled
    environment and would have stopped a deployment for nothing. Report the KEY
    names too: on the day, "RELAY_HOST" is the answer and a line number is a
    lookup.
  #>
  $leftover = Get-Content $envFile |
    Where-Object { $_ -notmatch '^\s*#' -and $_ -match 'change-me' } |
    ForEach-Object { ($_ -split '=', 2)[0].Trim() }
  if ($leftover) {
    throw "$envFile still needs a real value for: $($leftover -join ', ')"
  }
  Invoke-Compose @('config', '--quiet')
  $shape = if ($Relay) { 'production + relay overlay (no host ports at all)' } else { 'production (proxy publishes 80/443 on this host)' }
  Write-Host "OK: docker, $((Split-Path -Leaf $envFile)), compose interpolation. Shape: $shape." -ForegroundColor Green

  <#
    Without -Relay the proxy publishes KINO_HTTP_PORT/KINO_HTTPS_PORT on the
    host, and `up` then fails outright if something already holds them. Say so
    before a ten-minute build gets there. netstat rather than
    Get-NetTCPConnection, so this still runs on a stock PowerShell 5.1.
  #>
  if (-not $Relay) {
    $httpPort = Read-EnvValue 'KINO_HTTP_PORT' '80'
    $httpsPort = Read-EnvValue 'KINO_HTTPS_PORT' '443'
    foreach ($port in @($httpPort, $httpsPort)) {
      $pattern = '^\s+TCP\s+\S+:' + [regex]::Escape($port) + '\s+\S+\s+LISTENING\s+(\d+)'
      $held = & netstat -ano -p TCP | Select-String -Pattern $pattern
      if ($held) {
        $owners = ($held | ForEach-Object { $_.Matches[0].Groups[1].Value } | Sort-Object -Unique) -join ', '
        Write-Host "WARNING: TCP $port is already LISTENING (PID $owners). 'up' without -Relay cannot allocate it." -ForegroundColor Yellow
        Write-Host "         Stop that listener, or run the relay shape: deploy.ps1 up -Relay" -ForegroundColor Yellow
      }
    }
  }
}

function Wait-Healthy {
  param([string[]]$Services, [int]$TimeoutSec = 420)
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  foreach ($svc in $Services) {
    Write-Host "waiting for $svc to report healthy..."
    while ($true) {
      $id = (& docker compose --env-file $envFile @composeArgs ps -q $svc) 2>$null
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
    if ($Relay) {
      # frpc has no healthcheck: "connected" is a log line, not a container
      # state. Print it rather than let a running container imply a tunnel.
      Write-Host 'Relay client log - look for "login to server success":' -ForegroundColor Cyan
      Invoke-Compose @('logs', '--tail', '20', 'relay')
      $base = Read-EnvValue 'PUBLIC_BASE_URL' "https://$site"
      Write-Host "Stack is up. Verify from a phone on mobile data: $base/api/healthz , $base/ , $base/studio/" -ForegroundColor Green
    } else {
      Write-Host "Stack is up. Verify externally: https://$site/api/healthz , https://$site/ , https://$site/studio/" -ForegroundColor Green
    }
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
    # Only the production file here, deliberately: the project name comes from
    # `name: kino-${KINO_ENV}` in it, so `exec` finds the running postgres with
    # or without the relay overlay and the dump does not depend on the shape.
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

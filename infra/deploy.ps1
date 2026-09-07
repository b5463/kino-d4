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
  powershell -ExecutionPolicy Bypass -File infra\deploy.ps1 drain -Roll amber-001 -Expect 137
  powershell -ExecutionPolicy Bypass -File infra\deploy.ps1 event-backup -Roll amber-001 -BackupRoot D:\kino-backups
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
drain answers the one question at the end of an event: is it safe to shut this
      PC down yet. Needs -Roll <slug>; -Expect <n> adds "and the roll holds the
      number of photographs I counted at the door". Exit code 0 is SAFE TO SHUT
      DOWN, 1 is NOT SAFE and the reasons are printed. See the block above
      `Get-DrainReport` for where the answer comes from and what it cannot see.
event-backup
      one snapshot of BOTH stores for one event, into
      <BackupRoot>\events\<yyyy-MM-dd>-<slug>, then verifies it. It is
      backup-task.ps1 `run` + `verify` with a per-event -BackupRoot, not a third
      backup implementation. A pg_dump alone protects no photograph.
down  stops the stack. Volumes are always preserved.

This deployment is ON-DEMAND EVENT HOSTING: the stack runs on event days and
long enough afterwards for `drain` to pass and `event-backup` to finish, then
the PC may sleep or shut down. It is not a 24/7 service, and nothing here
assumes the machine is awake when nobody is using KINO. The always-on phase and
its dedicated machine are docs/runbooks/origin-machine-move.md.
#>
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidateSet('init', 'check', 'up', 'update', 'status', 'logs', 'backup', 'drain', 'event-backup', 'down')]
  [string]$Action,

  [ValidateSet('production', 'staging')]
  [string]$EnvName = 'production',

  # Drive the PC-behind-a-relay-VPS stack (infra/relay/). See the note above:
  # every action needs it, not only `up`.
  [switch]$Relay,

  [string]$Service = '',

  # The roll's public code, as printed on the QR card and shown on the camera's
  # ROLL screen. `drain` and `event-backup` need it.
  [string]$Roll = '',

  # How many photographs the event should have produced. -1 means "do not
  # check": drain then proves the queue is empty and the originals are here, but
  # not that nothing was missed. Count them at the door if you want that row.
  [int]$Expect = -1,

  # A camera that has not called in for longer than this has not told us
  # anything current, and `drain` refuses to read its last numbers as "done".
  # Firmware heartbeats every 45 s (upload_queue.c), so 180 s is four periods.
  [int]$HeartbeatMaxAgeSec = 180,

  # For `event-backup`: the same off-PC root backup-task.ps1 takes. The event's
  # own directory is created underneath it.
  [string]$BackupRoot = ''
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

<#
  Docker answers and the environment file exists. Nothing about the contents.

  Split out of Assert-Ready for `drain` and `event-backup`: those two talk to a
  stack that is already running and have no business refusing to answer because
  a value belonging to a path this deployment is not using still says change-me.
  Refusing to say whether the photographs are safe is the wrong kind of strict.
#>
function Assert-Docker {
  $null = & docker version --format '{{.Server.Version}}' 2>$null
  if ($LASTEXITCODE -ne 0) { throw 'Docker is not running or not installed on this machine.' }
  $null = & docker compose version 2>$null
  if ($LASTEXITCODE -ne 0) { throw 'Docker Compose v2 is not available (docker compose).' }
  if (-not (Test-Path $envFile)) {
    throw "Missing $envFile - run: deploy.ps1 init -EnvName $EnvName"
  }
}

function Assert-Ready {
  Assert-Docker
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

<#
  ---------------------------------------------------------------- drain -----

  "Is it safe to shut this PC down yet?" has two halves, and both have to be
  answered on the machine that is about to be switched off:

    1. Does any camera still owe this server photographs?
    2. Are the photographs it already sent actually here?

  There were four places to get the first half from, and this is why it is read
  out of the origin's own PostgreSQL:

  * **The camera's own ROLL screen** is the truth about the card - it is the
    only surface that knows `scanComplete` - but it is on a device that is in
    somebody's hands across the room, there are four of them, and it says
    nothing at all about whether the server kept the bytes. It stays the
    confirmation you read at the camera, not the thing a command can answer.
  * **A USB query over KDP** needs the camera cabled to this PC. At the end of
    an event that means collecting four cameras and a cable before anyone can
    answer a question about the server. Excluded.
  * **The host dashboard** shows exactly the right numbers, and reaches them
    through the public URL with a host token in a browser. Both of those are
    things that can be broken at the moment you need the answer, and the public
    ingress is not even decided yet (docs/runbooks/public-ingress-options.md).
  * **The API over the canonical URL** has the same dependency, plus a host
    token on a command line.

  So: `docker compose exec postgres psql`. No token, no browser, no cable, no
  ingress, and it works with the tunnel down - which is precisely the state in
  which somebody wants to know whether it is safe to give up and go to bed.

  What it reads, and what each number means:

  * `roll_devices` carries the last heartbeat each camera sent
    (`POST /api/device/rolls/:rollId/heartbeat`, every 45 s while on a roll).
    Its `queue_pending` is already `pending + cardPending` - the firmware sums
    them before sending, the same figure the ROLL screen calls "waiting"
    (upload_queue.c `heartbeat_tick`) - so the card's backlog is inside this
    number and not missing from it. `upload_paused` is the queue halted on a
    refused credential, the screen's UPLOAD PAUSED.
  * `assets` and `upload_sessions` are the server's side: an asset that is
    neither `ready` nor `failed` is still in flight, an `open` upload session is
    a transfer nobody finished, and a capture with no `ready` original-frame is
    a capture whose photograph is not here.

  What it cannot see, stated plainly:

  * **`scanComplete` is not on the heartbeat wire.** A camera that has just
    booted and not yet counted its card reports 0 waiting, and its screen says
    COUNTING THE CARD. That is why a stale heartbeat fails this check and why
    -Expect exists. Read "All uploaded" on the camera before you believe a zero
    from a camera that was power-cycled minutes ago.
  * **`captures.status` is a cache the API converges on read**
    (`convergeCaptureStatus`, apps/api/src/uploads/uploads.ts). Nothing here
    converges it, so unsettled captures are printed as information and are not
    part of the verdict. Open the host dashboard once and the number settles.
  * A camera that never joined and never called in has no row, so it cannot be
    counted. `drain` reports how many cameras it found; if that is not the
    number of cameras that shot the party, the answer is not yet.
#>
$backupTask = Join-Path $infraDir 'backup-task.ps1'

function Get-RollSlug {
  if ([string]::IsNullOrWhiteSpace($Roll)) {
    throw 'Pass -Roll <slug>: the roll code from the QR card, e.g. -Roll amber-001'
  }
  $slug = $Roll.Trim().ToLower()
  if ($slug -notmatch '^[a-z0-9][a-z0-9-]{1,47}$') {
    throw "Not a roll code: '$Roll'. Codes are lowercase letters, digits and hyphens."
  }
  return $slug
}

<#
  One psql call, one row per line, columns separated by '|'.

  Only the production compose file, deliberately, for the reason `backup` gives:
  the project name comes from `name: kino-${KINO_ENV}` in it, so `exec` finds the
  running postgres with or without the relay overlay.
#>
function Invoke-Psql {
  param([string]$Sql)
  $dbUser = Read-EnvValue 'POSTGRES_USER' 'kino'
  $dbName = Read-EnvValue 'POSTGRES_DB' 'kino'
  $rows = & docker compose --env-file $envFile -f $composeFile exec -T postgres `
    psql -U $dbUser -d $dbName -v ON_ERROR_STOP=1 -At -F '|' -c $Sql
  if ($LASTEXITCODE -ne 0) {
    throw 'psql did not answer. Is the stack up? Check: deploy.ps1 status'
  }
  return @($rows | ForEach-Object { "$_".Trim() } | Where-Object { $_ -ne '' })
}

<#
  How many objects the store actually holds under this roll's prefix.

  Rows in `assets` say an object should exist; this is the only check that says
  one does. Same mechanism `infra/scripts/backup.sh` uses to mirror the buckets:
  `mc` inside the createbucket container, which already has the credentials in
  its environment. Returns -1 when the count could not be taken, so a store that
  refuses to answer is never mistaken for an empty prefix.
#>
function Get-ObjectCount {
  param([string]$RollId)
  $script = 'mc alias set src http://object-storage:9000 "$S3_ACCESS_KEY" "$S3_SECRET_KEY" >/dev/null 2>&1; ' +
    'mc ls --recursive src/"$S3_BUCKET"/rolls/' + $RollId + '/ 2>/dev/null | wc -l'
  $out = & docker compose --env-file $envFile -f $composeFile run --rm --no-deps `
    --entrypoint /bin/sh createbucket -c $script
  if ($LASTEXITCODE -ne 0) { return -1 }
  $last = @($out | ForEach-Object { "$_".Trim() } | Where-Object { $_ -match '^\d+$' }) | Select-Object -Last 1
  if (-not $last) { return -1 }
  return [int]$last
}

function Get-DrainReport {
  param([string]$Slug)

  $rollRows = Invoke-Psql "select id, title, status from rolls where lower(slug) = '$Slug'"
  if ($rollRows.Count -eq 0) { throw "No roll with code '$Slug' in this database." }
  $roll = $rollRows[0].Split('|')
  $rollId = $roll[0]
  Write-Host ""
  Write-Host "Roll $Slug - $($roll[1])  ($rollId, status $($roll[2]))" -ForegroundColor Cyan

  $reasons = New-Object System.Collections.ArrayList

  # ---- what the cameras last said they still owe -------------------------
  $cameraSql = 'select d.serial' +
    ", coalesce(round(extract(epoch from (now() - rd.last_seen_at)))::bigint::text, '')" +
    ", coalesce(rd.queue_pending::text, '')" +
    ", coalesce(rd.queue_uploading::text, '')" +
    ", coalesce(rd.queue_failed::text, '')" +
    ", coalesce(rd.server_state, '')" +
    ", coalesce(rd.upload_paused::text, '')" +
    ", coalesce(rd.firmware_version, '')" +
    ' from roll_devices rd join devices d on d.id = rd.device_id' +
    " where rd.roll_id = '$rollId' order by rd.last_seen_at desc nulls last"
  $cameras = Invoke-Psql $cameraSql

  Write-Host "Cameras on this roll: $($cameras.Count)"
  if ($cameras.Count -eq 0) {
    [void]$reasons.Add('no camera has ever called in on this roll - nothing here can say the queue is empty')
  }
  foreach ($line in $cameras) {
    $c = $line.Split('|')
    $serial = $c[0]
    $ageText = $c[1]
    $waiting = $c[2]
    $uploading = $c[3]
    $failed = $c[4]
    $serverState = $c[5]
    $paused = $c[6]
    $firmware = $c[7]

    if ($ageText -eq '') { $ageLabel = 'never heard from' } else { $ageLabel = "$ageText s ago" }
    if ($waiting -eq '') { $waitingLabel = '?' } else { $waitingLabel = $waiting }
    if ($paused -eq '') { $pausedLabel = 'not reported' } else { $pausedLabel = $paused }
    Write-Host ("  {0,-12} {1,-18} waiting {2,-5} uploading {3,-3} failed {4,-3} server {5,-11} paused {6,-12} fw {7}" -f `
        $serial, $ageLabel, $waitingLabel, $uploading, $failed, $serverState, $pausedLabel, $firmware)

    if ($ageText -eq '') {
      [void]$reasons.Add("$serial has never sent a heartbeat - read its ROLL screen instead")
      continue
    }
    if ([int]$ageText -gt $HeartbeatMaxAgeSec) {
      [void]$reasons.Add("$serial was last heard from $ageText s ago (limit $HeartbeatMaxAgeSec s) - its numbers are not current")
    }
    if ($waiting -eq '' -or $uploading -eq '' -or $failed -eq '') {
      [void]$reasons.Add("$serial reports no queue counters - firmware older than the heartbeat fields")
    } else {
      if ([int]$waiting -ne 0) { [void]$reasons.Add("$serial still has $waiting waiting to upload (card backlog included)") }
      if ([int]$uploading -ne 0) { [void]$reasons.Add("$serial is uploading $uploading right now") }
      if ([int]$failed -ne 0) { [void]$reasons.Add("$serial has $failed parked as failed - retry them from Studio before shutting down") }
    }
    if ($paused -eq 't') {
      [void]$reasons.Add("$serial says UPLOAD PAUSED - this server refused its credential and it will never clear itself")
    }
    if ($serverState -eq 'unreachable') {
      [void]$reasons.Add("$serial cannot reach this server - it has photographs it has not been able to send")
    }
  }

  # ---- what this server actually holds -----------------------------------
  $serverSql = "select (select count(*) from captures where roll_id = '$rollId' and deleted_at is null)" +
    ", (select count(*) from captures where roll_id = '$rollId' and deleted_at is null and status not in ('ready','partial','failed'))" +
    ", (select count(*) from captures c where c.roll_id = '$rollId' and c.deleted_at is null and not exists" +
    "     (select 1 from assets a where a.capture_id = c.id and a.role = 'original-frame' and a.status = 'ready'))" +
    ", (select count(*) from assets a join captures c on c.id = a.capture_id where c.roll_id = '$rollId'" +
    "     and a.status <> 'ready' and a.status <> 'failed')" +
    ", (select count(*) from upload_sessions s join assets a on a.id = s.asset_id" +
    "     join captures c on c.id = a.capture_id where c.roll_id = '$rollId' and s.status = 'open')" +
    ", (select count(*) from assets a join captures c on c.id = a.capture_id where c.roll_id = '$rollId' and a.status = 'ready')" +
    ", (select count(*) from captures c where c.roll_id = '$rollId' and c.deleted_at is null and" +
    "     (select count(*) from assets a where a.capture_id = c.id and a.role = 'original-frame' and a.status = 'ready') < c.frame_count)"
  $s = (Invoke-Psql $serverSql)[0].Split('|')
  $captureCount = [int]$s[0]
  $unsettled = [int]$s[1]
  $noOriginal = [int]$s[2]
  $assetsInFlight = [int]$s[3]
  $openSessions = [int]$s[4]
  $readyAssets = [int]$s[5]
  $shortOriginals = [int]$s[6]

  Write-Host "Captures on the server: $captureCount"
  Write-Host "  captures with no original yet: $noOriginal"
  Write-Host "  assets still in flight:        $assetsInFlight"
  Write-Host "  upload sessions still open:    $openSessions"
  Write-Host "  assets ready:                  $readyAssets"

  $objects = Get-ObjectCount $rollId
  if ($objects -lt 0) {
    Write-Host '  objects under this roll:       could not be counted' -ForegroundColor Yellow
    [void]$reasons.Add('the object store did not answer - a row is not a photograph, so this is not a pass')
  } else {
    Write-Host "  objects under this roll:       $objects"
    if ($objects -lt $readyAssets) {
      [void]$reasons.Add("the store holds $objects objects for $readyAssets ready assets - something the database claims is not in the bucket")
    }
  }

  if ($noOriginal -gt 0) { [void]$reasons.Add("$noOriginal captures have no original-frame on this server") }
  if ($assetsInFlight -gt 0) { [void]$reasons.Add("$assetsInFlight assets are still in flight") }
  if ($openSessions -gt 0) { [void]$reasons.Add("$openSessions upload sessions are still open") }

  if ($Expect -ge 0) {
    Write-Host "  expected captures:             $Expect"
    if ($captureCount -ne $Expect) {
      [void]$reasons.Add("the roll holds $captureCount captures and you expected $Expect")
    }
  } else {
    Write-Host '  expected captures:             not given (-Expect <n> checks it)'
  }

  # Information, not a gate: see the block above this function.
  Write-Host "  captures not settled yet:      $unsettled (converges when the dashboard is read; not part of the verdict)"
  if ($shortOriginals -gt 0) {
    Write-Host "  captures with fewer ready originals than frame_count: $shortOriginals (informational - the API does not require the full set)"
  }

  Write-Host ''
  if ($reasons.Count -eq 0) {
    Write-Host 'VERDICT: SAFE TO SHUT DOWN' -ForegroundColor Green
    Write-Host "Take the event backup first:  deploy.ps1 event-backup -Roll $Slug -BackupRoot <off-PC path>"
    Write-Host 'One last look at each camera: the ROLL screen should read "All uploaded", not "COUNTING THE CARD".'
    return 0
  }
  Write-Host 'VERDICT: NOT SAFE - do not shut down yet' -ForegroundColor Red
  foreach ($reason in $reasons) { Write-Host "  - $reason" -ForegroundColor Yellow }
  Write-Host 'Leave the stack up and run this again. Nothing is lost while you wait: the card keeps the photographs.'
  return 1
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
  'drain' {
    $slug = Get-RollSlug
    Assert-Docker
    $code = Get-DrainReport $slug
    exit ([int]($code | Select-Object -Last 1))
  }
  'event-backup' {
    <#
      One event, one snapshot of both stores, in a directory named after the
      date and the roll.

      Neither script needed changing to do this: `-BackupRoot` is just a root,
      and backup.sh writes `daily/<UTC stamp>` under whatever root it is given.
      Pointing it at a per-event directory is therefore the whole feature, and
      `verify` then answers about that event rather than about last night.

      Retention is left at backup-task.ps1's defaults on purpose. This root
      holds one snapshot, so there is nothing to prune, and a small -KeepDaily
      here would mean a second run of the same event silently deleting the
      first.
    #>
    $slug = Get-RollSlug
    if ([string]::IsNullOrWhiteSpace($BackupRoot)) {
      throw 'Pass -BackupRoot: a path on a disk that is not this PC''s only copy.'
    }
    if (-not [System.IO.Path]::IsPathRooted($BackupRoot)) {
      throw "-BackupRoot must be an absolute path; got '$BackupRoot'."
    }
    if (-not (Test-Path $backupTask)) { throw "Missing $backupTask" }
    Assert-Docker

    $eventRoot = Join-Path (Join-Path $BackupRoot 'events') ((Get-Date -Format 'yyyy-MM-dd') + "-$slug")
    Write-Host "Event backup into $eventRoot" -ForegroundColor Cyan
    # No exit-code check: backup-task.ps1 throws on failure and this script runs
    # with $ErrorActionPreference = 'Stop', so a failed run stops here with the
    # backup script's own message. Its log is under $eventRoot\logs.
    & $backupTask run -BackupRoot $eventRoot -EnvName $EnvName
    & $backupTask verify -BackupRoot $eventRoot -EnvName $EnvName
    Write-Host "Event backup verified: PostgreSQL dump and both bucket mirrors under $eventRoot" -ForegroundColor Green
    Write-Host 'The daily task (backup-task.ps1 register) is a different thing and still worth having.'
  }
  'down' {
    Invoke-Compose @('down')
    Write-Host 'Stack stopped. Volumes (database, object storage, TLS certificates) are preserved.' -ForegroundColor Green
    Write-Host 'After an event, `drain` and `event-backup` come before this. If you ran it first, start the stack again and run them.'
  }
}

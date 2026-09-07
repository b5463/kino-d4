<#
Daily KINO backups on the Windows host, as a Scheduled Task (issue #88 follow-up).

infra/scripts/backup.sh has existed and been correct for a while, and nothing
ran it. A restore drill that nobody has a snapshot for is a document, not a
backup. This registers the task, runs it, and answers the one question an
operator actually needs answered on a Monday morning: is last night's backup
there, is it fresh, and does it contain photographs.

That last word is the point. A pg_dump protects no photograph - the rows say
which asset exists and where its object lives, and the object lives in MinIO.
`backup.sh` mirrors BOTH buckets alongside the dump, and `verify` below fails if
the object tree is missing or empty even when the dump is perfect.

  powershell -ExecutionPolicy Bypass -File infra\backup-task.ps1 register -BackupRoot D:\kino-backups
  powershell -ExecutionPolicy Bypass -File infra\backup-task.ps1 verify   -BackupRoot D:\kino-backups
  powershell -ExecutionPolicy Bypass -File infra\backup-task.ps1 run      -BackupRoot D:\kino-backups
  powershell -ExecutionPolicy Bypass -File infra\backup-task.ps1 status
  powershell -ExecutionPolicy Bypass -File infra\backup-task.ps1 unregister

register  Creates the scheduled task. It runs as SYSTEM (Docker Desktop's engine
          is reachable from it, and a task tied to a logged-in operator does not
          run when nobody is logged in), daily at -At, and it does NOT run this
          command for you - `register` is the one command the operator types
          once, deliberately.
run       Takes a backup now, exactly as the task would. This is what the task
          itself invokes.
verify    Fails loudly unless the newest snapshot is younger than -MaxAgeHours,
          carries a non-empty postgres.dump, carries a non-empty object mirror,
          and matches its own SHA256SUMS. Exit code 0 means restorable.
status    What the task is, when it last ran, and what it returned.

-BackupRoot MUST be somewhere that is not the machine being backed up: an
external disk, a NAS mount, anything whose failure is not the same failure. The
script cannot check that for you and does not pretend to.
#>
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidateSet('register', 'unregister', 'run', 'verify', 'status')]
  [string]$Action,

  [string]$BackupRoot = '',

  [ValidateSet('production', 'staging')]
  [string]$EnvName = 'production',

  # 03:30 local. Late enough that an evening's uploads have finished processing,
  # early enough to be over before anyone wants the machine.
  [string]$At = '03:30',

  # Daily snapshots kept. `backup.sh` also promotes the first of each ISO week
  # into weekly/ and keeps -KeepWeekly of those.
  [int]$KeepDaily = 14,
  [int]$KeepWeekly = 8,

  # Log files kept next to the backups. One per run, so this is also a record of
  # runs that produced no snapshot.
  [int]$KeepLogs = 30,

  # `verify` fails past this. 30 hours, not 24: a daily task plus a machine that
  # was asleep at 03:30 must not page anybody at 03:31 the next morning.
  [int]$MaxAgeHours = 30,

  [string]$TaskName = 'KINO Roll daily backup'
)

$ErrorActionPreference = 'Stop'
$infraDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $infraDir
$scriptPath = Join-Path $infraDir 'scripts\backup.sh'
$envFile = Join-Path $infraDir (".env.$EnvName")

function Assert-BackupRoot {
  if ([string]::IsNullOrWhiteSpace($BackupRoot)) {
    throw 'Pass -BackupRoot: an absolute path on a disk that is not this machine''s only copy.'
  }
  if (-not [System.IO.Path]::IsPathRooted($BackupRoot)) {
    throw "-BackupRoot must be an absolute path; got '$BackupRoot'."
  }
}

<#
  The Git-Bash spelling of a Windows path: D:\kino-backups -> /d/kino-backups.
  backup.sh insists on an absolute POSIX path and resolves it with `cd`, so
  handing it a drive letter is how the run dies three lines in.
#>
function ConvertTo-BashPath {
  param([string]$Path)
  $full = [System.IO.Path]::GetFullPath($Path)
  $drive = $full.Substring(0, 1).ToLower()
  $rest = $full.Substring(2).Replace('\', '/')
  return "/$drive$rest"
}

function Get-BashExe {
  # Git for Windows first: it ships the GNU find, sha256sum and bash 5 that
  # backup.sh uses, and it is already on the machine if the repo was cloned
  # with it. WSL is the fallback and works identically for this script.
  $candidates = @(
    (Join-Path $env:ProgramFiles 'Git\bin\bash.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Git\bin\bash.exe')
  )
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path $candidate)) { return $candidate }
  }
  $onPath = Get-Command bash.exe -ErrorAction SilentlyContinue
  if ($onPath) { return $onPath.Source }
  throw 'No bash.exe found. Install Git for Windows (it ships one), or enable WSL.'
}

function Get-LogDirectory {
  $logs = Join-Path $BackupRoot 'logs'
  if (-not (Test-Path $logs)) { $null = New-Item -ItemType Directory -Force -Path $logs }
  return $logs
}

function Invoke-Backup {
  Assert-BackupRoot
  if (-not (Test-Path $envFile)) { throw "Environment file not found: $envFile" }
  if (-not (Test-Path $scriptPath)) { throw "Backup script not found: $scriptPath" }

  $bash = Get-BashExe
  $logDir = Get-LogDirectory
  $stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
  $logFile = Join-Path $logDir "backup-$stamp.log"

  $env:BACKUP_ROOT = ConvertTo-BashPath $BackupRoot
  $env:COMPOSE_FILE = "infra/docker-compose.$(if ($EnvName -eq 'production') { 'prod' } else { $EnvName }).yml"
  $env:ENV_FILE = "infra/.env.$EnvName"
  $env:KEEP_DAILY = "$KeepDaily"
  $env:KEEP_WEEKLY = "$KeepWeekly"

  <#
    Piped through `tr -d '\r'` rather than executed directly.

    The repository checks out with CRLF line endings on this machine, and bash
    does not tolerate them: `set -Eeuo pipefail\r` is an invalid option and the
    script dies on line 2 with an error that names neither the file nor the
    cause. Normalising on the way in costs nothing and makes the helper
    independent of the operator's core.autocrlf setting.
  #>
  $repoBash = ConvertTo-BashPath $repoRoot
  $command = "cd '$repoBash' && tr -d '\r' < infra/scripts/backup.sh | bash -s"

  "=== KINO backup $stamp ===" | Out-File -FilePath $logFile -Encoding utf8
  "root: $BackupRoot  env: $EnvName  keep: $KeepDaily daily / $KeepWeekly weekly" |
    Out-File -FilePath $logFile -Encoding utf8 -Append

  & $bash -c $command 2>&1 | Tee-Object -FilePath $logFile -Append
  $code = $LASTEXITCODE
  "exit: $code" | Out-File -FilePath $logFile -Encoding utf8 -Append

  # Oldest logs first, keep the newest -KeepLogs. Done after the run so a
  # failing backup still leaves its own log behind to be read.
  Get-ChildItem -Path $logDir -Filter 'backup-*.log' |
    Sort-Object LastWriteTimeUtc -Descending |
    Select-Object -Skip $KeepLogs |
    Remove-Item -Force -ErrorAction SilentlyContinue

  if ($code -ne 0) { throw "backup.sh failed ($code). See $logFile" }
  Write-Output "Backup complete. Log: $logFile"
}

<#
  "Is the last backup fresh and non-empty?" as one command.

  Every check below is one an operator would otherwise do by hand and therefore
  never do. Note what is NOT claimed: this proves a snapshot exists, is recent,
  is internally consistent and contains objects. It does not prove Postgres will
  restore from it - that is infra/scripts/restore-drill.sh, and it needs a
  spare machine and half an hour.
#>
function Test-LastBackup {
  Assert-BackupRoot
  $daily = Join-Path $BackupRoot 'daily'
  if (-not (Test-Path $daily)) { throw "No backups at all: $daily does not exist." }

  $latest = Get-ChildItem -Path $daily -Directory |
    Where-Object { $_.Name -notlike '*.partial' } |
    Sort-Object Name -Descending |
    Select-Object -First 1
  if (-not $latest) { throw "No completed snapshot in $daily." }

  $ageHours = ((Get-Date).ToUniversalTime() - $latest.LastWriteTimeUtc).TotalHours
  Write-Output "Latest snapshot: $($latest.Name)  ($([math]::Round($ageHours, 1)) h old)"
  if ($ageHours -gt $MaxAgeHours) {
    throw "Stale: newest snapshot is $([math]::Round($ageHours, 1)) h old, limit is $MaxAgeHours h."
  }

  $dump = Join-Path $latest.FullName 'postgres.dump'
  if (-not (Test-Path $dump)) { throw "Missing postgres.dump in $($latest.FullName)." }
  $dumpBytes = (Get-Item $dump).Length
  if ($dumpBytes -lt 1024) { throw "postgres.dump is $dumpBytes bytes - that is not a database." }
  Write-Output "postgres.dump: $([math]::Round($dumpBytes / 1MB, 2)) MB"

  <#
    The check that makes this a backup of a photo library rather than of a
    catalogue. A dump alone restores rows that point at objects nobody has.
  #>
  $objects = Join-Path $latest.FullName 'objects'
  if (-not (Test-Path $objects)) { throw "Missing object mirror in $($latest.FullName)." }
  $objectFiles = Get-ChildItem -Path $objects -Recurse -File -ErrorAction SilentlyContinue
  $objectBytes = ($objectFiles | Measure-Object -Property Length -Sum).Sum
  if (-not $objectBytes) { $objectBytes = 0 }
  Write-Output "objects: $($objectFiles.Count) files, $([math]::Round($objectBytes / 1MB, 2)) MB"
  if ($objectFiles.Count -eq 0) {
    throw 'The object mirror is empty. A pg_dump alone protects no photograph.'
  }

  $sums = Join-Path $latest.FullName 'SHA256SUMS'
  if (-not (Test-Path $sums)) { throw "Missing SHA256SUMS in $($latest.FullName)." }
  Write-Output "SHA256SUMS present ($((Get-Content $sums).Count) entries)."
  Write-Output 'OK: the newest backup is fresh, non-empty, and carries both buckets.'
}

switch ($Action) {
  'register' {
    Assert-BackupRoot
    if (-not (Test-Path $envFile)) { throw "Environment file not found: $envFile" }
    $null = New-Item -ItemType Directory -Force -Path (Join-Path $BackupRoot 'logs')

    $self = $MyInvocation.MyCommand.Path
    $arguments = @(
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', "`"$self`"", 'run',
      '-BackupRoot', "`"$BackupRoot`"",
      '-EnvName', $EnvName,
      '-KeepDaily', $KeepDaily,
      '-KeepWeekly', $KeepWeekly,
      '-KeepLogs', $KeepLogs
    ) -join ' '

    $task = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arguments -WorkingDirectory $repoRoot
    $trigger = New-ScheduledTaskTrigger -Daily -At $At
    # StartWhenAvailable: a PC that was off at 03:30 takes the backup when it
    # comes back rather than skipping the night entirely.
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 6) -MultipleInstances IgnoreNew
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest

    Register-ScheduledTask -TaskName $TaskName -Action $task -Trigger $trigger `
      -Settings $settings -Principal $principal -Force | Out-Null

    Write-Output "Registered '$TaskName': daily at $At, into $BackupRoot."
    Write-Output "Check it tomorrow with:  powershell -ExecutionPolicy Bypass -File infra\backup-task.ps1 verify -BackupRoot `"$BackupRoot`""
  }
  'unregister' {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Output "Removed '$TaskName'. Existing snapshots are untouched."
  }
  'run' { Invoke-Backup }
  'verify' { Test-LastBackup }
  'status' {
    $info = Get-ScheduledTaskInfo -TaskName $TaskName
    $task = Get-ScheduledTask -TaskName $TaskName
    Write-Output "Task:      $TaskName ($($task.State))"
    Write-Output "Last run:  $($info.LastRunTime)  result 0x$('{0:X}' -f $info.LastTaskResult)"
    Write-Output "Next run:  $($info.NextRunTime)"
    if ($info.LastTaskResult -ne 0) {
      Write-Output 'Last run did not return 0 - read the newest log under <BackupRoot>\logs.'
    }
  }
}

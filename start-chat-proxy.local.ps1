param(
  [switch]$Restart,
  [int]$Port = 8787,
  [string]$HostName = '127.0.0.1'
)

$ErrorActionPreference = 'Stop'

$WorkDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProxyScript = Join-Path $WorkDir 'chat-completions-to-responses-proxy.js'
$RequestLog = Join-Path $WorkDir 'chat-completions-to-responses-proxy.requests.jsonl'
$RawLog = Join-Path $WorkDir 'chat-completions-to-responses-proxy.upstream.jsonl'
$PidFile = Join-Path $WorkDir 'chat-proxy.pid'

# Local startup parameters. Fill UpstreamApiKey only if your upstream requires it.
$UpstreamApiKey = ''
if ([string]::IsNullOrEmpty($UpstreamApiKey) -and $env:UPSTREAM_API_KEY) {
  $UpstreamApiKey = $env:UPSTREAM_API_KEY
}

$LocalApiKey = ''
if ([string]::IsNullOrEmpty($LocalApiKey) -and $env:LOCAL_API_KEY) {
  $LocalApiKey = $env:LOCAL_API_KEY
}

$env:PORT = [string]$Port
$env:HOST = $HostName
$env:UPSTREAM_MODE = 'responses'
if (-not $env:UPSTREAM_RESPONSES_URL) {
  $env:UPSTREAM_RESPONSES_URL = 'http://127.0.0.1:3000/v1/responses'
}
$env:LOG_FILE = $RequestLog
$env:RAW_LOG_FILE = $RawLog

function Get-ProxyListener {
  netstat -ano |
    Select-String ":$Port" |
    Select-String 'LISTENING' |
    Select-Object -First 1
}

function Get-ProxyPidFromListener($listenerLine) {
  if (-not $listenerLine) { return $null }
  $text = ($listenerLine.ToString() -replace '\s+', ' ').Trim()
  $parts = $text.Split(' ')
  if ($parts.Count -lt 5) { return $null }
  return [int]$parts[$parts.Count - 1]
}

if (-not (Test-Path -LiteralPath $ProxyScript)) {
  throw "Proxy script not found: $ProxyScript"
}

if (($HostName -eq '0.0.0.0' -or $HostName -eq '::') -and [string]::IsNullOrEmpty($LocalApiKey)) {
  throw "Refusing to listen on $HostName without LOCAL_API_KEY. Set `$LocalApiKey in this script or `$env:LOCAL_API_KEY before starting."
}

$listener = Get-ProxyListener
$existingPid = Get-ProxyPidFromListener $listener

if ($Restart -and $existingPid) {
  Stop-Process -Id $existingPid -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 600
  $listener = Get-ProxyListener
}

if ($listener) {
  $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 5
  [pscustomobject]@{
    status = 'already_running'
    pid = Get-ProxyPidFromListener $listener
    listener = (($listener.ToString() -replace '\s+', ' ').Trim())
    health_ok = $health.ok
    upstream_mode = $health.upstream_mode
    log_file = $RequestLog
    raw_log_file = $RawLog
  } | Format-List
  return
}

$node = (Get-Command node -ErrorAction Stop).Source
$psi = [System.Diagnostics.ProcessStartInfo]::new()
$psi.FileName = $node
$psi.Arguments = '"' + $ProxyScript + '"'
$psi.WorkingDirectory = $WorkDir
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$psi.Environment['UPSTREAM_API_KEY'] = $UpstreamApiKey
$psi.Environment['LOCAL_API_KEY'] = $LocalApiKey

$process = [System.Diagnostics.Process]::Start($psi)

$health = $null
for ($i = 0; $i -lt 40; $i++) {
  if ($process.HasExited) {
    throw "Proxy process exited early with code $($process.ExitCode)"
  }

  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 2
    break
  } catch {
    Start-Sleep -Milliseconds 250
  }
}

if (-not $health) {
  throw 'Proxy started, but health check did not respond.'
}

Set-Content -LiteralPath $PidFile -Value $process.Id -Encoding ASCII

$listener = Get-ProxyListener
[pscustomobject]@{
  status = 'started'
  pid = $process.Id
  listener = if ($listener) { (($listener.ToString() -replace '\s+', ' ').Trim()) } else { '' }
  health_ok = $health.ok
  upstream_mode = $health.upstream_mode
  log_file = $RequestLog
  raw_log_file = $RawLog
  pid_file = $PidFile
} | Format-List

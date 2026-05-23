param(
  [switch]$Restart,
  [int]$Port = 8787,
  [string]$HostName = '127.0.0.1',
  [string]$CodexAuthFile = (Join-Path $env:USERPROFILE '.codex\auth.json'),
  [string]$ProxyUrl = $env:PROXY_URL
)

$ErrorActionPreference = 'Stop'

$WorkDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProxyScript = Join-Path $WorkDir 'chat-completions-to-responses-proxy.js'
$RequestLog = Join-Path $WorkDir 'chat-completions-to-codex-proxy.requests.jsonl'
$RawLog = Join-Path $WorkDir 'chat-completions-to-codex-proxy.upstream.jsonl'
$PidFile = Join-Path $WorkDir 'chat-proxy-codex.pid'

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

if (-not (Test-Path -LiteralPath $CodexAuthFile)) {
  throw "Codex auth file not found: $CodexAuthFile"
}

$auth = Get-Content -LiteralPath $CodexAuthFile -Raw | ConvertFrom-Json
$tokens = $auth.tokens
if (-not $tokens.access_token) {
  throw "Codex auth file has no access_token: $CodexAuthFile"
}
if (-not $tokens.account_id) {
  throw "Codex auth file has no account_id: $CodexAuthFile"
}

$CodexClientId = [string]$tokens.id_token
if ($env:CODEX_CLIENT_ID) {
  $CodexClientId = $env:CODEX_CLIENT_ID
}

$LocalApiKey = ''
if ([string]::IsNullOrEmpty($LocalApiKey) -and $env:LOCAL_API_KEY) {
  $LocalApiKey = $env:LOCAL_API_KEY
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
    auth_file = $CodexAuthFile
    log_file = $RequestLog
  } | Format-List
  return
}

$env:PORT = [string]$Port
$env:HOST = $HostName
$env:UPSTREAM_MODE = 'codex'
$env:UPSTREAM_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses'
$env:CODEX_ACCESS_TOKEN = [string]$tokens.access_token
# Refresh token is intentionally not forwarded here; this proxy only uses the current access token.
# $env:CODEX_REFRESH_TOKEN = [string]$tokens.refresh_token
Remove-Item Env:\CODEX_REFRESH_TOKEN -ErrorAction SilentlyContinue
$env:CODEX_ACCOUNT_ID = [string]$tokens.account_id
$env:CODEX_STRICT = '1'
$env:LOG_FILE = $RequestLog
$env:RAW_LOG_FILE = $RawLog
if ($ProxyUrl) {
  $env:PROXY_URL = $ProxyUrl
}

$node = (Get-Command node -ErrorAction Stop).Source
$psi = [System.Diagnostics.ProcessStartInfo]::new()
$psi.FileName = $node
$psi.Arguments = '"' + $ProxyScript + '"'
$psi.WorkingDirectory = $WorkDir
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$psi.Environment['CODEX_CLIENT_ID'] = $CodexClientId
$psi.Environment['LOCAL_API_KEY'] = $LocalApiKey

$process = [System.Diagnostics.Process]::Start($psi)

# Remove secrets from this PowerShell process after the child has inherited them.
Remove-Item Env:\CODEX_ACCESS_TOKEN -ErrorAction SilentlyContinue
Remove-Item Env:\CODEX_REFRESH_TOKEN -ErrorAction SilentlyContinue
Remove-Item Env:\CODEX_ACCOUNT_ID -ErrorAction SilentlyContinue

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
  auth_file = $CodexAuthFile
  proxy_url = if ($ProxyUrl) { $ProxyUrl } else { '' }
  log_file = $RequestLog
  raw_log_file = $RawLog
  pid_file = $PidFile
} | Format-List

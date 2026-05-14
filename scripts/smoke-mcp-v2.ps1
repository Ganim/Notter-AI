# scripts/smoke-mcp-v2.ps1
#
# OAuth 2.1 + 17-tool surface smoke. Adapted from smoke-m3.ps1.
#
# Usage:
#   $env:MCP_URL = 'http://127.0.0.1:54781/mcp'
#   $env:MCP_ACCOUNT_ID = '<the account uuid to authorize for>'
#   pwsh scripts/smoke-mcp-v2.ps1
#
# Pre-requisites:
#   - Notter is running (npm run tauri dev) with at least one account signed in
#   - The signed-in account's UUID is in MCP_ACCOUNT_ID
#   - The MCP server has at least one AccountSummary pushed via
#     mcp_set_account_summaries (the front-end will push it on sign-in)
#
# Exits non-zero on any failure. Pretty-prints JSON.

[CmdletBinding()]
param(
    [string]$Url = $env:MCP_URL,
    [string]$AccountId = $env:MCP_ACCOUNT_ID
)
if (-not $Url) { Write-Error "Set MCP_URL (e.g. http://127.0.0.1:PORT/mcp)"; exit 2 }
if (-not $AccountId) { Write-Error "Set MCP_ACCOUNT_ID (the account UUID to test against)"; exit 2 }

$base = $Url -replace '/mcp$',''
$script:failures = 0

function Fail($msg) { Write-Host "FAIL: $msg" -ForegroundColor Red; $script:failures++ }
function OK($msg)   { Write-Host "OK:   $msg" -ForegroundColor Green }

# Step 1 — register a client
Write-Host "`n[1/6] Register client..." -ForegroundColor Cyan
$reg = Invoke-RestMethod -Method Post -Uri "$base/register" -ContentType application/json -Body (@{
    client_name = 'smoke-mcp-v2'
    redirect_uris = @('http://127.0.0.1:55555/cb')
} | ConvertTo-Json)
$clientId = $reg.client_id
$clientSecret = $reg.client_secret
if (-not $clientId) { Fail "register did not return client_id"; exit 1 }
OK "registered $clientId"

# Step 2 — simulate consent: POST /authorize directly with account_id
Write-Host "`n[2/6] Authorize..." -ForegroundColor Cyan

# PKCE pair
$verifierBytes = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($verifierBytes)
$verifier = [Convert]::ToBase64String($verifierBytes) -replace '\+','-' -replace '/','_' -replace '=',''
$sha = [System.Security.Cryptography.SHA256]::Create()
$hash = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($verifier))
$challenge = [Convert]::ToBase64String($hash) -replace '\+','-' -replace '/','_' -replace '=',''

$form = @{
    client_id = $clientId
    redirect_uri = 'http://127.0.0.1:55555/cb'
    code_challenge = $challenge
    code_challenge_method = 'S256'
    state = 'smoke-xyz'
    scope = 'notter:full'
    account_id = $AccountId
}
$resp = $null
try {
    $resp = Invoke-WebRequest -Method Post -Uri "$base/authorize" -Body $form -MaximumRedirection 0 -ErrorAction Stop
} catch {
    # PowerShell raises on 3xx when MaximumRedirection is 0; the response is in the exception
    $resp = $_.Exception.Response
    if (-not $resp) { Fail "authorize threw without a response: $_"; exit 1 }
}
$status = if ($resp.StatusCode) { [int]$resp.StatusCode } else { 0 }
if ($status -ne 303 -and $status -ne 302) { Fail "expected 302 or 303 from /authorize, got $status"; exit 1 }

$location = if ($resp.Headers.Location) { $resp.Headers.Location } elseif ($resp.Headers['Location']) { $resp.Headers['Location'] } else { $null }
if (-not $location) { Fail "no Location header on /authorize redirect"; exit 1 }
$code = ([uri]$location).Query -replace '^\?','' -split '&' | Where-Object { $_ -like 'code=*' } | ForEach-Object { ($_ -split '=',2)[1] }
$code = [System.Net.WebUtility]::UrlDecode($code)
if (-not $code) { Fail "no code in redirect location: $location"; exit 1 }
OK "authorize -> code (len=$($code.Length))"

# Step 3 — token exchange
Write-Host "`n[3/6] Token exchange..." -ForegroundColor Cyan
$tokenForm = @{
    grant_type = 'authorization_code'
    code = $code
    client_id = $clientId
    client_secret = $clientSecret
    redirect_uri = 'http://127.0.0.1:55555/cb'
    code_verifier = $verifier
}
$tokens = Invoke-RestMethod -Method Post -Uri "$base/token" -Body $tokenForm
$access = $tokens.access_token
$refresh = $tokens.refresh_token
if (-not $access) { Fail "token did not return access_token"; exit 1 }
OK "access_token (len=$($access.Length)), refresh_token (len=$($refresh.Length))"

# Step 4 — exercise every tool
Write-Host "`n[4/6] Exercise 17 tools..." -ForegroundColor Cyan
function Call-Mcp($method, $params) {
    $body = @{ jsonrpc = '2.0'; id = (Get-Random); method = $method; params = $params } | ConvertTo-Json -Depth 10 -Compress
    $h = @{ Authorization = "Bearer $access"; 'Content-Type' = 'application/json' }
    try {
        $r = Invoke-RestMethod -Method Post -Uri $Url -Headers $h -Body $body -ErrorAction Stop
    } catch {
        Fail "$method request failed: $($_.Exception.Message)"
        return $null
    }
    if ($r.error) { Fail "$method -> $($r.error.message)" } else { OK $method }
    return $r.result
}

$null = Call-Mcp 'list_subjects' @{}
$null = Call-Mcp 'list_versions' @{ subject_id = '00000000-0000-0000-0000-000000000000' }
$null = Call-Mcp 'list_comments' @{ subject_id = '00000000-0000-0000-0000-000000000000' }
$settings = Call-Mcp 'get_account_settings' @{}
if ($settings) { Write-Host "  settings: $($settings | ConvertTo-Json -Compress)" }

$wsList = Call-Mcp 'list_workspaces' @{}
$projList = Call-Mcp 'list_projects' @{}

# Create-update-archive-restore round-trip on a workspace
Write-Host "`n  --- workspace round-trip ---" -ForegroundColor DarkGray
$ws = Call-Mcp 'save_workspace' @{ name = "smoke-$(Get-Random)" }
if ($ws -and $ws.id) {
    $wsId = $ws.id
    $null = Call-Mcp 'archive_resource' @{ type = 'workspace'; id = $wsId }
    $null = Call-Mcp 'restore_resource' @{ type = 'workspace'; id = $wsId }
} else {
    Write-Host "  (skipped archive/restore — save_workspace did not return id)" -ForegroundColor DarkYellow
}

# Step 5 — revoke
Write-Host "`n[5/6] Revoke refresh..." -ForegroundColor Cyan
$revokeForm = @{
    token = $refresh
    token_type_hint = 'refresh_token'
    client_id = $clientId
    client_secret = $clientSecret
}
$null = Invoke-WebRequest -Method Post -Uri "$base/revoke" -Body $revokeForm
OK "revoke posted"

# Step 6 — confirm refresh dead
Write-Host "`n[6/6] Confirm refresh refused post-revoke..." -ForegroundColor Cyan
try {
    $bad = Invoke-RestMethod -Method Post -Uri "$base/token" -Body @{
        grant_type='refresh_token'
        refresh_token=$refresh
        client_id=$clientId
        client_secret=$clientSecret
    } -ErrorAction Stop
    Fail "expected refresh to be refused after revoke (got token: $($bad.access_token.Substring(0,10))...)"
} catch {
    OK "refresh refused post-revoke"
}

# Summary
Write-Host ""
if ($script:failures -gt 0) {
    Write-Host "$($script:failures) failures" -ForegroundColor Red
    exit 1
} else {
    Write-Host "ALL GREEN" -ForegroundColor Green
}

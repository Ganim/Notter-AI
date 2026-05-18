# scripts/smoke-mcp-v2.ps1
#
# OAuth 2.1 + 18-tool surface smoke. Adapted from smoke-m3.ps1.
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
Write-Host "`n[4/6] Exercise 18 tools..." -ForegroundColor Cyan
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
# Post-tags-migration: every project row must carry a `tag`.
if ($projList) {
    foreach ($p in $projList) {
        if (-not ($p.tag -and ($p.tag -match '^[a-z0-9]{2,8}$'))) {
            Fail "list_projects row '$($p.name)' missing or invalid tag (got: $($p.tag))"
        }
    }
    Write-Host "  list_projects: $($projList.Count) row(s), all with valid tags" -ForegroundColor DarkGray
}

# update_account_settings round-trip (toggle theme then restore)
Write-Host "`n  --- account_settings round-trip ---" -ForegroundColor DarkGray
$origTheme = if ($settings -and $settings.theme) { $settings.theme } else { 'system' }
$newTheme = if ($origTheme -eq 'dark') { 'light' } else { 'dark' }
$flipped = Call-Mcp 'update_account_settings' @{ theme = $newTheme }
if ($flipped -and $flipped.theme -eq $newTheme) { OK "theme flip $origTheme -> $newTheme persisted" }
else { Fail "theme flip did not persist (got: $($flipped | ConvertTo-Json -Compress))" }
$restored = Call-Mcp 'update_account_settings' @{ theme = $origTheme }
if ($restored -and $restored.theme -eq $origTheme) { OK "theme restored to $origTheme" }
else { Fail "theme restore failed (got: $($restored | ConvertTo-Json -Compress))" }

# Full lifecycle round-trip: workspace -> project -> subject -> revision -> comment -> cleanup
Write-Host "`n  --- workspace/project/subject round-trip ---" -ForegroundColor DarkGray
$stamp = Get-Random
$ws = Call-Mcp 'save_workspace' @{ name = "smoke-ws-$stamp" }
if (-not ($ws -and $ws.id)) { Fail "save_workspace did not return id; aborting round-trip"; }
else {
    $wsId = $ws.id
    $proj = Call-Mcp 'save_project' @{ name = "smoke-proj-$stamp"; workspace_id = $wsId }
    if (-not ($proj -and $proj.name)) { Fail "save_project did not return name" }
    else {
        $projName = $proj.name
        # Tag must be a 2-8 lowercase alphanumeric string per the post-tags-migration schema.
        if (-not ($proj.tag -and ($proj.tag -match '^[a-z0-9]{2,8}$'))) {
            Fail "save_project did not return a valid tag (got: $($proj.tag))"
        } else { Write-Host "    tag: $($proj.tag)" -ForegroundColor DarkGray }
        $subj = Call-Mcp 'save_subject' @{ project_name = $projName; file_name = "smoke-$stamp.md" }
        if (-not ($subj -and $subj.id)) { Fail "save_subject did not return id" }
        else {
            $subjId = $subj.id
            # Identifier was added by Phase 10.1 — must be present and well-formed.
            if (-not ($subj.identifier -and ($subj.identifier -match '^[a-z0-9]{2,8}-\d+$'))) {
                Fail "save_subject did not return a valid identifier (got: $($subj.identifier))"
            } else { Write-Host "    identifier: $($subj.identifier)" -ForegroundColor DarkGray }
            $fetched = Call-Mcp 'get_subject' @{ subject_id = $subjId }
            if (-not ($fetched -and $fetched.id -eq $subjId)) { Fail "get_subject mismatch" }
            if (-not ($fetched.identifier -eq $subj.identifier)) {
                Fail "get_subject identifier mismatch (save: $($subj.identifier), get: $($fetched.identifier))"
            }
            # find_subject_by_tag: exact (tag-seq), project (tag), and not-found paths.
            # Pass workspace_id explicitly so the lookup is deterministic even if
            # the auto-tag happens to collide with another workspace's tag.
            Write-Host "    --- find_subject_by_tag ---" -ForegroundColor DarkGray
            $findExact = Call-Mcp 'find_subject_by_tag' @{ query = $subj.identifier; workspace_id = $wsId }
            if (-not ($findExact -and $findExact.status -eq 'exact')) {
                Fail "find_subject_by_tag '$($subj.identifier)' expected status=exact (got: $($findExact.status))"
            } elseif ($findExact.subject.id -ne $subjId) {
                Fail "find_subject_by_tag exact returned subject.id $($findExact.subject.id), want $subjId"
            } elseif ($findExact.subject.identifier -ne $subj.identifier) {
                Fail "find_subject_by_tag exact returned identifier $($findExact.subject.identifier), want $($subj.identifier)"
            } else {
                Write-Host "    find_subject_by_tag exact: identifier=$($findExact.subject.identifier)" -ForegroundColor DarkGray
            }
            $findProj = Call-Mcp 'find_subject_by_tag' @{ query = $proj.tag; workspace_id = $wsId }
            if (-not ($findProj -and $findProj.status -eq 'project')) {
                Fail "find_subject_by_tag '$($proj.tag)' expected status=project (got: $($findProj.status))"
            } elseif (-not ($findProj.subjects | Where-Object { $_.id -eq $subjId })) {
                Fail "find_subject_by_tag project response did not include subject $subjId"
            } else {
                Write-Host "    find_subject_by_tag project: subjects=$($findProj.subjects.Count)" -ForegroundColor DarkGray
            }
            # NotFound: send the request directly so Call-Mcp's auto-Fail on error doesn't trip.
            $nfBody = @{ jsonrpc='2.0'; id=(Get-Random); method='find_subject_by_tag'; params=@{ query='zzzz9999' } } | ConvertTo-Json -Depth 10 -Compress
            $nfHdr = @{ Authorization = "Bearer $access"; 'Content-Type' = 'application/json' }
            try {
                $nfResp = Invoke-RestMethod -Method Post -Uri $Url -Headers $nfHdr -Body $nfBody -ErrorAction Stop
                if ($nfResp.error -and $nfResp.error.code -eq -32003) {
                    OK "find_subject_by_tag returns NotFound for unknown tag"
                } else {
                    Fail "find_subject_by_tag for unknown tag should error -32003 (got: $($nfResp | ConvertTo-Json -Compress))"
                }
            } catch {
                Fail "find_subject_by_tag unknown-tag request failed: $($_.Exception.Message)"
            }
            $v2Body = "anchor-target $stamp middle-text trailing-words"
            $rev = Call-Mcp 'post_subject_revision' @{ subject_id = $subjId; content_markdown = $v2Body; source_actor = 'smoke-mcp-v2'; label = 'smoke v2' }
            if (-not ($rev -and $rev.version_id)) { Fail "post_subject_revision did not return version_id" }
            else {
                $v2Id = $rev.version_id
                $ver = Call-Mcp 'get_version' @{ version_id = $v2Id }
                if (-not ($ver -and $ver.content_markdown -eq $v2Body)) { Fail "get_version content mismatch" }
                $cmt = Call-Mcp 'save_comment' @{
                    subject_id    = $subjId
                    version_id    = $v2Id
                    body          = "smoke comment $stamp"
                    anchor_quote  = "middle-text"
                    anchor_prefix = "anchor-target $stamp "
                    anchor_suffix = " trailing-words"
                }
                if (-not ($cmt -and $cmt.id)) { Fail "save_comment did not return id" }
                else {
                    $del = Call-Mcp 'delete_comment' @{ id = $cmt.id }
                    if (-not ($del -and $del.deleted -eq $cmt.id)) { Fail "delete_comment did not echo id" }
                }
            }
            $null = Call-Mcp 'archive_resource' @{ type = 'subject'; id = $subjId }
        }
        # archive project + workspace once their children are gone (cascade is manual)
        # Re-fetch projects list to obtain the project id (save_project returns name+id; capture id).
        if ($proj.id) { $null = Call-Mcp 'archive_resource' @{ type = 'project'; id = $proj.id } }
    }
    # archive_resource then restore_resource on the workspace (parity with the original smoke)
    $null = Call-Mcp 'archive_resource' @{ type = 'workspace'; id = $wsId }
    $null = Call-Mcp 'restore_resource' @{ type = 'workspace'; id = $wsId }
    # final archive so cleanup leaves no live workspace
    $null = Call-Mcp 'archive_resource' @{ type = 'workspace'; id = $wsId }
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

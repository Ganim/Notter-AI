# scripts/smoke-m3.ps1
#
# Phase L smoke for the M3 MCP server (per-account bearer refactor).
#
# Usage:
#   1. Run `npm run tauri dev`, sign in, open UserMenu -> "MCP config" -> Copy.
#   2. Paste the URL + bearer below (or pass via env).
#   3. Run: pwsh scripts/smoke-m3.ps1
#
# The script exits non-zero if any tool errors. Output is JSON-pretty.

[CmdletBinding()]
param(
    [string]$Url   = $env:MCP_URL,
    [string]$Token = $env:MCP_TOKEN,
    [string]$WorkspaceId = $env:MCP_WORKSPACE_ID  # optional — filters list_subjects
)

if (-not $Url -or -not $Token) {
    Write-Error "Set MCP_URL and MCP_TOKEN env vars (or pass -Url / -Token)."
    exit 2
}

$script:failures = 0

function Invoke-McpCall {
    param([int]$Id, [string]$Method, $Params = @{})

    $payload = @{
        jsonrpc = '2.0'
        id      = $Id
        method  = $Method
        params  = $Params
    } | ConvertTo-Json -Compress -Depth 10

    Write-Host "`n--- [$Id] $Method ---" -ForegroundColor Cyan
    try {
        $resp = Invoke-RestMethod -Method Post -Uri $Url `
            -Headers @{ Authorization = "Bearer $Token"; 'Content-Type' = 'application/json' } `
            -Body $payload -ErrorAction Stop
    } catch {
        Write-Host "REQUEST FAILED: $($_.Exception.Message)" -ForegroundColor Red
        $script:failures++
        return $null
    }

    $json = $resp | ConvertTo-Json -Depth 10
    Write-Host $json

    if ($resp.error) {
        Write-Host "JSON-RPC ERROR: $($resp.error.message)" -ForegroundColor Yellow
        $script:failures++
        return $null
    }
    return $resp.result
}

# 1. list_subjects (no filter)
$subjects = Invoke-McpCall -Id 1 -Method 'list_subjects'

if ($null -eq $subjects -or $subjects.Count -eq 0) {
    Write-Host "`nNo subjects to smoke against. Create one in the app, then re-run." -ForegroundColor Yellow
    exit ($script:failures)
}

$subjectId = $subjects[0].id
Write-Host "`nPicked subject: $subjectId" -ForegroundColor Green

# 1b. list_subjects with workspace_id filter (sanity-check the optional param)
if ($WorkspaceId) {
    Invoke-McpCall -Id 11 -Method 'list_subjects' -Params @{ workspace_id = $WorkspaceId } | Out-Null
}

# 2. get_subject
Invoke-McpCall -Id 2 -Method 'get_subject' -Params @{ subject_id = $subjectId } | Out-Null

# 3. list_versions
$versions = Invoke-McpCall -Id 3 -Method 'list_versions' -Params @{ subject_id = $subjectId }

# 4. get_version (only if versions exist)
if ($versions -and $versions.Count -gt 0) {
    $versionId = $versions[0].id
    Invoke-McpCall -Id 4 -Method 'get_version' -Params @{ version_id = $versionId } | Out-Null
} else {
    Write-Host "`n[skip] get_version — no existing versions on this subject" -ForegroundColor Gray
}

# 5. list_comments
Invoke-McpCall -Id 5 -Method 'list_comments' -Params @{ subject_id = $subjectId } | Out-Null

# 6. post_subject_revision — WRITE test. Verify in PlannerTab.
$revision = Invoke-McpCall -Id 6 -Method 'post_subject_revision' -Params @{
    subject_id       = $subjectId
    content_markdown = "# Hello`n`nRevised by smoke-m3.ps1 @ $(Get-Date -Format 'yyyy-MM-ddTHH:mm:ssZ')"
    label            = 'smoke L4'
    source_actor     = 'pwsh-smoke'
}

if ($revision -and $revision.version_id) {
    Write-Host "`nNew version_id: $($revision.version_id)" -ForegroundColor Green
    Write-Host "Open the subject in PlannerTab — the History dropdown should show 'smoke L4' as the newest entry."
}

# Final summary
Write-Host "`n========================" -ForegroundColor Cyan
if ($script:failures -eq 0) {
    Write-Host "SMOKE PASSED — 6/6 tools OK" -ForegroundColor Green
} else {
    Write-Host "SMOKE FAILED — $($script:failures) error(s)" -ForegroundColor Red
}
Write-Host "========================" -ForegroundColor Cyan

exit $script:failures

[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)]
    [ValidateSet('A', 'B', 'C')]
    [string]$Lane,

    [Parameter(Mandatory)]
    [ValidatePattern('^https://')]
    [string]$ApiBase,

    [string[]]$Repositories = @(
        'ptjworks/ci-central',
        'TshyGO/NebulaLab',
        'ptjworks/NebulaLab-Docs',
        'ptjworks/NebulaLab-Plugins',
        'ptjworks/resume-form-assistant-plugin',
        'ptjworks/AI-Thesis-Polisher',
        'TshyGO/NebulaGraph-License-Service'
    )
)

$ErrorActionPreference = 'Stop'
$keyName = "PR_AGENT_LANE_${Lane}_KEY"
$baseName = "PR_AGENT_LANE_${Lane}_API_BASE"

# Check every target before asking for the key. A slot whose key_slots entry names two providers
# keeps a version-1 JSON bundle, and a plain key written there would disable it. A plain slot of a
# paid API (anthropic, openai) holds one key per account, and a single key would drop the others.
# GitHub names are case-insensitive, so configs are matched that way; a target without one
# has an unknown slot format and is refused as well.
$configDirectory = [System.IO.Path]::Combine($PSScriptRoot, '..', 'review-action', 'config', 'repositories')
if (-not (Test-Path -LiteralPath $configDirectory -PathType Container)) {
    throw "Central repository configs not found at $configDirectory. No secrets were written."
}
$configs = @{}
foreach ($file in Get-ChildItem -LiteralPath $configDirectory -Filter '*.json' -File) {
    $configs[$file.BaseName.ToLowerInvariant()] = $file.FullName
}
$bundled = @()
$multiKey = @()
$unknown = @()
foreach ($repository in $Repositories) {
    if ($repository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') {
        throw "Invalid repository identifier: $repository"
    }
    $configPath = $configs[($repository -replace '/', '__').ToLowerInvariant()]
    if (-not $configPath) {
        $unknown += $repository
        continue
    }
    $slot = @((Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json).key_slots.$Lane)
    if ($slot.Count -gt 1) { $bundled += $repository }
    elseif ($slot.Count -eq 1 -and $slot[0] -in @('anthropic', 'openai')) { $multiKey += $repository }
}
if ($unknown) {
    throw "No central config in review-action/config/repositories for $($unknown -join ', '), so its Lane $Lane slot format is unknown. No secrets were written."
}
if ($bundled) {
    throw "Lane $Lane uses a version-1 provider credential bundle in $($bundled -join ', '). This script writes a plain key and would disable it. Leave those repositories out with -Repositories and update their bundle as docs/nebulalab-openai-c-migration.md describes. No secrets were written."
}
if ($multiKey) {
    throw "Lane $Lane holds one key per account in $($multiKey -join ', ') (a paid API slot). This script writes a single key and would drop the other accounts. Leave those repositories out with -Repositories and rewrite the slot with every account's key, one per line. No secrets were written."
}

$secureKey = Read-Host "Enter the new Lane $Lane API key" -AsSecureString
$key = [System.Net.NetworkCredential]::new('', $secureKey).Password

try {
    if ([string]::IsNullOrWhiteSpace($key)) {
        throw 'The API key must not be empty.'
    }
    foreach ($repository in $Repositories) {
        if ($PSCmdlet.ShouldProcess($repository, "set $keyName and $baseName")) {
            $key | & gh secret set $keyName --repo $repository --app actions
            if ($LASTEXITCODE -ne 0) { throw "Failed to set $keyName for $repository." }
            $ApiBase.TrimEnd('/') | & gh secret set $baseName --repo $repository --app actions
            if ($LASTEXITCODE -ne 0) { throw "Failed to set $baseName for $repository." }
            Write-Host "Updated Lane $Lane secret slots for $repository."
        }
    }
}
finally {
    $key = $null
    $secureKey.Dispose()
}

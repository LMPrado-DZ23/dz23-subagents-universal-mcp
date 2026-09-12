$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Node = (Get-Command node -ErrorAction Stop).Source
$Npm = (Get-Command npm.cmd -ErrorAction Stop).Source
$majorText = & $Node -p "process.versions.node.split('.')[0]"
if ($LASTEXITCODE -ne 0) { throw 'Unable to run Node.js.' }
if ([int]$majorText -lt 22) { throw 'Node.js 22+ is required.' }
if (-not (Test-Path (Join-Path $Root '.env'))) {
    Copy-Item (Join-Path $Root '.env.example') (Join-Path $Root '.env')
}
Push-Location $Root
try {
    & $Npm run check
    if ($LASTEXITCODE -ne 0) { throw 'Syntax validation failed. Installation stopped.' }
    & $Npm test
    if ($LASTEXITCODE -ne 0) { throw 'Regression tests failed. Installation stopped.' }
    & $Node (Join-Path $Root 'scripts/install-harness.mjs') all
    if ($LASTEXITCODE -ne 0) { throw 'MCP configuration generation failed.' }
} finally {
    Pop-Location
}
Write-Host "Prepared DZ23 Subagents at $Root"
Write-Host 'Edit .env privately and review config\generated before merging the snippets.'
Write-Host 'Existing harness configurations were not modified.'

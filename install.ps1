# 薄包装：真正的安装逻辑在 install.mjs（用 Node 改 JSON，避免 pwsh 的编码坑）。
#
#   powershell -ExecutionPolicy Bypass -File .\install.ps1
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -Remove

param([switch]$Remove)

$ErrorActionPreference = 'Stop'
$args2 = @()
if ($Remove) { $args2 += '--remove' }

& node (Join-Path $PSScriptRoot 'install.mjs') @args2
exit $LASTEXITCODE

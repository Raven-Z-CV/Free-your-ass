# paste-helper.ps1 - Windows-side helper for paste_bot (plaintext, reviewable)
# Job: read _paste-text.txt (UTF-8) from this directory, set the clipboard, and
# simulate Ctrl+V + Enter into the currently focused window.
# Called from the WSL-side paste_bot via interop:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File <this file>
# Use -NoKeys to only set the clipboard without simulating keys (for testing).

param([switch]$NoKeys)

$ErrorActionPreference = 'Stop'

$textFile = Join-Path $PSScriptRoot '_paste-text.txt'
$text = [System.IO.File]::ReadAllText($textFile, [System.Text.Encoding]::UTF8)

Set-Clipboard -Value $text

if (-not $NoKeys) {
    Add-Type -AssemblyName System.Windows.Forms
    Start-Sleep -Milliseconds 200
    [System.Windows.Forms.SendKeys]::SendWait('^v')
    Start-Sleep -Milliseconds 200
    [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
}

Write-Output 'ok'

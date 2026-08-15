[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ClaudeDir = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $HOME ".claude" }

# The mode is scoped to one session, so this has to know which session it is
# rendering for — otherwise every window shows whichever one switched mode last.
# Claude Code hands the statusline payload on stdin; session_id comes out with a
# regex rather than ConvertFrom-Json, which keeps this a short addition.
# Only when stdin is a pipe. Reading an interactive terminal would block forever,
# which is how someone running this by hand to check it works would find out.
$Payload = ""
if ([Console]::IsInputRedirected) {
    try { $Payload = [Console]::In.ReadToEnd() } catch { }
}

# The global flag is the fallback, not the default: it is what an install that has
# not yet run a session-scoped hook still has, and it is removed as soon as one does.
$Flag = Join-Path $ClaudeDir ".caveman-active"
if ($Payload -match '"session_id"\s*:\s*"([0-9a-fA-F-]{8,64})"') {
    $Scoped = Join-Path (Join-Path (Join-Path $ClaudeDir "modes") $Matches[1]) "caveman"
    if (Test-Path $Scoped) { $Flag = $Scoped }
}
if (-not (Test-Path $Flag)) { exit 0 }

# Refuse reparse points (symlinks / junctions) and oversized files. Without
# this, a local attacker could point the flag at a secret file and have the
# statusline render its bytes (including ANSI escape sequences) to the terminal
# every keystroke.
try {
    $Item = Get-Item -LiteralPath $Flag -Force -ErrorAction Stop
    if ($Item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { exit 0 }
    if ($Item.Length -gt 64) { exit 0 }
} catch {
    exit 0
}

$Mode = ""
try {
    $Raw = Get-Content -LiteralPath $Flag -TotalCount 1 -ErrorAction Stop
    if ($null -ne $Raw) { $Mode = ([string]$Raw).Trim() }
} catch {
    exit 0
}

# Strip anything outside [a-z0-9-] — blocks terminal-escape and OSC hyperlink
# injection via the flag contents. Then whitelist-validate.
$Mode = $Mode.ToLowerInvariant()
$Mode = ($Mode -replace '[^a-z0-9-]', '')

$Valid = @('off','lite','full','ultra','wenyan-lite','wenyan','wenyan-full','wenyan-ultra','commit','review','compress')
if (-not ($Valid -contains $Mode)) { exit 0 }

$Esc = [char]27
if ([string]::IsNullOrEmpty($Mode) -or $Mode -eq "full") {
    [Console]::Write("${Esc}[38;5;172m[CAVEMAN]${Esc}[0m")
} else {
    $Suffix = $Mode.ToUpperInvariant()
    [Console]::Write("${Esc}[38;5;172m[CAVEMAN:$Suffix]${Esc}[0m")
}

# Savings suffix: on by default. Opt out via CAVEMAN_STATUSLINE_SAVINGS=0.
# Reads a pre-rendered string written by caveman-stats.js. Refuses reparse
# points and strips control bytes (matches statusline.sh hardening). Until
# /caveman-stats has run at least once, the suffix file is absent and nothing
# is rendered — safe default for fresh installs.
if ($env:CAVEMAN_STATUSLINE_SAVINGS -ne "0") {
    $SavingsFile = Join-Path $ClaudeDir ".caveman-statusline-suffix"
    if (Test-Path $SavingsFile) {
        try {
            $SavingsItem = Get-Item -LiteralPath $SavingsFile -Force -ErrorAction Stop
            if (-not ($SavingsItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -and
                $SavingsItem.Length -le 64) {
                $Savings = (Get-Content -LiteralPath $SavingsFile -Encoding UTF8 -Raw -ErrorAction Stop).TrimEnd()
                $Savings = ($Savings -replace '[\x00-\x1F]', '')
                if ($Savings.Length -gt 0) {
                    [Console]::Write(" ${Esc}[38;5;172m$Savings${Esc}[0m")
                }
            }
        } catch {}
    }
}

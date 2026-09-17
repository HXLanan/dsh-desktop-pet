<#
.SYNOPSIS
  DSH Desktop Pet - a transparent, always-on-top, draggable desktop pet window.

.DESCRIPTION
  Windows PowerShell + WinForms implementation of the pet window itself. It is
  launched by the dsh-desktop-pet host half through ctx.subprocess, and can also
  be run standalone for debugging.

  Transport: local JSON file polling.
    - reads  <PetDir>\state.json  -- pet state/commands written by the DSH host half
    - writes <PetDir>\pet.json    -- pet reports its own state (position, clicks)
    - writes <PetDir>\pos.json    -- remembered window position

  Parameters:
    -PetDir      working directory (state.json / pet.json / pos.json / assets)
    -ImagePath   pet image (PNG with transparency); a drawn placeholder is used when empty
    -Scale       scale factor, default 1.0
    -PollMs      state poll interval in ms, default 250

.NOTES
  Transparency: WinForms TransparencyKey turns pixels exactly matching the key
  color into holes. The form background is set to the key color and the image is
  drawn alpha-blended on top. This works best for assets with a solid background
  color; soft semi-transparent shadows cannot be represented perfectly with a
  color key (an inherent WinForms limitation).

  Encoding: this file must stay pure ASCII so Windows PowerShell 5.1 reads it
  correctly regardless of the active ANSI code page.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$PetDir,
    [string]$ImagePath = '',
    [double]$Scale = 1.0,
    [int]$PollMs = 250
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# -- paths ------------------------------------------------------------------
if (-not (Test-Path -LiteralPath $PetDir)) {
    New-Item -ItemType Directory -Path $PetDir -Force | Out-Null
}
$PetDir    = (Resolve-Path -LiteralPath $PetDir).Path
$StateFile = Join-Path $PetDir 'state.json'
$PetFile   = Join-Path $PetDir 'pet.json'
$PosFile   = Join-Path $PetDir 'pos.json'
$LogFile   = Join-Path $PetDir 'pet.log'

function Write-PetLog([string]$Message) {
    try {
        $line = "[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $Message
        Add-Content -LiteralPath $LogFile -Value $line -Encoding UTF8
    } catch { }
}

function Read-JsonFile([string]$Path) {
    try {
        if (-not (Test-Path -LiteralPath $Path)) { return $null }
        $raw = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
        if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
        return $raw | ConvertFrom-Json
    } catch {
        Write-PetLog "read json failed ($Path): $($_.Exception.Message)"
        return $null
    }
}

function Write-JsonFile([string]$Path, $Object) {
    try {
        $json = $Object | ConvertTo-Json -Depth 6 -Compress
        $tmp  = "$Path.tmp"
        Set-Content -LiteralPath $tmp -Value $json -Encoding UTF8
        Move-Item -LiteralPath $tmp -Destination $Path -Force
    } catch {
        Write-PetLog "write json failed ($Path): $($_.Exception.Message)"
    }
}

# Shallow-merge a hashtable over a PSCustomObject read from disk, returning an
# ordered hashtable so extra keys written by either side are preserved.
function Merge-State($Existing, [hashtable]$Patch) {
    $out = [ordered]@{}
    if ($Existing) {
        foreach ($p in $Existing.PSObject.Properties) { $out[$p.Name] = $p.Value }
    }
    foreach ($k in $Patch.Keys) { $out[$k] = $Patch[$k] }
    return $out
}

Write-PetLog "start: PetDir=$PetDir Scale=$Scale PollMs=$PollMs"

# -- placeholder art: a drawn round creature used until real assets arrive ----
function New-PlaceholderBitmap([int]$Size) {
    $bmp = New-Object System.Drawing.Bitmap($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g   = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)

    $bodyRect  = New-Object System.Drawing.RectangleF(2, 2, ($Size - 4), ($Size - 4))
    $bodyBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        $bodyRect,
        [System.Drawing.Color]::FromArgb(255, 120, 190, 255),
        [System.Drawing.Color]::FromArgb(255, 80, 130, 240),
        90.0
    )
    $g.FillEllipse($bodyBrush, $bodyRect)

    $hlRect  = New-Object System.Drawing.RectangleF(($Size * 0.22), ($Size * 0.14), ($Size * 0.34), ($Size * 0.24))
    $hlBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(90, 255, 255, 255))
    $g.FillEllipse($hlBrush, $hlRect)

    $eyeBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 28, 34, 48))
    $eyeW = $Size * 0.11
    $eyeH = $Size * 0.15
    $g.FillEllipse($eyeBrush, ($Size * 0.30), ($Size * 0.40), $eyeW, $eyeH)
    $g.FillEllipse($eyeBrush, ($Size * 0.58), ($Size * 0.40), $eyeW, $eyeH)

    $penW = [Math]::Max(1.0, $Size * 0.025)
    $pen  = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 28, 34, 48), $penW)
    $g.DrawArc($pen, ($Size * 0.42), ($Size * 0.58), ($Size * 0.16), ($Size * 0.12), 20, 140)

    $pen.Dispose(); $eyeBrush.Dispose(); $hlBrush.Dispose(); $bodyBrush.Dispose(); $g.Dispose()
    return $bmp
}

# -- asset loading -----------------------------------------------------------
$baseSize = 160
$sprite   = $null
if ($ImagePath -and (Test-Path -LiteralPath $ImagePath)) {
    try {
        $spritePath = (Resolve-Path -LiteralPath $ImagePath).Path
        $sprite = [System.Drawing.Image]::FromFile($spritePath)
        Write-PetLog "loaded asset: $spritePath ($($sprite.Width)x$($sprite.Height))"
    } catch {
        Write-PetLog "asset load failed: $($_.Exception.Message)"
    }
}
if ($null -eq $sprite) {
    $sprite = New-PlaceholderBitmap $baseSize
    Write-PetLog 'using drawn placeholder art'
}

$winW = [int]([Math]::Round($sprite.Width * $Scale))
$winH = [int]([Math]::Round($sprite.Height * $Scale))

# -- form --------------------------------------------------------------------
$script:sprite = $sprite

$form = New-Object System.Windows.Forms.Form
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$form.ShowInTaskbar   = $false
$form.TopMost         = $true
$form.StartPosition   = [System.Windows.Forms.FormStartPosition]::Manual
$form.Text            = 'DSH Desktop Pet'
$form.ClientSize      = New-Object System.Drawing.Size($winW, $winH)
$form.DoubleBuffered  = $true

$keyColor = [System.Drawing.Color]::FromArgb(255, 1, 2, 3)
$form.BackColor       = $keyColor
$form.TransparencyKey = $keyColor

# Restore last position, else park at the bottom-right of the primary screen.
$screen = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$pos = Read-JsonFile $PosFile
$placed = $false
if ($pos -and ($pos.PSObject.Properties.Name -contains 'x') -and ($pos.PSObject.Properties.Name -contains 'y')) {
    $x = [int]$pos.x
    $y = [int]$pos.y
    foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {
        if ($s.WorkingArea.Contains($x, $y)) { $placed = $true; break }
    }
    if ($placed) { $form.Location = New-Object System.Drawing.Point($x, $y) }
}
if (-not $placed) {
    $form.Location = New-Object System.Drawing.Point(($screen.Right - $winW - 40), ($screen.Bottom - $winH - 40))
}

# -- paint -------------------------------------------------------------------
$form.Add_Paint({
    param($sender, $e)
    $e.Graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $e.Graphics.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $rect = New-Object System.Drawing.Rectangle(0, 0, $sender.ClientSize.Width, $sender.ClientSize.Height)
    $e.Graphics.DrawImage($script:sprite, $rect)
})

# -- drag + click ------------------------------------------------------------
$script:dragging   = $false
$script:dragOffset = New-Object System.Drawing.Point(0, 0)
$script:pressPoint = New-Object System.Drawing.Point(0, 0)
$script:moved      = $false

$form.Add_MouseDown({
    param($sender, $e)
    if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
        $script:dragging   = $true
        $script:moved      = $false
        $script:pressPoint = $e.Location
        $script:dragOffset = $e.Location
    }
})

$form.Add_MouseMove({
    param($sender, $e)
    if ($script:dragging) {
        $dx = [Math]::Abs($e.X - $script:pressPoint.X)
        $dy = [Math]::Abs($e.Y - $script:pressPoint.Y)
        if ($dx -gt 3 -or $dy -gt 3) { $script:moved = $true }
        if ($script:moved) {
            $sender.Location = New-Object System.Drawing.Point(
                ($sender.Location.X + $e.X - $script:dragOffset.X),
                ($sender.Location.Y + $e.Y - $script:dragOffset.Y)
            )
        }
    }
})

$form.Add_MouseUp({
    param($sender, $e)
    if ($e.Button -ne [System.Windows.Forms.MouseButtons]::Left) { return }
    $script:dragging = $false
    $existing = Read-JsonFile $script:PetFile

    if ($script:moved) {
        Write-JsonFile $script:PosFile ([pscustomobject]@{ x = $sender.Location.X; y = $sender.Location.Y })
        $state = Merge-State $existing @{
            x     = $sender.Location.X
            y     = $sender.Location.Y
            event = 'moved'
            at    = (Get-Date).ToString('o')
        }
        Write-JsonFile $script:PetFile ([pscustomobject]$state)
        Write-PetLog "moved to $($sender.Location.X),$($sender.Location.Y)"
    } else {
        Write-PetLog 'clicked -> request conversation'
        $clicks = 1
        if ($existing -and ($existing.PSObject.Properties.Name -contains 'clicks')) {
            $clicks = ([int]$existing.clicks) + 1
        }
        $state = Merge-State $existing @{
            event  = 'click'
            clicks = $clicks
            at     = (Get-Date).ToString('o')
        }
        Write-JsonFile $script:PetFile ([pscustomobject]$state)
    }
})

# -- context menu: quit (handy while debugging) ------------------------------
$menu   = New-Object System.Windows.Forms.ContextMenuStrip
$miQuit = $menu.Items.Add('Quit pet')
$miQuit.Add_Click({ $form.Close() })
$form.ContextMenuStrip = $menu

# -- state polling -----------------------------------------------------------
$script:mood      = 'idle'
$script:pollTimer = New-Object System.Windows.Forms.Timer
$script:pollTimer.Interval = [Math]::Max(60, $PollMs)
$script:pollTimer.Add_Tick({
    $st = Read-JsonFile $script:StateFile
    if (-not $st) { return }

    if ($st.PSObject.Properties.Name -contains 'mood') {
        $m = [string]$st.mood
        if ($m -and $m -ne $script:mood) {
            $script:mood = $m
            Write-PetLog "mood -> $m"
            # Stage 2 hooks the sprite animation switch here.
        }
    }

    if ($st.PSObject.Properties.Name -contains 'visible') {
        $want = [bool]$st.visible
        if ($want -ne $script:form.Visible) { $script:form.Visible = $want }
    }
})

# -- heartbeat: report liveness and position back into pet.json --------------
$script:hbTimer = New-Object System.Windows.Forms.Timer
$script:hbTimer.Interval = 2000
$script:hbTimer.Add_Tick({
    $existing = Read-JsonFile $script:PetFile
    $state = Merge-State $existing @{
        alive = $true
        pid   = $PID
        x     = $script:form.Location.X
        y     = $script:form.Location.Y
        mood  = $script:mood
        at    = (Get-Date).ToString('o')
    }
    Write-JsonFile $script:PetFile ([pscustomobject]$state)
})

$form.Add_Shown({
    $script:pollTimer.Start()
    $script:hbTimer.Start()
    Write-PetLog "shown at $($form.Location.X),$($form.Location.Y) size ${winW}x${winH}"
    Write-JsonFile $script:PetFile ([pscustomobject](Merge-State $null @{
        alive = $true
        ready = $true
        pid   = $PID
        x     = $script:form.Location.X
        y     = $script:form.Location.Y
        mood  = $script:mood
        at    = (Get-Date).ToString('o')
    }))
})

$form.Add_FormClosing({
    $script:pollTimer.Stop()
    $script:hbTimer.Stop()
    Write-JsonFile $script:PosFile ([pscustomobject]@{ x = $script:form.Location.X; y = $script:form.Location.Y })
    Write-JsonFile $script:PetFile ([pscustomobject]@{ alive = $false; event = 'quit'; at = (Get-Date).ToString('o') })
    Write-PetLog 'closing, pet exits'
})

# Single-instance guard: bail out when a live pet already reported in.
if (Test-Path -LiteralPath $PetFile) {
    $existing = Read-JsonFile $PetFile
    if ($existing -and $existing.alive -eq $true -and ($existing.PSObject.Properties.Name -contains 'pid')) {
        $proc = Get-Process -Id ([int]$existing.pid) -ErrorAction SilentlyContinue
        if ($proc -and $proc.ProcessName -match 'powershell|pwsh') {
            Write-PetLog "another pet instance is alive (PID $($existing.pid)); exiting"
            exit 0
        }
    }
}

Write-PetLog 'entering message loop'
[System.Windows.Forms.Application]::Run($form)
Write-PetLog 'message loop ended'

#Requires -Version 5.1
<#
  eyes.ps1 — the capture engine behind the DeepSeek Harness "我的眼睛 / My Eyes" plugin.

  Every request is one JSON line on stdin, every answer one JSON line on stdout:
      "<id>|<request json>"  ->  "<id>|<result json>"

  Actions
    info     screen geometry, monitors, elevation, cursor, foreground window, engine version
    windows  visible top-level windows: id, title, class, pid, process, bounds, foreground
    capture  one snapshot: full desktop, one monitor, a screen region, or one window
             (windows are rendered by the window itself through PrintWindow, so an
              occluded window still yields its own complete content)
    frames   N snapshots over a duration, written as numbered BMP files into a directory

  The script only reads the screen and writes BMP files into the directory the caller
  names. It never touches input devices, never launches programs, never edits files.

  One-shot mode (debugging):
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File eyes.ps1 -RequestPath req.json
#>

param(
    [Parameter(Position = 0)]
    [string]$RequestPath,
    [switch]$Serve
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch { }
try { [Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false) } catch { }

$script:EngineVersion = '1.2.0'
# Fallback only: the caller always names an explicit directory, and the plugin keeps
# every artefact inside its own D:-drive work directory (never the C: system drive).
$script:OutRoot = Join-Path $env:USERPROFILE 'Documents\dsh-my-eyes'

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

# ---------------------------------------------------------------- Win32 layer
$script:Win32Source = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

namespace DshMyEyes
{
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X, Y; }

    [StructLayout(LayoutKind.Sequential)]
    public struct CURSORINFO
    {
        public int cbSize;
        public int flags;
        public IntPtr hCursor;
        public POINT ptScreenPos;
    }

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    public static class EyeApi
    {
        public const uint CURSOR_SHOWING = 0x0001;
        public const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;
        public const int GWL_EXSTYLE = -20;
        public const long WS_EX_TOOLWINDOW = 0x00000080;
        public const uint PW_RENDERFULLCONTENT = 0x00000002;

        [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
        [DllImport("user32.dll")] public static extern bool GetCursorInfo(ref CURSORINFO ci);
        [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
        [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
        [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
        [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
        [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int max);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextLength(IntPtr h);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int max);
        [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr h, int idx);
        [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
        [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);
        [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);

        public static bool ScreenRect(IntPtr h, out RECT r)
        {
            if (DwmGetWindowAttribute(h, DWMWA_EXTENDED_FRAME_BOUNDS, out r, Marshal.SizeOf(typeof(RECT))) == 0) return true;
            return GetWindowRect(h, out r);
        }

        public static string Title(IntPtr h)
        {
            int n = GetWindowTextLength(h);
            if (n <= 0) return string.Empty;
            StringBuilder sb = new StringBuilder(n + 2);
            GetWindowText(h, sb, sb.Capacity);
            return sb.ToString();
        }

        public static string ClassName(IntPtr h)
        {
            StringBuilder sb = new StringBuilder(256);
            GetClassName(h, sb, sb.Capacity);
            return sb.ToString();
        }

        public static bool IsToolWindow(IntPtr h)
        {
            long ex = GetWindowLongPtr(h, GWL_EXSTYLE).ToInt64();
            return (ex & WS_EX_TOOLWINDOW) != 0;
        }

        public static List<IntPtr> TopLevelWindows()
        {
            var list = new List<IntPtr>();
            EnumWindows(delegate(IntPtr h, IntPtr p) { list.Add(h); return true; }, IntPtr.Zero);
            return list;
        }
    }
}
'@

$script:Ui = $null
try {
    if (-not ('DshMyEyes.EyeApi' -as [type])) { Add-Type -TypeDefinition $script:Win32Source -Language CSharp }
    $script:Ui = [DshMyEyes.EyeApi]
    [void]$script:Ui::SetProcessDPIAware()
} catch {
    $script:InitError = "failed to load Win32 layer: $($_.Exception.Message)"
}

# ---------------------------------------------------------------- helpers
function Get-Req {
    param($Req, [string]$Name, $Default)
    if ($null -ne $Req -and $Req.ContainsKey($Name) -and $null -ne $Req[$Name]) { return $Req[$Name] }
    return $Default
}

function Get-ScreenInfo {
    $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $monitors = @()
    foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {
        $monitors += [pscustomobject]@{
            name = $s.DeviceName
            primary = [bool]$s.Primary
            x = $s.Bounds.X; y = $s.Bounds.Y
            width = $s.Bounds.Width; height = $s.Bounds.Height
        }
    }
    return [pscustomobject]@{
        virtual = @{ x = $b.X; y = $b.Y; width = $b.Width; height = $b.Height }
        monitors = $monitors
        monitorCount = $monitors.Count
    }
}

function Get-Elevation {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($id)
    return [pscustomobject]@{
        elevated = [bool]$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
        user = $id.Name
    }
}

function Get-WindowRows {
    param([switch]$IncludeMinimized)
    $rows = New-Object System.Collections.ArrayList
    $fg = $script:Ui::GetForegroundWindow()
    foreach ($h in $script:Ui::TopLevelWindows()) {
        if (-not $script:Ui::IsWindowVisible($h)) { continue }
        if ($script:Ui::IsToolWindow($h)) { continue }
        $title = $script:Ui::Title($h)
        if ([string]::IsNullOrEmpty($title)) { continue }
        $ownerPid = [uint32]0
        [void]$script:Ui::GetWindowThreadProcessId($h, [ref]$ownerPid)
        $rect = New-Object DshMyEyes.RECT
        [void]$script:Ui::ScreenRect($h, [ref]$rect)
        $minimized = [bool]$script:Ui::IsIconic($h)
        if ($minimized -and -not $IncludeMinimized) { continue }
        if (($rect.Right -le $rect.Left) -and -not $minimized) { continue }
        $pname = ''
        try { $pname = (Get-Process -Id $ownerPid -ErrorAction Stop).ProcessName } catch { }
        [void]$rows.Add([pscustomobject]@{
            id         = [int64]$h
            title      = $title
            className  = $script:Ui::ClassName($h)
            pid        = [int]$ownerPid
            process    = $pname
            x          = $rect.Left
            y          = $rect.Top
            width      = [math]::Max(0, $rect.Right - $rect.Left)
            height     = [math]::Max(0, $rect.Bottom - $rect.Top)
            minimized  = $minimized
            foreground = ($h -eq $fg)
        })
    }
    return @($rows)
}

function Resolve-Window {
    param($Req)
    $rows = @(Get-WindowRows -IncludeMinimized)
    $id = [int64](Get-Req $Req 'windowId' 0)
    if ($id -gt 0) { return ($rows | Where-Object { $_.id -eq $id } | Select-Object -First 1) }
    $pidFilter = [int](Get-Req $Req 'pid' 0)
    if ($pidFilter -gt 0) { return ($rows | Where-Object { $_.pid -eq $pidFilter } | Select-Object -First 1) }
    $proc = [string](Get-Req $Req 'process' '')
    if (-not [string]::IsNullOrWhiteSpace($proc)) {
        return ($rows | Where-Object { $_.process -like "*$proc*" -and -not $_.minimized } | Select-Object -First 1)
    }
    $needle = [string](Get-Req $Req 'window' '')
    if (-not [string]::IsNullOrWhiteSpace($needle)) {
        $exact = @($rows | Where-Object { $_.title -ieq $needle })
        if ($exact.Count -gt 0) { return ($exact[0]) }
        return ($rows | Where-Object { $_.title -like "*$needle*" } | Select-Object -First 1)
    }
    return $null
}

function Resolve-Region {
    param($Req)
    $screen = Get-ScreenInfo
    $x = [int](Get-Req $Req 'x' ([int]::MinValue))
    $y = [int](Get-Req $Req 'y' ([int]::MinValue))
    $w = [int](Get-Req $Req 'width' 0)
    $h = [int](Get-Req $Req 'height' 0)

    $monitorIndex = [int](Get-Req $Req 'monitor' -1)
    if ($monitorIndex -ge 0 -and $w -le 0) {
        if ($monitorIndex -ge $screen.monitors.Count) { throw ("monitor index {0} out of range (0..{1})" -f $monitorIndex, ($screen.monitors.Count - 1)) }
        $m = $screen.monitors[$monitorIndex]
        $x = $m.x; $y = $m.y; $w = $m.width; $h = $m.height
    } elseif ($w -le 0 -or $h -le 0) {
        $x = $screen.virtual.x; $y = $screen.virtual.y
        $w = $screen.virtual.width; $h = $screen.virtual.height
    } else {
        if ($x -eq [int]::MinValue) { $x = $screen.virtual.x }
        if ($y -eq [int]::MinValue) { $y = $screen.virtual.y }
    }
    if ($w -lt 1 -or $h -lt 1) { throw 'invalid capture region' }

    [pscustomobject]@{ x = $x; y = $y; width = $w; height = $h; screen = $screen }
}

function Get-TargetSize {
    param([int]$Width, [int]$Height, $Req)
    $maxWidth = [int](Get-Req $Req 'maxWidth' 0)
    $scale = [double](Get-Req $Req 'scale' 0)
    if ($scale -gt 0 -and $scale -le 1) { $maxWidth = [int][math]::Round($Width * $scale) }
    if ($maxWidth -le 0) { return @($Width, $Height) }
    if ($Width -le $maxWidth) { return @($Width, $Height) }
    $ratio = [double]$maxWidth / [double]$Width
    return @($maxWidth, [int][math]::Max(1, [math]::Round($Height * $ratio)))
}

function New-ScaledBitmap {
    param([System.Drawing.Bitmap]$Source, [int]$Width, [int]$Height)
    if ($Width -eq $Source.Width -and $Height -eq $Source.Height) { return $Source }
    $dst = New-Object System.Drawing.Bitmap($Width, $Height, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $g = [System.Drawing.Graphics]::FromImage($dst)
    try {
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
        $g.DrawImage($Source, 0, 0, $Width, $Height)
    } finally {
        $g.Dispose()
    }
    $Source.Dispose()
    return $dst
}

function Save-BitmapAsBmp {
    param([System.Drawing.Bitmap]$Bitmap, [string]$Path)
    $parent = Split-Path -Parent $Path
    if ($parent -and -not (Test-Path $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    $Bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Bmp)
}

function New-Timestamp {
    return (Get-Date -Format 'yyyyMMdd-HHmmss-fff')
}

# ---------------------------------------------------------------- capture
function Invoke-CaptureBitmap {
    param([hashtable]$Req)
    $target = [string](Get-Req $Req 'target' 'screen')
    if ($target -eq 'window') {
        $win = Resolve-Window -Req $Req
        if ($null -eq $win) { throw 'window not found; run action "windows" and pass windowId' }
        $bmp = $null
        $rect = New-Object DshMyEyes.RECT
        [void]$script:Ui::ScreenRect([IntPtr]$win.id, [ref]$rect)
        $w = [math]::Max(1, $rect.Right - $rect.Left)
        $h = [math]::Max(1, $rect.Bottom - $rect.Top)
        $bmp = New-Object System.Drawing.Bitmap($w, $h, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $hdc = $g.GetHdc()
        $printed = $false
        try { $printed = [bool]$script:Ui::PrintWindow([IntPtr]$win.id, $hdc, $script:Ui::PW_RENDERFULLCONTENT) } finally { $g.ReleaseHdc($hdc); $g.Dispose() }
        if (-not $printed) {
            $bmp.Dispose()
            $bmp = New-Object System.Drawing.Bitmap($w, $h, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
            $g = [System.Drawing.Graphics]::FromImage($bmp)
            try { $g.CopyFromScreen($rect.Left, $rect.Top, 0, 0, (New-Object System.Drawing.Size($w, $h))) } finally { $g.Dispose() }
        }
        return [pscustomobject]@{ bitmap = $bmp; x = $rect.Left; y = $rect.Top; width = $w; height = $h; window = $win; printed = $printed }
    }

    $region = Resolve-Region -Req $Req
    $bmp = New-Object System.Drawing.Bitmap($region.width, $region.height, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    try { $g.CopyFromScreen($region.x, $region.y, 0, 0, (New-Object System.Drawing.Size($region.width, $region.height))) } finally { $g.Dispose() }
    return [pscustomobject]@{ bitmap = $bmp; x = $region.x; y = $region.y; width = $region.width; height = $region.height; window = $null; printed = $true }
}

function Invoke-Action {
    param([hashtable]$Req)
    $action = [string](Get-Req $Req 'action' 'info')
    if (-not $script:Ui) { throw $script:InitError }

    switch ($action.ToLowerInvariant()) {
        'info' {
            $elev = Get-Elevation
            $cursor = New-Object DshMyEyes.POINT
            [void]$script:Ui::GetCursorPos([ref]$cursor)
            $fg = $script:Ui::GetForegroundWindow()
            $psi = [System.Diagnostics.Process]::GetCurrentProcess()
            return [pscustomobject]@{
                ok            = $true
                action        = 'info'
                engineVersion = $script:EngineVersion
                psVersion     = $PSVersionTable.PSVersion.ToString()
                os            = [Environment]::OSVersion.VersionString
                user          = $elev.user
                elevated      = $elev.elevated
                sessionId     = $psi.SessionId
                workingSetMB  = [math]::Round(($psi.WorkingSet64 / 1MB), 1)
                cpuSeconds    = [math]::Round($psi.TotalProcessorTime.TotalSeconds, 2)
                screen        = Get-ScreenInfo
                cursor        = @{ x = $cursor.X; y = $cursor.Y }
                foreground    = @{ id = [int64]$fg; title = $script:Ui::Title($fg) }
                windowCount   = (Get-WindowRows).Count
                outRoot       = $script:OutRoot
            }
        }

        'windows' {
            $rows = @(Get-WindowRows -IncludeMinimized)
            $title = [string](Get-Req $Req 'title' '')
            $proc = [string](Get-Req $Req 'process' '')
            if (-not [string]::IsNullOrWhiteSpace($title)) { $rows = @($rows | Where-Object { $_.title -like "*$title*" }) }
            if (-not [string]::IsNullOrWhiteSpace($proc)) { $rows = @($rows | Where-Object { $_.process -like "*$proc*" }) }
            $rows = @($rows | Sort-Object -Property @{ Expression = { $_.foreground }; Descending = $true }, @{ Expression = { $_.width * $_.height }; Descending = $true })
            return [pscustomobject]@{ ok = $true; action = 'windows'; count = $rows.Count; windows = $rows; screen = Get-ScreenInfo }
        }

        'capture' {
            $cap = Invoke-CaptureBitmap -Req $Req
            try {
                $size = Get-TargetSize -Width $cap.width -Height $cap.height -Req $Req
                $bmp = New-ScaledBitmap -Source $cap.bitmap -Width $size[0] -Height $size[1]
                $path = [string](Get-Req $Req 'path' '')
                if ([string]::IsNullOrWhiteSpace($path)) {
                    $dir = [string](Get-Req $Req 'dir' '')
                    if ([string]::IsNullOrWhiteSpace($dir)) { $dir = Join-Path $script:OutRoot ('capture-' + (New-Timestamp)) }
                    $path = Join-Path $dir 'frame.bmp'
                }
                Save-BitmapAsBmp -Bitmap $bmp -Path $path
                $outW = $bmp.Width; $outH = $bmp.Height
                $bmp.Dispose()
                $fg = $script:Ui::GetForegroundWindow()
                return [pscustomobject]@{
                    ok           = $true
                    action       = 'capture'
                    image        = $path
                    width        = $outW
                    height       = $outH
                    sourceWidth  = $cap.width
                    sourceHeight = $cap.height
                    x            = $cap.x
                    y            = $cap.y
                    target       = if ($cap.window) { 'window' } else { 'screen' }
                    window       = $cap.window
                    printed      = $cap.printed
                    screen       = Get-ScreenInfo
                    foreground   = @{ id = [int64]$fg; title = $script:Ui::Title($fg) }
                }
            } finally {
                if ($cap.bitmap -and -not $cap.bitmap.IsDisposed) { $cap.bitmap.Dispose() }
            }
        }

        'frames' {
            $durationMs = [int](Get-Req $Req 'durationMs' 3000)
            if ($durationMs -lt 200) { $durationMs = 200 }
            if ($durationMs -gt 60000) { $durationMs = 60000 }
            $fps = [double](Get-Req $Req 'fps' 3)
            if ($fps -lt 0.2) { $fps = 0.2 }
            if ($fps -gt 10) { $fps = 10 }
            $interval = [int][math]::Max(40, [math]::Round(1000.0 / $fps))
            $maxFrames = [int](Get-Req $Req 'maxFrames' 40)
            if ($maxFrames -lt 2) { $maxFrames = 2 }

            $dir = [string](Get-Req $Req 'dir' '')
            if ([string]::IsNullOrWhiteSpace($dir)) { $dir = Join-Path $script:OutRoot ('watch-' + (New-Timestamp)) }
            if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }

            $frames = New-Object System.Collections.ArrayList
            $started = Get-Date
            $elapsed = 0
            $index = 0
            $errors = New-Object System.Collections.ArrayList
            while ($index -lt $maxFrames) {
                $elapsed = [int]((Get-Date) - $started).TotalMilliseconds
                if ($index -gt 0 -and $elapsed -ge $durationMs) { break }
                $cap = $null
                $bmp = $null
                try {
                    $cap = Invoke-CaptureBitmap -Req $Req
                    $size = Get-TargetSize -Width $cap.width -Height $cap.height -Req $Req
                    $bmp = New-ScaledBitmap -Source $cap.bitmap -Width $size[0] -Height $size[1]
                    $file = Join-Path $dir ('frame-{0:d3}.bmp' -f $index)
                    Save-BitmapAsBmp -Bitmap $bmp -Path $file
                    [void]$frames.Add([pscustomobject]@{
                        index   = $index
                        file    = $file
                        atMs    = [int]((Get-Date) - $started).TotalMilliseconds
                        width   = $bmp.Width
                        height  = $bmp.Height
                    })
                    $index++
                } catch {
                    [void]$errors.Add($_.Exception.Message)
                    if ($errors.Count -ge 3) { break }
                } finally {
                    if ($bmp -and -not $bmp.IsDisposed) { $bmp.Dispose() }
                    if ($cap -and $cap.bitmap -and -not $cap.bitmap.IsDisposed) { $cap.bitmap.Dispose() }
                }
                $spent = [int]((Get-Date) - $started).TotalMilliseconds
                $sleep = $interval - ($spent - $elapsed)
                if ($sleep -gt 0) { Start-Sleep -Milliseconds $sleep }
            }

            $fg = $script:Ui::GetForegroundWindow()
            return [pscustomobject]@{
                ok            = $true
                action        = 'frames'
                dir           = $dir
                frameCount    = $frames.Count
                frames        = $frames
                durationMs    = $durationMs
                actualMs      = [int]((Get-Date) - $started).TotalMilliseconds
                fps           = $fps
                target        = [string](Get-Req $Req 'target' 'screen')
                window        = if ($target -eq 'window') { Resolve-Window -Req $Req } else { $null }
                errors        = @($errors)
                screen        = Get-ScreenInfo
                foreground    = @{ id = [int64]$fg; title = $script:Ui::Title($fg) }
            }
        }

        'cleanup' {
            $keep = [int](Get-Req $Req 'keep' 20)
            if ($keep -lt 0) { $keep = 0 }
            $removed = 0
            $freed = 0
            if (Test-Path $script:OutRoot) {
                $dirs = @(Get-ChildItem $script:OutRoot -Directory | Sort-Object LastWriteTime -Descending)
                for ($i = $keep; $i -lt $dirs.Count; $i++) {
                    $size = (Get-ChildItem $dirs[$i].FullName -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
                    try {
                        Remove-Item $dirs[$i].FullName -Recurse -Force -ErrorAction Stop
                        $removed++
                        $freed += [int64]$size
                    } catch { }
                }
            }
            return [pscustomobject]@{ ok = $true; action = 'cleanup'; removed = $removed; freedMB = [math]::Round($freed / 1MB, 2); kept = $keep; outRoot = $script:OutRoot }
        }

        default { throw ("unknown action '{0}'" -f $action) }
    }
}

# ---------------------------------------------------------------- entrypoint
function ConvertTo-RequestHashtable {
    param($Raw)
    $req = @{}
    if ($null -eq $Raw) { return $req }
    if ($Raw -is [string]) { $Raw = $Raw | ConvertFrom-Json }
    foreach ($p in $Raw.PSObject.Properties) { $req[$p.Name] = $p.Value }
    return $req
}

function Invoke-RequestJson {
    param([string]$Json)
    $req = @{}
    try {
        if ([string]::IsNullOrWhiteSpace($Json)) { throw 'empty request' }
        $req = ConvertTo-RequestHashtable -Raw ($Json | ConvertFrom-Json)
        $result = Invoke-Action -Req $req
    } catch {
        $result = [pscustomobject]@{
            ok     = $false
            action = [string]$req['action']
            error  = [string]$_.Exception.Message
            detail = [string]$_.ScriptStackTrace
        }
    }
    return ($result | ConvertTo-Json -Depth 10 -Compress)
}

if ($Serve) {
    # Lifetime is owned by the caller: closing stdin ends this loop and exits.
    [Console]::Out.WriteLine('{"ok":true,"ready":true,"engine":"my-eyes","version":"' + $script:EngineVersion + '","pid":' + [System.Diagnostics.Process]::GetCurrentProcess().Id + '}')
    [Console]::Out.Flush()
    while ($true) {
        $line = [Console]::In.ReadLine()
        if ($null -eq $line) { break }
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        $id = ''
        $payload = $line
        $sep = $line.IndexOf('|')
        if ($sep -gt 0) { $id = $line.Substring(0, $sep); $payload = $line.Substring($sep + 1) }
        $out = Invoke-RequestJson -Json $payload
        [Console]::Out.WriteLine($id + '|' + $out)
        [Console]::Out.Flush()
    }
    exit 0
}

if ([string]::IsNullOrWhiteSpace($RequestPath)) {
    [Console]::Out.WriteLine('{"ok":false,"error":"missing request JSON path (or pass -Serve)"}')
    exit 0
}
$jsonText = [System.IO.File]::ReadAllText($RequestPath, [System.Text.Encoding]::UTF8)
[Console]::Out.WriteLine((Invoke-RequestJson -Json $jsonText))
exit 0

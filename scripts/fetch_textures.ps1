<#
Downloads planet textures (public domain / permissive sources) into assets/planet_textures.
If online sources fail, generates a pleasant placeholder JPEG so the app still works.

Run from repo root in Windows PowerShell.
#>

$ErrorActionPreference = "Stop"

if (-not ([Net.ServicePointManager]::SecurityProtocol -band [Net.SecurityProtocolType]::Tls12)) {
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
}

$dest = Join-Path $PSScriptRoot "..\assets\planet_textures"
New-Item -ItemType Directory -Path $dest -Force | Out-Null

function Write-Info($msg)  { Write-Host "[INFO]  $msg" -ForegroundColor Cyan }
function Write-Warn($msg)  { Write-Host "[WARN]  $msg" -ForegroundColor Yellow }
function Write-Ok($msg)    { Write-Host "[OK]    $msg" -ForegroundColor Green }
function Write-Err($msg)   { Write-Host "[ERROR] $msg" -ForegroundColor Red }

# Helper: try a list of candidate URLs until one works
function Get-FromCandidates {
  param(
    [string[]]$Urls,
    [string]$OutFile
  )
  foreach ($u in $Urls) {
    try {
      Write-Info "Trying $u"
      Invoke-WebRequest -Uri $u -OutFile $OutFile -UseBasicParsing -ErrorAction Stop
      if ((Test-Path $OutFile) -and ((Get-Item $OutFile).Length -gt 1024)) {
        return $true
      } else {
        Write-Warn "Downloaded but file is too small, trying next source..."
      }
    } catch {
      Write-Warn "Failed: $($_.Exception.Message)"
    }
  }
  return $false
}

# Helper: generate a simple shaded circle JPEG placeholder using System.Drawing
function New-PlaceholderTexture {
  param(
    [string]$OutFile,
    [int]$R = 180, [int]$G = 180, [int]$B = 180
  )
  Add-Type -AssemblyName System.Drawing
  $size = 256
  $bmp  = New-Object System.Drawing.Bitmap $size, $size
  $gfx  = [System.Drawing.Graphics]::FromImage($bmp)
  $gfx.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $gfx.Clear([System.Drawing.Color]::FromArgb(10,10,10))

  $rect = New-Object System.Drawing.Rectangle 0, 0, $size, $size
  $gp = New-Object System.Drawing.Drawing2D.GraphicsPath
  $gp.AddEllipse($rect)
  $brush = New-Object System.Drawing.Drawing2D.PathGradientBrush $gp
  $centerColor = [System.Drawing.Color]::FromArgb([Math]::Min(255, $R + 40), [Math]::Min(255, $G + 40), [Math]::Min(255, $B + 40))
  $edgeColor   = [System.Drawing.Color]::FromArgb($R, $G, $B)
  $brush.CenterColor = $centerColor
  $brush.SurroundColors = ,$edgeColor
  # Move highlight slightly to top-left
  $brush.CenterPoint = New-Object System.Drawing.PointF ($size * 0.32), ($size * 0.32)
  $gfx.FillPath($brush, $gp)

  # Subtle terminator shading (darken right-bottom quadrant)
  $shade = New-Object System.Drawing.Drawing2D.LinearGradientBrush (New-Object System.Drawing.Rectangle 0,0,$size,$size), ([System.Drawing.Color]::FromArgb(0,0,0,0)), ([System.Drawing.Color]::FromArgb(90,0,0,0)), ([System.Drawing.Drawing2D.LinearGradientMode]::ForwardDiagonal)
  $gfx.FillEllipse($shade, 0, 0, $size, $size)

  # Save JPEG with decent quality
  $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
  $ep = New-Object System.Drawing.Imaging.EncoderParameters 1
  $ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), 92L
  $bmp.Save($OutFile, $codec, $ep)
  $gfx.Dispose(); $bmp.Dispose(); $brush.Dispose(); $gp.Dispose(); $shade.Dispose()
}

# Catalog with multiple candidate URLs and a fallback color (approximate)
$catalog = @(
  @{ name='mercury.jpg'; color=@(220,190,150); urls=@(
      'https://upload.wikimedia.org/wikipedia/commons/2/2e/Mercury_in_true_color.jpg'
    ) },
  @{ name='venus.jpg';   color=@(235,210,150); urls=@(
      'https://upload.wikimedia.org/wikipedia/commons/e/e5/Venus-real_color.jpg'
    ) },
  @{ name='earth.jpg';   color=@(120,170,210); urls=@(
      'https://upload.wikimedia.org/wikipedia/commons/9/97/The_Earth_seen_from_Apollo_17.jpg'
    ) },
  @{ name='mars.jpg';    color=@(200,120,90); urls=@(
      'https://upload.wikimedia.org/wikipedia/commons/0/02/OSIRIS_Mars_true_color.jpg'
    ) },
  @{ name='jupiter.jpg'; color=@(210,180,150); urls=@(
      'https://upload.wikimedia.org/wikipedia/commons/e/e2/Jupiter.jpg'
    ) },
  @{ name='saturn.jpg';  color=@(230,210,160); urls=@(
      'https://upload.wikimedia.org/wikipedia/commons/c/c7/Saturn_during_Equinox.jpg'
    ) },
  @{ name='uranus.jpg';  color=@(160,200,210); urls=@(
      'https://upload.wikimedia.org/wikipedia/commons/3/3d/Uranus2.jpg'
    ) },
  @{ name='neptune.jpg'; color=@(90,140,220); urls=@(
      'https://upload.wikimedia.org/wikipedia/commons/5/56/Neptune_Full.jpg'
    ) },
  @{ name='pluto.jpg';   color=@(190,170,160); urls=@(
      'https://upload.wikimedia.org/wikipedia/commons/2/2a/Nh-pluto-in-true-color_2x_JPEG-edit-frame.jpg'
    ) }
)

$ok = 0; $ph = 0
foreach ($item in $catalog) {
  $out = Join-Path $dest $item.name
  Write-Host "\n==== $($item.name) ====" -ForegroundColor Magenta
  if (Get-FromCandidates -Urls $item.urls -OutFile $out) {
    Write-Ok "Saved $out"
    $ok++
  } else {
    Write-Warn "All sources failed; generating placeholder..."
    New-PlaceholderTexture -OutFile $out -R $item.color[0] -G $item.color[1] -B $item.color[2]
    if (Test-Path $out) { Write-Ok "Placeholder created: $out"; $ph++ } else { Write-Err "Failed to create placeholder: $out" }
  }
}

Write-Host "\nDone. Downloaded: $ok, Placeholders: $ph" -ForegroundColor Cyan
Write-Host "Textures are in: $dest" -ForegroundColor Cyan

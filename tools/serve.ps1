# Habla local server.
# Serves the app at http://localhost:<port>/ and keeps your progress in progress.json.
# Started by "Start Habla.cmd". Close the window to stop it.
param(
  [int]$Port = 8642,
  [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path.TrimEnd('\')
$progressFile = Join-Path $root 'progress.json'
$utf8 = New-Object System.Text.UTF8Encoding($false)

$mime = @{
  '.html' = 'text/html; charset=utf-8'
  '.js'   = 'text/javascript; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'
  '.svg'  = 'image/svg+xml'
  '.png'  = 'image/png'
  '.ico'  = 'image/x-icon'
  '.md'   = 'text/plain; charset=utf-8'
  '.txt'  = 'text/plain; charset=utf-8'
}

# Edge has the natural Spanish voices, so open it when it is installed.
function Open-App([string]$u) {
  try { Start-Process 'msedge.exe' -ArgumentList $u -ErrorAction Stop }
  catch { Start-Process $u }
}

function Test-Habla([int]$p) {
  try {
    $r = Invoke-WebRequest -Uri "http://localhost:$p/api/ping" -UseBasicParsing -TimeoutSec 2
    return ($r.Content -match '"habla"')
  } catch { return $false }
}

function Send-Bytes($res, [int]$code, [string]$type, [byte[]]$bytes) {
  $res.StatusCode = $code
  $res.ContentType = $type
  $res.Headers['Cache-Control'] = 'no-store'
  $res.ContentLength64 = $bytes.Length
  $res.OutputStream.Write($bytes, 0, $bytes.Length)
}

function Send-Text($res, [int]$code, [string]$type, [string]$text) {
  Send-Bytes $res $code $type ($utf8.GetBytes($text))
}

$listener = $null
for ($p = $Port; $p -lt ($Port + 10); $p++) {
  $l = New-Object System.Net.HttpListener
  $l.Prefixes.Add("http://localhost:$p/")
  try {
    $l.Start()
    $listener = $l
    $Port = $p
    break
  } catch {
    if (Test-Habla $p) {
      Write-Host "Habla is already running at http://localhost:$p/"
      if (-not $NoBrowser) { Open-App "http://localhost:$p/" }
      exit 0
    }
  }
}
if (-not $listener) {
  Write-Host 'Could not find a free port for Habla.'
  exit 1
}

$url = "http://localhost:$Port/"
Write-Host ''
Write-Host "  Habla is running at $url"
Write-Host '  Keep this window open while you study. Close it to stop.'
Write-Host ''
if (-not $NoBrowser) { Open-App $url }

while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  $req = $ctx.Request
  $res = $ctx.Response
  try {
    $path = [Uri]::UnescapeDataString($req.Url.AbsolutePath)

    if ($path -eq '/api/ping') {
      Send-Text $res 200 'application/json' '{"app":"habla"}'
    }
    elseif ($path -eq '/api/progress') {
      if ($req.HttpMethod -eq 'GET') {
        if (Test-Path -LiteralPath $progressFile) {
          Send-Bytes $res 200 'application/json; charset=utf-8' ([IO.File]::ReadAllBytes($progressFile))
        } else {
          Send-Text $res 200 'application/json' 'null'
        }
      }
      elseif ($req.HttpMethod -eq 'POST') {
        # The custom header blocks other websites from writing here: a cross-site
        # request with it needs a CORS preflight, which this server never grants.
        if ($req.Headers['X-Habla'] -ne '1') {
          Send-Text $res 403 'text/plain' 'forbidden'
        }
        elseif ($req.ContentLength64 -gt 5MB) {
          Send-Text $res 413 'text/plain' 'too large'
        }
        else {
          $reader = New-Object IO.StreamReader($req.InputStream, $utf8)
          $body = $reader.ReadToEnd()
          $reader.Close()
          $null = $body | ConvertFrom-Json
          $tmp = "$progressFile.tmp"
          [IO.File]::WriteAllText($tmp, $body, $utf8)
          Move-Item -LiteralPath $tmp -Destination $progressFile -Force
          Send-Text $res 200 'application/json' '{"ok":true}'
        }
      }
      else {
        Send-Text $res 405 'text/plain' 'method not allowed'
      }
    }
    else {
      if ($path.EndsWith('/')) { $path += 'index.html' }
      $full = [IO.Path]::GetFullPath((Join-Path $root $path.TrimStart('/')))
      $inside = $full.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)
      if ($inside -and (Test-Path -LiteralPath $full -PathType Leaf)) {
        $ext = [IO.Path]::GetExtension($full).ToLowerInvariant()
        $type = $mime[$ext]
        if (-not $type) { $type = 'application/octet-stream' }
        Send-Bytes $res 200 $type ([IO.File]::ReadAllBytes($full))
      } else {
        Send-Text $res 404 'text/plain' 'not found'
      }
    }
  } catch {
    try { $res.StatusCode = 500 } catch {}
  } finally {
    try { $res.OutputStream.Close() } catch {}
  }
}

# Lizzie — Screen Teacher OCR (Sonnet line-snapping).
#
# Runs the built-in Windows.Media.Ocr engine over a PNG and prints the text lines
# it found, each with its pixel bounding box, as a compact JSON array:
#   [{"text":"def foo(x):","x":120,"y":300,"w":410,"h":22}, ...]
#
# WHY: Sonnet 4.6 can READ which line of code it wants to explain but can't
# estimate the line's pixel position reliably (its annotations drift). So we OCR
# the SAME image we send the model, show it these lines + indexes, let it point at
# a line by INDEX, and snap the annotation onto the real rect here. Coordinates are
# in the pixels of the input image — which is the resized screenshot we send Claude
# and the size the overlay canvas uses, so they map 1:1.
#
# No native/compiled dependency — Windows.Media.Ocr ships with Windows 10/11.
# Prints "[]" on any failure so the caller cleanly falls back to the pixel path.

param([Parameter(Mandatory = $true)][string]$ImagePath)

$ErrorActionPreference = "Stop"

try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null

  # The generic AsTask<T>(IAsyncOperation<T>) used to await WinRT async calls from
  # Windows PowerShell 5.1 (which has no native await).
  $asTaskGeneric = [System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object {
      $_.Name -eq 'AsTask' -and
      $_.GetParameters().Count -eq 1 -and
      $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    } | Select-Object -First 1

  function Await($op, $resultType) {
    $m = $asTaskGeneric.MakeGenericMethod($resultType)
    $task = $m.Invoke($null, @($op))
    $task.Wait(-1) | Out-Null
    $task.Result
  }

  # Project the WinRT types we need.
  [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
  [Windows.Storage.FileAccessMode, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
  [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null
  [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime] | Out-Null
  [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType = WindowsRuntime] | Out-Null
  [Windows.Media.Ocr.OcrEngine, Windows.Media.Ocr, ContentType = WindowsRuntime] | Out-Null
  [Windows.Media.Ocr.OcrResult, Windows.Media.Ocr, ContentType = WindowsRuntime] | Out-Null

  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($ImagePath)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])

  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  if ($null -eq $engine) { [Console]::Out.Write("[]"); return }

  $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])

  $out = New-Object System.Collections.Generic.List[object]
  foreach ($line in $result.Lines) {
    $words = @($line.Words)
    if ($words.Count -eq 0) { continue }
    # A line's box is the union of its word boxes.
    $minX = [double]::MaxValue; $minY = [double]::MaxValue; $maxX = 0.0; $maxY = 0.0
    foreach ($w in $words) {
      $r = $w.BoundingRect
      if ($r.X -lt $minX) { $minX = $r.X }
      if ($r.Y -lt $minY) { $minY = $r.Y }
      if (($r.X + $r.Width) -gt $maxX) { $maxX = $r.X + $r.Width }
      if (($r.Y + $r.Height) -gt $maxY) { $maxY = $r.Y + $r.Height }
    }
    $out.Add([pscustomobject]@{
      text = [string]$line.Text
      x = [int][math]::Round($minX)
      y = [int][math]::Round($minY)
      w = [int][math]::Round($maxX - $minX)
      h = [int][math]::Round($maxY - $minY)
    })
  }

  $json = ConvertTo-Json -InputObject $out -Compress -Depth 4
  if ($null -eq $json) { $json = "[]" }
  # ConvertTo-Json emits a bare object (not a 1-element array) for a single item.
  elseif ($out.Count -eq 1) { $json = "[$json]" }
  [Console]::Out.Write($json)
}
catch {
  [Console]::Out.Write("[]")
}

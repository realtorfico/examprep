param(
  [Parameter(Mandatory=$true)][string]$TextFile,
  [Parameter(Mandatory=$true)][string]$OutFile,
  [int]$Rate = -1
)
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$synth.SelectVoice("Microsoft Zira Desktop")
$synth.Rate = $Rate
$text = Get-Content -Raw -Path $TextFile
$synth.SetOutputToWaveFile($OutFile)
$synth.Speak($text)
$synth.Dispose()

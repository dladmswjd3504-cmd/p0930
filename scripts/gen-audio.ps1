# TTS 미지원 기기용 발음 파일 생성 (Windows 내장 en-US 음성 사용)
# 사용: powershell -ExecutionPolicy Bypass -File scripts\gen-audio.ps1
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $root 'var\audio'
New-Item -ItemType Directory -Force $out | Out-Null
$words = Get-Content (Join-Path $root 'data\words.json') -Raw -Encoding UTF8 | ConvertFrom-Json

$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$voice = $synth.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -eq 'en-US' } | Select-Object -First 1
if (-not $voice) { throw 'en-US 음성이 설치되어 있지 않아요. Windows 설정 > 시간 및 언어 > 음성에서 영어(미국)를 추가하세요.' }
$synth.SelectVoice($voice.VoiceInfo.Name)
$synth.Rate = -1
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)

$n = 0
foreach ($w in $words) {
  $file = Join-Path $out $w.audio
  if (Test-Path $file) { continue }
  $synth.SetOutputToWaveFile($file, $fmt)
  $synth.Speak($w.word)
  $n++
}
$synth.SetOutputToNull()
$synth.Dispose()
Write-Output "생성 $n 개 → $out (음성: $($voice.VoiceInfo.Name))"

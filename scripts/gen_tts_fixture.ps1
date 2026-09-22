# R19 测试夹具生成:用 Windows 自带 SAPI 语音合成两段含已知文字的语音 wav(不向仓库提交音频)。
# 优先选中文声音;无中文声音时退回英文声音(转写断言按语言自动切换标记词)。
# 用法: powershell -NoProfile -ExecutionPolicy Bypass -File gen_tts_fixture.ps1 -Out1 <wav> -Out2 <wav>
param([string]$Out1, [string]$Out2)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer

$zh = $s.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture -and $_.VoiceInfo.Culture.Name -like "zh*" } | Select-Object -First 1
$en = $s.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture -and $_.VoiceInfo.Culture.Name -like "en*" } | Select-Object -First 1

if ($zh) {
  $s.SelectVoice($zh.VoiceInfo.Name)
  $text1 = "会议测试一。项目评审,第一项,今天通过。一,二,三,四,五。"
  $text2 = "会议测试二。产品发布,第二项,待评审。六,七,八,九,十。"
  Write-Output "LANG=zh"
} elseif ($en) {
  $s.SelectVoice($en.VoiceInfo.Name)
  $text1 = "Meeting test one. Project review, item number one. The first item is approved today. One two three four five."
  $text2 = "Meeting test two. Release plan, item number two. The second item is pending review. Six seven eight nine ten."
  Write-Output "LANG=en"
} else {
  Write-Output "LANG=none"
  $s.Dispose()
  exit 3
}

$s.Rate = 0
$s.SetOutputToWaveFile($Out1)
$s.Speak($text1)
$s.SetOutputToWaveFile($Out2)
$s.Speak($text2)
$s.Dispose()
Write-Output "GEN=ok"

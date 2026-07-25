import { randomUUID } from 'node:crypto'
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '../../services/process-runner'

interface TtsInput {
  text: string
  voiceId?: string
  rate?: number
  volume?: number
}

const TEMP_DIRECTORY_PREFIX = 'freecut-tts-'
const TEMP_DIRECTORY_MAX_AGE_MS = 24 * 60 * 60 * 1000

const LIST_VOICES_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $type = [Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType=WindowsRuntime]
  $type::AllVoices | ForEach-Object {
    [pscustomobject]@{ id = $_.Id; name = $_.DisplayName; language = $_.Language }
  } | ConvertTo-Json -Compress
} catch {
  $voice = New-Object -ComObject SAPI.SpVoice
  @($voice.GetVoices()) | ForEach-Object {
    [pscustomobject]@{ id = $_.Id; name = $_.GetDescription() }
  } | ConvertTo-Json -Compress
}
`

const SYNTHESIZE_SCRIPT = String.raw`
param([string]$InputPath, [string]$OutputPath)
$ErrorActionPreference = 'Stop'
$input = Get-Content -LiteralPath $InputPath -Raw -Encoding UTF8 | ConvertFrom-Json
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $synth = [Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType=WindowsRuntime]::new()
  if ($input.voiceId) {
    $voice = [Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType=WindowsRuntime]::AllVoices |
      Where-Object { $_.Id -eq $input.voiceId } | Select-Object -First 1
    if ($voice) { $synth.Voice = $voice }
  }
  if ($null -ne $input.rate) {
    $normalizedRate = [Math]::Max(-10, [Math]::Min(10, [double]$input.rate))
    $synth.Options.SpeakingRate = [Math]::Pow(2.0, $normalizedRate / 10.0)
  }
  if ($null -ne $input.volume) {
    $normalizedVolume = [double]$input.volume
    if ($normalizedVolume -gt 1) { $normalizedVolume = $normalizedVolume / 100 }
    $synth.Options.AudioVolume = [Math]::Max(0, [Math]::Min(1, $normalizedVolume))
  }
  $operation = $synth.SynthesizeTextToStreamAsync([string]$input.text)
  $stream = [System.WindowsRuntimeSystemExtensions]::AsTask($operation).Result
  $reader = [Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType=WindowsRuntime]::new($stream)
  [System.WindowsRuntimeSystemExtensions]::AsTask($reader.LoadAsync([uint32]$stream.Size)).Wait()
  $bytes = New-Object byte[] $stream.Size
  $reader.ReadBytes($bytes)
  [System.IO.File]::WriteAllBytes($OutputPath, $bytes)
  exit 0
} catch {
  $voice = New-Object -ComObject SAPI.SpVoice
  if ($input.voiceId) {
    $selected = @($voice.GetVoices()) | Where-Object { $_.Id -eq $input.voiceId } | Select-Object -First 1
    if ($selected) { $voice.Voice = $selected }
  }
  if ($null -ne $input.rate) { $voice.Rate = [Math]::Max(-10, [Math]::Min(10, [int]$input.rate)) }
  if ($null -ne $input.volume) {
    $sapiVolume = [double]$input.volume
    if ($sapiVolume -le 1) { $sapiVolume = $sapiVolume * 100 }
    $voice.Volume = [Math]::Max(0, [Math]::Min(100, [int]$sapiVolume))
  }
  $stream = New-Object -ComObject SAPI.SpFileStream
  $stream.Open($OutputPath, 3, $false)
  $voice.AudioOutputStream = $stream
  [void]$voice.Speak([string]$input.text)
  $stream.Close()
}
`

async function cleanupExpiredTemporaryDirectories(): Promise<void> {
  const temporaryRoot = tmpdir()
  const cutoff = Date.now() - TEMP_DIRECTORY_MAX_AGE_MS
  const entries = await readdir(temporaryRoot, { withFileTypes: true })
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(TEMP_DIRECTORY_PREFIX))
      .map(async (entry) => {
        const path = join(temporaryRoot, entry.name)
        try {
          if ((await stat(path)).mtimeMs < cutoff) {
            await rm(path, { recursive: true, force: true })
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }),
  )
}

function validateWaveFile(bytes: Buffer): void {
  if (bytes.length === 0) {
    throw new Error('Windows speech synthesis produced an empty WAV file.')
  }
  if (
    bytes.length < 12 ||
    bytes.subarray(0, 4).toString('ascii') !== 'RIFF' ||
    bytes.subarray(8, 12).toString('ascii') !== 'WAVE'
  ) {
    throw new Error('Windows speech synthesis produced an invalid WAV file.')
  }
}

export class WindowsTtsService {
  constructor(private readonly outputDirectory: string) {}

  async listVoices(): Promise<Array<{ id: string; name: string; language?: string }>> {
    const encoded = Buffer.from(LIST_VOICES_SCRIPT, 'utf16le').toString('base64')
    const result = await runProcess({
      executable: 'powershell.exe',
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      timeoutMs: 30_000,
    })
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || 'Failed to list Windows speech voices.')
    }
    const parsed = JSON.parse(result.stdout || '[]') as
      | { id: string; name: string; language?: string }
      | Array<{ id: string; name: string; language?: string }>
    return Array.isArray(parsed) ? parsed : [parsed]
  }

  async synthesize(input: TtsInput): Promise<string> {
    if (!input.text.trim()) throw new Error('TTS text is required.')
    if (input.text.length > 100_000) throw new Error('TTS text exceeds 100,000 characters.')
    await cleanupExpiredTemporaryDirectories()
    await mkdir(this.outputDirectory, { recursive: true })
    const id = randomUUID()
    const temporaryDirectory = await mkdtemp(join(tmpdir(), TEMP_DIRECTORY_PREFIX))
    const inputPath = join(temporaryDirectory, 'input.json')
    const temporaryOutputPath = join(temporaryDirectory, 'output.wav')
    const scriptPath = join(temporaryDirectory, 'synthesize.ps1')
    const outputPath = join(this.outputDirectory, `${id}.wav`)
    const stagedOutputPath = join(this.outputDirectory, `.${id}.wav.tmp`)
    try {
      await writeFile(inputPath, JSON.stringify(input))
      await writeFile(scriptPath, SYNTHESIZE_SCRIPT)
      const result = await runProcess({
        executable: 'powershell.exe',
        args: [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          scriptPath,
          inputPath,
          temporaryOutputPath,
        ],
        timeoutMs: 5 * 60_000,
      })
      if (result.exitCode !== 0) {
        throw new Error(result.stderr.trim() || 'Windows speech synthesis failed.')
      }
      validateWaveFile(await readFile(temporaryOutputPath))
      await copyFile(temporaryOutputPath, stagedOutputPath)
      await rename(stagedOutputPath, outputPath)
      return outputPath
    } finally {
      await Promise.all([
        rm(temporaryDirectory, { recursive: true, force: true }),
        rm(stagedOutputPath, { force: true }),
      ])
    }
  }
}

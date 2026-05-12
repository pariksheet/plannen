import { spawn } from 'node:child_process'
import { writeFile, readFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const DEFAULT_MODEL = `${process.env.HOME ?? ''}/.plannen/whisper/ggml-base.en.bin`

export function modelPath(): string {
  return process.env.PLANNEN_WHISPER_MODEL && process.env.PLANNEN_WHISPER_MODEL !== 'disabled'
    ? process.env.PLANNEN_WHISPER_MODEL
    : DEFAULT_MODEL
}

export function isDisabled(): boolean {
  return process.env.PLANNEN_WHISPER_MODEL === 'disabled'
}

export function parseDetectedLanguage(stderr: string): string | null {
  const m = stderr.match(/auto-detected language:\s*([a-z]{2})\b/i)
  return m ? m[1].toLowerCase() : null
}

export function extFromContentType(ct: string | undefined): string | null {
  if (!ct) return null
  const lower = ct.split(';')[0].trim().toLowerCase()
  switch (lower) {
    case 'audio/mpeg':   return 'mp3'
    case 'audio/mp3':    return 'mp3'
    case 'audio/mp4':    return 'm4a'
    case 'audio/x-m4a':  return 'm4a'
    case 'audio/aac':    return 'aac'
    case 'audio/wav':    return 'wav'
    case 'audio/x-wav':  return 'wav'
    case 'audio/ogg':    return 'ogg'
    case 'audio/webm':   return 'webm'
    case 'audio/flac':   return 'flac'
    default:             return null
  }
}

export function commandExists(cmd: string): Promise<boolean> {
  return new Promise(resolve => {
    const child = spawn(process.platform === 'win32' ? 'where' : 'command', process.platform === 'win32' ? [cmd] : ['-v', cmd], { stdio: 'ignore', shell: true })
    child.on('exit', code => resolve(code === 0))
    child.on('error', () => resolve(false))
  })
}

export async function whisperAvailable(): Promise<boolean> {
  if (isDisabled()) return false
  return await commandExists('whisper-cli')
}

export async function ffmpegAvailable(): Promise<boolean> {
  return await commandExists('ffmpeg')
}

interface RunResult { stdout: string; stderr: string; code: number | null }

function runCmd(cmd: string, args: string[]): Promise<RunResult> {
  return new Promise(resolve => {
    const child = spawn(cmd, args)
    let stdout = '', stderr = ''
    child.stdout.on('data', d => { stdout += d.toString() })
    child.stderr.on('data', d => { stderr += d.toString() })
    child.on('close', code => resolve({ stdout, stderr, code }))
    child.on('error', err => resolve({ stdout, stderr: stderr + String(err), code: -1 }))
  })
}

async function safeUnlink(...paths: string[]): Promise<void> {
  for (const p of paths) {
    try { await unlink(p) } catch { /* ignore */ }
  }
}

export async function transcribeAudioBytes(
  bytes: Uint8Array,
  hint: { contentType?: string; ext?: string } = {},
): Promise<{ transcript: string; language: string }> {
  const ext = hint.ext ?? extFromContentType(hint.contentType) ?? 'm4a'
  const base = join(tmpdir(), `plannen-${randomUUID()}`)
  const inputPath = `${base}.${ext}`
  await writeFile(inputPath, bytes)

  // whisper-cli's bundled decoder only handles wav, mp3, flac, and Vorbis-in-ogg.
  // Browser voice notes are typically Opus-in-ogg or webm/opus, which whisper
  // silently fails to decode (exits 0 with no .txt output). When ffmpeg is
  // available, normalise everything to 16 kHz mono PCM WAV first.
  const haveFfmpeg = await ffmpegAvailable()
  let whisperInput = inputPath
  let convertedPath: string | null = null
  if (haveFfmpeg) {
    convertedPath = `${base}.wav`
    const ffArgs = ['-y', '-i', inputPath, '-ar', '16000', '-ac', '1', '-f', 'wav', convertedPath]
    const ff = await runCmd('ffmpeg', ffArgs)
    if (ff.code !== 0) {
      await safeUnlink(inputPath, convertedPath)
      throw new Error(`ffmpeg exited ${ff.code ?? 'null'}: ${ff.stderr.slice(-500)}`)
    }
    whisperInput = convertedPath
  }

  const txtPath = `${whisperInput}.txt`   // whisper-cli writes <input>.txt with -otxt
  const cleanup = () => safeUnlink(...[inputPath, txtPath, convertedPath].filter(Boolean) as string[])

  const args = ['-m', modelPath(), '-f', whisperInput, '-otxt', '-l', 'auto', '-nt']
  const { stderr, code } = await runCmd('whisper-cli', args)
  if (code !== 0) {
    await cleanup()
    throw new Error(`whisper-cli exited ${code ?? 'null'}: ${stderr.slice(-500)}`)
  }
  let transcript = ''
  try { transcript = (await readFile(txtPath, 'utf8')).trim() }
  catch (e) {
    await cleanup()
    const hintMsg = haveFfmpeg
      ? ''
      : ' (install ffmpeg to support opus/m4a/webm: brew install ffmpeg)'
    throw new Error(`whisper-cli produced no transcript file${hintMsg}: ${e instanceof Error ? e.message : String(e)}`)
  }
  const language = parseDetectedLanguage(stderr) ?? 'en'
  await cleanup()
  return { transcript, language }
}

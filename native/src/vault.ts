import { spawn } from 'node:child_process'
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ActionError } from '../../shared/protocol.js'

const MAX_FILE_BYTES = 32 * 1024 * 1024

// Only the wrapping key passes through stdin. It never appears in arguments,
// logs, the Canvas context, or MyWallpaper's synchronized settings.
async function dpapi(input: Buffer, protect: boolean): Promise<Buffer> {
  const operation = protect ? 'Protect' : 'Unprotect'
  const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $bytes=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $result=[Security.Cryptography.ProtectedData]::${operation}($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($result))`
  return new Promise((resolve, reject) => {
    const executable = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const child = spawn(executable, ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
    let output = ''
    const timer = setTimeout(() => { child.kill(); reject(new ActionError('storage-failed')) }, 12_000)
    child.stdout.on('data', bytes => { output += bytes.toString('ascii'); if (output.length > 16_384) child.kill() })
    child.once('error', () => { clearTimeout(timer); reject(new ActionError('storage-failed')) })
    child.once('exit', code => { clearTimeout(timer); code === 0 && output.length > 0 ? resolve(Buffer.from(output.trim(), 'base64')) : reject(new ActionError('storage-failed')) })
    child.stdin.on('error', () => {})
    child.stdin.end(input.toString('base64'))
  })
}

function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT' }

async function atomicWrite(path: string, bytes: Buffer | string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' })
    await rename(temporary, path)
  } finally { await unlink(temporary).catch(error => { if (!missing(error)) throw error }) }
}

export class Vault {
  private key: Buffer | undefined
  private lockToken = randomUUID()
  private ownsLock = false
  constructor(readonly directory: string) {}

  async open() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const lockPath = join(this.directory, 'session.lock')
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await writeFile(lockPath, JSON.stringify({ pid: process.pid, token: this.lockToken }), { mode: 0o600, flag: 'wx' })
        this.ownsLock = true; break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new ActionError('storage-failed')
        let pid: number
        try { pid = JSON.parse(await readFile(lockPath, 'utf8')).pid } catch { throw new ActionError('session-in-use') }
        if (!Number.isSafeInteger(pid) || pid <= 0) throw new ActionError('session-in-use')
        try { process.kill(pid, 0); throw new ActionError('session-in-use') } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw new ActionError('session-in-use')
        }
        await unlink(lockPath)
      }
    }
    if (!this.ownsLock) throw new ActionError('session-in-use')
    try {
      const keyPath = join(this.directory, 'session.key')
      try {
        const envelope = JSON.parse(await readFile(keyPath, 'utf8')) as { format: string; bytes: string }
        if (typeof envelope.bytes !== 'string' || envelope.bytes.length > 16_384) throw new Error('invalid wrapping key')
        if (process.platform === 'win32' && envelope.format !== 'dpapi-v1') throw new Error('unprotected Windows key')
        if (process.platform !== 'win32' && envelope.format !== 'local-preview-v1') throw new Error('foreign wrapping key')
        this.key = envelope.format === 'dpapi-v1' ? await dpapi(Buffer.from(envelope.bytes, 'base64'), false) : Buffer.from(envelope.bytes, 'base64')
      } catch (error) {
        if (!missing(error)) throw error
        // A missing key must never overwrite an existing encrypted session.
        try { await readFile(join(this.directory, 'auth.bin')); throw new Error('session key is missing') } catch (existing) { if (!missing(existing)) throw existing }
        this.key = randomBytes(32)
        const wrapped = process.platform === 'win32' ? await dpapi(this.key, true) : this.key
        await writeFile(keyPath, JSON.stringify({ format: process.platform === 'win32' ? 'dpapi-v1' : 'local-preview-v1', bytes: wrapped.toString('base64') }), { flag: 'wx', mode: 0o600 })
      }
      if (this.key.length !== 32) throw new Error('invalid wrapping key length')
    } catch { await this.close(); throw new ActionError('storage-failed') }
  }
  async read(name: 'auth' | 'history'): Promise<string | undefined> {
    if (!this.key) throw new ActionError('storage-failed')
    let bytes: Buffer
    try { bytes = await readFile(join(this.directory, `${name}.bin`)) } catch (error) { if (missing(error)) return; throw new ActionError('storage-failed') }
    if (bytes.length < 32 || bytes.length > MAX_FILE_BYTES || bytes.subarray(0, 4).toString() !== 'MWA1') throw new ActionError('storage-failed')
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(4, 16))
      decipher.setAuthTag(bytes.subarray(16, 32))
      return Buffer.concat([decipher.update(bytes.subarray(32)), decipher.final()]).toString('utf8')
    } catch { throw new ActionError('storage-failed') }
  }
  async write(name: 'auth' | 'history', source: string) {
    if (!this.key || Buffer.byteLength(source) > MAX_FILE_BYTES - 32) throw new ActionError('storage-failed')
    const nonce = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce)
    const encrypted = Buffer.concat([cipher.update(source, 'utf8'), cipher.final()])
    await atomicWrite(join(this.directory, `${name}.bin`), Buffer.concat([Buffer.from('MWA1'), nonce, cipher.getAuthTag(), encrypted]))
  }
  async clearData() {
    for (const name of ['auth.bin', 'history.bin']) await unlink(join(this.directory, name)).catch(error => { if (!missing(error)) throw error })
  }
  async close() {
    this.key?.fill(0); this.key = undefined
    if (!this.ownsLock) return
    const path = join(this.directory, 'session.lock')
    try { if (JSON.parse(await readFile(path, 'utf8')).token === this.lockToken) await unlink(path) } catch (error) { if (!missing(error)) throw error }
    this.ownsLock = false
  }
}

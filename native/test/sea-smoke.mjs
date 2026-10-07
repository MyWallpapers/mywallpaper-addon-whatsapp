import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Exercise the built Windows binary, not a separate mock or development loader.
if (process.platform !== 'win32') throw new Error('Run this check on Windows.')
const binary = resolve(dirname(fileURLToPath(import.meta.url)), '../out/windows-x86_64/bin/whatsapp.exe')
const profile = await mkdtemp(join(tmpdir(), 'mwp-wa-smoke-'))
const requestId = randomUUID()
let child
try {
  child = spawn(binary, [], { env: { ...process.env, LOCALAPPDATA: profile }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  const write = value => { const bytes = Buffer.from(JSON.stringify(value)); const header = Buffer.alloc(4); header.writeUInt32LE(bytes.length); child.stdin.write(Buffer.concat([header, bytes])) }
  const result = new Promise((accept, reject) => {
    let pending = Buffer.alloc(0)
    let ready = false
    const timer = setTimeout(() => { child.kill(); reject(new Error('Native handshake timed out')) }, 30_000)
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.stdin.on('error', () => {})
    child.stderr.on('data', () => {})
    child.stdout.on('data', bytes => {
      try {
        pending = Buffer.concat([pending, bytes])
        while (pending.length >= 4 && pending.length >= pending.readUInt32LE(0) + 4) {
          const length = pending.readUInt32LE(0)
          if (length > 1024 * 1024) throw new Error('Unframed or oversized native output')
          const value = JSON.parse(pending.subarray(4, 4 + length).toString('utf8')); pending = pending.subarray(4 + length)
          if (value.type === 'error') throw new Error(`Native error: ${value.code}`)
          if (value.type === 'ready') {
            ready = true
            write({ type: 'message', v: 5, surface: 'interface', instanceId: 'smoke', displayIndex: 0, payload: { kind: 'wa.command', requestId, action: 'snapshot' } })
          }
          if (value.payload?.kind === 'wa.result' && value.payload.requestId === requestId) {
            assert.equal(ready, true); assert.equal(value.payload.ok, true)
            assert.deepEqual(value.payload.result, { state: { status: 'idle' }, chats: [] })
            write({ type: 'shutdown', v: 5 })
          }
        }
      } catch (error) { clearTimeout(timer); child.kill(); reject(error) }
    })
    child.once('exit', code => { clearTimeout(timer); code === 0 && ready ? accept() : reject(new Error(`Native executable exited with ${code}`)) })
  })
  write({ type: 'init', v: 5, addonId: 'whatsapp-smoke', artifactDigest: 'a'.repeat(64), version: '0.1.0', targetArchitecture: 'windows-x86_64', scratchDirectory: join(profile, 'layer-smoke'), layerSettings: {}, deviceSettings: {} })
  await result
  console.log('Windows SEA: process-v2 ready/snapshot/shutdown and DPAPI storage verified.')
} finally {
  if (child && child.exitCode === null) child.kill()
  // Only our own uniquely named disposable profile is removed.
  if (!resolve(profile).startsWith(resolve(tmpdir()) + '\\') || !profile.includes('mwp-wa-smoke-')) throw new Error('Unexpected temporary profile path')
  await rm(profile, { recursive: true, force: true })
}

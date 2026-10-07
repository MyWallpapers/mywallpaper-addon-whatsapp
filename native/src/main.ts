import { createHash } from 'node:crypto'
import { basename, join } from 'node:path'
import { FramedTransport } from './transport.js'
import { Session } from './session.js'

// Library diagnostics cannot share stdout with the host's binary framing.
console.log = console.info = console.debug = console.warn = console.error = () => {}
const transport = new FramedTransport(process.stdin, process.stdout)
let session: Session | undefined
let cleanup: (() => void) | undefined
let closing = false
async function close() {
  if (closing) return
  closing = true; cleanup?.()
  await session?.close(); await transport.flush()
}
process.once('SIGTERM', () => { void close().finally(() => process.exit()) })
process.once('SIGINT', () => { void close().finally(() => process.exit()) })
async function main() {
try {
  for await (const raw of transport.records()) {
    const frame = raw as { type?: string; v?: number; addonId?: string; scratchDirectory?: string; deviceSettings?: Record<string, unknown>; payload?: unknown }
    if (frame.v !== transport.version) throw new Error('Invalid protocol version')
    if (frame.type === 'init') {
      if (session || typeof frame.addonId !== 'string' || !frame.addonId || frame.addonId.length > 200 || typeof frame.scratchDirectory !== 'string') throw new Error('Invalid initialization')
      const layerKey = basename(frame.scratchDirectory)
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(layerKey) || !process.env.LOCALAPPDATA) throw new Error('Invalid session scope')
      const addonKey = createHash('sha256').update(frame.addonId).digest('hex')
      session = new Session(join(process.env.LOCALAPPDATA, 'MyWallpaper', 'Addons', 'WhatsApp', addonKey, layerKey), frame.deviceSettings?.markRead === true)
      cleanup = session.subscribe(payload => { void transport.send({ type: 'message', v: transport.version, target: 'broadcast', payload }).catch(() => { void close() }) })
      await transport.send({ type: 'ready', v: transport.version })
    } else if (!session) throw new Error('Host has not initialized the companion')
    else if (frame.type === 'settings') session.settings(frame.deviceSettings?.markRead === true)
    else if (frame.type === 'message') {
      // Do not block stdin while WhatsApp responds; Session bounds and serializes mutations.
      void session.handle(frame.payload).then(payload => payload && transport.send({ type: 'message', v: transport.version, target: 'broadcast', payload })).catch(() => {})
    } else if (frame.type === 'shutdown') break
    else throw new Error('Unknown host frame')
  }
} catch {
  await transport.send({ type: 'error', v: transport.version, code: 'companion-protocol-error', message: 'The WhatsApp companion could not complete this host request.' }).catch(() => {})
  process.exitCode = 1
} finally { await close() }
}
void main()

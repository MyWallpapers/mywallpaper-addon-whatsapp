import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { WebSocketServer, WebSocket } from 'ws'
import { Session } from './session.js'

console.log = console.info = console.debug = console.warn = console.error = () => {}
const directory = process.platform === 'win32' ? join(process.env.LOCALAPPDATA!, 'MyWallpaper', 'Preview', 'WhatsApp') : join(homedir(), '.local', 'state', 'mywallpaper-whatsapp-preview')
const session = new Session(directory)
const server = createServer((_request, response) => { response.writeHead(404); response.end() })
const websocket = new WebSocketServer({ noServer: true, maxPayload: 16_384 })
const origins = new Set(['http://127.0.0.1:5190', 'http://localhost:5190'])
server.on('upgrade', (request, socket, head) => {
  if (!origins.has(request.headers.origin ?? '') || !['127.0.0.1:5191', 'localhost:5191'].includes(request.headers.host ?? '')) { socket.destroy(); return }
  websocket.handleUpgrade(request, socket, head, client => websocket.emit('connection', client, request))
})
websocket.on('connection', client => {
  const unsubscribe = session.subscribe(event => { if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(event)) })
  client.on('message', data => {
    let value: unknown
    try { value = JSON.parse(data.toString('utf8')) } catch { client.close(1003); return }
    void session.handle(value).then(result => { if (result && client.readyState === WebSocket.OPEN) client.send(JSON.stringify(result)) })
  })
  client.once('close', unsubscribe)
  client.on('error', () => {})
})
server.listen(5191, '127.0.0.1', () => process.stderr.write('WhatsApp preview companion listening on 127.0.0.1:5191\n'))
let stopping = false
async function close() {
  if (stopping) return
  stopping = true
  websocket.clients.forEach(client => client.close()); websocket.close(); server.close()
  await session.close()
}
process.once('SIGTERM', () => { void close().finally(() => process.exit()) })
process.once('SIGINT', () => { void close().finally(() => process.exit()) })

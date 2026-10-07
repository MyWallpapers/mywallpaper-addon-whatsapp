import { RpcClient } from './client'
import { createDemoClient } from './demo'
import { createWidget } from './widget'
import { ActionError } from '../shared/protocol'

const params = new URLSearchParams(location.search)
const demo = params.has('demo')
const wide = params.has('wide')
document.documentElement.lang = 'fr'
const style = document.createElement('style')
style.textContent = `html,body{margin:0;min-height:100%;background:#15181b}body{min-height:100dvh;display:grid;place-items:center;background:radial-gradient(ellipse at 20% 10%,#233139,transparent 70%),radial-gradient(ellipse at 90% 90%,#242d28,transparent 65%),#101316}#preview{width:min(${wide ? 720 : 400}px,calc(100vw - 32px));height:min(620px,calc(100dvh - 32px));min-height:240px}.wa-stage{padding:0}`
document.head.append(style)
const root = document.querySelector<HTMLElement>('#app')!; root.id = 'preview'
let client
if (demo) client = createDemoClient()
else {
  const socket = new WebSocket('ws://127.0.0.1:5191')
  const opened = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new ActionError('offline')) }, 8000)
    socket.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new ActionError('offline')) }, { once: true })
  })
  client = new RpcClient(async command => { await opened; if (socket.readyState !== WebSocket.OPEN) throw new ActionError('offline'); socket.send(JSON.stringify(command)) }, () => socket.close())
  const live = client
  socket.addEventListener('message', event => { try { live.receive(JSON.parse(event.data)) } catch {} })
  socket.addEventListener('close', () => live.receive({ kind: 'wa.state', state: { status: 'error', error: 'offline' } }))
}
const widget = createWidget(root, client, { settings: { language: 'fr' }, demo })
window.addEventListener('pagehide', () => { widget.dispose(); client.close() }, { once: true })

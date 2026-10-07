import type { CanvasLayerApi, JsonValue, NativeConnection } from '../generated/mywallpaper-runtime'
import { ActionError, type Action, type Command, type MessagingClient, type Payload, type Push } from '../shared/protocol'

export class RpcClient implements MessagingClient {
  private listeners = new Set<(event: Push) => void>()
  private pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private stopped = false
  constructor(private send: (command: Command) => Promise<void>, private stop: () => void) {}
  subscribe(listener: (event: Push) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  receive(raw: unknown) {
    if (this.stopped || !raw || typeof raw !== 'object') return
    const value = raw as Payload
    if (value.kind === 'wa.result') {
      const pending = this.pending.get(value.requestId)
      if (!pending) return
      clearTimeout(pending.timer)
      this.pending.delete(value.requestId)
      if (value.ok) pending.resolve(value.result)
      else pending.reject(new ActionError(value.error ?? 'action-failed'))
    } else if (['wa.state', 'wa.chats', 'wa.message', 'wa.reset'].includes(value.kind)) {
      this.listeners.forEach(listener => listener(value as Push))
    }
  }
  async request<T>(action: Action, input: Pick<Command, 'chatId' | 'before' | 'text' | 'messageId'> = {}): Promise<T> {
    if (this.stopped) throw new ActionError('offline')
    if (this.pending.size >= 12) throw new ActionError('not-ready')
    const requestId = crypto.randomUUID()
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new ActionError(action === 'send' ? 'send-unconfirmed' : 'timeout')) }, action === 'send' ? 60_000 : 20_000)
      this.pending.set(requestId, { resolve: value => resolve(value as T), reject, timer })
      void this.send({ kind: 'wa.command', requestId, action, ...input }).catch(error => {
        const pending = this.pending.get(requestId)
        if (!pending) return
        clearTimeout(pending.timer); this.pending.delete(requestId); pending.reject(error instanceof ActionError ? error : new ActionError('offline'))
      })
    })
  }
  close() {
    if (this.stopped) return
    this.stopped = true
    this.pending.forEach(pending => { clearTimeout(pending.timer); pending.reject(new ActionError('offline')) })
    this.pending.clear(); this.listeners.clear(); this.stop()
  }
}

export function createNativeClient(layer: CanvasLayerApi): MessagingClient {
  let connection: NativeConnection | null = null
  let disposed = false
  let stopMessages: (() => void) | undefined
  let stopState: (() => void) | undefined
  const connecting = layer.native.companion.available ? layer.native.companion.connect() : Promise.reject(new ActionError('desktop-required'))
  const client = new RpcClient(async command => {
    if (!connection) { try { connection = await connecting } catch { throw new ActionError('desktop-required') } }
    if (disposed) throw new ActionError('offline')
    await connection.send(command as unknown as JsonValue)
  }, () => { disposed = true; stopMessages?.(); stopState?.(); connection?.close() })
  void connecting.then(value => {
    if (disposed) { value.close(); return }
    connection = value
    stopMessages = value.onMessage(payload => client.receive(payload))
    stopState = value.onStateChange(state => {
      if (state === 'open') void client.request('snapshot').then(snapshot => {
        const value = snapshot as { state: unknown; chats: unknown }
        client.receive({ kind: 'wa.state', state: value.state }); client.receive({ kind: 'wa.chats', chats: value.chats })
      }).catch(() => {})
      else client.receive({ kind: 'wa.state', state: { status: state === 'reconnecting' ? 'reconnecting' : 'error', error: 'offline' } })
    })
  }).catch(() => {})
  return client
}

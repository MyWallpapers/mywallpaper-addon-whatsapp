import makeWASocket, { Browsers, DisconnectReason, proto, type WASocket } from 'baileys'
import { pino } from 'pino'
import { ActionError, TEXT_LIMIT, isChatId, type Command, type Payload, type Push, type Result, type SessionState, type Snapshot } from '../../shared/protocol.js'
import { AuthStore } from './auth.js'
import { History } from './history.js'
import { Vault } from './vault.js'

const logger = pino({ level: 'silent' })
const actions = new Set(['snapshot', 'connect', 'messages', 'send', 'read', 'logout'])
export function validateCommand(raw: unknown): Command {
  const value = raw as Partial<Command> | null
  if (!value || value.kind !== 'wa.command' || typeof value.requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(value.requestId) || !actions.has(value.action ?? '')) throw new ActionError('invalid-request')
  if (['messages', 'send', 'read'].includes(value.action!) && !isChatId(value.chatId)) throw new ActionError('invalid-request')
  if (value.before !== undefined && (typeof value.before !== 'string' || value.before.length > 200)) throw new ActionError('invalid-request')
  if (value.action === 'send' && (typeof value.text !== 'string' || !value.text.trim() || value.text.length > TEXT_LIMIT)) throw new ActionError('invalid-request')
  if (value.action === 'send' && (typeof value.messageId !== 'string' || !/^[A-F0-9]{32}$/.test(value.messageId))) throw new ActionError('invalid-request')
  return value as Command
}

/** One connection per layer, shared by its Interface and Wallpaper surfaces. */
export class Session {
  private readonly vault: Vault
  private auth!: AuthStore
  private history: History
  private socket?: WASocket
  private state: SessionState = { status: 'connecting' }
  private epoch = 0
  private stopped = false
  private retry?: ReturnType<typeof setTimeout>
  private retryCount = 0
  private chatTimer?: ReturnType<typeof setTimeout>
  private listeners = new Set<(event: Push) => void>()
  private initialized: Promise<void>
  private mutation: Promise<unknown> = Promise.resolve()
  private requests = new Map<string, Promise<Result>>()
  private completed = new Map<string, Result>()
  constructor(directory: string, private markRead = false) {
    this.vault = new Vault(directory)
    this.history = new History(this.vault, () => this.storageFailed())
    this.initialized = this.open()
  }
  subscribe(listener: (event: Push) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  settings(markRead: boolean) { this.markRead = markRead }
  private emit(event: Push) { if (!this.stopped) this.listeners.forEach(listener => listener(event)) }
  private setState(state: SessionState) { this.state = state; this.emit({ kind: 'wa.state', state }) }
  private chatsChanged() {
    if (this.chatTimer || this.stopped) return
    this.chatTimer = setTimeout(() => { this.chatTimer = undefined; this.emit({ kind: 'wa.chats', chats: this.history.list() }) }, 80)
    this.chatTimer.unref()
  }
  private async open() {
    try {
      await this.vault.open()
      this.auth = await AuthStore.open(this.vault)
      await this.history.open()
      if (this.stopped) return
      this.setState({ status: 'idle' })
      if (this.auth.state.creds.registered) this.connect()
    } catch (error) { this.setState({ status: 'error', error: error instanceof ActionError ? error.code : 'storage-failed' }) }
  }
  snapshot(): Snapshot { return { state: this.state, chats: this.history.list() } }
  private storageFailed() {
    if (this.stopped || this.state.error === 'storage-failed') return
    this.epoch++; clearTimeout(this.retry); this.retry = undefined
    const socket = this.socket; this.socket = undefined
    void socket?.end(new Error('local-storage-failed')).catch(() => {})
    this.setState({ status: 'error', error: 'storage-failed' })
  }
  private connect() {
    if (this.stopped || this.socket || this.retry) return
    if (!this.auth || this.state.error === 'storage-failed' || this.state.error === 'session-in-use') throw new ActionError(this.state.error ?? 'storage-failed')
    const epoch = ++this.epoch
    this.setState({ status: this.auth.state.creds.registered ? 'reconnecting' : 'connecting' })
    const socket = makeWASocket({
      auth: this.auth.state, logger, browser: Browsers.appropriate('MyWallpaper'),
      syncFullHistory: false, markOnlineOnConnect: false, defaultQueryTimeoutMs: 15_000,
      shouldSyncHistoryMessage: message => message.syncType !== proto.HistorySync.HistorySyncType.FULL,
      getMessage: async key => key.remoteJid && key.id ? this.history.raw(key.remoteJid, key.id)?.message ?? undefined : undefined,
    })
    this.socket = socket
    const current = () => !this.stopped && this.epoch === epoch
    socket.ev.on('creds.update', changes => { if (current()) void this.auth.update(changes).catch(() => this.storageFailed()) })
    socket.ev.on('connection.update', update => {
      if (!current()) return
      if (update.qr) this.setState({ status: 'pairing', qr: update.qr })
      if (update.connection === 'open') {
        this.retryCount = 0
        this.setState({ status: 'ready', account: socket.user?.name || socket.user?.id?.split(':')[0] })
        this.chatsChanged()
      } else if (update.connection === 'close') {
        this.socket = undefined
        const code = (update.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode
        if (code === DisconnectReason.loggedOut || code === DisconnectReason.badSession) {
          this.epoch++
          this.setState({ status: 'error', error: 'expired' })
          void this.enqueue(() => this.forget()).catch(() => this.storageFailed())
        } else if (code === DisconnectReason.connectionReplaced) {
          this.setState({ status: 'error', error: 'session-in-use' })
        } else if ((code === DisconnectReason.restartRequired || this.auth.state.creds.registered) && this.retryCount < 5) {
          this.setState({ status: 'reconnecting' })
          const delay = Math.min(30_000, (code === DisconnectReason.restartRequired ? 150 : 1000) * 2 ** this.retryCount++)
          this.retry = setTimeout(() => { this.retry = undefined; if (current()) { try { this.connect() } catch { this.setState({ status: 'error', error: 'connection-failed' }) } } }, delay)
          this.retry.unref()
        } else this.setState({ status: 'error', error: 'connection-failed' })
      }
    })
    socket.ev.on('messaging-history.set', value => {
      if (!current()) return
      this.history.contacts(value.contacts); this.history.updateChats(value.chats)
      // A large sync is never retained wholesale; the store keeps only recent, bounded history.
      for (const message of value.messages) this.history.upsert(message, false)
      this.chatsChanged()
    })
    socket.ev.on('contacts.upsert', values => { if (current()) { this.history.contacts(values); this.chatsChanged() } })
    socket.ev.on('contacts.update', values => { if (current()) { this.history.contacts(values); this.chatsChanged() } })
    socket.ev.on('chats.upsert', values => { if (current()) { this.history.updateChats(values); this.chatsChanged() } })
    socket.ev.on('chats.update', values => { if (current()) { this.history.updateChats(values); this.chatsChanged() } })
    socket.ev.on('chats.delete', ids => { if (current()) { ids.forEach(id => this.history.deleteChat(id)); this.chatsChanged() } })
    socket.ev.on('messages.upsert', value => {
      if (!current()) return
      for (const raw of value.messages) {
        const message = this.history.upsert(raw, value.type === 'notify')
        if (message) this.emit({ kind: 'wa.message', message })
      }
      this.chatsChanged()
    })
    socket.ev.on('messages.update', updates => {
      if (!current()) return
      for (const { key, update } of updates) {
        if (key.remoteJid && key.id && update.messageStubType === proto.WebMessageInfo.StubType.REVOKE) {
          const message = this.history.revoke(key.remoteJid, key.id)
          if (message) this.emit({ kind: 'wa.message', message })
          this.chatsChanged()
        }
        if (key.remoteJid && key.id && update.status != null) {
          const message = this.history.delivery(key.remoteJid, key.id, update.status)
          if (message) this.emit({ kind: 'wa.message', message })
        }
      }
    })
    socket.ev.on('messages.delete', value => {
      if (!current()) return
      if ('keys' in value) for (const key of value.keys) { if (key.remoteJid && key.id) this.history.deleteMessages(key.remoteJid, [key.id]) }
      else this.history.deleteMessages(value.jid)
      this.chatsChanged()
    })
  }
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.mutation.then(task)
    this.mutation = next.catch(() => {})
    return next
  }
  async handle(raw: unknown): Promise<Payload | undefined> {
    let command: Command
    try { command = validateCommand(raw) } catch { return }
    const cached = this.completed.get(command.requestId)
    if (cached) return cached
    if (this.requests.has(command.requestId)) return this.requests.get(command.requestId)!
    if (this.requests.size >= 12) return { kind: 'wa.result', requestId: command.requestId, ok: false, error: 'not-ready' }
    const task = (async (): Promise<Result> => {
      try {
        await this.initialized
        if (this.stopped) throw new ActionError('offline')
        const result = ['send', 'logout', 'connect', 'read'].includes(command.action) ? await this.enqueue(() => this.run(command)) : await this.run(command)
        return { kind: 'wa.result', requestId: command.requestId, ok: true, result }
      } catch (error) { return { kind: 'wa.result', requestId: command.requestId, ok: false, error: error instanceof ActionError ? error.code : 'action-failed' } }
    })()
    this.requests.set(command.requestId, task)
    const result = await task
    this.requests.delete(command.requestId); this.completed.set(command.requestId, result)
    while (this.completed.size > 64) this.completed.delete(this.completed.keys().next().value!)
    return result
  }
  private async run(command: Command): Promise<unknown> {
    if (command.action === 'snapshot') return this.snapshot()
    if (command.action === 'connect') { this.retryCount = 0; this.connect(); return null }
    if (command.action === 'messages') return this.history.page(command.chatId!, command.before)
    if (this.state.status !== 'ready' || !this.socket) throw new ActionError('not-ready')
    if (command.action === 'send') {
      // Only an existing conversation can be used; no unsolicited-contact API is exposed.
      if (!this.history.list().some(chat => chat.id === command.chatId)) throw new ActionError('invalid-request')
      const pending = this.history.upsert({ key: { remoteJid: command.chatId!, id: command.messageId!, fromMe: true }, message: { conversation: command.text!.trim() }, messageTimestamp: Math.floor(Date.now() / 1000), status: proto.WebMessageInfo.Status.PENDING }, false)
      if (pending) { this.emit({ kind: 'wa.message', message: pending }); this.chatsChanged() }
      let raw
      try { raw = await this.socket.sendMessage(command.chatId!, { text: command.text!.trim() }, { messageId: command.messageId }) }
      catch { throw new ActionError('send-unconfirmed') }
      const message = raw ? this.history.upsert(raw, false) : undefined
      if (!message) throw new ActionError('action-failed')
      this.emit({ kind: 'wa.message', message }); this.chatsChanged()
      return { message }
    }
    if (command.action === 'read') {
      if (!this.markRead) return null
      const keys = this.history.unreadKeys(command.chatId!)
      if (keys.length) await this.socket.readMessages(keys)
      this.history.markRead(command.chatId!); this.chatsChanged(); return null
    }
    if (command.action === 'logout') {
      const socket = this.socket
      this.epoch++
      try { await socket.logout() } catch {
        this.socket = undefined; await socket.end(undefined)
        this.setState({ status: 'error', error: 'connection-failed' }); throw new ActionError('action-failed')
      }
      this.socket = undefined
      await this.forget(); this.setState({ status: 'idle' }); return null
    }
    throw new ActionError('invalid-request')
  }
  private async forget() {
    await this.auth.close(); await this.history.flush()
    this.history.clear(); await this.vault.clearData()
    this.auth = await AuthStore.open(this.vault)
    this.completed.clear()
    this.emit({ kind: 'wa.reset' })
  }
  async close() {
    if (this.stopped) return
    this.stopped = true; this.epoch++
    clearTimeout(this.retry); clearTimeout(this.chatTimer)
    await this.socket?.end(undefined).catch(() => {}); this.socket = undefined
    await this.initialized
    await this.mutation
    if (this.auth) { await this.auth.close().catch(() => {}); await this.history.flush().catch(() => {}) }
    await this.vault.close(); this.listeners.clear(); this.completed.clear()
  }
}

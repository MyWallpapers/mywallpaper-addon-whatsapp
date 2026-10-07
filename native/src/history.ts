import { BufferJSON, normalizeMessageContent, proto, type Chat as WaChat, type Contact, type WAMessage } from 'baileys'
import { MAX_CHATS, MAX_MESSAGES_PER_CHAT, MAX_TOTAL_MESSAGES, PAGE_SIZE, isChatId, type Chat, type Message, type MessagePage } from '../../shared/protocol.js'
import { Vault } from './vault.js'

interface StoredMessage { value: Message; raw: WAMessage }
function delivery(status?: number | null): Message['delivery'] {
  return status === proto.WebMessageInfo.Status.ERROR ? 'failed' : status === proto.WebMessageInfo.Status.PENDING ? 'pending' : status != null && status >= proto.WebMessageInfo.Status.READ ? 'read' : status != null && status >= proto.WebMessageInfo.Status.DELIVERY_ACK ? 'delivered' : 'sent'
}
export class History {
  private chats = new Map<string, Chat>()
  private records = new Map<string, Map<string, StoredMessage>>()
  private names = new Map<string, string>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private writing: Promise<void> = Promise.resolve()
  constructor(private vault: Vault, private onStorageError: () => void) {}
  async open() {
    const source = await this.vault.read('history')
    if (!source) return
    const value = JSON.parse(source, BufferJSON.reviver) as { chats: Chat[]; names: [string, string][]; messages: StoredMessage[] }
    this.contacts(value.names.map(([id, name]) => ({ id, name })))
    for (const chat of value.chats.slice(0, MAX_CHATS)) if (isChatId(chat.id)) this.chats.set(chat.id, chat)
    for (const item of value.messages.slice(-MAX_TOTAL_MESSAGES)) {
      if (!isChatId(item.value?.chatId) || !item.value.id || !this.chats.has(item.value.chatId)) continue
      let entries = this.records.get(item.value.chatId)
      if (!entries) { entries = new Map(); this.records.set(item.value.chatId, entries) }
      entries.set(item.value.id, item)
    }
    this.trim()
  }
  contacts(contacts: Partial<Contact>[]) {
    for (const contact of contacts) {
      if (!isChatId(contact.id)) continue
      const name = (contact.name || contact.notify || contact.verifiedName)?.slice(0, 100)
      if (!name) continue
      this.names.set(contact.id, name)
      const chat = this.chats.get(contact.id)
      if (chat) chat.name = name
    }
    // Contact names are useful only for the bounded recent-chat cache.
    while (this.names.size > MAX_CHATS * 4) this.names.delete(this.names.keys().next().value!)
  }
  updateChats(chats: Partial<WaChat>[]) {
    for (const value of chats) {
      if (!isChatId(value.id)) continue
      const old = this.chats.get(value.id)
      this.chats.set(value.id, {
        id: value.id,
        name: this.names.get(value.id) || value.name?.slice(0, 100) || old?.name || value.id.split('@')[0],
        lastText: old?.lastText ?? '',
        lastAt: Math.max(old?.lastAt ?? 0, Number(value.conversationTimestamp ?? value.lastMessageRecvTimestamp ?? 0)),
        unread: value.unreadCount == null ? old?.unread ?? 0 : Math.max(0, value.unreadCount),
        group: value.id.endsWith('@g.us'),
      })
    }
    this.trim(); this.schedule()
  }
  upsert(raw: WAMessage, notify: boolean): Message | undefined {
    const chatId = raw.key.remoteJid
    const id = raw.key.id
    if (!isChatId(chatId) || !id || id.length > 200 || !raw.message) return
    // Disappearing and view-once messages must never become a durable widget cache.
    if (raw.message.ephemeralMessage || raw.message.viewOnceMessage || raw.message.viewOnceMessageV2 || raw.message.viewOnceMessageV2Extension) return
    const content = normalizeMessageContent(raw.message)
    if (!content) return
    if (Object.values(content).some(part => part && typeof part === 'object' && ((part as { viewOnce?: boolean }).viewOnce === true || Number((part as { contextInfo?: { expiration?: number } }).contextInfo?.expiration ?? 0) > 0))) return
    const deleted = content.protocolMessage?.type === proto.Message.ProtocolMessage.Type.REVOKE
    if (content.protocolMessage && !deleted) return
    if (deleted) {
      const target = content.protocolMessage?.key?.id
      return target ? this.revoke(chatId, target) : undefined
    }
    const media = content.imageMessage ? 'image' : content.videoMessage ? 'video' : content.audioMessage ? 'audio' : content.documentMessage ? 'document' : content.stickerMessage ? 'sticker' : undefined
    const text = (content.conversation || content.extendedTextMessage?.text || content.imageMessage?.caption || content.videoMessage?.caption || content.documentMessage?.caption || content.contactMessage?.displayName || '').slice(0, 8192)
    if (!text && !media) return
    let entries = this.records.get(chatId)
    if (!entries) { entries = new Map(); this.records.set(chatId, entries) }
    const existing = entries.get(id)
    const sender = raw.pushName?.slice(0, 100) || (raw.key.participant ? this.names.get(raw.key.participant) : undefined)
    const message: Message = {
      id, chatId, text, time: Number(raw.messageTimestamp ?? 0), fromMe: raw.key.fromMe === true,
      delivery: existing?.value.delivery ?? delivery(raw.status),
      ...(media ? { media } : {}), ...(chatId.endsWith('@g.us') && sender ? { sender } : {}),
    }
    // This widget sends plain text only. Retain its retry body, never attachment
    // URLs, keys, thumbnails, quoted messages, or library-owned mutable objects.
    const minimal: WAMessage = { key: { ...raw.key }, message: { conversation: text }, messageTimestamp: raw.messageTimestamp, status: raw.status, pushName: raw.pushName }
    entries.set(id, { value: message, raw: minimal })
    while (entries.size > MAX_MESSAGES_PER_CHAT) {
      const oldest = [...entries.values()].sort((a, b) => a.value.time - b.value.time)[0]
      if (oldest) entries.delete(oldest.value.id)
    }
    const old = this.chats.get(chatId)
    const latest = message.time >= (old?.lastAt ?? 0)
    this.chats.set(chatId, {
      id: chatId, name: this.names.get(chatId) || old?.name || (!message.fromMe && !chatId.endsWith('@g.us') ? sender : undefined) || chatId.split('@')[0],
      lastText: latest ? text.slice(0, 240) || (media ? `[${media}]` : '') : old?.lastText ?? '', lastAt: Math.max(message.time, old?.lastAt ?? 0),
      unread: (old?.unread ?? 0) + (notify && !message.fromMe && !existing ? 1 : 0), group: chatId.endsWith('@g.us'),
    })
    this.trim(); this.schedule(); return message
  }
  delivery(chatId: string, id: string, status: number): Message | undefined {
    const entry = this.records.get(chatId)?.get(id)
    if (!entry) return
    if (status !== proto.WebMessageInfo.Status.ERROR && status < (entry.raw.status ?? 0)) return
    entry.raw.status = status
    entry.value.delivery = delivery(status)
    this.schedule(); return entry.value
  }
  revoke(chatId: string, id: string): Message | undefined {
    const entry = this.records.get(chatId)?.get(id)
    if (!entry) return
    entry.value = { ...entry.value, text: '', media: undefined, deleted: true }
    const chat = this.chats.get(chatId)
    if (chat && chat.lastAt === entry.value.time) chat.lastText = ''
    entry.raw.message = {}; this.schedule(); return entry.value
  }
  deleteChat(id: string) { this.chats.delete(id); this.records.delete(id); this.names.delete(id); this.schedule() }
  deleteMessages(chatId: string, ids?: string[]) {
    const entries = this.records.get(chatId)
    if (ids) ids.forEach(id => entries?.delete(id))
    else this.records.delete(chatId)
    this.schedule()
  }
  list(): Chat[] { return [...this.chats.values()].sort((a, b) => b.lastAt - a.lastAt).slice(0, MAX_CHATS) }
  page(chatId: string, before?: string): MessagePage {
    const values = [...(this.records.get(chatId)?.values() ?? [])].map(item => item.value).sort((a, b) => a.time - b.time || a.id.localeCompare(b.id))
    const end = before ? values.findIndex(message => message.id === before) : values.length
    if (end < 0) return { messages: [], hasMore: false }
    const start = Math.max(0, end - PAGE_SIZE)
    return { messages: values.slice(start, end), hasMore: start > 0 }
  }
  raw(chatId: string, id: string) { return this.records.get(chatId)?.get(id)?.raw }
  unreadKeys(chatId: string) { return [...(this.records.get(chatId)?.values() ?? [])].filter(entry => !entry.value.fromMe).slice(-PAGE_SIZE).map(entry => entry.raw.key) }
  markRead(chatId: string) { const chat = this.chats.get(chatId); if (chat) chat.unread = 0; this.schedule() }
  private trim() {
    const keep = new Set(this.list().map(chat => chat.id))
    for (const id of this.chats.keys()) if (!keep.has(id)) this.deleteChat(id)
    const all = [...this.records.values()].flatMap(entries => [...entries.values()])
    if (all.length > MAX_TOTAL_MESSAGES) for (const entry of all.sort((a, b) => a.value.time - b.value.time).slice(0, all.length - MAX_TOTAL_MESSAGES)) this.records.get(entry.value.chatId)?.delete(entry.value.id)
  }
  private schedule() {
    if (this.timer) return
    this.timer = setTimeout(() => { this.timer = undefined; void this.persist().catch(this.onStorageError) }, 750)
    this.timer.unref()
  }
  private persist() {
    const source = JSON.stringify({ chats: this.list(), names: [...this.names], messages: [...this.records.values()].flatMap(entries => [...entries.values()]) }, BufferJSON.replacer)
    const next = this.writing.then(() => this.vault.write('history', source))
    this.writing = next.catch(this.onStorageError)
    return next
  }
  async flush() { clearTimeout(this.timer); this.timer = undefined; await this.persist(); await this.writing }
  clear() { clearTimeout(this.timer); this.timer = undefined; this.chats.clear(); this.records.clear(); this.names.clear() }
}

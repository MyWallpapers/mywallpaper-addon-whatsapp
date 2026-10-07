export type SessionStatus = 'idle' | 'connecting' | 'pairing' | 'ready' | 'reconnecting' | 'error'
export type ErrorCode = 'offline' | 'expired' | 'connection-failed' | 'session-in-use' | 'storage-failed' | 'invalid-request' | 'action-failed' | 'timeout' | 'send-unconfirmed' | 'desktop-required' | 'not-ready'
export interface SessionState { status: SessionStatus; account?: string; qr?: string; error?: ErrorCode }
export interface Chat { id: string; name: string; lastText: string; lastAt: number; unread: number; group: boolean }
export type MediaKind = 'image' | 'video' | 'audio' | 'document' | 'sticker'
export interface Message {
  id: string; chatId: string; text: string; time: number; fromMe: boolean
  delivery: 'pending' | 'sent' | 'delivered' | 'read' | 'failed'
  sender?: string; media?: MediaKind; deleted?: boolean
}
export interface MessagePage { messages: Message[]; hasMore: boolean }
export interface Snapshot { state: SessionState; chats: Chat[] }
export type Action = 'snapshot' | 'connect' | 'messages' | 'send' | 'read' | 'logout'
export interface Command {
  kind: 'wa.command'; requestId: string; action: Action
  chatId?: string; before?: string; text?: string; messageId?: string
}
export type Push =
  | { kind: 'wa.state'; state: SessionState }
  | { kind: 'wa.chats'; chats: Chat[] }
  | { kind: 'wa.message'; message: Message }
  | { kind: 'wa.reset' }
export interface Result { kind: 'wa.result'; requestId: string; ok: boolean; result?: unknown; error?: ErrorCode }
export type Payload = Push | Result
export interface MessagingClient {
  subscribe(listener: (event: Push) => void): () => void
  request<T = unknown>(action: Action, input?: Pick<Command, 'chatId' | 'before' | 'text' | 'messageId'>): Promise<T>
  close(): void
}

export const TEXT_LIMIT = 4096
export const PAGE_SIZE = 30
export const MAX_CHATS = 150
export const MAX_MESSAGES_PER_CHAT = 120
export const MAX_TOTAL_MESSAGES = 1200

export function isChatId(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[0-9]{5,24}@(s\.whatsapp\.net|lid)|[0-9]{5,24}(?:-[0-9]{1,24})?@g\.us)$/.test(value)
}

export class ActionError extends Error {
  constructor(readonly code: ErrorCode) { super(code); this.name = 'ActionError' }
}

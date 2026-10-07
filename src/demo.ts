import { ActionError, type Action, type Chat, type Command, type Message, type MessagingClient, type Push } from '../shared/protocol'

// Isolated fictional data for the local preview and catalogue thumbnail only.
// A normal runtime mount always uses the native companion.
export function createDemoClient(): MessagingClient {
  const now = Math.floor(Date.now() / 1000)
  const chats: Chat[] = [
    { id: '33600000001@s.whatsapp.net', name: 'Camille', lastText: 'On se retrouve à 18 h ?', lastAt: now, unread: 2, group: false },
    { id: '12345678900@g.us', name: 'Week-end', lastText: 'Léa : J’ai trouvé un super endroit 🌿', lastAt: now - 1600, unread: 3, group: true },
    { id: '33600000002@s.whatsapp.net', name: 'Alex', lastText: 'Parfait, merci !', lastAt: now - 3600, unread: 0, group: false },
    { id: '33600000003@s.whatsapp.net', name: 'Sarah', lastText: 'Photo', lastAt: now - 7200, unread: 0, group: false },
  ]
  const messages: Message[] = [
    { id: 'preview-1', chatId: chats[0].id, text: 'Salut ! Tu es disponible ce soir ?', time: now - 600, fromMe: false, delivery: 'sent' },
    { id: 'preview-2', chatId: chats[0].id, text: 'Oui, avec plaisir 😊', time: now - 480, fromMe: true, delivery: 'read' },
    { id: 'preview-3', chatId: chats[0].id, text: 'On se retrouve à 18 h ?', time: now - 120, fromMe: false, delivery: 'sent' },
  ]
  const listeners = new Set<(value: Push) => void>()
  return {
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    async request<T>(action: Action, input: Pick<Command, 'chatId' | 'before' | 'text' | 'messageId'> = {}) {
      if (action === 'snapshot') return { state: { status: 'ready', account: 'Aperçu' }, chats } as T
      if (action === 'messages') return { messages: messages.filter(message => message.chatId === input.chatId), hasMore: false } as T
      if (action === 'send' && input.text && input.chatId) {
        const message: Message = { id: input.messageId ?? crypto.randomUUID(), chatId: input.chatId, text: input.text, time: Math.floor(Date.now() / 1000), fromMe: true, delivery: 'sent' }
        messages.push(message); listeners.forEach(listener => listener({ kind: 'wa.message', message }))
        return { message } as T
      }
      if (action === 'read') return null as T
      throw new ActionError('desktop-required')
    },
    close() { listeners.clear() },
  }
}

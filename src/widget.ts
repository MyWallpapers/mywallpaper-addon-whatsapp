import QRCode from 'qrcode'
import type { AddonValues } from '../generated/mywallpaper-runtime'
import { ActionError, MAX_MESSAGES_PER_CHAT, TEXT_LIMIT, type Chat, type Message, type MessagePage, type MessagingClient, type SessionState, type Snapshot } from '../shared/protocol'
import { icon } from './icons'
import { copy, type Language } from './i18n'
import './styles.css'

interface Configuration { settings?: AddonValues; deviceSettings?: AddonValues; demo?: boolean }
const el = <T extends keyof HTMLElementTagNameMap>(tag: T, className: string, text?: string) => {
  const node = document.createElement(tag); node.className = className
  if (text !== undefined) node.textContent = text
  return node
}
const initials = (name: string) => Array.from(name.trim().split(/\s+/).slice(0, 2).map(word => Array.from(word)[0] ?? '').join('')).slice(0, 2).join('').toUpperCase()

export function createWidget(root: HTMLElement, client: MessagingClient, initial: Configuration = {}) {
  const controller = new AbortController()
  const { signal } = controller
  let settings = initial.settings ?? {}
  let deviceSettings = initial.deviceSettings ?? {}
  let language: Language = 'fr'
  let state: SessionState = { status: 'connecting' }
  let chats: Chat[] = []
  let active: string | null = null
  let messages = new Map<string, Message>()
  const drafts = new Map<string, string>()
  const messageNodes = new Map<string, HTMLElement>()
  let generation = 0
  let disposed = false
  let sending = false
  let loading = false
  let hasMore = false
  let qrValue = ''
  let qrGeneration = 0
  let confirmLogout = false
  let feedbackTimer: ReturnType<typeof setTimeout> | undefined
  const t = () => copy[language]

  const stage = el('div', 'wa-stage')
  const widget = el('section', 'wa-widget')
  widget.innerHTML = `<header class="wa-header"><div class="wa-brand">${icon('chat')}<h1>WhatsApp</h1></div><div class="wa-header-end"><span class="wa-connection" role="status"><i></i><span></span></span><button type="button" class="wa-icon-button" data-action="more" aria-haspopup="menu" aria-expanded="false">${icon('more')}</button></div></header>
    <div class="wa-session"><div class="wa-welcome-symbol">${icon('chat')}</div><h2></h2><p class="wa-session-description"></p><div class="wa-qr" hidden><canvas></canvas></div><button type="button" class="wa-primary" data-action="connect"></button><div class="wa-privacy">${icon('lock')}<span></span></div><p class="wa-unofficial"></p></div>
    <div class="wa-workspace" hidden><aside class="wa-list-pane"><label class="wa-search">${icon('search')}<input type="search" autocomplete="off"></label><nav class="wa-list"></nav><div class="wa-list-empty" hidden><h2></h2><p></p></div></aside>
    <section class="wa-conversation"><div class="wa-choose"><div class="wa-welcome-symbol">${icon('chat')}</div><h2></h2><p></p></div><div class="wa-thread" hidden><header class="wa-thread-header"><button type="button" class="wa-icon-button wa-back" data-action="back">${icon('back')}</button><span class="wa-avatar wa-thread-avatar"></span><div class="wa-thread-person"><h2></h2><p></p></div></header><div class="wa-message-scroll"><button type="button" class="wa-load-earlier" data-action="earlier" hidden></button><p class="wa-thread-note"></p><div class="wa-messages" role="list"></div></div><form class="wa-composer"><textarea rows="1" maxlength="4096"></textarea><button type="submit" class="wa-send">${icon('send')}</button></form></div></section></div>
    <div class="wa-menu" role="menu" hidden><p class="wa-menu-account"></p><button type="button" role="menuitem" data-action="logout">${icon('logout')}<span></span></button><div class="wa-logout-confirm" hidden><p></p><div><button type="button" data-action="cancel-logout"></button><button type="button" data-action="confirm-logout"></button></div></div></div>
    <p class="wa-feedback" role="status" hidden></p><p class="wa-demo" hidden></p>`
  stage.append(widget); root.replaceChildren(stage)
  const get = <T extends Element>(selector: string) => widget.querySelector<T>(selector)!
  const session = get<HTMLElement>('.wa-session')
  const workspace = get<HTMLElement>('.wa-workspace')
  const list = get<HTMLElement>('.wa-list')
  const listEmpty = get<HTMLElement>('.wa-list-empty')
  const search = get<HTMLInputElement>('.wa-search input')
  const thread = get<HTMLElement>('.wa-thread')
  const choose = get<HTMLElement>('.wa-choose')
  const scroll = get<HTMLElement>('.wa-message-scroll')
  const messageList = get<HTMLElement>('.wa-messages')
  const composer = get<HTMLTextAreaElement>('.wa-composer textarea')
  const sendButton = get<HTMLButtonElement>('.wa-send')
  const connectButton = get<HTMLButtonElement>('[data-action="connect"]')
  const earlier = get<HTMLButtonElement>('[data-action="earlier"]')
  const more = get<HTMLButtonElement>('[data-action="more"]')
  const menu = get<HTMLElement>('.wa-menu')
  const feedback = get<HTMLElement>('.wa-feedback')
  const qr = get<HTMLElement>('.wa-qr')
  const canvas = get<HTMLCanvasElement>('.wa-qr canvas')

  function inform(error: unknown) {
    if (disposed) return
    const code = error instanceof ActionError ? error.code : 'action-failed'
    feedback.textContent = t().errors[code]; feedback.hidden = false
    clearTimeout(feedbackTimer)
    feedbackTimer = setTimeout(() => { feedback.hidden = true }, 8000)
  }
  function updateComposer() {
    sendButton.disabled = sending || state.status !== 'ready' || !composer.value.trim()
    composer.disabled = state.status !== 'ready'
    composer.style.height = 'auto'
    composer.style.height = `${Math.min(104, composer.scrollHeight)}px`
    composer.style.overflowY = composer.scrollHeight > 104 ? 'auto' : 'hidden'
  }
  function closeMenu(focus = false) {
    menu.hidden = true; confirmLogout = false; get<HTMLElement>('.wa-logout-confirm').hidden = true
    get<HTMLButtonElement>('[data-action="logout"]').hidden = false
    more.setAttribute('aria-expanded', 'false')
    if (focus) more.focus()
  }
  function formatTime(time: number, day = false) {
    const date = new Date(time * 1000)
    if (!time) return ''
    const today = new Date()
    if (day && date.toDateString() !== today.toDateString()) return date.toLocaleDateString(language, { day: 'numeric', month: 'short' })
    return date.toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit' })
  }
  function preview(message: Message) {
    if (message.deleted) return t().deleted
    return message.text || (message.media ? t().media[message.media] : '')
  }
  function renderChats() {
    const query = search.value.trim().toLocaleLowerCase(language).normalize('NFD').replace(/\p{Diacritic}/gu, '')
    const visible = chats.filter(chat => `${chat.name} ${chat.id.split('@')[0]}`.toLocaleLowerCase(language).normalize('NFD').replace(/\p{Diacritic}/gu, '').includes(query))
    const focusedId = (document.activeElement as HTMLElement)?.dataset.chat
    const top = list.scrollTop
    const fragment = document.createDocumentFragment()
    for (const chat of visible) {
      const item = el('button', 'wa-chat-row')
      item.type = 'button'; item.dataset.chat = chat.id
      item.setAttribute('aria-pressed', String(active === chat.id))
      item.setAttribute('aria-label', chat.unread ? `${chat.name}, ${chat.unread} ${language === 'fr' ? 'messages non lus' : 'unread messages'}` : chat.name)
      const avatar = el('span', 'wa-avatar', initials(chat.name))
      const info = el('span', 'wa-chat-info')
      info.append(el('strong', 'wa-chat-name', chat.name), el('span', 'wa-chat-preview', settings.hidePreviews ? t().previewHidden : chat.lastText))
      const meta = el('span', 'wa-chat-meta')
      meta.append(el('time', 'wa-chat-time', formatTime(chat.lastAt, true)))
      if (chat.unread) meta.append(el('span', 'wa-unread', chat.unread > 99 ? '99+' : String(chat.unread)))
      item.append(avatar, info, meta); fragment.append(item)
    }
    list.replaceChildren(fragment); list.scrollTop = top
    if (focusedId) Array.from(list.querySelectorAll<HTMLButtonElement>('button')).find(button => button.dataset.chat === focusedId)?.focus({ preventScroll: true })
    listEmpty.hidden = visible.length > 0
    get<HTMLElement>('.wa-list-empty h2').textContent = query ? t().noResults : t().empty
    get<HTMLElement>('.wa-list-empty p').textContent = query ? t().noResultsHint : t().emptyHint
    const chat = chats.find(value => value.id === active)
    if (chat) {
      get<HTMLElement>('.wa-thread-person h2').textContent = chat.name
      get<HTMLElement>('.wa-thread-person p').textContent = chat.group ? (language === 'fr' ? 'Groupe' : 'Group') : chat.id.endsWith('@s.whatsapp.net') ? `+${chat.id.split('@')[0]}` : ''
      get<HTMLElement>('.wa-thread-avatar').textContent = initials(chat.name)
    }
  }
  function renderMessages(preserveScroll = false) {
    // Keep a bounded rendered window too, including live incoming messages.
    if (messages.size > MAX_MESSAGES_PER_CHAT) for (const message of [...messages.values()].sort((a, b) => a.time - b.time).slice(0, messages.size - MAX_MESSAGES_PER_CHAT)) messages.delete(message.id)
    const atBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 64
    const height = scroll.scrollHeight
    const top = scroll.scrollTop
    const ordered = [...messages.values()].sort((a, b) => a.time - b.time || a.id.localeCompare(b.id))
    const fragment = document.createDocumentFragment()
    let day = ''
    for (const message of ordered) {
      const nextDay = new Date(message.time * 1000).toDateString()
      if (nextDay !== day) {
        day = nextDay
        const date = new Date(message.time * 1000)
        fragment.append(el('div', 'wa-day', date.toDateString() === new Date().toDateString() ? t().today : date.toLocaleDateString(language, { day: 'numeric', month: 'long' })))
      }
      let node = messageNodes.get(message.id)
      if (!node) {
        node = el('div', 'wa-message'); node.dataset.id = message.id; node.setAttribute('role', 'listitem')
        node.append(el('span', 'wa-message-sender'), el('p', 'wa-message-text'), el('span', 'wa-media-note'), el('div', 'wa-message-meta'))
        messageNodes.set(message.id, node)
      }
      node.dataset.own = String(message.fromMe)
      node.dataset.failed = String(message.delivery === 'failed')
      const sender = node.querySelector<HTMLElement>('.wa-message-sender')!
      sender.textContent = message.sender ?? ''; sender.hidden = !message.sender || message.fromMe
      node.querySelector<HTMLElement>('.wa-message-text')!.textContent = preview(message)
      const mediaNote = node.querySelector<HTMLElement>('.wa-media-note')!
      mediaNote.hidden = !message.media; mediaNote.textContent = t().mediaHint
      const meta = node.querySelector<HTMLElement>('.wa-message-meta')!
      meta.replaceChildren(el('time', '', formatTime(message.time)))
      if (message.fromMe) {
        const delivery = el('span', 'wa-delivery')
        delivery.dataset.state = message.delivery
        delivery.innerHTML = message.delivery === 'read' || message.delivery === 'delivered' ? icon('checks') : icon('check')
        delivery.title = message.delivery === 'failed' ? t().failed : message.delivery
        meta.append(delivery)
      }
      fragment.append(node)
    }
    for (const key of messageNodes.keys()) if (!messages.has(key)) messageNodes.delete(key)
    messageList.replaceChildren(fragment)
    get<HTMLElement>('.wa-thread-note').textContent = loading ? t().syncing : ordered.length ? t().recentOnly : t().noMessages
    earlier.hidden = !hasMore; earlier.disabled = loading
    if (preserveScroll) scroll.scrollTop = top + scroll.scrollHeight - height
    else if (atBottom || top === 0) scroll.scrollTop = scroll.scrollHeight
  }
  async function loadMessages(older = false) {
    if (!active || loading || state.status !== 'ready') return
    const chatId = active
    const run = ++generation
    loading = true; renderMessages()
    const before = older ? [...messages.values()].sort((a, b) => a.time - b.time || a.id.localeCompare(b.id))[0]?.id : undefined
    try {
      const page = await client.request<MessagePage>('messages', { chatId, before })
      if (disposed || active !== chatId || generation !== run) return
      for (const message of page.messages) messages.set(message.id, message)
      hasMore = page.hasMore; loading = false; renderMessages(older)
      if (!older && deviceSettings.markRead === true) void client.request('read', { chatId }).catch(inform)
    } catch (error) {
      if (disposed || active !== chatId || generation !== run) return
      loading = false; renderMessages(); inform(error)
    }
  }
  function selectChat(chatId: string) {
    if (active) drafts.set(active, composer.value)
    active = chatId; generation++; loading = false; hasMore = false
    messages.clear(); messageNodes.clear(); messageList.replaceChildren()
    widget.dataset.thread = 'true'; choose.hidden = true; thread.hidden = false
    composer.value = drafts.get(chatId) ?? ''; renderChats(); updateComposer(); void loadMessages()
  }
  async function send() {
    const text = composer.value.trim()
    const chatId = active
    if (!text || !chatId || sending || state.status !== 'ready') return
    if (text.length > TEXT_LIMIT) { feedback.textContent = t().length; feedback.hidden = false; return }
    sending = true
    const temporaryId = crypto.randomUUID().replaceAll('-', '').toUpperCase()
    const pending: Message = { id: temporaryId, chatId, text, fromMe: true, time: Math.floor(Date.now() / 1000), delivery: 'pending' }
    messages.set(temporaryId, pending); drafts.delete(chatId); composer.value = ''; updateComposer(); renderMessages(); scroll.scrollTop = scroll.scrollHeight
    try {
      const value = await client.request<{ message: Message }>('send', { chatId, text, messageId: temporaryId })
      if (disposed) return
      if (active === chatId) { messages.delete(temporaryId); messages.set(value.message.id, value.message); renderMessages() }
    } catch (error) {
      if (disposed) return
      if (error instanceof ActionError && error.code === 'send-unconfirmed') {
        // The socket may confirm later. Keep the same message ID and never
        // silently restore/resubmit text whose delivery is uncertain.
        inform(error); return
      }
      if (active === chatId) { messages.set(temporaryId, { ...pending, delivery: 'failed' }); renderMessages() }
      if (active === chatId && !composer.value) { composer.value = text; drafts.set(chatId, text) }
      else if (!drafts.has(chatId)) drafts.set(chatId, text)
      inform(error)
    } finally { sending = false; if (!disposed) updateComposer() }
  }
  function renderState() {
    const connected = state.status === 'ready' || state.status === 'reconnecting' && chats.length > 0
    session.hidden = connected; workspace.hidden = !connected
    widget.dataset.status = state.status
    get<HTMLElement>('.wa-connection span').textContent = state.status === 'ready' ? t().ready : state.status === 'pairing' ? t().pairing : state.status === 'reconnecting' ? t().reconnecting : state.status === 'connecting' ? t().connecting : ''
    const failed = state.status === 'error'
    get<HTMLElement>('.wa-session h2').textContent = state.status === 'pairing' ? t().pairing : failed && state.error === 'desktop-required' ? t().unavailable : t().intro
    get<HTMLElement>('.wa-session-description').textContent = state.status === 'pairing' ? t().qrHelp : failed ? t().errors[state.error ?? 'connection-failed'] : state.status === 'connecting' || state.status === 'reconnecting' ? t().connecting : t().hint
    connectButton.textContent = failed ? t().retry : t().connect
    connectButton.hidden = state.status === 'pairing' || state.status === 'connecting' || state.status === 'reconnecting' || state.error === 'desktop-required' || state.error === 'session-in-use'
    connectButton.disabled = false
    more.disabled = state.status !== 'ready'
    qr.hidden = state.status !== 'pairing' || !state.qr
    if (state.qr !== qrValue) {
      qrValue = state.qr ?? ''
      const run = ++qrGeneration
      if (qrValue) {
        const buffer = document.createElement('canvas')
        void QRCode.toCanvas(buffer, qrValue, { width: 256, margin: 2, errorCorrectionLevel: 'M', color: { dark: '#101010', light: '#ffffff' } }).then(() => {
          if (disposed || run !== qrGeneration) return
          canvas.width = buffer.width; canvas.height = buffer.height; canvas.getContext('2d')?.drawImage(buffer, 0, 0)
        }).catch(() => inform(new ActionError('action-failed')))
      } else canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height)
    }
    get<HTMLElement>('.wa-menu-account').textContent = state.account ?? 'WhatsApp'
    updateComposer()
  }
  function configure(configuration: Configuration) {
    settings = configuration.settings ?? settings; deviceSettings = configuration.deviceSettings ?? deviceSettings
    const configured = settings.language
    language = configured === 'fr' || configured === 'en' ? configured : navigator.language.startsWith('fr') ? 'fr' : 'en'
    widget.lang = language
    widget.setAttribute('aria-label', t().title)
    widget.style.setProperty('--wa-opacity', String(typeof settings.opacity === 'number' ? Math.max(0.5, Math.min(1, settings.opacity)) : 0.85))
    widget.style.setProperty('--wa-blur', `${typeof settings.blur === 'number' ? Math.max(0, Math.min(24, settings.blur)) : 16}px`)
    search.placeholder = t().search; search.setAttribute('aria-label', t().search)
    list.setAttribute('aria-label', t().chats)
    composer.placeholder = t().message; composer.setAttribute('aria-label', t().message)
    sendButton.setAttribute('aria-label', t().send); more.setAttribute('aria-label', t().more)
    get<HTMLButtonElement>('[data-action="back"]').setAttribute('aria-label', t().back)
    canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', t().qrLabel)
    get<HTMLElement>('.wa-privacy span').textContent = t().private
    get<HTMLElement>('.wa-unofficial').textContent = t().unofficial
    get<HTMLElement>('.wa-choose h2').textContent = t().choose
    get<HTMLElement>('.wa-choose p').textContent = t().chooseHint
    get<HTMLElement>('[data-action="logout"] span').textContent = t().logout
    get<HTMLElement>('.wa-logout-confirm p').textContent = t().logoutConfirm
    get<HTMLElement>('[data-action="cancel-logout"]').textContent = t().cancel
    get<HTMLElement>('[data-action="confirm-logout"]').textContent = t().confirm
    earlier.textContent = t().earlier
    get<HTMLElement>('.wa-demo').hidden = !initial.demo
    get<HTMLElement>('.wa-demo').textContent = t().demo
    renderState(); renderChats(); renderMessages()
  }

  list.addEventListener('click', event => { const chat = (event.target as Element).closest<HTMLElement>('[data-chat]')?.dataset.chat; if (chat) selectChat(chat) }, { signal })
  search.addEventListener('input', renderChats, { signal })
  composer.addEventListener('input', () => { if (active) drafts.set(active, composer.value); updateComposer() }, { signal })
  composer.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); void send() } }, { signal })
  get<HTMLFormElement>('.wa-composer').addEventListener('submit', event => { event.preventDefault(); void send() }, { signal })
  widget.addEventListener('click', event => {
    const action = (event.target as Element).closest<HTMLButtonElement>('[data-action]')?.dataset.action
    if (action === 'connect') { connectButton.disabled = true; void client.request('connect').catch(inform).finally(() => { if (!disposed) connectButton.disabled = false }) }
    else if (action === 'back') { if (active) drafts.set(active, composer.value); active = null; generation++; widget.dataset.thread = 'false'; thread.hidden = true; choose.hidden = false; renderChats(); search.focus() }
    else if (action === 'earlier') void loadMessages(true)
    else if (action === 'more') { if (!menu.hidden) closeMenu(true); else { menu.hidden = false; more.setAttribute('aria-expanded', 'true'); get<HTMLButtonElement>('[data-action="logout"]').focus() } }
    else if (action === 'logout') { confirmLogout = true; get<HTMLElement>('.wa-logout-confirm').hidden = false; get<HTMLButtonElement>('[data-action="logout"]').hidden = true; get<HTMLButtonElement>('[data-action="cancel-logout"]').focus() }
    else if (action === 'cancel-logout') closeMenu(true)
    else if (action === 'confirm-logout' && confirmLogout) { closeMenu(); void client.request('logout').catch(inform) }
  }, { signal })
  document.addEventListener('pointerdown', event => { if (!menu.hidden && !menu.contains(event.target as Node) && !more.contains(event.target as Node)) closeMenu() }, { signal })
  menu.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); closeMenu(true) }
    if (event.key === 'Tab') closeMenu()
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const buttons = Array.from(menu.querySelectorAll<HTMLButtonElement>('button')).filter(button => !button.hidden && !button.closest('[hidden]'))
      const i = buttons.indexOf(document.activeElement as HTMLButtonElement)
      buttons[(i + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus()
    }
  }, { signal })
  const stop = client.subscribe(event => {
    if (disposed) return
    if (event.kind === 'wa.state') {
      const wasReady = state.status === 'ready'
      state = event.state; renderState()
      if (!wasReady && state.status === 'ready' && active) void loadMessages()
    } else if (event.kind === 'wa.chats') { chats = event.chats; renderChats() }
    else if (event.kind === 'wa.message' && active === event.message.chatId) { messages.set(event.message.id, event.message); renderMessages() }
    else if (event.kind === 'wa.reset') {
      active = null; generation++; loading = false; chats = []; messages.clear(); messageNodes.clear(); drafts.clear()
      search.value = ''; composer.value = ''; thread.hidden = true; choose.hidden = false; widget.dataset.thread = 'false'; closeMenu(); renderChats()
    }
  })
  configure(initial)
  void client.request<Snapshot>('snapshot').then(snapshot => {
    if (disposed) return
    state = snapshot.state; chats = snapshot.chats; renderState(); renderChats()
  }).catch(error => { if (!disposed) { state = { status: 'error', error: error instanceof ActionError ? error.code : 'desktop-required' }; renderState() } })

  return {
    configure,
    dispose() { if (disposed) return; disposed = true; generation++; qrGeneration++; controller.abort(); clearTimeout(feedbackTimer); stop(); drafts.clear(); messages.clear(); messageNodes.clear(); stage.remove() },
  }
}

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, PassThrough } from 'node:stream'
import { test } from 'node:test'
import { proto } from 'baileys'
import { ActionError, MAX_MESSAGES_PER_CHAT, PAGE_SIZE } from '../../shared/protocol.js'
import { AuthStore } from '../src/auth.js'
import { History } from '../src/history.js'
import { Session, validateCommand } from '../src/session.js'
import { FramedTransport, MAX_CHUNK } from '../src/transport.js'
import { Vault } from '../src/vault.js'

const hasCode = (code: string) => (error: unknown) => error instanceof ActionError && error.code === code
async function fixture(task: (vault: Vault, path: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'mwp-wa-test-'))
  const vault = new Vault(directory)
  try { await vault.open(); await task(vault, directory) } finally { await vault.close(); await rm(directory, { recursive: true, force: true }) }
}
function frame(value: unknown) { const bytes = Buffer.from(JSON.stringify(value)); const header = Buffer.alloc(4); header.writeUInt32LE(bytes.length); return Buffer.concat([header, bytes]) }
const init = (v = 5) => frame({ type: 'init', v })
async function decode(buffers: Buffer[]) {
  const values: unknown[] = []
  for await (const value of new FramedTransport(Readable.from(buffers), new PassThrough()).records()) values.push(value)
  return values
}

test('process-v2 reassembles UTF-8 across arbitrary input and v5 physical chunks', async () => {
  const output = new PassThrough(); const chunks: Buffer[] = []
  output.on('data', bytes => chunks.push(Buffer.from(bytes)))
  const value = { type: 'message', text: 'é'.repeat(MAX_CHUNK) }
  await new FramedTransport(Readable.from([]), output).send(value)
  const bytes = Buffer.concat([init(), ...chunks])
  assert.deepEqual((await decode([bytes.subarray(0, 3), bytes.subarray(3, 300), bytes.subarray(300)]))[1], value)
})
test('process-v2 preserves v4 and rejects truncation, invalid sequence and oversize', async () => {
  assert.deepEqual(await decode([init(4), frame({ type: 'shutdown', v: 4 })]), [{ type: 'init', v: 4 }, { type: 'shutdown', v: 4 }])
  await assert.rejects(decode([init().subarray(0, 6)]), /Truncated/)
  const header = Buffer.alloc(4); header.writeUInt32LE(((2 << 30) | 2) >>> 0)
  await assert.rejects(decode([init(), header, Buffer.from('{}')]), /sequence/)
  header.writeUInt32LE(MAX_CHUNK + 1)
  await assert.rejects(decode([init(), header]), /length/)
})
test('the vault encrypts persisted data and authenticates it before decoding', async () => fixture(async (vault, path) => {
  await vault.write('auth', 'private-session-data')
  const bytes = await readFile(join(path, 'auth.bin'))
  assert.equal(bytes.includes(Buffer.from('private-session-data')), false)
  assert.equal(await vault.read('auth'), 'private-session-data')
  bytes[bytes.length - 1] ^= 1; await writeFile(join(path, 'auth.bin'), bytes)
  await assert.rejects(vault.read('auth'), hasCode('storage-failed'))
}))
test('an active session cannot be opened or unlocked by a second process instance', async () => fixture(async (vault, path) => {
  const other = new Vault(path)
  await assert.rejects(other.open(), hasCode('session-in-use'))
  await other.close()
  await assert.rejects(new Vault(path).open(), hasCode('session-in-use'))
  await vault.write('history', '{}')
}))
test('Signal keys and binary credentials round-trip, including key deletion', async () => fixture(async vault => {
  const store = await AuthStore.open(vault)
  const original = Buffer.from(store.state.creds.noiseKey.private)
  await store.state.keys.set({ session: { peer: Buffer.from('signal-key') } })
  await store.update({ registered: true })
  await store.flush()
  const restored = await AuthStore.open(vault)
  assert.deepEqual(restored.state.creds.noiseKey.private, original)
  assert.equal(restored.state.creds.registered, true)
  assert.deepEqual((await restored.state.keys.get('session', ['peer'])).peer, Buffer.from('signal-key'))
  await restored.state.keys.set({ session: { peer: null } })
  assert.deepEqual(await restored.state.keys.get('session', ['peer']), {})
  await restored.close()
  await assert.rejects(async () => restored.state.keys.set({ session: { peer: Buffer.from('late write') } }), hasCode('offline'))
}))
test('history is bounded/paginated, preserves read status and never caches view-once messages', async () => fixture(async vault => {
  const history = new History(vault, () => assert.fail('storage failed'))
  const jid = '33600000001@s.whatsapp.net'
  for (let n = 0; n < MAX_MESSAGES_PER_CHAT + 5; n++) history.upsert({ key: { remoteJid: jid, id: `m-${n}`, fromMe: true }, messageTimestamp: n + 1000, message: { conversation: `Message ${n}` } }, false)
  const latest = history.page(jid)
  assert.equal(latest.messages.length, PAGE_SIZE); assert.equal(latest.hasMore, true)
  assert.equal(history.page(jid, latest.messages[0].id).messages.length, PAGE_SIZE)
  history.delivery(jid, 'm-124', proto.WebMessageInfo.Status.READ)
  history.delivery(jid, 'm-124', proto.WebMessageInfo.Status.SERVER_ACK)
  assert.equal(history.page(jid).messages.at(-1)?.delivery, 'read')
  assert.equal(history.upsert({ key: { remoteJid: jid, id: 'secret' }, message: { viewOnceMessage: { message: { imageMessage: { caption: 'private' } } } } }, true), undefined)
  assert.equal(history.upsert({ key: { remoteJid: jid, id: 'disappearing' }, message: { extendedTextMessage: { text: 'Temporary', contextInfo: { expiration: 3600 } } } }, true), undefined)
  const revoked = history.revoke(jid, 'm-124')
  assert.equal(revoked?.deleted, true); assert.equal(revoked?.text, '')
  await history.flush(); history.clear()
  const restored = new History(vault, () => assert.fail('storage failed'))
  await restored.open()
  assert.equal(restored.page(jid).messages.at(-1)?.deleted, true)
  await restored.flush(); restored.clear()
}))
test('adapter validates targets and text, and a fresh snapshot never connects or sends', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mwp-wa-adapter-'))
  const command = { kind: 'wa.command', requestId: randomUUID(), action: 'send', chatId: '33600000001@s.whatsapp.net', text: 'Hello', messageId: randomUUID().replaceAll('-', '').toUpperCase() }
  assert.equal(validateCommand(command).text, 'Hello')
  assert.throws(() => validateCommand({ ...command, text: 'x'.repeat(4097) }), hasCode('invalid-request'))
  assert.throws(() => validateCommand({ ...command, chatId: 'status@broadcast' }), hasCode('invalid-request'))
  assert.throws(() => validateCommand({ ...command, messageId: '../../invalid' }), hasCode('invalid-request'))
  const session = new Session(directory)
  try {
    const snapshot = await session.handle({ kind: 'wa.command', requestId: randomUUID(), action: 'snapshot' })
    assert.deepEqual(snapshot && 'result' in snapshot ? snapshot.result : null, { state: { status: 'idle' }, chats: [] })
    const send = await session.handle(command)
    assert.equal(send && 'error' in send ? send.error : null, 'not-ready')
    assert.equal(await session.handle({ bad: 'input' }), undefined)
  } finally { await session.close(); await rm(directory, { recursive: true, force: true }) }
})

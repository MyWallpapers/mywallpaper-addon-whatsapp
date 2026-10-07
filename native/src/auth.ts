import { BufferJSON, initAuthCreds, proto, type AuthenticationCreds, type AuthenticationState, type SignalDataTypeMap, type SignalDataSet } from 'baileys'
import { ActionError } from '../../shared/protocol.js'
import { Vault } from './vault.js'

export class AuthStore {
  readonly state: AuthenticationState
  private data: Record<string, unknown>
  private writing: Promise<void> = Promise.resolve()
  private failure: unknown
  private closed = false
  private constructor(private vault: Vault, creds: AuthenticationCreds, keys: Record<string, unknown>) {
    this.data = keys
    this.state = {
      creds,
      keys: {
        get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
          if (this.closed) throw new ActionError('offline')
          const result: { [id: string]: SignalDataTypeMap[T] } = {}
          for (const id of ids) {
            let value = this.data[`${type}:${id}`]
            if (value === undefined) continue
            if (type === 'app-state-sync-key') value = proto.Message.AppStateSyncKeyData.fromObject(value as proto.Message.IAppStateSyncKeyData)
            result[id] = value as SignalDataTypeMap[T]
          }
          return result
        },
        set: async (values: SignalDataSet) => {
          if (this.closed) throw new ActionError('offline')
          for (const [type, entries] of Object.entries(values)) for (const [id, value] of Object.entries(entries ?? {})) {
            const key = `${type}:${id}`
            if (value === null) delete this.data[key]
            else this.data[key] = value
          }
          await this.save()
        },
      },
    }
  }
  static async open(vault: Vault) {
    const source = await vault.read('auth')
    if (!source) return new AuthStore(vault, initAuthCreds(), Object.create(null))
    try {
      const value = JSON.parse(source, BufferJSON.reviver) as { creds: AuthenticationCreds; keys: Record<string, unknown> }
      if (!value.creds?.noiseKey?.private || typeof value.keys !== 'object' || !value.keys) throw new Error('invalid auth state')
      return new AuthStore(vault, value.creds, Object.assign(Object.create(null), value.keys))
    } catch { throw new ActionError('storage-failed') }
  }
  update(changes: Partial<AuthenticationCreds>) { if (this.closed) return Promise.reject(new ActionError('offline')); Object.assign(this.state.creds, changes); return this.save() }
  save(): Promise<void> {
    if (this.closed) return Promise.reject(new ActionError('offline'))
    if (this.failure) return Promise.reject(new ActionError('storage-failed'))
    const source = JSON.stringify({ creds: this.state.creds, keys: this.data }, BufferJSON.replacer)
    const next = this.writing.then(() => this.vault.write('auth', source))
    this.writing = next.catch(error => { this.failure = error })
    return next
  }
  async flush() { await this.writing; if (this.failure) throw new ActionError('storage-failed') }
  async close() { this.closed = true; await this.flush() }
}

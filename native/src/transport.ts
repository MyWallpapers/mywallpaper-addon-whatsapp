import type { Readable, Writable } from 'node:stream'

export const MAX_CHUNK = 1024 * 1024
const MAX_RECORD = 8 * 1024 * 1024

/** Same length-prefixed process-v2 framing as the Desktop host (v4 and v5). */
export class FramedTransport {
  version = 5
  private output: Promise<void> = Promise.resolve()
  constructor(private input: Readable, private writer: Writable) {}
  async *records(): AsyncGenerator<unknown> {
    let pending = Buffer.alloc(0)
    let pieces: Buffer[] = []
    let recordBytes = 0
    let initial = true
    for await (const source of this.input) {
      pending = pending.length ? Buffer.concat([pending, source]) : Buffer.from(source)
      while (pending.length >= 4) {
        const header = pending.readUInt32LE(0)
        const kind = initial || this.version === 4 ? 0 : header >>> 30
        const length = initial || this.version === 4 ? header : header & 0x3fffffff
        if (!length || length > MAX_CHUNK) throw new Error('Invalid physical chunk length')
        if (pending.length < length + 4) break
        const bytes = Buffer.from(pending.subarray(4, 4 + length))
        pending = pending.subarray(4 + length)
        if (kind === 0 && pieces.length || kind === 1 && pieces.length || kind >= 2 && !pieces.length) throw new Error('Invalid chunk sequence')
        recordBytes += length
        if (recordBytes > MAX_RECORD) throw new Error('Record exceeds companion boundary')
        pieces.push(bytes)
        if (kind === 0 || kind === 3) {
          const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(pieces, recordBytes))
          const value = JSON.parse(text)
          pieces = []; recordBytes = 0
          if (initial) {
            if (value.type !== 'init' || value.v !== 4 && value.v !== 5) throw new Error('Invalid host initialization')
            this.version = value.v; initial = false
          }
          yield value
        }
      }
      if (pending.length > MAX_CHUNK + 4) throw new Error('Oversized partial chunk')
    }
    if (pending.length || pieces.length) throw new Error('Truncated host record')
  }
  send(value: unknown): Promise<void> {
    const record = Buffer.from(JSON.stringify(value))
    if (!record.length || record.length > MAX_RECORD || this.version === 4 && record.length > MAX_CHUNK) return Promise.reject(new Error('Oversized output record'))
    const operation = this.output.then(async () => {
      for (let start = 0; start < record.length; start += MAX_CHUNK) {
        const chunk = record.subarray(start, start + MAX_CHUNK)
        const kind = record.length <= MAX_CHUNK ? 0 : start === 0 ? 1 : start + MAX_CHUNK >= record.length ? 3 : 2
        const header = Buffer.allocUnsafe(4)
        header.writeUInt32LE(((kind << 30) | chunk.length) >>> 0)
        await new Promise<void>((resolve, reject) => { this.writer.write(Buffer.concat([header, chunk]), error => error ? reject(error) : resolve()) })
      }
    })
    this.output = operation.catch(() => {})
    return operation
  }
  async flush() { await this.output }
}

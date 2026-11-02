/** Streaming ZIP writer (Store mode) used by the gallery export route. */
import { once } from 'node:events'
import type { ServerResponse } from 'node:http'
import { crc32 } from 'node:zlib'

const LOCAL_HEADER_BYTES = 30
const CENTRAL_HEADER_BYTES = 46
const END_OF_CENTRAL_BYTES = 22
/** ZIP32 caps the archive at 4 GiB and 65535 entries; leave a small margin. */
const MAX_ZIP32_BYTES = 0xffff_ff00
const MAX_ENTRIES = 0xfffe

/** Raised when the export would need ZIP64, which this writer does not emit yet. */
export class ZipTooLargeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ZipTooLargeError'
  }
}

/**
 * Write a ZIP archive straight to an HTTP response.
 *
 * Images are already compressed, so entries are stored (method 0) and the only
 * CPU work is the CRC — `zlib.crc32` runs in native code. Each entry is read
 * and written one at a time, so peak memory stays near one attachment instead
 * of the whole selection.
 */
export class ZipStreamWriter {
  private readonly central: Buffer[] = []
  private readonly names = new Set<string>()
  private offset = 0
  private entries = 0
  private closed = false

  constructor(private readonly res: ServerResponse) {}

  get entryCount(): number {
    return this.entries
  }

  get bytesWritten(): number {
    return this.offset
  }

  /** Stop writing as soon as the browser closes the download. */
  markClientClosed(): void {
    this.closed = true
  }

  /** Append one file entry. Throws ZipTooLargeError before crossing the ZIP32 limit. */
  async add(name: string, data: Buffer): Promise<void> {
    if (this.entries >= MAX_ENTRIES) {
      throw new ZipTooLargeError('ZIP export exceeds the 65535 entry limit')
    }
    const safeName = this.uniqueName(name)
    const nameBytes = Buffer.from(safeName, 'utf8')
    const size = data.byteLength
    if (this.offset + LOCAL_HEADER_BYTES + nameBytes.length + size > MAX_ZIP32_BYTES) {
      throw new ZipTooLargeError('ZIP export exceeds the 4 GiB ZIP32 limit')
    }
    const checksum = crc32(data)
    const { time, date } = dosDateTime()
    const headerOffset = this.offset

    const local = Buffer.alloc(LOCAL_HEADER_BYTES)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0x0800, 6) // UTF-8 file names
    local.writeUInt16LE(0, 8) // stored
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(size, 18)
    local.writeUInt32LE(size, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28)

    const central = Buffer.alloc(CENTRAL_HEADER_BYTES)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4) // version made by
    central.writeUInt16LE(20, 6) // version needed
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(date, 14)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(size, 20)
    central.writeUInt32LE(size, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt16LE(0, 30) // extra length
    central.writeUInt16LE(0, 32) // comment length
    central.writeUInt16LE(0, 34) // disk number
    central.writeUInt16LE(0, 36) // internal attributes
    central.writeUInt32LE(0, 38) // external attributes
    central.writeUInt32LE(headerOffset, 42)

    await this.write(local)
    await this.write(nameBytes)
    await this.write(data)
    this.central.push(Buffer.concat([central, nameBytes]))
    this.entries += 1
  }

  /** Write the central directory and finish the response. */
  async finish(): Promise<void> {
    const centralOffset = this.offset
    let centralSize = 0
    for (const record of this.central) centralSize += record.byteLength
    if (centralOffset + centralSize + END_OF_CENTRAL_BYTES > MAX_ZIP32_BYTES) {
      throw new ZipTooLargeError('ZIP central directory exceeds the ZIP32 limit')
    }
    for (const record of this.central) await this.write(record)

    const end = Buffer.alloc(END_OF_CENTRAL_BYTES)
    end.writeUInt32LE(0x06054b50, 0)
    end.writeUInt16LE(0, 4) // this disk
    end.writeUInt16LE(0, 6) // disk with central directory
    end.writeUInt16LE(this.entries, 8)
    end.writeUInt16LE(this.entries, 10)
    end.writeUInt32LE(centralSize, 12)
    end.writeUInt32LE(centralOffset, 16)
    end.writeUInt16LE(0, 20) // comment length
    await this.write(end)
    this.res.end()
  }

  private async write(chunk: Buffer): Promise<void> {
    if (this.closed) throw new Error('client closed the download')
    this.offset += chunk.byteLength
    if (!this.res.write(chunk)) await once(this.res, 'drain')
  }

  private uniqueName(raw: string): string {
    const cleaned = sanitizeName(raw)
    if (!this.names.has(cleaned)) {
      this.names.add(cleaned)
      return cleaned
    }
    const dot = cleaned.lastIndexOf('.')
    const stem = dot > 0 ? cleaned.slice(0, dot) : cleaned
    const extension = dot > 0 ? cleaned.slice(dot) : ''
    let suffix = 1
    let candidate = cleaned
    while (this.names.has(candidate)) {
      candidate = stem + '-' + suffix + extension
      suffix += 1
    }
    this.names.add(candidate)
    return candidate
  }
}

/** Keep download names portable: no paths, no control characters, bounded length. */
export function sanitizeName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? 'image'
  const cleaned = base.replace(/[^A-Za-z0-9._@-]+/g, '_').replace(/^[._]+/, '').slice(0, 120)
  return cleaned.length > 0 ? cleaned : 'image'
}

function dosDateTime(when = new Date()): { time: number; date: number } {
  const time = (when.getHours() << 11) | (when.getMinutes() << 5) | Math.floor(when.getSeconds() / 2)
  const year = Math.max(when.getFullYear() - 1980, 0)
  const date = ((year << 9) | ((when.getMonth() + 1) << 5) | when.getDate()) & 0xffff
  return { time, date }
}

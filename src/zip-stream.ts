/** Streaming ZIP writer (Store mode) used by the gallery export route. */
import { once } from 'node:events'
import type { ServerResponse } from 'node:http'
import { crc32 } from 'node:zlib'

const LOCAL_HEADER_BYTES = 30
const CENTRAL_HEADER_BYTES = 46
const END_OF_CENTRAL_BYTES = 22
const ZIP64_END_BYTES = 56
const ZIP64_LOCATOR_BYTES = 20
const ZIP64_EXTRA_ID = 0x0001
const ZIP64_VERSION = 45
const ZIP32_VERSION = 20
const UINT32_MAX = 0xffff_ffff
const UINT16_MAX = 0xffff
const MAX_ENTRIES = 0xffff_fffe

/** Raised when the selection cannot be represented even with ZIP64 records. */
export class ZipTooLargeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ZipTooLargeError'
  }
}

interface EntryRecord {
  nameBytes: Buffer
  checksum: number
  size: number
  headerOffset: number
  size64: boolean
  offset64: boolean
}

/**
 * Write a ZIP archive straight to an HTTP response.
 *
 * Images are already compressed, so entries are stored (method 0) and the only
 * CPU work is the CRC — `zlib.crc32` runs in native code. Sizes are known before
 * each header is written, so no data descriptor is needed; entries that cross
 * the ZIP32 limits get ZIP64 extra fields, and the archive ends with a ZIP64
 * end-of-central-directory record when any entry needs one.
 */
export class ZipStreamWriter {
  private readonly central: Buffer[] = []
  private readonly names = new Set<string>()
  private offset = 0
  private entries = 0
  private closed = false
  private zip64Archive = false

  constructor(
    private readonly res: ServerResponse,
    private readonly options: { zip64?: 'auto' | 'always' } = {},
  ) {}

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

  /** Append one file entry. */
  async add(name: string, data: Buffer): Promise<void> {
    if (this.entries >= MAX_ENTRIES) {
      throw new ZipTooLargeError('ZIP export exceeds the entry limit')
    }
    const safeName = this.uniqueName(name)
    const nameBytes = Buffer.from(safeName, 'utf8')
    const size = data.byteLength
    const checksum = crc32(data)
    const { time, date } = dosDateTime()
    const headerOffset = this.offset
    const zip64 = this.options.zip64 ?? 'auto'
    const size64 = zip64 === 'always' || size >= UINT32_MAX
    const offset64 = zip64 === 'always' || headerOffset >= UINT32_MAX
    if (size64 || offset64) this.zip64Archive = true

    const localExtra = size64 ? zip64Extra([size, size]) : Buffer.alloc(0)
    const version = size64 ? ZIP64_VERSION : ZIP32_VERSION

    const local = Buffer.alloc(LOCAL_HEADER_BYTES)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(version, 4) // version needed
    local.writeUInt16LE(0x0800, 6) // UTF-8 file names
    local.writeUInt16LE(0, 8) // stored
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(size64 ? UINT32_MAX : size, 18)
    local.writeUInt32LE(size64 ? UINT32_MAX : size, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(localExtra.length, 28)

    await this.write(local)
    await this.write(nameBytes)
    if (localExtra.length > 0) await this.write(localExtra)
    await this.write(data)

    this.central.push(this.centralRecord({
      nameBytes,
      checksum,
      size,
      headerOffset,
      size64,
      offset64,
    }))
    this.entries += 1
  }

  /** Write the central directory and finish the response. */
  async finish(): Promise<void> {
    const centralOffset = this.offset
    let centralSize = 0
    for (const record of this.central) centralSize += record.byteLength
    const zip64 = this.zip64Archive
      || this.entries > UINT16_MAX
      || centralOffset >= UINT32_MAX
      || centralSize >= UINT32_MAX
    if (zip64) this.zip64Archive = true

    for (const record of this.central) await this.write(record)

    if (zip64) {
      const zip64Offset = this.offset
      const end64 = Buffer.alloc(ZIP64_END_BYTES)
      end64.writeUInt32LE(0x06064b50, 0)
      end64.writeBigUInt64LE(44n, 4) // size of the remaining record
      end64.writeUInt16LE(ZIP64_VERSION, 12) // version made by
      end64.writeUInt16LE(ZIP64_VERSION, 14) // version needed
      end64.writeUInt32LE(0, 16) // this disk
      end64.writeUInt32LE(0, 20) // disk with central directory
      end64.writeBigUInt64LE(BigInt(this.entries), 24)
      end64.writeBigUInt64LE(BigInt(this.entries), 32)
      end64.writeBigUInt64LE(BigInt(centralSize), 40)
      end64.writeBigUInt64LE(BigInt(centralOffset), 48)
      await this.write(end64)

      const locator = Buffer.alloc(ZIP64_LOCATOR_BYTES)
      locator.writeUInt32LE(0x07064b50, 0)
      locator.writeUInt32LE(0, 4) // disk holding the ZIP64 EOCD
      locator.writeBigUInt64LE(BigInt(zip64Offset), 8)
      locator.writeUInt32LE(1, 16) // total disks
      await this.write(locator)
    }

    const end = Buffer.alloc(END_OF_CENTRAL_BYTES)
    end.writeUInt32LE(0x06054b50, 0)
    end.writeUInt16LE(0, 4) // this disk
    end.writeUInt16LE(0, 6) // disk with central directory
    end.writeUInt16LE(zip64 ? UINT16_MAX : this.entries, 8)
    end.writeUInt16LE(zip64 ? UINT16_MAX : this.entries, 10)
    end.writeUInt32LE(zip64 ? UINT32_MAX : centralSize, 12)
    end.writeUInt32LE(zip64 ? UINT32_MAX : centralOffset, 16)
    end.writeUInt16LE(0, 20) // comment length
    await this.write(end)
    this.res.end()
  }

  private centralRecord(entry: EntryRecord): Buffer {
    // ZIP64 extra values must appear in the order: sizes, then offset. When only
    // the offset overflows the size fields stay 32-bit, so no placeholder is
    // written for them.
    const extraValues = [
      ...(entry.size64 ? [entry.size, entry.size] : []),
      ...(entry.offset64 ? [entry.headerOffset] : []),
    ]
    const extra = extraValues.length > 0 ? zip64Extra(extraValues) : Buffer.alloc(0)
    const central = Buffer.alloc(CENTRAL_HEADER_BYTES)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(entry.size64 || entry.offset64 ? ZIP64_VERSION : ZIP32_VERSION, 4) // version made by
    central.writeUInt16LE(entry.size64 || entry.offset64 ? ZIP64_VERSION : ZIP32_VERSION, 6) // version needed
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(dosDateTime().time, 12)
    central.writeUInt16LE(dosDateTime().date, 14)
    central.writeUInt32LE(entry.checksum, 16)
    central.writeUInt32LE(entry.size64 ? UINT32_MAX : entry.size, 20)
    central.writeUInt32LE(entry.size64 ? UINT32_MAX : entry.size, 24)
    central.writeUInt16LE(entry.nameBytes.length, 28)
    central.writeUInt16LE(extra.length, 30)
    central.writeUInt16LE(0, 32) // comment length
    central.writeUInt16LE(0, 34) // disk number
    central.writeUInt16LE(0, 36) // internal attributes
    central.writeUInt32LE(0, 38) // external attributes
    central.writeUInt32LE(entry.offset64 ? UINT32_MAX : entry.headerOffset, 42)
    return Buffer.concat([central, entry.nameBytes, extra])
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

/** Encode a ZIP64 extra field: id, size, then one or more 8-byte values. */
function zip64Extra(values: number[]): Buffer {
  const body = Buffer.alloc(values.length * 8)
  values.forEach((value, index) => body.writeBigUInt64LE(BigInt(value), index * 8))
  const extra = Buffer.alloc(4 + body.length)
  extra.writeUInt16LE(ZIP64_EXTRA_ID, 0)
  extra.writeUInt16LE(body.length, 2)
  body.copy(extra, 4)
  return extra
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

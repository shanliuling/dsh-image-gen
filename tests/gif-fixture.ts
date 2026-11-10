/** Smallest valid GIF89a with the given frames; shared by the player, workbench and tool suites. */
export function gifBytes(frames: number, delayCs = 10, width = 16, height = 8): Uint8Array {
  const le16 = (value: number) => [value & 0xff, (value >> 8) & 0xff]
  return Uint8Array.from([
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61, ...le16(width), ...le16(height), 0x80, 0x00, 0x00, 0, 0, 0, 255, 255, 255,
    ...Array.from({ length: frames }, () => [
      0x21, 0xf9, 0x04, 0x00, ...le16(delayCs), 0x00, 0x00,
      0x2c, 0, 0, 0, 0, ...le16(width), ...le16(height), 0x00, 0x02, 0x02, 0x44, 0x01, 0x00,
    ]).flat(),
    0x3b,
  ])
}

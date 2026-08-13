/**
 * CRC-32 (IEEE 802.3 polynomial 0xEDB88320) implementation for Acoustic Packet Integrity.
 */
const CRC_TABLE = new Uint32Array(256)
for (let i = 0; i < 256; i++) {
  let c = i
  for (let j = 0; j < 8; j++) {
    c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
  }
  CRC_TABLE[i] = c >>> 0
}

export function crc32(data: Uint8Array): number {
  let crc = 0xFFFFFFFF
  for (let i = 0; i < data.length; i++) {
    const byte = data[i]!
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xFF]!
  }
  return (crc ^ 0xFFFFFFFF) >>> 0
}

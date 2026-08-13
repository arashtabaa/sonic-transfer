import { describe, expect, it } from 'vitest'
import {
  AcousticFrameType,
  AcousticPacketizer,
  BFSKAcousticModem,
  OFDMAcousticModem,
  crc32,
  decodeFrame,
  encodeFrame,
  getProfileConfig,
  ModemProfileKey,
} from '../app/acoustic'

describe('Acoustic Protocol & Framing', () => {
  it('should compute valid CRC32 checksums', () => {
    const data = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
    const checksum1 = crc32(data)
    const checksum2 = crc32(data)
    expect(checksum1).toBe(checksum2)
    expect(checksum1).toBeGreaterThan(0)
  })

  it('should encode and decode acoustic frames with CRC validation', () => {
    const sessionId = 123456
    const sequence = 42
    const payload = new Uint8Array([10, 20, 30, 40, 50])

    const buffer = encodeFrame(sessionId, AcousticFrameType.DATA, sequence, payload)
    expect(buffer).toBeInstanceOf(Uint8Array)

    const frame = decodeFrame(buffer)
    expect(frame).not.toBeNull()
    expect(frame?.version).toBe(1)
    expect(frame?.sessionId).toBe(sessionId)
    expect(frame?.frameType).toBe(AcousticFrameType.DATA)
    expect(frame?.sequence).toBe(sequence)
    expect(frame?.payload).toEqual(payload)
  })

  it('should reject corrupted acoustic frames', () => {
    const sessionId = 654321
    const payload = new Uint8Array([100, 200, 255])
    const buffer = encodeFrame(sessionId, AcousticFrameType.DATA, 1, payload)

    // Corrupt a byte in the payload
    buffer[18] = buffer[18]! ^ 0xFF

    const frame = decodeFrame(buffer)
    expect(frame).toBeNull() // Rejected due to CRC failure!
  })

  it('should handle session header frames via packetizer', () => {
    const packetizer = new AcousticPacketizer(9999)
    const headerFrame = packetizer.createSessionHeaderFrame({
      protocolVersion: 1,
      sessionId: 9999,
      filename: 'test.bin',
      contentType: 'application/octet-stream',
      originalSize: 1024,
      encodedSize: 1200,
      fileChecksum: 7777,
      totalFountainK: 10,
      modemProfile: 'balanced',
    })

    const parsed = packetizer.parseIncomingBuffer(headerFrame)
    expect(parsed.frame).not.toBeNull()
    expect(parsed.sessionHeader?.filename).toBe('test.bin')
    expect(parsed.sessionHeader?.totalFountainK).toBe(10)
  })
})

describe('Acoustic Modem Modulation & Demodulation', () => {
  it('should generate valid audio frames for BFSK modem', () => {
    const config = getProfileConfig(ModemProfileKey.ROBUST, 48000)
    const modem = new BFSKAcousticModem(config)

    const packet = new Uint8Array([0xAA, 0x55, 0x12, 0x34])
    const audioFrame = modem.encode(packet)

    expect(audioFrame.samples).toBeInstanceOf(Float32Array)
    expect(audioFrame.samples.length).toBeGreaterThan(0)
    expect(audioFrame.durationMs).toBeGreaterThan(0)
  })

  it('should encode and demodulate synthetic audio signal end-to-end for BFSK modem', () => {
    const config = getProfileConfig(ModemProfileKey.ROBUST, 48000)
    const modem = new BFSKAcousticModem(config)

    const packet = new Uint8Array([0x12, 0x34])
    const audioFrame = modem.encode(packet)

    const decodedPackets = modem.decode(audioFrame.samples)
    expect(decodedPackets.length).toBeGreaterThan(0)
    expect(decodedPackets[0]!.subarray(0, packet.length)).toEqual(packet)
  })
})

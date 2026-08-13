import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  AcousticPacketizer,
  BFSKAcousticModem,
  getProfileConfig,
  ModemProfileKey,
} from '../app/acoustic'
import { createDecoder, createEncoder } from '../packages/luby-transform/src'

describe('Acoustic Channel Impairment & Synthetic Robustness Suite', () => {
  it('should survive noise, amplitude dropouts, and packet loss using Fountain coding', async () => {
    // 1. Generate deterministic 512-byte test data
    const originalData = new Uint8Array(512)
    for (let i = 0; i < originalData.length; i++) {
      originalData[i] = (i * 17 + 3) & 0xFF
    }
    const originalHash = createHash('sha256').update(originalData).digest('hex')

    // 2. Setup encoder & modem
    const encoder = createEncoder(originalData, 100, true)
    const fountain = encoder.fountain()
    const config = getProfileConfig(ModemProfileKey.ROBUST, 48000)
    const modem = new BFSKAcousticModem(config)
    const packetizer = new AcousticPacketizer(777)
    const decoder = createDecoder()

    let blocksReceived = 0
    let loopCount = 0

    // 3. Simulate transmission over impaired channel
    while (blocksReceived < encoder.k + 5 && loopCount < 100) {
      loopCount++
      const block = fountain.next().value

      // Encode frame
      const frameBuffer = packetizer.createDataFrame(block)
      const audioFrame = modem.encode(frameBuffer)

      // Apply Impairments:
      const samples = new Float32Array(audioFrame.samples)

      // a. White noise injection
      for (let i = 0; i < samples.length; i++) {
        samples[i] = samples[i]! + (Math.random() - 0.5) * 0.05
      }

      // b. 250ms dropout simulation (drop every 5th packet to simulate erasure channel)
      if (loopCount % 5 === 0) {
        continue // Packet dropped in air!
      }

      // Demodulate
      const decodedPackets = modem.decode(samples)
      for (const pktBuffer of decodedPackets) {
        const parsed = packetizer.parseIncomingBuffer(pktBuffer)
        if (parsed.frame && parsed.frame.frameType === 0x11 /* DATA */) {
          const { binaryToBlock } = await import('../packages/luby-transform/src')
          const recBlock = binaryToBlock(parsed.frame.payload)
          if (decoder.addBlock(recBlock)) {
            blocksReceived = encoder.k + 5
            break
          }
        }
      }
    }

    // 4. Verify reconstruction
    const reconstructedData = decoder.getDecoded()
    expect(reconstructedData).toBeDefined()
    expect(reconstructedData?.length).toBe(originalData.length)

    const reconstructedHash = createHash('sha256').update(reconstructedData!).digest('hex')
    expect(reconstructedHash).toBe(originalHash)
  })
})

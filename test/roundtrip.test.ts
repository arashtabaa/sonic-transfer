import { createHash, randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  AcousticPacketizer,
  BFSKAcousticModem,
  getProfileConfig,
  ModemProfileKey,
} from '../app/acoustic'
import { createDecoder, createEncoder } from '../packages/luby-transform/src'

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

describe('Final Acoustic Round-Trip Verification Test', () => {
  it('BFSK Modem synthetic acoustic round-trip over random binary data', () => {
    const sampleRate = 48000
    const testType = 'synthetic (software loopback)'

    // Generate random 1024 bytes
    const randomBuffer = randomBytes(1024)
    const originalBytes = new Uint8Array(randomBuffer.buffer, randomBuffer.byteOffset, randomBuffer.byteLength)
    const originalHash = sha256(originalBytes)

    // Fountain encode
    const encoder = createEncoder(originalBytes, 128, true)
    const fountainGen = encoder.fountain()

    // Modem setup
    const config = getProfileConfig(ModemProfileKey.ROBUST, sampleRate)
    const modem = new BFSKAcousticModem(config)
    const packetizer = new AcousticPacketizer(8888)

    const decoder = createDecoder()

    // Encode -> Modulate -> Synthetic Channel -> Demodulate -> Decode
    let reconstructedBytes: Uint8Array | undefined

    for (let i = 0; i < encoder.k * 4; i++) {
      const block = fountainGen.next().value
      const dataFrameBytes = packetizer.createDataFrame(block)

      // Acoustic Modulation
      const audioFrame = modem.encode(dataFrameBytes)

      // Demodulation from synthetic samples
      const decodedRawPackets = modem.decode(audioFrame.samples)
      for (const rawPacket of decodedRawPackets) {
        const parsed = packetizer.parseIncomingBuffer(rawPacket)
        if (parsed.fountainBlock) {
          const isComplete = decoder.addBlock(parsed.fountainBlock)
          if (isComplete) {
            reconstructedBytes = decoder.getDecoded()
            break
          }
        }
      }
      if (reconstructedBytes) break
    }

    expect(reconstructedBytes).toBeDefined()
    const reconstructedHash = sha256(reconstructedBytes!)

    console.log('\n--- FINAL ACOUSTIC ROUND-TRIP TEST RESULTS ---')
    console.log(`Test Type: ${testType}`)
    console.log(`Modem Used: BFSKAcousticModem (MFSK Robust Profile)`)
    console.log(`Sample Rate: ${sampleRate} Hz`)
    console.log(`Original SHA-256:      ${originalHash}`)
    console.log(`Reconstructed SHA-256: ${reconstructedHash}`)
    console.log(`Exact Byte Equality:   ${originalHash === reconstructedHash}`)
    console.log('----------------------------------------------\n')

    expect(reconstructedHash).toBe(originalHash)
    expect(reconstructedBytes).toEqual(originalBytes)
  })
})

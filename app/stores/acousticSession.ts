import { defineStore } from 'pinia'
import { readFileHeaderMetaFromBuffer } from 'luby-transform'
import {
  AcousticPacketizer,
  AudioReceiver,
  AudioTransmitter,
  BFSKAcousticModem,
  encodeFrame,
  getProfileConfig,
  MetricsCollector,
  ModemProfileKey,
  type AudioDiagnosticsInfo,
  type SessionHeaderPayload,
} from '~/acoustic'
import { createLTDecodeWorker } from '~/composables/lt-decode'

export const useAcousticSessionStore = defineStore('acousticSession', () => {
  // --- Persistent Preferences ---
  const selectedProfile = useLocalStorage<ModemProfileKey>('sonic-profile', ModemProfileKey.BALANCED)
  const outputGain = useLocalStorage<number>('sonic-gain', 0.7)
  const selectedMicId = useLocalStorage<string>('sonic-mic-id', '')
  const selectedSpeakerId = useLocalStorage<string>('sonic-speaker-id', '')
  const sliceSize = useLocalStorage<number>('sonic-slice-size', 200)

  // --- Live Runtime State (Survives SPA Navigation) ---
  const isTransmitting = ref(false)
  const isListening = ref(false)
  const liveSamples = ref<Float32Array | null>(null)
  const activePage = ref<'send' | 'receive' | 'idle'>('idle')

  // Sender Session State
  const sendFilename = ref<string | null>(null)
  const sendContentType = ref<string | null>(null)
  const sendTotalBytes = ref(0)
  const framesSent = ref(0)
  const bytesSent = ref(0)

  // Receiver Session State
  const receiveHeader = ref<SessionHeaderPayload | null>(null)
  const fountainK = ref(0)
  const decodedCount = ref(0)
  const totalBlocksReceived = ref(0)
  const downloadUrl = ref<string | null>(null)
  const downloadedFilename = ref<string | null>(null)
  const downloadedContentType = ref<string | null>(null)
  const isIntegrityVerified = ref(false)

  // Singletons
  let transmitter: AudioTransmitter | null = null
  let receiver: AudioReceiver | null = null
  let packetizer: AcousticPacketizer | null = null
  let decoderWorker: ReturnType<typeof createLTDecodeWorker> | null = null
  const metricsCollector = new MetricsCollector()
  const liveStats = ref(metricsCollector.getStats())
  let statsInterval: any = null

  // Wake Lock handle
  let wakeLock: any = null

  async function requestWakeLock() {
    try {
      if ('wakeLock' in navigator && (navigator as any).wakeLock) {
        wakeLock = await (navigator as any).wakeLock.request('screen')
      }
    } catch {
      // Ignored if unsupported
    }
  }

  function releaseWakeLock() {
    if (wakeLock) {
      wakeLock.release().catch(() => {})
      wakeLock = null
    }
  }

  // --- Sender Controls ---
  async function startTransmission(data: Uint8Array, filename?: string, contentType?: string) {
    if (isTransmitting.value) return

    sendFilename.value = filename || 'file.bin'
    sendContentType.value = contentType || 'application/octet-stream'
    sendTotalBytes.value = data.length
    framesSent.value = 0
    bytesSent.value = 0

    if (!transmitter) {
      transmitter = new AudioTransmitter({ sampleRate: 48000, gain: outputGain.value })
    }
    if (!packetizer) packetizer = new AcousticPacketizer()

    await transmitter.start()
    const config = getProfileConfig(selectedProfile.value, transmitter.getSampleRate())
    config.gain = outputGain.value
    const modem = new BFSKAcousticModem(config)

    const { createEncoder } = await import('luby-transform')
    const encoder = createEncoder(data, sliceSize.value, true)
    const fountain = encoder.fountain()

    let sequence = 0
    const sessionId = Math.floor(Math.random() * 1000000)

    isTransmitting.value = true
    activePage.value = 'send'
    await requestWakeLock()

    const step = async () => {
      if (!isTransmitting.value) return

      let frameBuffer: Uint8Array
      if (sequence % 10 === 0) {
        frameBuffer = packetizer!.createSessionHeaderFrame({
          protocolVersion: 1,
          sessionId,
          filename: sendFilename.value || 'file.bin',
          contentType: sendContentType.value || 'application/octet-stream',
          originalSize: data.length,
          encodedSize: encoder.compressed.length,
          fileChecksum: encoder.checksum,
          totalFountainK: encoder.k,
          modemProfile: selectedProfile.value,
        })
      } else {
        const block = fountain.next().value
        const blockBytes = blockToBinary(block)
        frameBuffer = encodeFrame(sessionId, 2 /* DATA */, sequence, blockBytes)
      }

      const audioFrame = modem.encode(frameBuffer)
      liveSamples.value = audioFrame.samples
      transmitter!.enqueueFrame(audioFrame)

      framesSent.value++
      bytesSent.value += frameBuffer.length
      sequence++

      if (isTransmitting.value) {
        setTimeout(step, config.symbolDurationMs * 2)
      }
    }

    step()
  }

  function stopTransmission() {
    isTransmitting.value = false
    if (transmitter) {
      transmitter.stop()
    }
    releaseWakeLock()
    if (!isListening.value) activePage.value = 'idle'
  }

  // --- Receiver Controls ---
  async function startListening() {
    if (isListening.value) return

    if (!packetizer) packetizer = new AcousticPacketizer()
    if (!decoderWorker) decoderWorker = createLTDecodeWorker()

    downloadUrl.value = null
    downloadedFilename.value = null
    downloadedContentType.value = null
    isIntegrityVerified.value = false
    receiveHeader.value = null
    fountainK.value = 0
    decodedCount.value = 0
    totalBlocksReceived.value = 0
    metricsCollector.start()

    const config = getProfileConfig(selectedProfile.value, 48000)
    const modem = new BFSKAcousticModem(config)

    if (!receiver) {
      receiver = new AudioReceiver({
        onAudioData: (samples) => {
          liveSamples.value = samples

          const packets = modem.decode(samples)
          for (const packet of packets) {
            processIncomingPacket(packet)
          }
        },
      })
    }

    await receiver.start(selectedMicId.value || undefined)

    isListening.value = true
    activePage.value = 'receive'
    await requestWakeLock()

    statsInterval = setInterval(() => {
      liveStats.value = metricsCollector.getStats()
    }, 250)
  }

  async function processIncomingPacket(packetBuffer: Uint8Array) {
    if (!packetizer || !decoderWorker) return

    const parsed = packetizer.parseIncomingBuffer(packetBuffer)
    if (!parsed.frame) {
      metricsCollector.recordPacket(0, false)
      return
    }

    metricsCollector.recordPacket(parsed.frame.payload.length, true)

    if (parsed.sessionHeader) {
      receiveHeader.value = parsed.sessionHeader
      fountainK.value = parsed.sessionHeader.totalFountainK
      if (decoderWorker) {
        await decoderWorker.createDecoder()
      }
    } else if (parsed.frame.frameType === 2 /* DATA */) {
      try {
        const { binaryToBlock } = await import('luby-transform')
        const block = binaryToBlock(parsed.frame.payload)
        totalBlocksReceived.value++

        const success = await decoderWorker.addBlock(block)
        const status = await decoderWorker.getStatus()
        decodedCount.value = status.decodedCount

        if (success && !downloadUrl.value) {
          const decodedMerged = (await decoderWorker.getDecoded())!
          const [mergedData, meta] = readFileHeaderMetaFromBuffer(decodedMerged)

          const blob = new Blob([mergedData], { type: meta.contentType })
          downloadUrl.value = URL.createObjectURL(blob)
          downloadedFilename.value = meta.filename || 'received-file'
          downloadedContentType.value = meta.contentType
          isIntegrityVerified.value = true
        }
      } catch (e) {
        console.error('Failed to process Fountain block', e)
      }
    }
  }

  function stopListening() {
    isListening.value = false
    if (receiver) {
      receiver.stop()
    }
    if (statsInterval) {
      clearInterval(statsInterval)
      statsInterval = null
    }
    releaseWakeLock()
    if (!isTransmitting.value) activePage.value = 'idle'
  }

  function blockToBinary(block: any): Uint8Array {
    const { k, bytes, checksum, indices, data } = block
    const header = new Uint32Array([indices.length, ...indices, k, bytes, checksum])
    const binary = new Uint8Array(header.length * 4 + data.length)
    let offset = 0
    binary.set(new Uint8Array(header.buffer), offset)
    offset += header.length * 4
    binary.set(data, offset)
    return binary
  }

  return {
    selectedProfile,
    outputGain,
    selectedMicId,
    selectedSpeakerId,
    sliceSize,
    isTransmitting,
    isListening,
    liveSamples,
    activePage,
    sendFilename,
    sendContentType,
    sendTotalBytes,
    framesSent,
    bytesSent,
    receiveHeader,
    fountainK,
    decodedCount,
    totalBlocksReceived,
    downloadUrl,
    downloadedFilename,
    downloadedContentType,
    isIntegrityVerified,
    liveStats,
    startTransmission,
    stopTransmission,
    startListening,
    stopListening,
  }
})

import { defineStore } from 'pinia'
import { appendFileHeaderMetaToBuffer, readFileHeaderMetaFromBuffer } from 'luby-transform'
import {
  AcousticFrameType,
  AcousticPacketizer,
  AudioReceiver,
  AudioTransmitter,
  BFSKAcousticModem,
  decodeTestFileStart,
  encodeFrame,
  encodeTestFileComplete,
  encodeTestFileStart,
  getProfileConfig,
  MetricsCollector,
  ModemProfileKey,
  BFSKStreamDecoder,
  createProfileProbeFrame,
  createChannelReportFrame,
  decodeProfileProposal,
  decodeProfileAccept,
  decodeChannelReport,
  encodeProfileProposal,
  encodeProfileAccept,
  validateProfileProposal,
  classifyProfileReport,
  decodeProfileProbe,
  encodeProfileProbeEnd,
  decodeProfileProbeEnd,
  encodeProfileReject,
  decodeProfileReject,
  encodeTransferEnd,
  decodeTransferEnd,
  encodeTransferStatus,
  decodeTransferStatus,
  encodeTransferPoll,
  decodeTransferPoll,
  getPilotMultitoneConfig,
  createDataTxPhy,
  createDataRxPhy,
  encodeWithDataTxPhy,
  type DataPhyConfig,
  type DataRxPhy,
  type AudioDiagnosticsInfo,
  type SessionHeaderPayload,
  SessionLifecycleRuntime,
  HALF_DUPLEX_TIMING,
  AdaptiveHandshakeRuntime,
  type AdaptiveHandshakeState,
  type AdaptiveLinkContext,
  AdaptiveHandshakeController,
  TransferCompletionCache,
} from '~/acoustic'
import { AcousticLinkTester } from '~/acoustic/transport/link-test'
import { createLTDecodeWorker } from '~/composables/lt-decode'
import { EXPECTED_TEST_SHA256, generateTestPayload } from '~/constants/testPayload'

export enum SessionStep {
  NOT_READY = 'NOT_READY',
  HARDWARE_READY = 'HARDWARE_READY',
  VERIFYING_LINK = 'VERIFYING_LINK',
  LINK_VERIFIED = 'LINK_VERIFIED',
  TEST_TRANSFERRING = 'TEST_TRANSFERRING',
  TEST_TRANSFER_VERIFIED = 'TEST_TRANSFER_VERIFIED',
  READY_FOR_FILE = 'READY_FOR_FILE',
  FILE_SELECTED = 'FILE_SELECTED',
  TRANSFERRING = 'TRANSFERRING',
  COMPLETE = 'COMPLETE',
}

export enum ReceiveMode {
  IDLE = 'IDLE',
  NORMAL_RECEIVE = 'NORMAL_RECEIVE',
  LINK_ACK_WAIT = 'LINK_ACK_WAIT',
  LINK_PROBE_LISTEN = 'LINK_PROBE_LISTEN',
  TEST_COMPLETE_WAIT = 'TEST_COMPLETE_WAIT',
  TEST_DATA_RECEIVE = 'TEST_DATA_RECEIVE',
  FREQUENCY_PROBE_LISTEN = 'FREQUENCY_PROBE_LISTEN',
  FREQUENCY_REPORT_WAIT = 'FREQUENCY_REPORT_WAIT',
  PROFILE_PROBE_LISTEN = 'PROFILE_PROBE_LISTEN',
  PROFILE_REPORT_WAIT = 'PROFILE_REPORT_WAIT',
  CONTROL_RX_WINDOW = 'CONTROL_RX_WINDOW',
}

export enum TransferPhase {
  IDLE = 'IDLE',
  DATA_TX = 'DATA_TX',
  TX_DRAIN = 'TX_DRAIN',
  TURNAROUND_TO_RX = 'TURNAROUND_TO_RX',
  ACK_WINDOW = 'ACK_WINDOW',
  TURNAROUND_TO_TX = 'TURNAROUND_TO_TX',
  COMPLETE = 'COMPLETE',
}

export type DspStage =
  | 'MICROPHONE_READY'
  | 'MEASURING_NOISE'
  | 'SEARCHING_FOR_SIGNAL'
  | 'CARRIER_LOCKED'
  | 'PREAMBLE_DETECTED'
  | 'FRAME_RECEIVING'
  | 'CRC_VALID'
  | 'FOUNTAIN_BLOCK_ACCEPTED'
  | 'RECONSTRUCTING'
  | 'COMPLETE'

async function computeSha256Hex(buffer: Uint8Array): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
}

export const useAcousticSessionStore = defineStore('acousticSession', () => {
  const sessionLifecycle = new SessionLifecycleRuntime()
  const adaptiveHandshake = new AdaptiveHandshakeRuntime()
  const transferCompletionCache = new TransferCompletionCache()
  // --- Persistent Preferences ---
  const selectedProfile = useLocalStorage<ModemProfileKey>('sonic-profile', ModemProfileKey.BALANCED)
  const outputGain = useLocalStorage<number>('sonic-gain', 0.7)
  const preferredOutputGain = outputGain
  const adaptiveCandidateGain = ref<number | null>(null)
  const verifiedAdaptiveTxGain = ref<number | null>(null)
  const effectiveTxGain = computed(() => adaptiveCandidateGain.value ?? verifiedAdaptiveTxGain.value ?? preferredOutputGain.value)
  const selectedMicId = useLocalStorage<string>('sonic-mic-id', '')
  const selectedSpeakerId = useLocalStorage<string>('sonic-speaker-id', '')
  const sliceSize = useLocalStorage<number>('sonic-slice-size', 200)

  // --- Workflow & Dispatcher State ---
  const sessionStep = ref<SessionStep>(SessionStep.NOT_READY)
  const receiveMode = ref<ReceiveMode>(ReceiveMode.IDLE)
  const transferPhase = ref<TransferPhase>(TransferPhase.IDLE)
  const dspStage = ref<DspStage>('MICROPHONE_READY')
  const linkCheckMessage = ref<string | null>(null)
  const adaptiveHandshakeState = ref<AdaptiveHandshakeState>('IDLE')
  const adaptiveHandshakeEvents = ref<Array<{ atMs: number; state: AdaptiveHandshakeState; message: string; evidence?: Record<string, unknown> }>>([])
  const adaptiveLinkContext = ref<AdaptiveLinkContext | null>(null)
  const adaptiveLocalGain = ref<number | null>(null)
  const adaptiveRemoteGain = ref<number | null>(null)
  const adaptiveSelectedBand = ref<{ startFreq: number; endFreq: number; carrierCount: number } | null>(null)
  const adaptiveConfigFingerprint = ref<string | null>(null)
  const duplexMode = 'HALF_DUPLEX_TDD' as const

  // Canonical Session ID & Nonce for Active Transfer (Requirement 4 & 5 & 6)
  const transferSessionId = ref<number | null>(null)
  const controlSessionId = ref<number | null>(null)
  const verificationSessionId = ref<number | null>(null)
  const activeTransferSessionId = ref<number | null>(null)
  const activeProbeNonce = ref<number | null>(null)
  const activeTestTransferId = ref<number | null>(null)
  const profileVerificationStatus = ref<'UNVERIFIED' | 'READY' | 'MARGINAL' | 'FAILED'>('UNVERIFIED')
  const profileVerificationReport = ref<any>(null)
  const profileVerificationNonce = ref<number | null>(null)
  const profileProbeValid = ref(0)
  const receivedProbeSequences = new Set<number>()
  const verifiedProfile = ref<ModemProfileKey | null>(null)
  const verifiedConfigFingerprint = ref<string | null>(null)
  const verifiedAt = ref<number | null>(null)
  let profileVerificationResolver: ((ready: boolean) => void) | null = null
  let profileVerificationTimer: ReturnType<typeof setTimeout> | null = null
  let profileVerificationPhase: 'ACCEPT' | 'REPORT' | null = null

  // Receiver Learned Test State (Requirement 4 & 6 - NO 888/999 Fallbacks)
  const incomingTestSessionId = ref<number | null>(null)
  const incomingTestTransferId = ref<number | null>(null)
  const incomingExpectedSha256 = ref<string | null>(null)

  // --- Live Runtime State (Survives SPA Navigation) ---
  const isTransmitting = ref(false)
  const isListening = ref(false)
  const liveSamples = ref<Float32Array | null>(null)
  const activePage = ref<'send' | 'receive' | 'idle'>('idle')

  // Stored File (Survives SPA Navigation)
  const storedData = ref<Uint8Array | null>(null)
  const sendFilename = ref<string | null>(null)
  const sendContentType = ref<string | null>(null)
  const sendTotalBytes = ref(0)
  const sendSha256 = ref<string | null>(null)
  const framesSent = ref(0)
  const framesGenerated = ref(0)
  const framesQueued = ref(0)
  const framesPlayed = ref(0)
  const bytesSent = ref(0)

  // Receiver Session State
  const receiveHeader = ref<SessionHeaderPayload | null>(null)
  const fountainK = ref(0)
  const decodedCount = ref(0)
  const totalBlocksReceived = ref(0)
  const downloadUrl = ref<string | null>(null)
  const downloadedFilename = ref<string | null>(null)
  const downloadedContentType = ref<string | null>(null)
  const expectedSha256 = ref<string | null>(null)
  const receivedSha256 = ref<string | null>(null)
  const isIntegrityVerified = ref(false)
  const pollSequence = ref(0)

  // Singletons & Audio Contexts
  let transmitter: AudioTransmitter | null = null
  let receiver: AudioReceiver | null = null
  let packetizer: AcousticPacketizer | null = null
  let decoderWorker: ReturnType<typeof createLTDecodeWorker> | null = null
  const metricsCollector = new MetricsCollector()
  const liveStats = ref(metricsCollector.getStats())
  let statsInterval: any = null
  let controlWindowTimer: ReturnType<typeof setTimeout> | null = null
  let wakeLock: any = null
  let controlRxDecoder: BFSKStreamDecoder | null = null
  let dataRxDecoder: BFSKStreamDecoder | null = null
  let negotiatedDataRxPhy: DataRxPhy | null = null
  const verifiedDataConfig = ref<DataPhyConfig | null>(null)
  const activeVerificationModulation = ref<'MFSK' | 'MULTITONE'>('MFSK')
  let rxSampleRateOverride: number | null = null

  // Modems: Dedicated ROBUST controlModem vs negotiated dataModem (Requirement 3 & 8)
  function getControlModem(sampleRate?: number): BFSKAcousticModem {
    const rate = sampleRate || transmitter?.getSampleRate() || receiver?.getSampleRate() || 48000
    const config = getProfileConfig(ModemProfileKey.ROBUST, rate)
    config.gain = effectiveTxGain.value
    return new BFSKAcousticModem(config)
  }

  function getDataTxPhy(sampleRate?: number) {
    const rate = sampleRate || transmitter?.getSampleRate() || receiver?.getSampleRate() || 48000
    return createDataTxPhy(selectedProfile.value, rate, verifiedDataConfig.value || undefined)
  }

  function currentProfileFingerprint(profile = selectedProfile.value, sampleRate = transmitter?.getSampleRate() || 48000, explicitConfig?: DataPhyConfig): string {
    if (profile === ModemProfileKey.FAST_DATA_EXPERIMENTAL) {
      const config = explicitConfig ? { ...explicitConfig, sampleRate } : getPilotMultitoneConfig(sampleRate)
      config.gain = effectiveTxGain.value
      return JSON.stringify({ protocolVersion: 1, modulation: (config as any).modulationId || 'GUARDED_MULTITONE_V1', profile, startFreq: config.startFreq, endFreq: config.endFreq, carrierCount: config.carrierCount, symbolDurationMs: config.symbolDurationMs, guardMs: config.guardMs, gain: config.gain, txSampleRate: sampleRate })
    }
    const config = getProfileConfig(profile === ModemProfileKey.AUTO ? ModemProfileKey.BALANCED : profile, sampleRate)
    config.gain = outputGain.value
    return JSON.stringify({ protocolVersion: 1, modulation: 'MFSK-FSK-v1', profile, startFreq: config.startFreq, endFreq: config.endFreq, carrierCount: config.carrierCount, symbolDurationMs: config.symbolDurationMs, guardMs: config.guardMs, gain: config.gain, txSampleRate: sampleRate })
  }

  function invalidateVerifiedProfile() {
    if (profileVerificationStatus.value === 'READY') profileVerificationStatus.value = 'UNVERIFIED'
    verifiedProfile.value = null
    verifiedConfigFingerprint.value = null
    verifiedDataConfig.value = null
    verifiedAt.value = null
  }

  watch([selectedProfile, outputGain], invalidateVerifiedProfile)

  function ensureRxDecoders() {
    const rate = receiver?.getSampleRate() || rxSampleRateOverride || 48000
    if (!controlRxDecoder || controlRxDecoder.getSampleRate() !== rate) {
      controlRxDecoder = new BFSKStreamDecoder(getControlModem(rate))
    }
    const profile = verifiedProfile.value || selectedProfile.value
    if (profile === ModemProfileKey.FAST_DATA_EXPERIMENTAL) {
      if (!negotiatedDataRxPhy) negotiatedDataRxPhy = createDataRxPhy(profile, rate, verifiedDataConfig.value || undefined)
    } else if (!dataRxDecoder || dataRxDecoder.getSampleRate() !== rate) {
      dataRxDecoder = createDataRxPhy(profile, rate, verifiedDataConfig.value || undefined) as BFSKStreamDecoder
      negotiatedDataRxPhy = dataRxDecoder
    }
  }

  async function requestWakeLock() {
    try {
      if ('wakeLock' in navigator && (navigator as any).wakeLock) {
        wakeLock = await (navigator as any).wakeLock.request('screen')
      }
    } catch {}
  }

  function releaseWakeLock() {
    if (wakeLock) {
      wakeLock.release().catch(() => {})
      wakeLock = null
    }
  }

  function generateSecureRandomUint32(): number {
    const arr = new Uint32Array(1)
    crypto.getRandomValues(arr)
    return arr[0]!
  }

  async function setFile(data: Uint8Array, filename: string, contentType: string) {
    storedData.value = data
    sendFilename.value = filename
    sendContentType.value = contentType
    sendTotalBytes.value = data.length
    sendSha256.value = await computeSha256Hex(data)

    if (sessionStep.value === SessionStep.READY_FOR_FILE || sessionStep.value === SessionStep.TEST_TRANSFER_VERIFIED) {
      sessionStep.value = SessionStep.FILE_SELECTED
    }
  }

  function skipVerification() {
    sessionStep.value = SessionStep.READY_FOR_FILE
  }

  // --- Central AudioReceiver Dispatcher (Requirement 3) ---
  function processCentralAudioData(samples: Float32Array) {
    liveSamples.value = samples
    ensureRxDecoders()

    // 1. Control channel decode (ROBUST modem)
    const controlFrames = controlRxDecoder!.pushSamples(samples)
    for (const frame of controlFrames) {
      handleIncomingPacket(encodeFrame(frame.sessionId, frame.frameType, frame.sequence, frame.payload))
    }

    // 2. Data channel decode (negotiated dataModem)
    if (receiveMode.value === ReceiveMode.NORMAL_RECEIVE || receiveMode.value === ReceiveMode.TEST_DATA_RECEIVE || receiveMode.value === ReceiveMode.PROFILE_PROBE_LISTEN) {
      const dataFrames = (receiveMode.value === ReceiveMode.PROFILE_PROBE_LISTEN && activeVerificationModulation.value === 'MULTITONE') || verifiedProfile.value === ModemProfileKey.FAST_DATA_EXPERIMENTAL
        ? negotiatedDataRxPhy!.pushSamples(samples)
        : dataRxDecoder!.pushSamples(samples)
      if (dataFrames.length > 0) {
        dspStage.value = 'CARRIER_LOCKED'
      }
      for (const frame of dataFrames) {
        handleIncomingPacket(encodeFrame(frame.sessionId, frame.frameType, frame.sequence, frame.payload))
      }
    }
  }

  function prepareArtifactDecoding(sampleRate = 48000) {
    if (!packetizer) packetizer = new AcousticPacketizer()
    if (!decoderWorker) decoderWorker = createLTDecodeWorker()
    controlRxDecoder = null
    dataRxDecoder = null
    negotiatedDataRxPhy = null
    rxSampleRateOverride = sampleRate
    receiveMode.value = ReceiveMode.NORMAL_RECEIVE
    dspStage.value = 'SEARCHING_FOR_SIGNAL'
  }

  // --- Real Half-Duplex Acoustic Link Probe & ACK Verification (Requirement 4 & 5) ---
  async function runAcousticLinkCheck(context?: AdaptiveLinkContext) {
    if (isTransmitting.value) return
    sessionStep.value = SessionStep.VERIFYING_LINK
    linkCheckMessage.value = 'Transmitting LINK_PROBE...'

    // Requirement 4 & 5: One canonical Session ID and nonce generated via crypto.getRandomValues()
    transferSessionId.value = context?.controlSessionId || generateSecureRandomUint32()
    controlSessionId.value = transferSessionId.value
    sessionLifecycle.beginControl(controlSessionId.value)
    activeProbeNonce.value = context?.calibrationNonce || generateSecureRandomUint32()
    packetizer = new AcousticPacketizer(transferSessionId.value)

    const probeFrame = AcousticLinkTester.createProbeFrame(transferSessionId.value, activeProbeNonce.value)

    if (!transmitter) transmitter = new AudioTransmitter()
    await transmitter.start()

    const controlModem = getControlModem(transmitter.getSampleRate())
    const audioFrame = controlModem.encode(probeFrame)

    // Step 1: Play frame and WAIT for real audio queue drain (Requirement 1 & 4)
    isTransmitting.value = true
    await transmitter.playFrame(audioFrame)
    await transmitter.waitUntilDrained()

    // Step 2: Half-duplex turnaround - stop TX before starting RX
    transmitter.stop()
    isTransmitting.value = false
    linkCheckMessage.value = 'LINK_PROBE finished playback. Half-duplex turnaround: Listening for LINK_ACK...'

    // Step 3: Switch central receiver mode to LINK_ACK_WAIT
    receiveMode.value = ReceiveMode.LINK_ACK_WAIT
    if (!receiver) {
      receiver = new AudioReceiver({ onAudioData: processCentralAudioData })
    } else {
      receiver.setOnAudioDataCallback(processCentralAudioData)
    }
    await receiver.start(selectedMicId.value || undefined)
    rxSampleRateOverride = null

    // Timeout handler for LINK_ACK window
    setTimeout(() => {
      if (sessionStep.value === SessionStep.VERIFYING_LINK) {
        sessionStep.value = SessionStep.NOT_READY
        linkCheckMessage.value = 'Link Verification Failed: ACK Timeout. Ensure receiver is listening.'
        if (receiver) receiver.stop()
        receiveMode.value = ReceiveMode.IDLE
        transferSessionId.value = null
        activeProbeNonce.value = null
      }
    }, 10000)
  }

  function startAdaptiveLink() {
    adaptiveLinkContext.value = { controlSessionId: generateSecureRandomUint32(), calibrationNonce: generateSecureRandomUint32(), role: 'INITIATOR', startedAt: Date.now() }
    adaptiveCandidateGain.value = 0.12
    const controller = new AdaptiveHandshakeController({
      runtime: adaptiveHandshake,
      transport: {
        sendRobust: async (frame, gain) => {
          adaptiveCandidateGain.value = gain
          await transmitControlVerificationFrame(frame)
        },
        waitForLevelReport: async () => null,
      },
      setCandidateGain: gain => { adaptiveCandidateGain.value = gain },
      eventSink: event => { linkCheckMessage.value = event.message },
    })
    controller.start(adaptiveLinkContext.value)
    adaptiveHandshakeState.value = adaptiveHandshake.state
    adaptiveHandshakeEvents.value = [...adaptiveHandshake.events]
    linkCheckMessage.value = 'Adaptive link: starting robust control bootstrap. Application acoustic gain is negotiated; system volume remains user-controlled.'
    void runAcousticLinkCheck(adaptiveLinkContext.value)
  }

  // --- Real Finite DATA Bursts + ACK Control Windows (Requirement 1, 4, 5, 6) ---
  async function runTestFileTransfer() {
    sessionStep.value = SessionStep.TEST_TRANSFERRING
    transferPhase.value = TransferPhase.DATA_TX

    // Generate test session ID and testTransferId via crypto.getRandomValues()
    transferSessionId.value = generateSecureRandomUint32()
    activeTransferSessionId.value = transferSessionId.value
    sessionLifecycle.beginTransfer(activeTransferSessionId.value)
    transferCompletionCache.activateNewSession(activeTransferSessionId.value)
    activeTestTransferId.value = generateSecureRandomUint32()
    packetizer = new AcousticPacketizer(transferSessionId.value)

    const testPayload = generateTestPayload()
    sendSha256.value = EXPECTED_TEST_SHA256
    sendFilename.value = 'sonic-test-fixture.bin'

    if (!transmitter) transmitter = new AudioTransmitter()
    await transmitter.start()

    const controlModem = getControlModem(transmitter.getSampleRate())
    const dataModem = getDataTxPhy(transmitter.getSampleRate())

    // Step 1: Transmit TEST_FILE_START over ROBUST control channel (Requirement 1 & 4)
    const startPayloadBytes = encodeTestFileStart({
      protocolVersion: 1,
      sessionId: transferSessionId.value,
      testTransferId: activeTestTransferId.value,
      payloadSize: testPayload.length,
      expectedSha256: EXPECTED_TEST_SHA256,
    })
    const startFrame = encodeFrame(transferSessionId.value, AcousticFrameType.TEST_FILE_START, 1, startPayloadBytes)
    const startAudioFrame = controlModem.encode(startFrame)
    await transmitter.playFrame(startAudioFrame)
    await transmitter.waitUntilDrained()

    // Centralized half-duplex guard before starting test DATA bursts.
    await new Promise(r => setTimeout(r, HALF_DUPLEX_TIMING.TX_TO_RX_GUARD_MS))

    const { createEncoder } = await import('luby-transform')
    const canonicalPayload = appendFileHeaderMetaToBuffer(testPayload, {
      filename: sendFilename.value,
      contentType: 'application/octet-stream',
    })
    const encoder = createEncoder(canonicalPayload, sliceSize.value, true)
    const fountain = encoder.fountain()

    let sequence = 2
    isTransmitting.value = true
    activePage.value = 'send'
    await requestWakeLock()

    // Finite Fountain DATA burst loop (10 frames per burst)
    const runBurst = async () => {
      if (!isTransmitting.value || sessionStep.value !== SessionStep.TEST_TRANSFERRING) return

      transferPhase.value = TransferPhase.DATA_TX
      const framePromises: Promise<void>[] = []

      for (let i = 0; i < 10; i++) {
        let frameBuffer: Uint8Array
        if (sequence % 10 === 0) {
          frameBuffer = packetizer!.createSessionHeaderFrame({
            protocolVersion: 1,
            sessionId: transferSessionId.value!,
            filename: sendFilename.value!,
            contentType: 'application/octet-stream',
            originalSize: testPayload.length,
            encodedSize: encoder.compressed.length,
            fileChecksum: encoder.checksum,
            sha256Hex: sendSha256.value!,
            totalFountainK: encoder.k,
            modemProfile: selectedProfile.value,
          })
        } else {
          const block = fountain.next().value
          const blockBytes = blockToBinary(block)
          frameBuffer = encodeFrame(transferSessionId.value!, AcousticFrameType.DATA, sequence, blockBytes)
        }

        const audioFrame = encodeWithDataTxPhy(dataModem, frameBuffer)
        framePromises.push(transmitter!.playFrame(audioFrame))
        sequence++
      }

      // Requirement 3: Track every frame promise and wait for queue drain!
      transferPhase.value = TransferPhase.TX_DRAIN
      await Promise.all(framePromises)
      await transmitter!.waitUntilDrained()

      // Half-duplex turnaround to RX
      transferPhase.value = TransferPhase.TURNAROUND_TO_RX
      transmitter!.stop()

      // Production feedback handshake: POLL -> STATUS/END.
      pollSequence.value++
      const pollFrame = encodeFrame(transferSessionId.value!, AcousticFrameType.TRANSFER_POLL, pollSequence.value, encodeTransferPoll({ protocolVersion: 1, transferSessionId: transferSessionId.value!, pollSequence: pollSequence.value, framesPlayed: framesPlayed.value, lastDataSequence: sequence - 1 }))
      await transmitter!.start()
      await transmitter!.playFrame(controlModem.encode(pollFrame))
      await transmitter!.waitUntilDrained()
      transmitter!.stop()
      await new Promise(resolve => setTimeout(resolve, HALF_DUPLEX_TIMING.TX_TO_RX_GUARD_MS))
      receiveMode.value = ReceiveMode.CONTROL_RX_WINDOW
      if (!receiver) {
        receiver = new AudioReceiver({ onAudioData: processCentralAudioData })
      } else {
        receiver.setOnAudioDataCallback(processCentralAudioData)
      }
      await receiver.start(selectedMicId.value || undefined)

      transferPhase.value = TransferPhase.ACK_WINDOW

      // ACK Window timeout: Resume next DATA burst if not complete
      controlWindowTimer = setTimeout(async () => {
        controlWindowTimer = null
        if (sessionStep.value === SessionStep.TEST_TRANSFERRING && isTransmitting.value) {
          if (receiver) receiver.stop()
          receiveMode.value = ReceiveMode.IDLE
          transferPhase.value = TransferPhase.TURNAROUND_TO_TX
          await transmitter!.start()
          runBurst()
        }
      }, HALF_DUPLEX_TIMING.CONTROL_WINDOW_MS)
    }

    runBurst()
  }

  async function transmitControlVerificationFrame(frame: Uint8Array) {
    if (!transmitter) transmitter = new AudioTransmitter()
    await transmitter.start()
    const modem = getControlModem(transmitter.getSampleRate())
    await transmitter.playFrame(modem.encode(frame))
    await transmitter.waitUntilDrained()
    transmitter.stop()
  }

  async function transmitTransferFeedback(frame: Uint8Array) {
    if (!transmitter) transmitter = new AudioTransmitter()
    if (receiver) receiver.stop()
    receiveMode.value = ReceiveMode.IDLE
    await transmitter.start()
    const modem = getControlModem(transmitter.getSampleRate())
    await transmitter.playFrame(modem.encode(frame))
    await transmitter.waitUntilDrained()
    transmitter.stop()
    if (isListening.value && receiver) await receiver.start(selectedMicId.value || undefined)
  }

  async function transmitProfileProbes(proposal: any) {
    if (!transmitter) transmitter = new AudioTransmitter()
    await transmitter.start()
    const modem = createDataTxPhy(proposal.profile, transmitter.getSampleRate(), proposal.config)
    for (let sequence = 1; sequence <= proposal.probeCount; sequence++) {
      const probe = { protocolVersion: 1, sessionId: proposal.sessionId, verificationNonce: proposal.verificationNonce, profile: proposal.profile, probeSequence: sequence, totalProbes: proposal.probeCount }
      await transmitter.playFrame(modem.encode(createProfileProbeFrame(probe, proposal.sessionId, sequence)))
    }
    await transmitter.waitUntilDrained()
    transmitter.stop()
    await new Promise(resolve => setTimeout(resolve, HALF_DUPLEX_TIMING.PROFILE_RESPONSE_DELAY_MS))
    await transmitControlVerificationFrame(encodeFrame(proposal.sessionId, AcousticFrameType.PROFILE_PROBE_END, proposal.probeCount + 1, encodeProfileProbeEnd({ protocolVersion: 1, sessionId: proposal.sessionId, verificationNonce: proposal.verificationNonce, profile: proposal.profile, attemptedProbes: proposal.probeCount })))
  }

  async function verifyDataProfile(profile = selectedProfile.value, probeCount = 30, explicitConfig?: DataPhyConfig): Promise<boolean> {
    if (profile === ModemProfileKey.AUTO || profile === ModemProfileKey.NEAR_ULTRASONIC || profile === ModemProfileKey.ULTRASONIC_EXPERIMENTAL || transferSessionId.value === null) {
      profileVerificationStatus.value = 'FAILED'
      return false
    }
    const sampleRate = transmitter?.getSampleRate() || receiver?.getSampleRate() || 48000
    const verificationNonce = generateSecureRandomUint32()
    profileVerificationNonce.value = verificationNonce
    verifiedProfile.value = profile
    verifiedConfigFingerprint.value = currentProfileFingerprint(profile, sampleRate, explicitConfig)
    profileVerificationStatus.value = 'UNVERIFIED'
    receivedProbeSequences.clear()
    profileVerificationReport.value = null
    const config = explicitConfig ? { ...explicitConfig, sampleRate } : profile === ModemProfileKey.FAST_DATA_EXPERIMENTAL ? getPilotMultitoneConfig(sampleRate) : getProfileConfig(profile, sampleRate)
    const proposal = { protocolVersion: 1, sessionId: transferSessionId.value, verificationNonce, profile, sampleRate, config, probeCount, configFingerprint: currentProfileFingerprint(profile, sampleRate, config) }
    proposal.config.gain = outputGain.value
    verifiedDataConfig.value = { ...proposal.config }
    await transmitControlVerificationFrame(encodeFrame(transferSessionId.value, AcousticFrameType.PROFILE_PROPOSE, 1, encodeProfileProposal(proposal)))
    receiveMode.value = ReceiveMode.PROFILE_REPORT_WAIT
    if (!receiver) receiver = new AudioReceiver({ onAudioData: processCentralAudioData })
    else receiver.setOnAudioDataCallback(processCentralAudioData)
    verificationSessionId.value = transferSessionId.value
    sessionLifecycle.bindVerification(verificationSessionId.value)
    const result = new Promise<boolean>((resolve) => { profileVerificationResolver = resolve })
    await receiver.start(selectedMicId.value || undefined)
    profileVerificationPhase = 'ACCEPT'
    profileVerificationTimer = setTimeout(() => finishProfileVerification(false, 'PROFILE_ACCEPT_TIMEOUT'), 8000)
    return result
  }

  function finishProfileVerification(ready: boolean, reason?: string) {
    if (profileVerificationTimer) clearTimeout(profileVerificationTimer)
    profileVerificationTimer = null
    profileVerificationPhase = null
    if (!ready) {
      profileVerificationStatus.value = 'FAILED'
      verifiedProfile.value = null
      verifiedConfigFingerprint.value = null
      verifiedDataConfig.value = null
      if (reason) linkCheckMessage.value = `DATA profile verification failed: ${reason}`
      if (receiver) receiver.stop()
      receiveMode.value = ReceiveMode.IDLE
    }
    const resolver = profileVerificationResolver
    profileVerificationResolver = null
    resolver?.(ready)
  }

  async function verifyAutoProfile(probeCount = 30): Promise<ModemProfileKey | null> {
    for (const candidate of [ModemProfileKey.TURBO, ModemProfileKey.BALANCED, ModemProfileKey.ROBUST]) {
      if (await verifyDataProfile(candidate, probeCount)) {
        selectedProfile.value = candidate
        return candidate
      }
    }
    return null
  }

  // --- Sender Transmission ---
  async function startTransmission(data?: Uint8Array, filename?: string, contentType?: string) {
    if (isTransmitting.value) return
    if (profileVerificationStatus.value !== 'READY' || verifiedProfile.value !== selectedProfile.value || verifiedConfigFingerprint.value !== currentProfileFingerprint(selectedProfile.value, transmitter?.getSampleRate() || 48000)) {
      linkCheckMessage.value = `${selectedProfile.value} DATA profile is not READY; run production profile verification first.`
      return
    }

    const rawData = data || storedData.value
    if (!rawData) return

    sendFilename.value = filename || sendFilename.value || 'file.bin'
    sendContentType.value = contentType || sendContentType.value || 'application/octet-stream'
    sendTotalBytes.value = rawData.length

    // Requirement 8: Compute SHA-256 over ORIGINAL FILE BYTES!
    sendSha256.value = await computeSha256Hex(rawData)
    framesSent.value = 0
    framesGenerated.value = 0
    framesQueued.value = 0
    framesPlayed.value = 0
    bytesSent.value = 0

    // Requirement 4: Canonical session ID per transfer
    transferSessionId.value = generateSecureRandomUint32()
    activeTransferSessionId.value = transferSessionId.value
    sessionLifecycle.beginTransfer(activeTransferSessionId.value)
    transferCompletionCache.activateNewSession(activeTransferSessionId.value)
    packetizer = new AcousticPacketizer(transferSessionId.value)

    // Requirement 8: Prepare canonical transfer payload = appendFileHeaderMetaToBuffer(rawData, meta)
    const canonicalPayload = appendFileHeaderMetaToBuffer(rawData, {
      filename: sendFilename.value,
      contentType: sendContentType.value,
    })

    if (!transmitter) transmitter = new AudioTransmitter()
    await transmitter.start()
    const txPhy = getDataTxPhy(transmitter.getSampleRate())

    const { createEncoder } = await import('luby-transform')
    const encoder = createEncoder(canonicalPayload, sliceSize.value, true)
    const fountain = encoder.fountain()

    let sequence = 0
    isTransmitting.value = true
    activePage.value = 'send'
    await requestWakeLock()

    const runBurst = async () => {
      for (let burst = 0; burst < 8 && isTransmitting.value; burst++) {
        let frameBuffer: Uint8Array
        if (sequence % 10 === 0) {
        frameBuffer = packetizer!.createSessionHeaderFrame({
          protocolVersion: 1,
          sessionId: transferSessionId.value!,
          filename: sendFilename.value || 'file.bin',
          contentType: sendContentType.value || 'application/octet-stream',
          originalSize: rawData.length,
          encodedSize: encoder.compressed.length,
          fileChecksum: encoder.checksum,
          sha256Hex: sendSha256.value || undefined,
          totalFountainK: encoder.k,
          modemProfile: selectedProfile.value,
        })
        } else {
          const block = fountain.next().value
          const blockBytes = blockToBinary(block)
          frameBuffer = encodeFrame(transferSessionId.value!, AcousticFrameType.DATA, sequence, blockBytes)
        }
        const audioFrame = encodeWithDataTxPhy(txPhy, frameBuffer)
        liveSamples.value = audioFrame.samples
        framesGenerated.value++
        framesQueued.value++
        bytesSent.value += frameBuffer.length
        sequence++
        await transmitter!.playFrame(audioFrame)
        framesPlayed.value++
        framesSent.value = framesPlayed.value
      }
      if (isTransmitting.value) {
        await transmitter!.waitUntilDrained()
        pollSequence.value++
        const pollFrame = encodeFrame(transferSessionId.value!, AcousticFrameType.TRANSFER_POLL, pollSequence.value, encodeTransferPoll({ protocolVersion: 1, transferSessionId: transferSessionId.value!, pollSequence: pollSequence.value, framesPlayed: framesPlayed.value, lastDataSequence: sequence - 1 }))
        const controlModem = getControlModem(transmitter!.getSampleRate())
        await transmitter!.playFrame(controlModem.encode(pollFrame))
        await transmitter!.waitUntilDrained()
        transferPhase.value = TransferPhase.TURNAROUND_TO_RX
        transmitter!.stop()
        await new Promise(resolve => setTimeout(resolve, HALF_DUPLEX_TIMING.TX_TO_RX_GUARD_MS))
        receiveMode.value = ReceiveMode.CONTROL_RX_WINDOW
        if (!receiver) receiver = new AudioReceiver({ onAudioData: processCentralAudioData })
        else receiver.setOnAudioDataCallback(processCentralAudioData)
        await receiver.start(selectedMicId.value || undefined)
        transferPhase.value = TransferPhase.ACK_WINDOW
        controlWindowTimer = setTimeout(async () => {
          controlWindowTimer = null
          if (!isTransmitting.value || receiveMode.value !== ReceiveMode.CONTROL_RX_WINDOW) return
          receiver?.stop()
          await new Promise(resolve => setTimeout(resolve, HALF_DUPLEX_TIMING.RX_TO_TX_GUARD_MS))
          transferPhase.value = TransferPhase.TURNAROUND_TO_TX
          await transmitter!.start()
          void runBurst()
        }, HALF_DUPLEX_TIMING.CONTROL_WINDOW_MS)
      }
    }

    void runBurst()
  }

  function stopTransmission() {
    isTransmitting.value = false
    if (controlWindowTimer) {
      clearTimeout(controlWindowTimer)
      controlWindowTimer = null
    }
    if (transmitter) transmitter.stop()
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
    expectedSha256.value = null
    receivedSha256.value = null
    isIntegrityVerified.value = false
    receiveHeader.value = null
    fountainK.value = 0
    decodedCount.value = 0
    totalBlocksReceived.value = 0
    dspStage.value = 'SEARCHING_FOR_SIGNAL'
    receiveMode.value = ReceiveMode.NORMAL_RECEIVE
    metricsCollector.start()

    if (!receiver) {
      receiver = new AudioReceiver({ onAudioData: processCentralAudioData })
    } else {
      receiver.setOnAudioDataCallback(processCentralAudioData)
    }

    await receiver.start(selectedMicId.value || undefined)
    controlRxDecoder = null
    dataRxDecoder = null
    negotiatedDataRxPhy = null
    ensureRxDecoders()
    isListening.value = true
    activePage.value = 'receive'
    await requestWakeLock()

    statsInterval = setInterval(() => {
      liveStats.value = metricsCollector.getStats()
    }, 250)
  }

  async function handleIncomingPacket(packetBuffer: Uint8Array) {
    if (!packetizer) return

    const parsed = packetizer.parseIncomingBuffer(packetBuffer)
    if (!parsed.frame) {
      metricsCollector.recordPacket(0, false)
      return
    }

    const frameType = parsed.frame.frameType
    const verificationFrame = frameType === AcousticFrameType.PROFILE_PROPOSE || frameType === AcousticFrameType.PROFILE_ACCEPT || frameType === AcousticFrameType.PROFILE_REJECT || frameType === AcousticFrameType.PROFILE_PROBE_END || frameType === AcousticFrameType.CHANNEL_REPORT || frameType === AcousticFrameType.LINK_PROBE || frameType === AcousticFrameType.LINK_ACK
    const transferFrame = frameType === AcousticFrameType.SESSION_HEADER || frameType === AcousticFrameType.DATA || frameType === AcousticFrameType.END || frameType === AcousticFrameType.TEST_FILE_START || frameType === AcousticFrameType.TEST_FILE_COMPLETE
    if (!sessionLifecycle.acceptFrame(parsed.frame.sessionId, frameType)) return
    if (transferFrame && frameType !== AcousticFrameType.SESSION_HEADER && activeTransferSessionId.value !== null && parsed.frame.sessionId !== activeTransferSessionId.value) {
      console.warn('Rejected foreign transfer frame', parsed.frame.sessionId)
      return
    }
    if (transferFrame && frameType !== AcousticFrameType.SESSION_HEADER && activeTransferSessionId.value === null && frameType !== AcousticFrameType.TEST_FILE_START) return

    dspStage.value = 'CRC_VALID'
    metricsCollector.recordPacket(parsed.frame.payload.length, true)

    const profileProbe = parsed.frame.frameType === AcousticFrameType.LINK_PROBE ? decodeProfileProbe(parsed.frame.payload) : null
    if (profileProbe && receiveMode.value === ReceiveMode.PROFILE_PROBE_LISTEN && profileVerificationNonce.value === profileProbe.verificationNonce && profileProbe.sessionId === verificationSessionId.value && profileProbe.profile === verifiedProfile.value) {
      if (!receivedProbeSequences.has(profileProbe.probeSequence)) receivedProbeSequences.add(profileProbe.probeSequence)
      profileProbeValid.value = receivedProbeSequences.size
      return
    }

    if (parsed.frame.frameType === AcousticFrameType.PROFILE_PROBE_END) {
      const end = decodeProfileProbeEnd(parsed.frame.payload)
      if (end && end.sessionId === verificationSessionId.value && end.verificationNonce === profileVerificationNonce.value && end.profile === verifiedProfile.value) {
        const stats = activeVerificationModulation.value === 'MULTITONE' ? null : dataRxDecoder?.getStats()
        const valid = Math.min(end.attemptedProbes, receivedProbeSequences.size)
        const report = {
          protocolVersion: 1,
          sessionId: end.sessionId,
          verificationNonce: end.verificationNonce,
          profile: end.profile,
          attemptedProbes: end.attemptedProbes,
          framesDetected: stats?.framesDetected || valid,
          crcValid: valid,
          crcInvalid: Math.max(0, end.attemptedProbes - valid),
          per: 1 - valid / end.attemptedProbes,
          classification: classifyProfileReport(valid, end.attemptedProbes),
          sampleRate: dataRxDecoder?.getSampleRate() || 48000,
          configFingerprint: verifiedConfigFingerprint.value || '',
        }
        if (receiver) receiver.stop()
        await transmitControlVerificationFrame(createChannelReportFrame(report, end.sessionId))
        profileVerificationReport.value = report
        profileVerificationStatus.value = report.classification
        profileVerificationResolver?.(report.classification === 'READY')
        profileVerificationResolver = null
        receiveMode.value = ReceiveMode.IDLE
      }
      return
    }

    if (parsed.frame.frameType === AcousticFrameType.PROFILE_PROPOSE) {
      const proposal = decodeProfileProposal(parsed.frame.payload)
      const actualRate = receiver?.getSampleRate() || rxSampleRateOverride || 48000
      if (proposal && validateProfileProposal(proposal, actualRate)) {
        verificationSessionId.value = proposal.sessionId
        profileVerificationNonce.value = proposal.verificationNonce
        profileProbeValid.value = 0
        receivedProbeSequences.clear()
        verifiedProfile.value = proposal.profile as ModemProfileKey
        verifiedConfigFingerprint.value = proposal.configFingerprint
        activeVerificationModulation.value = proposal.profile === ModemProfileKey.FAST_DATA_EXPERIMENTAL ? 'MULTITONE' : 'MFSK'
        if (receiver) receiver.stop()
        await transmitControlVerificationFrame(encodeFrame(proposal.sessionId, AcousticFrameType.PROFILE_ACCEPT, 1, encodeProfileAccept(proposal)))
        verifiedDataConfig.value = { ...proposal.config }
        if (activeVerificationModulation.value === 'MULTITONE') {
          negotiatedDataRxPhy = createDataRxPhy(proposal.profile, actualRate, proposal.config)
        } else {
          dataRxDecoder = createDataRxPhy(proposal.profile, actualRate, proposal.config) as BFSKStreamDecoder
          negotiatedDataRxPhy = dataRxDecoder
        }
        receiveMode.value = ReceiveMode.PROFILE_PROBE_LISTEN
        if (isListening.value && receiver) await receiver.start(selectedMicId.value || undefined)
      } else if (proposal) {
        const reason = proposal.config?.endFreq >= (actualRate / 2 - 1500) ? 'NYQUIST_INCOMPATIBLE' : 'INVALID_CONFIG'
        if (receiver) receiver.stop()
        await transmitControlVerificationFrame(encodeFrame(proposal.sessionId, AcousticFrameType.PROFILE_REJECT, 1, encodeProfileReject({ protocolVersion: 1, sessionId: proposal.sessionId, verificationNonce: proposal.verificationNonce, profile: proposal.profile, reason })))
        if (isListening.value && receiver) await receiver.start(selectedMicId.value || undefined)
      }
      return
    }

    if (parsed.frame.frameType === AcousticFrameType.PROFILE_ACCEPT) {
      const proposal = decodeProfileAccept(parsed.frame.payload)
      if (proposal && proposal.verificationNonce === profileVerificationNonce.value && proposal.sessionId === verificationSessionId.value) {
        if (profileVerificationTimer) clearTimeout(profileVerificationTimer)
        profileVerificationTimer = null
        profileVerificationPhase = null
        if (receiver) receiver.stop()
        await transmitProfileProbes(proposal)
        receiveMode.value = ReceiveMode.PROFILE_REPORT_WAIT
        if (receiver) await receiver.start(selectedMicId.value || undefined)
        profileVerificationPhase = 'REPORT'
        profileVerificationTimer = setTimeout(() => finishProfileVerification(false, 'CHANNEL_REPORT_TIMEOUT'), 10000)
      }
      return
    }

    if (parsed.frame.frameType === AcousticFrameType.PROFILE_REJECT) {
      const rejection = decodeProfileReject(parsed.frame.payload)
      if (rejection && rejection.sessionId === verificationSessionId.value && rejection.verificationNonce === profileVerificationNonce.value && rejection.profile === verifiedProfile.value) finishProfileVerification(false, rejection.reason)
      return
    }

    if (parsed.frame.frameType === AcousticFrameType.CHANNEL_REPORT) {
      const report = decodeChannelReport(parsed.frame.payload)
      const expectedClass = report ? classifyProfileReport(report.crcValid, report.attemptedProbes) : null
      if (report && report.verificationNonce === profileVerificationNonce.value && report.sessionId === verificationSessionId.value && report.profile === verifiedProfile.value && report.configFingerprint === verifiedConfigFingerprint.value && report.classification === expectedClass && report.crcValid + report.crcInvalid === report.attemptedProbes) {
        profileVerificationReport.value = report
        profileVerificationStatus.value = report.classification
        verifiedConfigFingerprint.value = currentProfileFingerprint(report.profile as ModemProfileKey, transmitter?.getSampleRate() || 48000)
        verifiedAt.value = Date.now()
        linkCheckMessage.value = `${report.profile} DATA verification: ${report.classification} (${report.crcValid}/${report.attemptedProbes} CRC-valid probes)`
        if (receiver) receiver.stop()
        receiveMode.value = ReceiveMode.IDLE
        finishProfileVerification(report.classification === 'READY')
      }
      return
    }

    // Handle TEST_FILE_START: Device B learns incoming test session details! (Requirement 1 & 4)
    if (parsed.frame.frameType === AcousticFrameType.TEST_FILE_START) {
      const startPayload = decodeTestFileStart(parsed.frame.payload)
      if (
        startPayload &&
        startPayload.protocolVersion === 1 &&
        startPayload.payloadSize === 8192 &&
        startPayload.expectedSha256 === EXPECTED_TEST_SHA256 &&
        parsed.frame.sessionId === startPayload.sessionId
      ) {
        incomingTestSessionId.value = startPayload.sessionId
        incomingTestTransferId.value = startPayload.testTransferId
        incomingExpectedSha256.value = startPayload.expectedSha256
        transferSessionId.value = startPayload.sessionId
        receiveMode.value = ReceiveMode.TEST_DATA_RECEIVE
      }
    }

    // Requirement 4 & 5: Handle LINK_PROBE and send LINK_ACK with half-duplex turnaround
    if (parsed.frame.frameType === AcousticFrameType.LINK_PROBE) {
      const probePayload = AcousticLinkTester.parseProbePayload(parsed.frame.payload)
      if (probePayload) {
        controlSessionId.value = probePayload.sessionId
        sessionLifecycle.beginControl(probePayload.sessionId)
        if (receiver) receiver.stop()

        setTimeout(async () => {
          const ackFrame = AcousticLinkTester.createAckFrame(probePayload.sessionId, probePayload.nonce, liveStats.value.snrDb)
          if (!transmitter) transmitter = new AudioTransmitter()
          await transmitter.start()

          const controlModem = getControlModem(transmitter.getSampleRate())
          const audioFrame = controlModem.encode(ackFrame)
          await transmitter.playFrame(audioFrame)
          await transmitter.waitUntilDrained()
          transmitter.stop()

          if (isListening.value && receiver) {
            await receiver.start(selectedMicId.value || undefined)
          }
        }, HALF_DUPLEX_TIMING.RX_TO_TX_GUARD_MS)
      }
    }

    // Requirement 5: Handle LINK_ACK validation on Sender
    if (parsed.frame.frameType === AcousticFrameType.LINK_ACK) {
      const ack = AcousticLinkTester.parseAckPayload(parsed.frame.payload)
      if (
        ack &&
        transferSessionId.value !== null &&
        activeProbeNonce.value !== null &&
        ack.sessionId === controlSessionId.value &&
        ack.nonce === activeProbeNonce.value
      ) {
        if (adaptiveHandshake.state === 'BOOTSTRAP_CONTROL_LINK') {
          adaptiveHandshake.recordControlLink(true)
          adaptiveHandshakeState.value = adaptiveHandshake.state
          adaptiveHandshakeEvents.value = [...adaptiveHandshake.events]
        }
        sessionStep.value = SessionStep.LINK_VERIFIED
        linkCheckMessage.value = `LINK VERIFIED! Real acoustic ACK received (Session: ${ack.sessionId}, Nonce: ${ack.nonce}).`
        if (receiver) receiver.stop()
        receiveMode.value = ReceiveMode.IDLE
        activeProbeNonce.value = null
      }
    }

    // TEST_FILE_COMPLETE is retained as a legacy wire type for compatibility,
    // but it can never unlock a transfer. Completion is only TRANSFER_END.

    // END is a DATA-side marker only. Successful completion requires a valid,
    // session-bound TRANSFER_END with matching expected and actual SHA-256.

    if (parsed.frame.frameType === AcousticFrameType.TRANSFER_POLL) {
      const poll = decodeTransferPoll(parsed.frame.payload)
      if (!poll || parsed.frame.sessionId !== activeTransferSessionId.value || poll.transferSessionId !== activeTransferSessionId.value) return
      const cachedCompletion = transferCompletionCache.forPoll(parsed.frame.sessionId, poll.transferSessionId)
      const response = cachedCompletion
        ? encodeFrame(activeTransferSessionId.value, AcousticFrameType.TRANSFER_END, poll.pollSequence, encodeTransferEnd({ protocolVersion: 1, transferSessionId: activeTransferSessionId.value, expectedSha256: cachedCompletion.expectedSha256, actualSha256: cachedCompletion.actualSha256, pass: true, blocksReceived: cachedCompletion.blocksReceived }))
        : encodeFrame(activeTransferSessionId.value, AcousticFrameType.TRANSFER_STATUS, poll.pollSequence, encodeTransferStatus({ protocolVersion: 1, transferSessionId: activeTransferSessionId.value, blocksReceived: totalBlocksReceived.value, decodedCount: decodedCount.value, complete: false }))
      void new Promise(resolve => setTimeout(resolve, HALF_DUPLEX_TIMING.POLL_RESPONSE_DELAY_MS)).then(() => transmitTransferFeedback(response))
      return
    }

    if (parsed.frame.frameType === AcousticFrameType.TRANSFER_END) {
      const completion = decodeTransferEnd(parsed.frame.payload)
      if (completion && completion.transferSessionId === activeTransferSessionId.value && completion.expectedSha256 === sendSha256.value && completion.actualSha256 === sendSha256.value && completion.pass) {
        if (controlWindowTimer) {
          clearTimeout(controlWindowTimer)
          controlWindowTimer = null
        }
        stopTransmission()
        if (receiver) receiver.stop()
        receiveMode.value = ReceiveMode.IDLE
        transferPhase.value = TransferPhase.COMPLETE
        sessionStep.value = sendFilename.value === 'sonic-test-fixture.bin' && sendSha256.value === EXPECTED_TEST_SHA256
          ? SessionStep.TEST_TRANSFER_VERIFIED
          : SessionStep.COMPLETE
        activeTransferSessionId.value = null
        sessionLifecycle.activeTransferSessionId = null
      }
      return
    }
    if (parsed.frame.frameType === AcousticFrameType.TRANSFER_STATUS) {
      const status = decodeTransferStatus(parsed.frame.payload)
      if (status && status.transferSessionId === activeTransferSessionId.value && status.complete) return
    }

    if (parsed.sessionHeader) {
      transferCompletionCache.activateNewSession(parsed.sessionHeader.sessionId)
      receiveHeader.value = parsed.sessionHeader
      transferSessionId.value = parsed.sessionHeader.sessionId
      activeTransferSessionId.value = parsed.sessionHeader.sessionId
      sessionLifecycle.acquireSessionHeader(parsed.sessionHeader.sessionId)
      fountainK.value = parsed.sessionHeader.totalFountainK
      expectedSha256.value = parsed.sessionHeader.sha256Hex || null
      dspStage.value = 'FRAME_RECEIVING'
      if (decoderWorker) {
        await decoderWorker.createDecoder()
      }
    } else if (parsed.frame.frameType === AcousticFrameType.DATA) {
      try {
        const { binaryToBlock } = await import('luby-transform')
        const block = binaryToBlock(parsed.frame.payload)
        totalBlocksReceived.value++
        dspStage.value = 'FOUNTAIN_BLOCK_ACCEPTED'

        if (!decoderWorker) decoderWorker = createLTDecodeWorker()
        const success = await decoderWorker.addBlock(block)
        const status = await decoderWorker.getStatus()
        decodedCount.value = status.decodedCount

        if (success && !downloadUrl.value) {
          dspStage.value = 'RECONSTRUCTING'
          const decodedMerged = (await decoderWorker.getDecoded())!
          const [originalBytes, meta] = readFileHeaderMetaFromBuffer(decodedMerged)

          // Requirement 8: Compute SHA-256 over ORIGINAL FILE BYTES!
          const actualHash = await computeSha256Hex(originalBytes)
          receivedSha256.value = actualHash

          // Requirement 8: Missing expected SHA-256 results in INTEGRITY UNVERIFIED!
          if (expectedSha256.value) {
            isIntegrityVerified.value = (actualHash === expectedSha256.value)
          } else {
            isIntegrityVerified.value = false
          }

          if (isIntegrityVerified.value) {
            const blob = new Blob([originalBytes], { type: meta.contentType })
            downloadUrl.value = URL.createObjectURL(blob)
            downloadedFilename.value = meta.filename || 'received-file'
            downloadedContentType.value = meta.contentType
            dspStage.value = 'COMPLETE'

            transferCompletionCache.remember({ transferSessionId: activeTransferSessionId.value!, expectedSha256: expectedSha256.value!, actualSha256: actualHash, blocksReceived: totalBlocksReceived.value, completedAt: Date.now() })
            sessionLifecycle.markTransferComplete(activeTransferSessionId.value!)
            // Completion is cached and emitted only in response to the next valid TRANSFER_POLL.
            if (
              downloadedFilename.value === 'sonic-test-fixture.bin' &&
              incomingTestSessionId.value &&
              incomingTestTransferId.value
            ) {
              // Legacy TEST_FILE_COMPLETE remains an explicit test-transfer path; normal transfers use polls.
            } else {
              // Do not transmit completion immediately; wait for the sender's next poll.
            }
          }
        }
      } catch (e) {
        console.error('Failed to process Fountain block', e)
      }
    }
  }

  function stopListening() {
    isListening.value = false
    if (receiver) receiver.stop()
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
    preferredOutputGain,
    adaptiveCandidateGain,
    verifiedAdaptiveTxGain,
    effectiveTxGain,
    selectedMicId,
    selectedSpeakerId,
    sliceSize,
    sessionStep,
    receiveMode,
    transferPhase,
    dspStage,
    linkCheckMessage,
    adaptiveHandshakeState,
    adaptiveHandshakeEvents,
    adaptiveLinkContext,
    adaptiveLocalGain,
    adaptiveRemoteGain,
    adaptiveSelectedBand,
    adaptiveConfigFingerprint,
    duplexMode,
    isTransmitting,
    isListening,
    liveSamples,
    activePage,
    storedData,
    sendFilename,
    sendContentType,
    sendTotalBytes,
    sendSha256,
    framesSent,
    framesGenerated,
    framesQueued,
    framesPlayed,
    bytesSent,
    receiveHeader,
    fountainK,
    decodedCount,
    totalBlocksReceived,
    downloadUrl,
    downloadedFilename,
    downloadedContentType,
    expectedSha256,
    receivedSha256,
    isIntegrityVerified,
    profileVerificationStatus,
    profileVerificationReport,
    liveStats,
    processCentralAudioData,
    prepareArtifactDecoding,
    setFile,
    skipVerification,
    runAcousticLinkCheck,
    startAdaptiveLink,
    runTestFileTransfer,
    verifyDataProfile,
    verifyAutoProfile,
    startTransmission,
    stopTransmission,
    startListening,
    stopListening,
  }
})

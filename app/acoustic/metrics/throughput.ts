import { getProfileConfig, ModemProfileKey } from '../modulation/modem'
import { SonicWaveformRenderer } from '../transport/waveform-renderer'

export interface ThroughputBenchmarkResult {
  profile: ModemProfileKey
  originalPayloadBytes: number
  canonicalPayloadBytes: number
  compressedPayloadBytes: number
  protocolFrames: number
  sourceFountainBlocks: number
  transmittedFountainBlocks: number
  protocolBytes: number
  pcmSamples: number
  durationSeconds: number
  compressionRatio: number
  protocolExpansionRatio: number
  fountainRedundancyRatio: number
  rawPhyBitrate: number
  sourceUsefulBitrate: number
  compressedPayloadBitrate: number
  wireProtocolBitrate: number
  overallEfficiency: number
}

export interface ThroughputBenchmarkOptions {
  sampleRate?: number
  sliceSize?: number
  extraBlocks?: number
  filename?: string
  contentType?: string
}

export type PayloadEntropyClass = 'REPETITIVE' | 'STRUCTURED' | 'INCOMPRESSIBLE' | 'ALREADY_COMPRESSED_LIKE'

/** Deterministic payloads for comparing compression-sensitive benchmark cases. */
export function createBenchmarkPayload(size: number, kind: PayloadEntropyClass): Uint8Array {
  const payload = new Uint8Array(size)
  if (kind === 'REPETITIVE') {
    payload.fill(0)
    return payload
  }
  let state = kind === 'INCOMPRESSIBLE' ? 0x12345678 : kind === 'ALREADY_COMPRESSED_LIKE' ? 0x9e3779b9 : 0x31415926
  for (let i = 0; i < size; i++) {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0
    payload[i] = kind === 'STRUCTURED' ? ((i * 31 + (state >>> 24)) & 0xff) : state >>> 24
  }
  return payload
}

/** Measures the actual PCM produced by the production renderer, not a symbol-only estimate. */
export function benchmarkPayload(
  payload: Uint8Array,
  profile: ModemProfileKey,
  options: ThroughputBenchmarkOptions = {},
): ThroughputBenchmarkResult {
  const sampleRate = options.sampleRate ?? 48000
  const sliceSize = options.sliceSize ?? 100
  const extraBlocks = options.extraBlocks ?? 30
  const render = SonicWaveformRenderer.renderPayloadToPcm(
    payload,
    options.filename ?? 'benchmark.bin',
    options.contentType ?? 'application/octet-stream',
    profile,
    sampleRate,
    sliceSize,
    extraBlocks,
  )
  const config = getProfileConfig(profile, sampleRate)
  const rawBitrate = Math.log2(config.carrierCount) * 1000 / (config.symbolDurationMs + config.guardMs)
  const compressedBitrate = render.encodedBytes * 8 / render.durationSec
  const sourceUsefulBitrate = payload.length * 8 / render.durationSec
  const wireProtocolBitrate = render.protocolBytes * 8 / render.durationSec
  const fountainBlocks = render.fountainBlocks
  return {
    profile,
    originalPayloadBytes: payload.length,
    canonicalPayloadBytes: render.canonicalBytes,
    compressedPayloadBytes: render.encodedBytes,
    protocolFrames: render.totalFrames,
    sourceFountainBlocks: render.sourceBlocks,
    transmittedFountainBlocks: fountainBlocks,
    protocolBytes: render.protocolBytes,
    pcmSamples: render.totalSamples,
    durationSeconds: render.totalSamples / sampleRate,
    compressionRatio: render.canonicalBytes ? render.encodedBytes / render.canonicalBytes : 0,
    protocolExpansionRatio: render.encodedBytes ? render.protocolBytes / render.encodedBytes : 0,
    fountainRedundancyRatio: render.sourceBlocks ? (fountainBlocks - render.sourceBlocks) / render.sourceBlocks : 0,
    rawPhyBitrate: rawBitrate,
    sourceUsefulBitrate,
    compressedPayloadBitrate: compressedBitrate,
    wireProtocolBitrate,
    overallEfficiency: sourceUsefulBitrate / rawBitrate * 100,
  }
}

export function formatDuration(seconds: number): string {
  const rounded = Math.max(0, Math.round(seconds))
  const minutes = Math.floor(rounded / 60)
  const remaining = rounded % 60
  return minutes ? `${minutes}m ${remaining}s` : `${remaining}s`
}

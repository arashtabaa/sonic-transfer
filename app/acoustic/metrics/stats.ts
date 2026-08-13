export interface LiveTransferStats {
  rawBitrateBps: number
  payloadBitrateBps: number
  validPayloadBitrateBps: number
  snrDb: number
  packetsReceived: number
  validPackets: number
  invalidPackets: number
  packetErrorRatePercent: number
  fountainBlocksRequired: number
  fountainBlocksReceived: number
  fountainProgressPercent: number
  elapsedTimeSec: number
  estimatedTimeRemainingSec: number
}

export class MetricsCollector {
  private startTime = 0
  private endTime = 0
  private totalBytesReceived = 0
  private validBytesReceived = 0
  private packetsReceived = 0
  private validPackets = 0
  private invalidPackets = 0
  private totalFountainK = 0
  private decodedFountainCount = 0
  private lastSnrDb = 20

  public start(): void {
    this.startTime = performance.now()
    this.endTime = 0
    this.totalBytesReceived = 0
    this.validBytesReceived = 0
    this.packetsReceived = 0
    this.validPackets = 0
    this.invalidPackets = 0
    this.decodedFountainCount = 0
  }

  public recordPacket(bytes: number, isValid: boolean, snrDb = 20): void {
    this.packetsReceived++
    this.lastSnrDb = snrDb
    this.totalBytesReceived += bytes

    if (isValid) {
      this.validPackets++
      this.validBytesReceived += bytes
    } else {
      this.invalidPackets++
    }
  }

  public setFountainStatus(k: number, decodedCount: number): void {
    this.totalFountainK = k
    this.decodedFountainCount = decodedCount
    if (decodedCount === k && k > 0 && this.endTime === 0) {
      this.endTime = performance.now()
    }
  }

  public getStats(): LiveTransferStats {
    const now = this.endTime || performance.now()
    const elapsedSec = Math.max(0.1, (now - this.startTime) / 1000)

    const rawBitrateBps = (this.totalBytesReceived * 8) / elapsedSec
    const validPayloadBitrateBps = (this.validBytesReceived * 8) / elapsedSec

    const totalPkts = this.packetsReceived || 1
    const packetErrorRatePercent = (this.invalidPackets / totalPkts) * 100

    const progressPercent = this.totalFountainK > 0
      ? Math.min(100, (this.decodedFountainCount / this.totalFountainK) * 100)
      : 0

    let estRemainingSec = 0
    if (progressPercent > 0 && progressPercent < 100) {
      const remainingPercent = 100 - progressPercent
      const secPerPercent = elapsedSec / progressPercent
      estRemainingSec = remainingPercent * secPerPercent
    }

    return {
      rawBitrateBps,
      payloadBitrateBps: validPayloadBitrateBps,
      validPayloadBitrateBps,
      snrDb: this.lastSnrDb,
      packetsReceived: this.packetsReceived,
      validPackets: this.validPackets,
      invalidPackets: this.invalidPackets,
      packetErrorRatePercent,
      fountainBlocksRequired: this.totalFountainK,
      fountainBlocksReceived: this.decodedFountainCount,
      fountainProgressPercent: progressPercent,
      elapsedTimeSec: elapsedSec,
      estimatedTimeRemainingSec: estRemainingSec,
    }
  }
}

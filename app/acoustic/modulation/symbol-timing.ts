export class SymbolTiming {
  readonly activeSamplesExact: number
  readonly guardSamplesExact: number
  readonly strideExact: number

  constructor(sampleRate: number, activeMs: number, guardMs: number) {
    this.activeSamplesExact = sampleRate * activeMs / 1000
    this.guardSamplesExact = sampleRate * guardMs / 1000
    this.strideExact = this.activeSamplesExact + this.guardSamplesExact
  }

  symbolStart(origin: number, index: number): number { return Math.round(origin + index * this.strideExact) }
  activeEnd(origin: number, index: number): number { return Math.round(origin + index * this.strideExact + this.activeSamplesExact) }
  symbolLength(origin: number, index: number): number { return this.symbolStart(origin, index + 1) - this.symbolStart(origin, index) }
  activeLength(origin: number, index: number): number { return this.activeEnd(origin, index) - this.symbolStart(origin, index) }
}

# Production data throughput V1

The current `BFSKAcousticModem` name is historical. Its production profiles select one carrier from a bank for each symbol, so the implementation is M-ary FSK (MFSK):

```text
bits per symbol = log2(carrierCount)
symbol interval  = symbolDurationMs + guardMs
raw bitrate      = bits per symbol / symbol interval
```

ROBUST remains the resilient control and fallback channel. DATA profiles are measured independently; a successful control `LINK_ACK` does not imply that a faster DATA profile is usable.

`benchmarkPayload()` measures the PCM length produced by `SonicWaveformRenderer`, including the session header, frame bytes, Fountain redundancy, symbol guards, and profile-specific modem timing. It reports raw PHY bitrate, useful payload bitrate, protocol overhead, and Fountain redundancy. The benchmark is synthetic and does not claim speaker-to-microphone performance.

The diagnostic `applySyntheticChannel()` applies seeded gain, SNR noise, delay, clock drift, deterministic pitch/frequency warp, echo, dropouts, and impulse interference. It is a repeatable channel laboratory, not a physical-room substitute.

Current engineering targets are goals, not achieved guarantees: roughly 50–200 bit/s for ROBUST control and at least 2 kbit/s useful for a future production DATA profile in clean synthetic/WAV conditions. No PHY V2 or OFDM claim is made by this document.

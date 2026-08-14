# FAST_DATA_EXPERIMENTAL V1

FAST_DATA_EXPERIMENTAL is a separate guarded parallel-multitone modem. It carries the existing `AcousticFrame` bytes and does not change the application protocol or ROBUST control PHY.

V1 uses 16 separated carriers from 6–18 kHz, 5 ms active symbols, 1 ms guards, a known alternating multitone preamble, per-carrier energy decisions, and a two-symbol silent frame gap. `ParallelMultitoneStreamDecoder` retains samples across arbitrary chunks, searches for the preamble, parses the existing frame header, validates the existing CRC, and reacquires after a bad frame.

The default clean synthetic raw rate is approximately 2.67 kbit/s. A measured incompressible-like 5 KiB render is about 31.7 seconds with the current 20% Fountain redundancy policy; this is a generated PCM result, not a physical transfer claim. The WAV roundtrip and clean 8 KiB SHA path are covered by tests. Hardware, OGG, and broad physical support remain unverified.

The design intentionally avoids full OFDM: no FFT blocks, cyclic prefix, QAM, or channel equalizer are claimed. If the multitone impairment boundary is insufficient, the next study should evaluate pilot-assisted multicarrier or proper OFDM rather than silently increasing MFSK speed.

# Acoustic Modem Architecture & Frequency Profiles

Sonic Transfer implements a modular acoustic communication interface (`AcousticModem`) with two modem implementations and multiple frequency profiles.

## Modem Implementations

### Modem A — Robust MFSK / BFSK
Frequency-shift keying modem with continuous phase synthesis and Hann window envelope. Spreads bits across carrier frequencies with guard intervals to prevent echo multipath corruption.

### Modem B — High Throughput OFDM
Multicarrier Orthogonal Frequency Division Multiplexing modem with pilot tones and cyclic prefix. Divides spectrum into parallel orthogonal subcarriers for high bitrate transfer.

## Frequency Profiles

1. **Auto**: Automatically measures channel SNR and noise floor, selecting the optimal profile.
2. **Robust**: 1.5 kHz – 3.5 kHz. Maximum device compatibility.
3. **Balanced**: 2.0 kHz – 6.0 kHz. Default trade-off between speed and reliability.
4. **Turbo**: 3.0 kHz – 12.0 kHz. High speed for low-noise environments.
5. **Near-Ultrasonic**: 15.0 kHz – 19.5 kHz. Reduces audible sound.
6. **Ultrasonic Experimental**: 18.0 kHz – 22.5 kHz. Experimental high frequency mode.
7. **Custom**: User-defined start/end frequencies and carrier count.

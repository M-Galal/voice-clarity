# Test recordings

`whisper_mix_16k.wav` (and `../e2e/audio/whisper_mix.m4a`, the same mix as AAC at 44.1 kHz):
19 s, generated with espeak-ng and ffmpeg (see `tests/e2e/make-audio.sh` for the method).

| Spoken (s) | Content |
|---|---|
| 1.56–4.30 | normal Arabic sentence |
| 6.22–9.56 | whispered sentence (`ar+whisper`), 20 dB lower |
| 11.53–13.53 | whispered sentence, 20 dB lower |
| 15.51–17.13 | normal sentence |

Background: brown noise (room rumble) plus pink noise. The whispered parts are only about 1 dB above
the background in the 150 Hz+ band, which makes this a hard case for detection and for audibility.

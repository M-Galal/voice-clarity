# Voice Clarity

A voice player for Android and iOS that makes spoken recordings easier to hear, navigate and transcribe, with Arabic treated as a first-class language. Built with Expo (React Native, TypeScript). Every enhancement and transcription step runs on the phone.

## Run it

You need Node 20 or newer, plus Android Studio for Android or Xcode on a Mac for iOS. The app uses native modules, so it runs in a development build and not in Expo Go.

```bash
npm install                 # also downloads whisper.rn native binaries from GitHub releases
npm test                    # 29 unit tests (DSP, loudness, transcript formats, colour contrast)
npm run typecheck
npx expo run:android        # or: npx expo run:ios
```

For store builds use EAS Build (`eas build -p android` / `eas build -p ios`). Change `bundleIdentifier` and `package` in `app.json` before publishing.

What was checked while building: TypeScript compiles with `strict`, all 29 tests pass, `expo export` bundles for both Android and iOS, and `expo prebuild` generates both native projects with the expected permissions. I could not run the app on a device or simulator in the build environment, so on-device behaviour (playback, decoding of real M4A files, Whisper speed) still needs a test pass on real hardware.

## Product summary

The workflow has four steps: import a recording, listen and jump between its speech sections, enhance and optionally transcribe it, then review and export.

Supported input formats are M4A (AAC), MP4 audio, AAC, MP3, WAV, FLAC, OGG and Opus. Decoding uses react-native-audio-api, which decodes AAC/M4A/MP4 through its bundled FFmpeg on mobile. The original file is copied into the app untouched and never modified. Enhanced audio is always a separate file.

### Key user flows

1. Import. The user taps "Import recording" and picks one or more files in the system picker (Files app on iOS, the document picker on Android, which includes Downloads, Drive and other providers). The app checks the extension and free space, copies the file, then decodes it at 16 kHz to draw the waveform and find speech.
2. Listen. Speech sections are shaded on the waveform and listed as chips. Previous/next buttons jump between sections; bookmarks have their own previous/next buttons. Position, speed and bookmarks are saved and restored.
3. Auto Enhance. The screen shows the steps that will run and the exact settings, then the user taps start. Progress is shown with a cancel button. The result opens in a review screen where the user can switch between original and enhanced at the same timestamp, read measured levels and warnings, then keep or discard it. Nothing is saved before "Keep". If transcription is enabled in the Auto Enhance steps, the transcript screen opens next.
4. Transcribe. The user picks a language (or automatic detection), a speech model and whether to use the enhanced copy, then starts. Each line has timestamps; tapping a line plays it, long-pressing edits it.
5. Export. Original file, enhanced WAV, and transcript as TXT, SRT, VTT or JSON go out through the system share sheet.

## Screens

Recordings: import button, list with name, duration, format, size, processing status and badges for "Enhanced copy" and "Transcript". Settings is in the header.

Player: file details (duration, format, size, status, with Retry after an error), Original/Enhanced switch, waveform with speech shading, red bookmark ticks and a playhead (tap to seek; screen readers get ±5 s swipe actions), transport controls (previous speech, back 10 s, play/pause, forward 10 s, next speech), bookmark controls, speed (0.75× to 2×), skip-silence toggle, buttons for Auto Enhance, Enhance, Transcript and Export, a bookmark list with edit and delete, and the list of speech sections.

Enhance: strength preset (Light, Balanced, Strong, Advanced), noise suppression and hum removal switches, advanced sliders, the loudness section with an explanation of LUFS, peak and gain, processing quality, the option to shorten pauses in the exported file, a summary card of the settings that will be used, and "Delete enhanced copy" when one exists. While running, the screen shows a progress bar and a cancel button and keeps the screen awake. The review screen is described in flow 3.

Transcript: language, model (with in-place download), source audio, optional context words, notes on dialects and speakers. After transcription: detected language, a count of passages to check, Arabic-aware search, the segment list with right-to-left rendering for Arabic lines, a mini player, copy, export format, export, re-transcribe and delete.

Settings: privacy statement, app language (English or Arabic, which switches the layout to right-to-left after a restart), theme (system, light, dark), text size (85 to 160 %, on top of the OS font size), skip-silence gap, speech-detection threshold, Auto Enhance steps, model downloads and deletion, and "Delete all recordings and data".

## Audio processing

The pipeline is in `src/dsp/pipeline.ts`. It works on a mono mix at the chosen processing rate (16, 24 or 48 kHz; default 24 kHz):

```
measure → speech detection → high-pass → hum notches → noise suppression
        → clarity EQ → pause attenuation → gain → peak limiter
        → [optional pause shortening] → measure → report + warnings
```

Speech detection (`vad.ts`) measures 20 ms frames on a 100 Hz to 4 kHz band, sets the noise floor at the 10th percentile of frame levels and marks frames that sit a set margin above it (default 10 dB, adjustable from 4 to 20 dB). Minimum speech length, minimum gap and padding turn frames into sections. If nothing passes at 10 dB it retries once at 6 dB. It detects voice-like energy, not words, and the app says so.

Noise suppression (`denoise.ts`) is spectral subtraction on a short-time Fourier transform with ~32 ms frames and 50 % overlap. The noise profile comes from the pauses and keeps adapting during them, which follows steady or slowly changing noise (hiss, hum, fans, traffic, room tone). Short sounds that land in the middle of speech are not learned, so intermittent noise is only partly reduced. The "deepest cut per band" floor limits how far any frequency band can be lowered, which is the main protection against removing parts of words.

Hum removal uses Goertzel analysis on non-speech audio to look for 50 or 60 Hz and its harmonics, and only adds notch filters when it finds them.

The high-pass filter (70 to 100 Hz in the presets, up to 200 Hz in Advanced) handles rumble, wind and low-frequency plosive pops. De-reverberation is shown as not available in this version.

| Preset | Noise amount | Deepest cut | High-pass | Clarity boost | Pause lowering |
|---|---|---|---|---|---|
| Light | 1.0× | −10 dB | 70 Hz | +2 dB | off |
| Balanced | 1.5× | −18 dB | 80 Hz | +3 dB | 6 dB |
| Strong | 2.2× | −26 dB | 100 Hz | +4 dB | 10 dB |

Changing any of these values switches the preset to Advanced.

### Loudness, units and safeguards

Loudness follows ITU-R BS.1770-4 (K-weighting, 400 ms blocks, absolute gate at −70 LUFS, relative gate 10 LU down). The K-weighting filters are derived for any sample rate; at 48 kHz they reproduce the coefficients in the standard, and a full-scale 997 Hz sine reads −3.01 LUFS. Both facts are covered by tests.

"Speech loudness" applies the same gating only to blocks inside detected speech, so long pauses do not pull the number down. The gain stage targets this value. The default target is −16 LUFS (adjustable from −30 to −10). Automatic gain is capped at +24 dB; when the cap is hit, the review says the result is quieter than the target.

In manual mode the user sets the change in dB (−12 to +24) or types a percentage. dB is what gets applied. The percentage is only a view of the same amplitude ratio, `percent = (10^(dB/20) − 1) × 100`, so +6.02 dB is +100 % and −6.02 dB is −50 %. Typed percentages are converted back to dB with the inverse formula, and a test checks the round trip.

Pause attenuation lowers the gaps between speech sections before the gain stage, so raising the voice raises the background less.

A look-ahead peak limiter (5 ms look-ahead, 80 ms release) follows the gain, with a hard clamp at the ceiling (default −1 dBFS, adjustable from −6 to −0.5). The review shows input and output speech loudness, whole-file loudness, sample peak, an estimated true peak (4× oversampling), gain applied in dB and %, and an estimate of how far speech sits above the noise.

The review shows warnings when the source clips, when speech is close to or buried in noise, when Strong settings meet noisy audio, when gain was capped, when the limiter reduced peaks by more than 6 dB, and when no speech was found. The wording avoids promising recovery: buried words cannot be brought back, and the user is told to compare both versions.

The original is never normalized or overwritten. Previews are written to the cache and only moved into the recording folder when the user taps "Keep enhanced copy".

## Arabic transcription and privacy

Transcription uses whisper.rn, a React Native binding of whisper.cpp, and runs on the device. Models come from the whisper.cpp repository on Hugging Face and are downloaded only when the user asks:

| Option | File | Size |
|---|---|---|
| Base | `ggml-base.bin` | 148 MB |
| Small (default) | `ggml-small.bin` | 488 MB |
| Large v3 Turbo q5 | `ggml-large-v3-turbo-q5_0.bin` | 574 MB |

Audio is resampled to 16 kHz mono and written as a 16-bit WAV for the model, then deleted. whisper.cpp reports segment times in 10 ms units (it converts offsets with `offset_ms/10`); the app scales them to seconds.

Arabic handling:

- Language can be Arabic, English, French, Urdu, Hindi or automatic detection; the detected language is shown.
- Whisper has a single "ar" language and no dialect switch. The UI says this. Optional context words are passed as Whisper's prompt to nudge vocabulary, and the UI calls this a hint.
- Latin commas, semicolons and question marks in Arabic lines become ، ؛ ؟ (decimals like 3,5 are left alone).
- Arabic lines render right to left. SRT and VTT exports wrap Arabic lines in Unicode embedding marks, and text exports start with a UTF-8 byte order mark.
- Search ignores diacritics and tatweel and treats أ إ آ ا, ى ي and ة ه as equal.

whisper.rn does not return word confidence, so the app cannot mark individual uncertain words. It flags whole passages instead: lines where speech sits less than 8 dB above the noise floor, and lines that repeat the previous line (Whisper sometimes loops on noise). Flagged lines get a dashed amber border and a reason.

Speaker separation is not offered. whisper.cpp's tinydiarize needs a special English-only model, so it does not help Arabic.

Privacy: recordings, enhanced copies and transcripts stay in the app's document folder. The only network request is the model download. The app asks for no microphone, contacts or location permission. On Android, the build blocks `RECORD_AUDIO`, `SYSTEM_ALERT_WINDOW`, `VIBRATE` and the legacy storage permissions; the remaining ones are `INTERNET` (model download), `MODIFY_AUDIO_SETTINGS` and the media-playback foreground service used for background playback. Settings has a button that deletes everything, including models.

## Architecture

```
App.tsx                      router, audio session, back button, first-run privacy notice
src/state/AppContext.tsx     library + settings state, persistence, import, errors, i18n, theme
src/screens/                 Library, Player, Enhance (setup/run/review), Transcript, Settings
src/ui/                      accessible components, waveform, colour themes
src/services/storage.ts      on-device storage with atomic JSON writes
src/services/audio.ts        decoding (react-native-audio-api), WAV writing
src/services/processing.ts   import, analysis, enhancement preview/commit, sharing
src/services/transcription.ts model download, whisper.rn transcription, flags
src/dsp/                     pure TypeScript DSP: biquads, FFT, VAD, denoise, loudness, limiter, WAV
src/transcript/format.ts     Arabic helpers, SRT/VTT/TXT/JSON, search
tests/                       Node tests for dsp, transcript and contrast
```

Libraries: expo-audio for playback (rate change with pitch correction, background playback, lock-screen controls), react-native-audio-api for decoding, whisper.rn for speech recognition, expo-file-system, expo-document-picker, expo-sharing, expo-clipboard and expo-keep-awake.

The DSP is plain TypeScript with no React Native imports, so it is tested in Node and could later move to a native module or a worklet without changes to the UI. Processing runs on the JavaScript thread in chunks that yield to the UI between steps; cancel takes effect at the next chunk.

## Known limits

- Enhanced audio is exported as 16-bit mono WAV. None of the libraries used here encodes an in-memory buffer to M4A/AAC, so M4A export of the enhanced copy would need a small native encoder (AVAudioFile on iOS, MediaCodec + MediaMuxer on Android). The original M4A can be exported unchanged.
- Import uses the system file picker. Receiving files from another app's share sheet needs an iOS share extension and Android intent filters, which are not included yet.
- Processing is mono.
- Decoded audio is held in memory. At 16 kHz mono that is about 230 MB per hour of audio as 32-bit floats, and enhancement at 24 kHz needs more. The app warns above 45 minutes and checks free storage before starting, but very long files may run out of memory on smaller phones.
- If the app is closed during processing, the recording is marked "interrupted" on next launch and the user can retry. Partial work is not resumed.
- When "shorten pauses" is used, bookmarks stay on the original timeline and are hidden while the enhanced copy plays.
- De-reverberation is not implemented.

## Acceptance criteria

Playback
- Play, pause, ±10 s and tap-to-seek work for every supported format; position is accurate to the status update interval (100 ms).
- Speed 0.75× to 2× keeps pitch.
- Leaving and reopening a recording restores position, source and bookmarks.
- Playback continues with the screen locked, and lock-screen controls appear.

M4A import and export
- An AAC-encoded `.m4a` imports, shows duration, format and size, and plays.
- An unsupported file shows the unsupported-format message and nothing is added.
- Too little free space shows the needed and free amounts.
- The original exports byte for byte; the enhanced copy exports as WAV.

Bookmarks
- Add at the current time, rename, change time (m:ss, validated against duration), delete.
- Previous/next bookmark jumps work, and ticks appear on the waveform.

Speech detection
- Speech sections are shaded and listed; previous/next speech jumps work.
- Skip silence only skips pauses longer than the configured gap (0.3 to 5 s).
- After changing the threshold in Settings, "Find speech again" on the player re-runs detection.

Enhancement controls
- Each preset applies its values from the table; editing any value switches to Advanced.
- The summary lists every setting before processing; cancel leaves no files and no changes.
- Review lets the user switch original/enhanced at the same time position; Discard deletes the preview; Keep stores `enhanced.wav` beside the untouched original.

Loudness targets
- In target mode, output speech loudness is within ±1 LU of the target unless the gain cap or limiter warning is shown (tested at −16 LUFS).
- No output sample exceeds the ceiling.
- dB and % always show the same value under the stated formula.

Arabic transcription
- With a model downloaded, an Arabic recording produces timestamped lines rendered right to left with Arabic punctuation.
- Tapping a line plays from its start; long-press edits and marks it "Edited".
- Search finds words with or without diacritics.
- TXT, SRT, VTT and JSON exports open with correct Arabic text and timestamps.
- Without a model, the app says so and offers the download.

Accessibility
- All controls have screen-reader labels and at least 48 pt touch targets.
- Sliders and the timeline respond to VoiceOver/TalkBack increment and decrement.
- Text pairs in both themes meet WCAG AA 4.5:1 (tested).
- Text scales with the OS setting and the in-app slider.
- Arabic UI switches the whole layout to right to left; the waveform and transport stay left to right like other media players.

Error handling
- Decode failure, low storage, cancelled jobs, missing models, unavailable sharing and interrupted processing each show a specific message, and the library stays usable.

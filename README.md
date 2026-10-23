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
2. Listen. Speech sections are shaded on the waveform and listed as chips; whispered or distant sections have their own tint and a "whisper" tag. Previous/next buttons jump between sections; bookmarks have their own previous/next buttons. The back and forward buttons jump by an interval you choose (1 s to 1 h each, set in Settings). Playback speed goes from 0.1× to 5× with the pitch kept. Position, speed and bookmarks are saved and restored.
3. Auto Enhance. By default it uses Smart mode, which measures the recording and chooses the settings for the clearest speech, including raising whispers and distant voices to the level of normal speech. The screen shows the steps that will run and the exact settings, then the user taps start. Progress is shown with a cancel button. The result opens in a review screen where the user can switch between original and enhanced at the same timestamp, read measured levels and warnings, then keep or discard it. Nothing is saved before "Keep". If transcription is enabled in the Auto Enhance steps, the transcript screen opens next.
4. Transcribe. The user picks a language (or automatic detection), a speech model and whether to use the enhanced copy, then starts. Each line has timestamps; tapping a line plays it, long-pressing edits it.
5. Edit. Trim the recording to a selection or remove a selection, and change its speed (0.1× to 5×, pitch kept). Preview the result, then Save (replaces this recording, after a confirmation) or Save as (adds a new recording named `<name>-v<n>` by default, and leaves this one alone). The edit keeps the original's file type where the phone can encode it.
6. Export. Original file, enhanced WAV, and transcript as TXT, SRT, VTT or JSON go out through the system share sheet.
7. Play list from a folder. The user picks a folder once in the system folder picker; the app lists the audio files in it (optionally with subfolders), filtered by file name and extension and sorted by name or date. Tapping a file plays it; "Play all" starts at the top. Next/previous file buttons appear in the player, the next file starts when one ends (can be switched off), and Skip silence applies to every file. Files play from the folder where they are; nothing is copied into the app, and a file changes only when the user edits it and chooses Save. For speech detection (and Skip silence) the file is read into memory and decoded there. The library keeps only the app's own data for each file: position, bookmarks, speech sections, and any enhanced copy or transcript the user makes. Edit offers both Save and Save as for folder files. Save overwrites the file in its folder (after a confirmation) when the phone can write its type (M4A, MP4, WAV, and AAC on Android); the previous contents are held in memory and written back if the write fails. For MP3, FLAC, OGG and Opus, Save writes `<name>.m4a` in the same folder and deletes the old file once the new one is written. Save as adds a new recording to the app's library.
8. Send to Secure Folder (Samsung phones). In the Export sheet, "Send to Secure Folder" explains the steps and opens the share menu with the original or enhanced file. The user picks Secure Folder, unlocks it and chooses the app to keep the file in.

## Screens

Recordings: theme button in the header (one tap cycles Match system, Light, Dark), import button, "Play list from a folder" button, list with name, duration, format, size, processing status and badges for "Enhanced copy" and "Transcript". Settings is in the header.

Player: file details (duration, format, size, status, with Retry after an error), Original/Enhanced switch, waveform with speech shading, red bookmark ticks and a playhead (tap to seek; screen readers get ±5 s swipe actions), previous/next file and "File n of m" when playing from a play list, transport controls (previous speech, back, play/pause, forward, next speech; the jump sizes are set in Settings), bookmark controls, speed (0.1× to 5×, slider plus 0.5–5× shortcuts), skip-silence toggle, buttons for Auto Enhance, Enhance, Transcript and Export, a bookmark list with edit and delete, and the list of speech sections.

Edit: choose the original or enhanced version, a trim mode (no trimming, keep the selection, remove the selection), start and end set from the playhead with ±0.1 s nudges, "Play selection", a speed slider from 0.1× to 5× in 0.05 steps with 0.5–3× shortcuts, the resulting length, Preview (switch between the current audio and the preview), Save and Save as. The waveform dims what will be dropped in keep mode and shades the removed part in cut mode.

Play list: the chosen folder shown as a path (for example "Internal storage/Music/Calls"), Choose/Change folder, include subfolders, a file-name filter (text found anywhere in the name, or patterns with `*` and `?` such as `call_*.m4a`; several separated by `;`), an extension filter (for example `m4a, mp3`; empty means every supported type), order (name with natural number order, newest first, oldest first), "play the next file", Skip silence, the match count, Play all, Refresh, and the file list with size, date, subfolder, a tick for files the app has data for, and a delete button (also on long-press) that deletes the file from the folder after a confirmation.

Enhance: strength preset (Light, Balanced, Strong, Advanced), noise suppression and hum removal switches, advanced sliders, the loudness section with an explanation of LUFS, peak and gain, processing quality, the option to shorten pauses in the exported file, a summary card of the settings that will be used, and "Delete enhanced copy" when one exists. While running, the screen shows a progress bar and a cancel button and keeps the screen awake. The review screen is described in flow 3.

Transcript: language, model (with in-place download), source audio, optional context words, notes on dialects and speakers. After transcription: detected language, a count of passages to check, Arabic-aware search, the segment list with right-to-left rendering for Arabic lines, a mini player, copy, export format, export, re-transcribe and delete.

Settings: privacy statement, app language (English or Arabic, which switches the layout to right-to-left after a restart), theme (Match system, Light, Dark; the choice also applies to system alerts, the keyboard and dialogs through React Native's `Appearance.setColorScheme`, and to the window background through expo-system-ui), text size (85 to 160 %, on top of the OS font size), skip-silence gap, speech-detection threshold, Auto Enhance steps, model downloads and deletion, and "Delete all recordings and data".

## Audio processing

The pipeline is in `src/dsp/pipeline.ts`. It works on a mono mix at the chosen processing rate (16, 24 or 48 kHz; default 24 kHz):

```
measure → speech detection → high-pass → hum notches → noise suppression
        → clarity EQ → pause attenuation → gain → peak limiter
        → [optional pause shortening] → measure → report + warnings
```

Speech detection (`vad.ts`) measures 20 ms frames in two bands: a voice band (100 Hz–4 kHz) and a whisper band (1.5–7 kHz, averaged over 100 ms). Whispered and distant speech has little voiced low end, so it shows up in the whisper band while the voice band barely moves. Each band's noise floor is the 10th percentile of its frame levels; a frame is speech when the voice band is a set margin above its floor (default 10 dB, adjustable from 4 to 20 dB) or the whisper band is 4 dB above its own. Minimum speech length, minimum gap and padding turn frames into sections; sections found mainly through the whisper band are labelled as whispers. Whisper detection can be switched off in Settings. It detects voice-like energy, not words, and the app says so.

On the committed test recording (`tests/fixtures/whisper_mix_16k.wav`: two normal Arabic sentences and two whispered ones 20 dB quieter, over room rumble and hiss), the voice band alone finds only the normal sentences; with the whisper band, more than 85 % of each whispered sentence is detected and labelled, and noise alone produces no sections. Both are unit tests.

Noise suppression (`denoise.ts`) is spectral subtraction on a short-time Fourier transform with ~32 ms frames and 50 % overlap. The noise profile comes from the pauses and keeps adapting during them, which follows steady or slowly changing noise (hiss, hum, fans, traffic, room tone). Short sounds that land in the middle of speech are not learned, so intermittent noise is only partly reduced. The "deepest cut per band" floor limits how far any frequency band can be lowered, which is the main protection against removing parts of words.

Hum removal uses Goertzel analysis on non-speech audio to look for 50 or 60 Hz and its harmonics, and only adds notch filters when it finds them.

The high-pass filter (70 to 100 Hz in the presets, up to 200 Hz in Advanced) handles rumble, wind and low-frequency plosive pops. De-reverberation is shown as not available in this version.

The speech leveller (`levelSpeech` in `dynamics.ts`) raises quiet speech towards the louder speech in the same file. It measures speech in ~1 s windows on a K-weighted copy (which counts the 1.5–7 kHz whisper region more than the low end), boosts each window by the gap to the 80th-percentile level, up to a maximum, never turns anything down, gives pauses no boost, and changes gain over ~80 ms.

| Preset | Noise amount | Deepest cut | High-pass | Clarity boost | Pause lowering | Leveller |
|---|---|---|---|---|---|---|
| Light | 1.0× | −10 dB | 70 Hz | +2 dB | off | off |
| Balanced | 1.5× | −18 dB | 80 Hz | +3 dB | 6 dB | up to 12 dB |
| Strong | 2.2× | −26 dB | 100 Hz | +4 dB | 10 dB | up to 20 dB |

Changing any of these values switches the preset to Advanced.

Smart (the default, `autoTune.ts`) measures the recording first: speech-to-noise ratio, the share of speech that is whispered, the level spread between loud and quiet speech, low-frequency rumble in the pauses, hum and clipping. It then picks noise reduction by noise level (gentler when whispers are present, because whispers are noise-like and their consonants are easily removed), turns the leveller on when speech levels differ by more than 4 dB or whispers are present (maximum boost = spread + 6 dB, 8–30 dB), raises the low-cut to 100 or 120 Hz when there is rumble, uses a +4 dB clarity boost for whispered or distant speech, and lowers pauses by 4 or 8 dB. Your loudness target and peak ceiling are kept. The review screen lists each choice with its reason.

On the whisper test recording, Smart mode brings the whispered sentences from −42 dB to about −18 dB, the same level as the normal sentences (−18 / −16 dB), while the pauses drop from −43 to −53 dB. Before, the whispers were only about 1 dB above the background; after, about 35 dB. A unit test checks that whispers end within 4 dB of normal speech and more than 20 dB above the pauses.

### Editing

`src/dsp/edit.ts` trims or cuts every channel with 5 ms fades at the joins, then changes speed with WSOLA (waveform-similarity overlap-add): 40 ms Hann frames at 50 % overlap, each shifted by up to ±10 ms to the position that best continues the previous frame. The search runs on a 4 kHz mono copy and is refined at full rate; the same shift is applied to every channel, so stereo stays aligned and pitch is unchanged. Tests check pitch at 0.5×, 0.75×, 1.5× and 2×, output length, event timing and channel alignment.

Edits are rendered at the file's own sample rate and channel count (recordings over 20 minutes at 24 kHz to limit memory) and saved in the original's file type where the phone has an encoder for it. A small local native module, `modules/voice-encoder`, encodes AAC: on Android with MediaCodec into MPEG-4 (`.m4a`, `.mp4`) or raw ADTS (`.aac`), on iOS with AVAudioFile into MPEG-4. The bit rate follows the original's average bit rate within AAC limits, so size and quality stay close.

| Original | Saved as |
|---|---|
| M4A, MP4 | same type (AAC) |
| WAV | WAV |
| AAC | AAC on Android, M4A on iOS |
| MP3, FLAC, OGG, Opus | M4A (AAC) |

Android's media documentation lists no MP3 encoder, and this app does not ship one, so MP3 edits become M4A. FLAC and Opus encoders exist on Android but have no matching iOS path here, so they are saved as M4A on both platforms for consistency. The Edit screen states the file type before saving. If encoding fails, the edit is saved as WAV rather than lost.

"Save as" suggests `<name>-v1`, `-v2` and so on: it drops an existing `-v<n>` suffix from the name and uses one more than the highest version already in the library. Save asks for confirmation, replaces the recording's audio, removes its enhanced copy and transcript because their timing no longer matches, and moves bookmarks that fall inside the kept audio to their new times. Save as creates a new recording with the remapped bookmarks and leaves the source untouched. Speed buttons on the player change playback only; the speed on the Edit screen changes the file.

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
src/edit/saveFormat.ts       save file type, AAC bit rate, -v<n> naming
modules/voice-encoder/       local Expo module: AAC encoder (Kotlin MediaCodec, Swift AVAudioFile)
src/dsp/                     pure TypeScript DSP: biquads, FFT, VAD, denoise, loudness, limiter, WAV
src/transcript/format.ts     Arabic helpers, SRT/VTT/TXT/JSON, search
src/playlist/filter.ts       play-list name/extension filters, sorting, SAF names and folder labels
src/services/playlist.ts     folder picker, folder scan, Secure Folder availability
tests/                       Node tests for dsp, transcript and contrast
```

Playback speed above 2×: expo-audio limits the rate to 2× in its own code. The underlying players support more (Media3's `DefaultAudioSink` accepts 0.1×–8×; Apple documents the `timeDomain` time-pitch algorithm, which is meant for voice, for 1/32× to 32×), so `patches/expo-audio+58.0.10.patch` raises that limit and the app uses 0.1×–5× with the `timeDomain` algorithm on iOS. The patch is applied by `patch-package` after every `npm install`; re-check it when upgrading expo-audio.

Play-list folders: on Android the folder comes from the system folder picker (`ACTION_OPEN_DOCUMENT_TREE`, through expo-file-system's `Directory.pickDirectoryAsync`). Files are played from their `content://` URIs (expo-audio uses Media3's `DefaultDataSource` for local sources) and decoded from memory (react-native-audio-api's `decodeAudioData` accepts an `ArrayBuffer`). expo-file-system takes the persistable read grant, so the folder stays readable after a restart; Android drops the grant if the folder is moved or deleted, and the screen then asks for the folder again. Android 11 and later do not let apps pick the top level of internal storage or an SD card, or the Download folder itself, so a folder inside them is needed ([Android: access documents and other files](https://developer.android.com/training/data-storage/shared/documents-files)). Typing a raw path is not offered because apps cannot read arbitrary storage paths on Android 11+ without the "all files access" permission. On iOS the Files folder picker is used.

Secure Folder: Samsung documents three ways to put files into Secure Folder: "Add files" inside Secure Folder, "Move to Secure Folder" in Samsung's own apps (My Files, Gallery, Voice Recorder, Contacts), and "Share via" with Secure Folder chosen in the share menu ([Samsung Knox: move content in and out of Secure Folder](https://docs.samsungknox.com/secure-folder/Content/backup-secure-folder-data.htm), [Samsung support](https://www.samsung.com/uk/support/mobile-devices/how-do-i-move-content-or-apps-to-the-secure-folder/)). There is no documented API for other apps, so the app uses the share menu. The option is shown on Samsung phones only.

Libraries: expo-audio for playback (rate change with pitch correction, background playback, lock-screen controls), react-native-audio-api for decoding, whisper.rn for speech recognition, expo-file-system, expo-document-picker, expo-sharing, expo-clipboard and expo-keep-awake.

The DSP is plain TypeScript with no React Native imports, so it is tested in Node and could later move to a native module or a worklet without changes to the UI. Processing runs on the JavaScript thread in chunks that yield to the UI between steps; cancel takes effect at the next chunk.

## Known limits

- MP3, FLAC, OGG and Opus edits are saved as M4A (AAC); raw AAC edits become M4A on iOS.
- Enhanced audio is exported as 16-bit mono WAV. None of the libraries used here encodes an in-memory buffer to M4A/AAC, so M4A export of the enhanced copy would need a small native encoder (AVAudioFile on iOS, MediaCodec + MediaMuxer on Android). The original M4A can be exported unchanged.
- Import uses the system file picker. Receiving files from another app's share sheet needs an iOS share extension and Android intent filters, which are not included yet.
- Processing is mono.
- Decoded audio is held in memory. At 16 kHz mono that is about 230 MB per hour of audio as 32-bit floats, and enhancement at 24 kHz needs more. The app warns above 45 minutes and checks free storage before starting, but very long files may run out of memory on smaller phones.
- If the app is closed during processing, the recording is marked "interrupted" on next launch and the user can retry. Partial work is not resumed.
- When "shorten pauses" is used, bookmarks stay on the original timeline and are hidden while the enhanced copy plays.
- De-reverberation is not implemented.
- Play-list files are read from their folder each time. If a file is moved, renamed or deleted, or folder access is removed, it can no longer be played until the folder is chosen again.
- Sharing a play-list file (Export or Send to Secure Folder) makes a temporary copy for the share menu, because expo-sharing shares local files; temporary files are cleared when the app starts.
- "Send to Secure Folder" sends a copy through the share menu. The app cannot delete or move the original into Secure Folder itself.

## Acceptance criteria

Playback
- Play, pause, ±10 s and tap-to-seek work for every supported format; position is accurate to the status update interval (100 ms).
- Playback speed 0.1× to 5× keeps pitch; back and forward jumps follow the intervals set in Settings (1 s to 1 h).
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

Play list
- After choosing a folder, the screen shows its path and lists only supported audio files (other files are ignored).
- Extension and name filters (substring or `*`/`?` patterns, `;` for several) narrow the list as you type and are remembered.
- Tapping a file plays it with "File n of m"; next/previous file work; the next file starts when one ends if that option is on; Skip silence applies to every file.
- Playing a file does not copy it: the player shows "Plays from folder", speech sections are found, and the app's storage does not grow by the file's size.
- Deleting a folder file (trash button on its play-list row, long-press, or Delete in the player then "Delete file") asks first, deletes the file from the folder and the app's data for it; "Remove from app" in the player keeps the file.
- Save on a folder file overwrites it in place (same type) or writes `<name>.m4a` next to it and removes the old file (MP3, FLAC, OGG, Opus); the play list then shows the new file. Save as adds a new recording.

Secure Folder (Samsung)
- Export shows "Send to Secure Folder"; it explains the steps, then opens the share menu with the chosen file.

Editing
- Keep-selection and remove-selection produce the expected length; speed 0.1× to 5× keeps pitch.
- Preview plays the edited result before anything is saved.
- Save asks first, then replaces the audio in the original's file type (M4A stays M4A), clears the enhanced copy and transcript, keeps bookmarks inside the kept part at their new times and re-runs speech detection.
- Save as suggests `<name>-v<n>` with the next free counter, adds a new recording and leaves the source unchanged.

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

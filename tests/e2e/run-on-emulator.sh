#!/usr/bin/env bash
# Runs inside the emulator step. Exits non-zero when the flow fails or the app crashes;
# the outcome is also written to results/STATUS (results are published by a later step).
set -uo pipefail
APK=$(ls apk/*.apk | head -1)
RES=results
mkdir -p "$RES/screens"
# A retry reuses the results folder: keep the first attempt's output under attempt1/
if [ -f "$RES/STATUS" ]; then
  mkdir -p "$RES/attempt1"
  mv "$RES"/STATUS "$RES"/maestro.txt "$RES"/junit.xml "$RES"/logcat-js.txt "$RES"/app-errors.txt "$RES"/crashes.txt "$RES"/process-deaths.txt "$RES"/final-ui.xml "$RES/attempt1/" 2>/dev/null || true
  mv "$RES/screens" "$RES/attempt1/screens" 2>/dev/null || true
  mkdir -p "$RES/screens"
fi
adb wait-for-device
adb shell settings put global window_animation_scale 0
adb shell settings put global transition_animation_scale 0
adb shell settings put global animator_duration_scale 0
# start clean: no app data or play-list changes left from an earlier attempt
adb uninstall com.example.voiceclarity > /dev/null 2>&1 || true
adb shell rm -rf /sdcard/Music/vc-playlist
adb install -r -g "$APK" > "$RES/install.txt" 2>&1 || { echo "INSTALL_FAILED" > "$RES/STATUS"; exit 1; }
for f in e2e-audio/*; do adb push "$f" /sdcard/Download/ >/dev/null; done
# play-list folder (Android 11+ does not allow picking Download itself)
adb shell mkdir -p /sdcard/Music/vc-playlist
for f in arabic_noisy.m4a english_stereo.mp3 whisper_mix.m4a; do adb push "e2e-audio/$f" /sdcard/Music/vc-playlist/ >/dev/null; done
adb shell "echo notes > /sdcard/Music/vc-playlist/notes.txt"
adb shell content call --method scan_volume --uri content://media --arg external_primary > /dev/null 2>&1 || true
adb shell am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file:///sdcard/Download/ > /dev/null 2>&1 || true
adb logcat -c
adb logcat -v time > "$RES/logcat-full.txt" 2>&1 &
LOGPID=$!

ROOT=$PWD
STAMP=$(mktemp)
"$HOME/.maestro/bin/maestro" test tests/e2e/flows/main.yaml --format junit --output "$RES/junit.xml" \
  --test-output-dir "$RES/maestro-out" > "$RES/maestro.txt" 2>&1
CODE=$?
# takeScreenshot paths are resolved by Maestro, not by our cwd: collect every new PNG.
find "$ROOT" "$HOME/.maestro" -name "*.png" -newer "$STAMP" -not -path "$ROOT/$RES/screens/*" -exec cp {} "$RES/screens/" \; 2>/dev/null || true
# last screen state for diagnosis
adb exec-out screencap -p > "$RES/screens/zz_final.png" 2>/dev/null || true
adb exec-out uiautomator dump /dev/tty > "$RES/final-ui.xml" 2>/dev/null || true
kill $LOGPID 2>/dev/null || true
sleep 1
grep -E "ReactNativeJS|\[VC\]" "$RES/logcat-full.txt" > "$RES/logcat-js.txt" || true
grep -E -A30 "FATAL EXCEPTION|AndroidRuntime: |libc.*Fatal signal|DEBUG   : " "$RES/logcat-full.txt" > "$RES/crashes.txt" || true
# processes the system killed or that died (to tell memory pressure from test-tool failures)
grep -E "lowmemorykiller|lmkd|Process .* has died|Killing [0-9]+:(com.example|dev.mobile)" "$RES/logcat-full.txt" > "$RES/process-deaths.txt" || true
grep -E "com.example.voiceclarity|whisper|RNWhisper|audioapi|ExoPlayer|ExpoAudio|AudioPlayer|MediaCodec|Codec2" "$RES/logcat-full.txt" | grep -E " [EW]/" > "$RES/app-errors.txt" || true
# Maestro's own logging fills the log; keep everything else
grep -vE "I/Maestro|UiDevice" "$RES/logcat-full.txt" | tail -c 5000000 > "$RES/logcat-tail.txt"; rm -f "$RES/logcat-full.txt"
echo "maestro_exit=$CODE" > "$RES/STATUS"
if [ -s "$RES/crashes.txt" ]; then echo "crashes=yes" >> "$RES/STATUS"; [ "$CODE" -eq 0 ] && CODE=1; fi
# A failed flow or an app crash fails the job (the workflow then retries once on a fresh boot).
exit "$CODE"

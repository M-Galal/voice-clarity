#!/usr/bin/env bash
# Runs inside the emulator step. Never exits non-zero so results always get published;
# the outcome is written to results/STATUS.
set -uo pipefail
APK=$(ls apk/*.apk | head -1)
RES=results
mkdir -p "$RES/screens"
adb wait-for-device
adb shell settings put global window_animation_scale 0
adb shell settings put global transition_animation_scale 0
adb shell settings put global animator_duration_scale 0
adb install -r -g "$APK" > "$RES/install.txt" 2>&1 || { echo "INSTALL_FAILED" > "$RES/STATUS"; exit 0; }
for f in e2e-audio/*; do adb push "$f" /sdcard/Download/ >/dev/null; done
adb shell content call --method scan_volume --uri content://media --arg external_primary > /dev/null 2>&1 || true
adb shell am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file:///sdcard/Download/ > /dev/null 2>&1 || true
adb logcat -c
adb logcat -v time > "$RES/logcat-full.txt" 2>&1 &
LOGPID=$!

cd "$RES/screens"
"$HOME/.maestro/bin/maestro" test ../../tests/e2e/flows/main.yaml --format junit --output ../junit.xml > ../maestro.txt 2>&1
CODE=$?
cd ../..
# last screen state for diagnosis
adb exec-out screencap -p > "$RES/screens/zz_final.png" 2>/dev/null || true
adb exec-out uiautomator dump /dev/tty > "$RES/final-ui.xml" 2>/dev/null || true
kill $LOGPID 2>/dev/null || true
sleep 1
grep -E "ReactNativeJS|\[VC\]" "$RES/logcat-full.txt" > "$RES/logcat-js.txt" || true
grep -E -A30 "FATAL EXCEPTION|AndroidRuntime: |libc.*Fatal signal|DEBUG   : " "$RES/logcat-full.txt" > "$RES/crashes.txt" || true
grep -E "com.example.voiceclarity|whisper|RNWhisper|audioapi|ExoPlayer" "$RES/logcat-full.txt" | grep -E " [EW]/" > "$RES/app-errors.txt" || true
tail -c 5000000 "$RES/logcat-full.txt" > "$RES/logcat-tail.txt"; rm -f "$RES/logcat-full.txt"
echo "maestro_exit=$CODE" > "$RES/STATUS"
if [ -s "$RES/crashes.txt" ]; then echo "crashes=yes" >> "$RES/STATUS"; fi
exit 0

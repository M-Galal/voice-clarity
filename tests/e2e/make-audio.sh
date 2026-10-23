#!/usr/bin/env bash
# Generates test recordings for the device test (needs espeak-ng and ffmpeg).
#   arabic_noisy.m4a  Arabic speech in 3 sentences with pauses, pink noise and 50 Hz hum, AAC in M4A, mono 44.1 kHz
#   english_stereo.mp3  English speech, stereo 48 kHz MP3, clean
#   broken.m4a        random bytes with an .m4a name (must fail cleanly)
set -euo pipefail
OUT=${1:-e2e-audio}
mkdir -p "$OUT"
T=$(mktemp -d)

espeak-ng -v ar -s 140 -w "$T/a1.wav" "السلام عليكم ورحمة الله"
espeak-ng -v ar -s 140 -w "$T/a2.wav" "هذا تسجيل تجريبي لاختبار تطبيق صفاء الصوت"
espeak-ng -v ar -s 140 -w "$T/a3.wav" "نحن نختبر تقليل الضوضاء والتفريغ النصي باللغة العربية"
ffmpeg -loglevel error -f lavfi -t 1.5 -i anullsrc=r=22050:cl=mono "$T/sil.wav"
ffmpeg -loglevel error -i "$T/sil.wav" -i "$T/a1.wav" -i "$T/sil.wav" -i "$T/a2.wav" -i "$T/sil.wav" -i "$T/a3.wav" -i "$T/sil.wav" \
  -filter_complex "[0:a][1:a][2:a][3:a][4:a][5:a][6:a]concat=n=7:v=0:a=1,aresample=44100,volume=0.6[s]" -map "[s]" "$T/speech.wav"
DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$T/speech.wav")
ffmpeg -loglevel error -i "$T/speech.wav" \
  -f lavfi -t "$DUR" -i "anoisesrc=color=pink:amplitude=0.04:sample_rate=44100" \
  -f lavfi -t "$DUR" -i "sine=frequency=50:sample_rate=44100" \
  -filter_complex "[2:a]volume=0.03[h];[0:a][1:a][h]amix=inputs=3:normalize=0[m]" -map "[m]" \
  -ac 1 -ar 44100 -c:a aac -b:a 96k "$OUT/arabic_noisy.m4a"

espeak-ng -v en -s 150 -w "$T/e.wav" "This is a short English test. It checks stereo MP3 import. The end."
ffmpeg -loglevel error -i "$T/e.wav" -ac 2 -ar 48000 -c:a libmp3lame -b:a 128k "$OUT/english_stereo.mp3"

head -c 40000 /dev/urandom > "$OUT/broken.m4a"
ls -la "$OUT"
for f in "$OUT/arabic_noisy.m4a" "$OUT/english_stereo.mp3"; do ffprobe -v error -show_entries stream=codec_name,sample_rate,channels -show_entries format=duration -of compact "$f"; done

# Whisper test: normal and whispered (20 dB lower) Arabic over room rumble and hiss.
espeak-ng -v ar -s 140 -w "$T/n1.wav" "السلام عليكم ورحمة الله"
espeak-ng -v ar+whisper -s 130 -w "$T/w1.wav" "هذا كلام هامس لا يكاد يسمع"
espeak-ng -v ar+whisper -s 130 -w "$T/w2.wav" "هل تسمعني الآن"
espeak-ng -v ar -s 140 -w "$T/n2.wav" "انتهى الاختبار"
ffmpeg -loglevel error -y -i "$T/n1.wav" -i "$T/sil.wav" -i "$T/w1.wav" -i "$T/w2.wav" -i "$T/n2.wav" -filter_complex \
  "[0:a]volume=0.6[a0];[2:a]volume=0.06[a2];[3:a]volume=0.06[a3];[4:a]volume=0.6[a4];[1:a][a0][1:a][a2][1:a][a3][1:a][a4][1:a]concat=n=9:v=0:a=1,aresample=44100[s]" \
  -map "[s]" "$T/wspeech.wav"
WD=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$T/wspeech.wav")
ffmpeg -loglevel error -y -i "$T/wspeech.wav" -f lavfi -t "$WD" -i "anoisesrc=color=pink:amplitude=0.006:sample_rate=44100" \
  -f lavfi -t "$WD" -i "anoisesrc=color=brown:amplitude=0.05:sample_rate=44100" \
  -filter_complex "[0:a][1:a][2:a]amix=inputs=3:normalize=0[m]" -map "[m]" -ac 1 -ar 44100 -c:a aac -b:a 96k "$OUT/whisper_mix.m4a"

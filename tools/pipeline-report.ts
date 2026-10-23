/**
 * Runs the enhancement pipeline on a WAV file in Node and prints the report.
 * Usage: npx tsx tools/pipeline-report.ts input.wav [output.wav] [preset]
 * Convert other formats first, e.g. ffmpeg -i in.m4a -ar 24000 in.wav
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { decodeWav, encodeWav16 } from '../src/dsp/wav';
import { enhance, settingsForPreset, type Strength } from '../src/dsp/pipeline';

async function main() {
  const [inPath, outPath, preset = 'balanced'] = process.argv.slice(2);
  if (!inPath) throw new Error('usage: pipeline-report.ts input.wav [output.wav] [preset]');
  const wav = decodeWav(new Uint8Array(readFileSync(inPath)));
  const t0 = Date.now();
  const r = await enhance(wav.channels, wav.sampleRate, settingsForPreset(preset as Strength));
  const ms = Date.now() - t0;
  const { segments, ...rep } = r.report;
  console.log(JSON.stringify({ ms, sampleRate: wav.sampleRate, segments, ...rep }, (k, v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v), 2));
  if (outPath) writeFileSync(outPath, encodeWav16([r.output], r.sampleRate));
}
main().catch((e) => { console.error(e); process.exit(1); });

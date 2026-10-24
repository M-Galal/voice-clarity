// Writes a 20-minute 16 kHz mono WAV for the long-file e2e test by repeating the whisper fixture
// (normal speech, whispers, room noise) with a slightly different level each time.
// usage: node tests/e2e/make-long-wav.mjs <out.wav> [minutes]
import { readFileSync, openSync, writeSync, closeSync } from 'node:fs';

const out = process.argv[2];
const minutes = Number(process.argv[3] ?? 20);
const src = readFileSync(new URL('../fixtures/whisper_mix_16k.wav', import.meta.url));
// find the data chunk
let off = 12, data = null, rate = 16000;
while (off + 8 <= src.length) {
  const id = src.toString('ascii', off, off + 4);
  const size = src.readUInt32LE(off + 4);
  if (id === 'fmt ') rate = src.readUInt32LE(off + 12);
  if (id === 'data') { data = new Int16Array(src.buffer.slice(src.byteOffset + off + 8, src.byteOffset + off + 8 + size)); break; }
  off += 8 + size + (size % 2);
}
if (!data) throw new Error('fixture has no data chunk');
const total = Math.round(minutes * 60 * rate);
const header = Buffer.alloc(44);
header.write('RIFF', 0); header.writeUInt32LE(36 + total * 2, 4); header.write('WAVE', 8);
header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
header.write('data', 36); header.writeUInt32LE(total * 2, 40);
const fd = openSync(out, 'w');
writeSync(fd, header);
const block = new Int16Array(rate * 10);
for (let pos = 0; pos < total; pos += block.length) {
  const n = Math.min(block.length, total - pos);
  for (let i = 0; i < n; i++) {
    const k = pos + i;
    const rep = Math.floor(k / data.length);
    const g = 0.7 + 0.3 * ((rep * 37) % 10) / 10;
    block[i] = Math.max(-32768, Math.min(32767, Math.round(data[k % data.length] * g)));
  }
  writeSync(fd, Buffer.from(block.buffer, 0, n * 2));
}
closeSync(fd);
console.log(`wrote ${out}: ${minutes} min, ${rate} Hz, ${(44 + total * 2) / 1e6} MB`);

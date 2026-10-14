/**
 * Generate a short, self-made "task finished" chime as a 16-bit mono WAV.
 *
 * Written from scratch (sine partials + exponential decay) so the bundled
 * default sound carries no third-party licence at all. No dependencies, no
 * external assets — run it to regenerate the file:
 *
 *   node scripts/make-chime.mjs            # writes audio/chime.wav
 *   node scripts/make-chime.mjs out.wav
 */
import { writeFileSync } from 'node:fs'

const SAMPLE_RATE = 22_050
const NOTES = [
  { hz: 1046.5, seconds: 0.18 }, // C6
  { hz: 1568.0, seconds: 0.34 }, // G6
]
const AMPLITUDE = 0.32
const ATTACK_SECONDS = 0.006
const FADE_OUT_SECONDS = 0.05

/** One decaying note, additive sine with a soft second partial. */
function renderNote(hz, seconds) {
  const total = Math.round(seconds * SAMPLE_RATE)
  const attack = Math.max(1, Math.round(ATTACK_SECONDS * SAMPLE_RATE))
  const tau = seconds / 3.2
  const samples = new Float64Array(total)
  for (let index = 0; index < total; index += 1) {
    const t = index / SAMPLE_RATE
    const envelope =
      (index < attack ? index / attack : 1) * Math.exp(-t / tau)
    const fundamental = Math.sin(2 * Math.PI * hz * t)
    const second = 0.22 * Math.sin(2 * Math.PI * hz * 2 * t)
    samples[index] = AMPLITUDE * envelope * (fundamental + second)
  }
  return samples
}

const rendered = NOTES.flatMap((note) => [...renderNote(note.hz, note.seconds)])
/* Guarantee a silent end so the file never clicks on playback. */
const fade = Math.round(FADE_OUT_SECONDS * SAMPLE_RATE)
for (let index = 0; index < fade; index += 1) {
  const at = rendered.length - fade + index
  if (at >= 0) rendered[at] *= 1 - index / fade
}

const data = Buffer.alloc(rendered.length * 2)
for (let index = 0; index < rendered.length; index += 1) {
  const clamped = Math.max(-1, Math.min(1, rendered[index]))
  data.writeInt16LE(Math.round(clamped * 32_767), index * 2)
}

const header = Buffer.alloc(44)
header.write('RIFF', 0, 'latin1')
header.writeUInt32LE(36 + data.length, 4)
header.write('WAVE', 8, 'latin1')
header.write('fmt ', 12, 'latin1')
header.writeUInt32LE(16, 16) // PCM chunk size
header.writeUInt16LE(1, 20) // format: PCM
header.writeUInt16LE(1, 22) // channels: mono
header.writeUInt32LE(SAMPLE_RATE, 24)
header.writeUInt32LE(SAMPLE_RATE * 2, 28) // byte rate
header.writeUInt16LE(2, 32) // block align
header.writeUInt16LE(16, 34) // bits per sample
header.write('data', 36, 'latin1')
header.writeUInt32LE(data.length, 40)

const target = process.argv[2] ?? new URL('../audio/chime.wav', import.meta.url)
const path = target instanceof URL ? target : new URL(`file://${target}`)
writeFileSync(path, Buffer.concat([header, data]))
const seconds = (rendered.length / SAMPLE_RATE).toFixed(3)
console.log(`wrote ${path.pathname} — ${String(seconds)}s, ${String(header.length + data.length)} bytes`)

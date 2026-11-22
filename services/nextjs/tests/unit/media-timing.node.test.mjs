import test from "node:test";
import assert from "node:assert/strict";
import { buildMeasuredSrt, combineNaraWavs, parseNaraWav, splitNarrationText } from "../../src/workers/media-timing.mjs";

function wav(pcmSamples = 2_400) {
  const dataLength = pcmSamples * 2;
  const bytes = Buffer.alloc(44 + dataLength);
  bytes.write("RIFF", 0, "ascii"); bytes.writeUInt32LE(36 + dataLength, 4); bytes.write("WAVE", 8, "ascii");
  bytes.write("fmt ", 12, "ascii"); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(24_000, 24); bytes.writeUInt32LE(48_000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write("data", 36, "ascii"); bytes.writeUInt32LE(dataLength, 40);
  return bytes;
}

test("Nara WAV metadata and merged audio duration come from PCM samples", () => {
  const parsed = parseNaraWav(wav(12_000));
  assert.equal(parsed.duration, 0.5);
  const combined = combineNaraWavs([wav(12_000), wav(24_000)]);
  assert.equal(combined.duration, 1.5);
  assert.equal(parseNaraWav(combined.wav).duration, 1.5);
});

test("invalid WAV formats fail closed", () => {
  const invalid = wav();
  invalid.writeUInt32LE(16_000, 24);
  assert.throws(() => parseNaraWav(invalid), /mono 24 kHz PCM16/);
  assert.throws(() => combineNaraWavs([]), /At least one/);
});

test("text is chunked without exceeding Nara Mini's request limit", () => {
  const input = `${"မြန်မာစာ။".repeat(800)}${"a".repeat(5001)}`;
  const chunks = splitNarrationText(input, 4800);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => Array.from(chunk).length <= 4800));
});

test("SRT cue boundaries use measured duration and preserve the narration text", () => {
  const result = buildMeasuredSrt([{ text: "မင်္ဂလာပါ", duration: 1.25 }, { text: "How are you?", duration: 2.5 }]);
  assert.equal(result.duration, 3.75);
  assert.match(result.content, /00:00:00,000 --> 00:00:01,250/);
  assert.match(result.content, /00:00:01,250 --> 00:00:03,750/);
  assert.match(result.content, /မင်္ဂလာပါ/);
});

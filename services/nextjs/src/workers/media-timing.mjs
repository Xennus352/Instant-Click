const SAMPLE_RATE = 24_000;
const CHANNELS = 1;
const BITS_PER_SAMPLE = 16;
const MAX_WAV_BYTES = 256 * 1024 * 1024;

export function splitNarrationText(text, maxCodePoints = 4_800) {
  if (typeof text !== "string" || !text.trim() || !Number.isSafeInteger(maxCodePoints) || maxCodePoints < 100) {
    throw new TypeError("Narration text and a safe positive chunk size are required");
  }
  const sentences = text.trim().split(/(?<=[။.!?…！？၊\n])\s*/u).filter(Boolean);
  const units = [];
  for (const sentence of sentences) {
    let remaining = Array.from(sentence.trim());
    while (remaining.length > maxCodePoints) {
      let cut = maxCodePoints;
      for (let index = maxCodePoints - 1; index >= Math.floor(maxCodePoints * 0.6); index -= 1) {
        if (/\s/u.test(remaining[index])) { cut = index; break; }
      }
      const part = remaining.slice(0, cut).join("").trim();
      if (part) units.push(part);
      remaining = remaining.slice(cut).join("").trimStart().split("");
    }
    const last = remaining.join("").trim();
    if (last) units.push(last);
  }
  const chunks = [];
  let current = "";
  for (const unit of units) {
    const candidate = current ? `${current} ${unit}` : unit;
    if (Array.from(candidate).length > maxCodePoints && current) {
      chunks.push(current);
      current = unit;
    } else current = candidate;
  }
  if (current) chunks.push(current);
  if (!chunks.length || chunks.some((chunk) => Array.from(chunk).length > maxCodePoints)) {
    throw new TypeError("Narration text could not be safely chunked");
  }
  return chunks;
}

export function parseNaraWav(input) {
  const wav = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (wav.length < 44 || wav.length > MAX_WAV_BYTES || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
    throw new TypeError("Nara Mini output is not a bounded RIFF/WAVE file");
  }
  let offset = 12;
  let format;
  let data;
  while (offset + 8 <= wav.length) {
    const name = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > wav.length) throw new TypeError("Nara Mini WAV chunk exceeds the artifact length");
    if (name === "fmt ") {
      if (size < 16) throw new TypeError("Nara Mini WAV format chunk is incomplete");
      format = {
        audioFormat: wav.readUInt16LE(start), channels: wav.readUInt16LE(start + 2),
        sampleRate: wav.readUInt32LE(start + 4), bitsPerSample: wav.readUInt16LE(start + 14),
      };
    } else if (name === "data") data = wav.subarray(start, end);
    offset = end + (size % 2);
  }
  if (!format || !data || format.audioFormat !== 1 || format.channels !== CHANNELS ||
      format.sampleRate !== SAMPLE_RATE || format.bitsPerSample !== BITS_PER_SAMPLE || data.length % 2 !== 0) {
    throw new TypeError("Nara Mini WAV must contain mono 24 kHz PCM16 audio");
  }
  const duration = data.length / (SAMPLE_RATE * CHANNELS * (BITS_PER_SAMPLE / 8));
  if (!Number.isFinite(duration) || duration <= 0) throw new TypeError("Nara Mini WAV contains no audio samples");
  return { pcm: data, duration, sampleRate: SAMPLE_RATE, channels: CHANNELS, bitsPerSample: BITS_PER_SAMPLE };
}

export function combineNaraWavs(wavs) {
  if (!Array.isArray(wavs) || wavs.length === 0) throw new TypeError("At least one Nara Mini WAV is required");
  const parsed = wavs.map(parseNaraWav);
  const dataLength = parsed.reduce((total, item) => total + item.pcm.length, 0);
  if (!Number.isSafeInteger(dataLength) || dataLength > MAX_WAV_BYTES - 44) throw new RangeError("Combined narration exceeds the artifact limit");
  const output = Buffer.allocUnsafe(44 + dataLength);
  output.write("RIFF", 0, "ascii"); output.writeUInt32LE(36 + dataLength, 4); output.write("WAVE", 8, "ascii");
  output.write("fmt ", 12, "ascii"); output.writeUInt32LE(16, 16); output.writeUInt16LE(1, 20);
  output.writeUInt16LE(CHANNELS, 22); output.writeUInt32LE(SAMPLE_RATE, 24);
  output.writeUInt32LE(SAMPLE_RATE * CHANNELS * (BITS_PER_SAMPLE / 8), 28);
  output.writeUInt16LE(CHANNELS * (BITS_PER_SAMPLE / 8), 32); output.writeUInt16LE(BITS_PER_SAMPLE, 34);
  output.write("data", 36, "ascii"); output.writeUInt32LE(dataLength, 40);
  let cursor = 44;
  for (const item of parsed) { item.pcm.copy(output, cursor); cursor += item.pcm.length; }
  return { wav: output, duration: dataLength / (SAMPLE_RATE * CHANNELS * (BITS_PER_SAMPLE / 8)), sampleRate: SAMPLE_RATE };
}

function timestamp(seconds) {
  const milliseconds = Math.round(seconds * 1000);
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const wholeSeconds = Math.floor((milliseconds % 60_000) / 1000);
  const millis = milliseconds % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(wholeSeconds).padStart(2, "0")},${String(millis).padStart(3, "0")}`;
}

/** Subtitle cues are derived only from each synthesized chunk's measured PCM duration. */
export function buildMeasuredSrt(segments) {
  if (!Array.isArray(segments) || segments.length === 0) throw new TypeError("Narration segments are required for subtitles");
  let cursor = 0;
  const cues = segments.map((segment, index) => {
    if (typeof segment.text !== "string" || !segment.text.trim() || !Number.isFinite(segment.duration) || segment.duration <= 0) {
      throw new TypeError("Subtitle text and measured narration duration are required");
    }
    const start = cursor;
    cursor += segment.duration;
    const text = segment.text.replace(/[\r\n]+/gu, " ").trim();
    return `${index + 1}\n${timestamp(start)} --> ${timestamp(cursor)}\n${text}\n`;
  });
  return { content: `${cues.join("\n")}`, duration: cursor };
}

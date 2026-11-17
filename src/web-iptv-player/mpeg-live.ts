const PACKET = 188;

export function prepareSegment(input: ArrayBuffer): { media: ArrayBuffer; audio: Uint8Array | null } {
  const source = new Uint8Array(input);
  if (source.length < PACKET || source[0] !== 0x47) return { media: input, audio: null };
  const audioPids = new Set<number>();
  let sawVideo = false;
  let sawAac = false;
  for (let index = 0; index + PACKET <= source.length; index += PACKET) {
    if (source[index] !== 0x47) return { media: input, audio: null };
    const kinds = pmtStreams(source.subarray(index, index + PACKET));
    if (!kinds) continue;
    for (const stream of kinds) {
      if (stream.type === 0x03 || stream.type === 0x04) audioPids.add(stream.pid);
      if (stream.type === 0x0f || stream.type === 0x11) sawAac = true;
      if (stream.type === 0x1b || stream.type === 0x24) sawVideo = true;
    }
  }
  if (audioPids.size === 0 || !sawVideo || sawAac) return { media: input, audio: null };
  const copy = source.slice();
  const audio = new Uint8Array(source.length);
  let written = 0;
  for (let index = 0; index + PACKET <= copy.length; index += PACKET) {
    const packet = copy.subarray(index, index + PACKET);
    const pid = ((packet[1] & 0x1f) << 8) | packet[2];
    if (pmtStreams(packet)) patchPmt(packet);
    if (!audioPids.has(pid)) continue;
    const payload = pesPayload(packet);
    audio.set(payload, written);
    written += payload.length;
    packet[1] = 0x1f;
    packet[2] = 0xff;
    packet[3] = 0x10;
    packet.fill(0xff, 4);
  }
  return { media: copy.buffer, audio: written ? audio.subarray(0, written) : null };
}

export class LiveMpegAudio {
  private video: HTMLVideoElement;
  private context: AudioContext | null = null;
  private decoder: { ready: Promise<void>; decode: (data: Uint8Array) => { channelData: Float32Array[]; sampleRate: number; samplesDecoded: number } } | null = null;
  private opening: Promise<void> | null = null;
  private rest = new Uint8Array(0);
  private queue: Array<{ start: number; buffer: AudioBuffer }> = [];
  private active: AudioBufferSourceNode | null = null;
  private activeStart = 0;
  private activeAt = 0;
  private closed = false;

  constructor(video: HTMLVideoElement) {
    this.video = video;
  }

  push(chunk: Uint8Array, mediaStart: number): void {
    if (this.closed || !chunk.length) return;
    void this.open().then(() => {
      if (this.closed || !this.decoder || !this.context) return;
      try {
        const joined = new Uint8Array(this.rest.length + chunk.length);
        joined.set(this.rest);
        joined.set(chunk, this.rest.length);
        const { frames, rest } = takeFrames(joined);
        this.rest = new Uint8Array(rest);
        if (!frames.length) return;
        const decoded = this.decoder.decode(new Uint8Array(frames));
        if (!decoded.samplesDecoded || !decoded.channelData.length) return;
        const buffer = this.context.createBuffer(decoded.channelData.length, decoded.samplesDecoded, decoded.sampleRate || 48000);
        decoded.channelData.forEach((channel, index) => buffer.copyToChannel(new Float32Array(channel), index));
        this.queue.push({ start: mediaStart, buffer });
        this.queue = this.queue.filter((item) => item.start + item.buffer.duration > this.video.currentTime - 1).slice(-6);
        this.sync();
      } catch {
        /* this segment's sound could not be decoded */
      }
    });
  }

  resume(): void {
    if (this.closed) return;
    void this.open().then(() => this.context?.resume());
  }

  sync(): void {
    const context = this.context;
    if (!context || this.video.paused) {
      this.stopSource();
      return;
    }
    const now = this.video.currentTime;
    const played = this.active ? this.activeStart + (context.currentTime - this.activeAt) : -1;
    if (this.active && Math.abs(played - now) < 0.35) return;
    const item = this.queue.find((entry) => now >= entry.start && now < entry.start + entry.buffer.duration - 0.05);
    if (!item) return;
    this.stopSource();
    const source = context.createBufferSource();
    source.buffer = item.buffer;
    source.connect(context.destination);
    const offset = Math.max(0, now - item.start);
    this.active = source;
    this.activeStart = now;
    this.activeAt = context.currentTime;
    source.start(context.currentTime, offset);
    source.onended = () => {
      if (this.active === source) this.active = null;
    };
  }

  stop(): void {
    this.closed = true;
    this.stopSource();
    this.queue = [];
    void this.context?.close();
  }

  private open(): Promise<void> {
    if (this.opening) return this.opening;
    this.opening = import("mpg123-decoder").then(async ({ MPEGDecoder }) => {
      if (this.closed) return;
      this.decoder = new MPEGDecoder();
      await this.decoder.ready;
      this.context = new AudioContext();
      void this.context.resume();
    });
    return this.opening;
  }

  private stopSource(): void {
    if (!this.active) return;
    try {
      this.active.stop();
    } catch {
      /* already stopped */
    }
    this.active = null;
  }
}

function takeFrames(data: Uint8Array): { frames: Uint8Array; rest: Uint8Array } {
  let start = syncAt(data, 0);
  if (start < 0) return { frames: new Uint8Array(0), rest: data.slice(-2) };
  let cursor = start;
  while (cursor + 4 < data.length) {
    const next = syncAt(data, cursor);
    if (next < 0) break;
    const size = frameSize(data, next);
    if (!size || next + size > data.length) {
      return { frames: data.subarray(start, next), rest: data.subarray(next) };
    }
    cursor = next + size;
  }
  return { frames: data.subarray(start, cursor), rest: data.subarray(cursor) };
}

function syncAt(data: Uint8Array, from: number): number {
  for (let index = from; index + 1 < data.length; index += 1) {
    if (data[index] === 0xff && (data[index + 1] & 0xe0) === 0xe0) return index;
  }
  return -1;
}

function frameSize(data: Uint8Array, index: number): number {
  const rates = [44100, 48000, 32000];
  const layer = (data[index + 1] >> 1) & 3;
  const bitrateIndex = (data[index + 2] >> 4) & 0xf;
  const rateIndex = (data[index + 2] >> 2) & 3;
  const padding = (data[index + 2] >> 1) & 1;
  const version = (data[index + 1] >> 3) & 3;
  if (!layer || layer === 0 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3 || version === 1) return 0;
  const bitrate = layerBitrate(layer, bitrateIndex);
  const rate = rates[rateIndex] >> (version === 3 ? 0 : 1);
  if (!bitrate || !rate) return 0;
  if (layer === 3) return Math.floor((12 * bitrate * 1000) / rate + padding) * 4;
  return Math.floor((144 * bitrate * 1000) / rate) + padding;
}

function layerBitrate(layer: number, index: number): number {
  const layer2 = [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 0];
  const layer3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
  return (layer === 3 ? layer3 : layer2)[index] || 0;
}

function pmtStreams(packet: Uint8Array): Array<{ type: number; pid: number }> | null {
  const payload = payloadOffset(packet);
  if (payload < 0 || !(packet[1] & 0x40)) return null;
  const table = payload + 1 + packet[payload];
  if (table + 12 >= PACKET || packet[table] !== 2) return null;
  const sectionLength = ((packet[table + 1] & 0x0f) << 8) | packet[table + 2];
  const end = Math.min(table + 3 + sectionLength - 4, PACKET);
  const info = ((packet[table + 10] & 0x0f) << 8) | packet[table + 11];
  const streams: Array<{ type: number; pid: number }> = [];
  let cursor = table + 12 + info;
  while (cursor + 5 <= end) {
    const type = packet[cursor];
    const pid = ((packet[cursor + 1] & 0x1f) << 8) | packet[cursor + 2];
    const extra = ((packet[cursor + 3] & 0x0f) << 8) | packet[cursor + 4];
    streams.push({ type, pid });
    cursor += 5 + extra;
  }
  return streams.length ? streams : null;
}

function patchPmt(packet: Uint8Array): void {
  const payload = payloadOffset(packet);
  if (payload < 0) return;
  const table = payload + 1 + packet[payload];
  if (packet[table] !== 2) return;
  const sectionLength = ((packet[table + 1] & 0x0f) << 8) | packet[table + 2];
  const end = table + 3 + sectionLength;
  if (end > PACKET) return;
  const info = ((packet[table + 10] & 0x0f) << 8) | packet[table + 11];
  let cursor = table + 12 + info;
  const crcAt = end - 4;
  const kept: number[] = [];
  while (cursor + 5 <= crcAt) {
    const extra = ((packet[cursor + 3] & 0x0f) << 8) | packet[cursor + 4];
    const size = 5 + extra;
    if (packet[cursor] !== 0x03 && packet[cursor] !== 0x04) kept.push(...packet.subarray(cursor, cursor + size));
    cursor += size;
  }
  const headLength = table + 12 + info - table;
  const body = new Uint8Array(headLength + kept.length);
  body.set(packet.subarray(table, table + headLength));
  body.set(kept, headLength);
  const newLength = body.length + 4 - 3;
  body[1] = (body[1] & 0xf0) | ((newLength >> 8) & 0x0f);
  body[2] = newLength & 0xff;
  const crc = mpegCrc(body);
  packet.fill(0xff, table, PACKET);
  packet.set(body, table);
  packet[table + body.length] = (crc >>> 24) & 0xff;
  packet[table + body.length + 1] = (crc >>> 16) & 0xff;
  packet[table + body.length + 2] = (crc >>> 8) & 0xff;
  packet[table + body.length + 3] = crc & 0xff;
}

function pesPayload(packet: Uint8Array): Uint8Array {
  const offset = payloadOffset(packet);
  if (offset < 0 || offset >= PACKET) return new Uint8Array(0);
  let chunk = packet.subarray(offset);
  if ((packet[1] & 0x40) && chunk.length > 9 && chunk[0] === 0 && chunk[1] === 0 && chunk[2] === 1) {
    chunk = chunk.subarray(9 + chunk[8]);
  }
  return chunk;
}

function payloadOffset(packet: Uint8Array): number {
  const adapt = (packet[3] >> 4) & 3;
  if (adapt === 1) return 4;
  if (adapt === 3) return 5 + packet[4];
  return -1;
}

function mpegCrc(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const value of bytes) {
    crc ^= value << 24;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x80000000 ? ((crc << 1) ^ 0x04c11db7) >>> 0 : (crc << 1) >>> 0;
    }
  }
  return crc >>> 0;
}

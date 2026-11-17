type Sample = { pts: number; key: boolean; data: Uint8Array };
type Cue = { timeMs: number; offset: number };
type Pending = { bytes: Uint8Array; filePos: number; fetched: number };
type Ac3Decoder = {
  decode: (data: Uint8Array) => { channelData: Float32Array[]; sampleRate: number };
  errors: number;
  free: () => void;
};

const VIDEO_TIMESCALE = 24000;
const FRAME_TICKS = 1001;
const CHUNK = 512 * 1024;

export function playMatroska(
  video: HTMLVideoElement,
  url: string,
  options: { startAt?: number; onFail: () => void },
): { stop: () => void; resume: () => void; sync: () => void } {
  const Factory = (window as unknown as { ManagedMediaSource?: typeof MediaSource }).ManagedMediaSource || window.MediaSource;
  let stopped = false;
  let resumeAudio = () => undefined as void;
  let syncAudio = () => undefined as void;
  let cleanup = () => undefined as void;
  if (!Factory) {
    video.src = url;
    return { stop: () => undefined, resume: () => undefined, sync: () => undefined };
  }
  video.disableRemotePlayback = true;
  void run(video, url, Factory, options, () => stopped, (hooks) => {
    resumeAudio = hooks.resume;
    syncAudio = hooks.sync;
    cleanup = hooks.cleanup;
  }).catch(() => {
    if (!stopped) options.onFail();
  });
  return {
    stop: () => {
      stopped = true;
      cleanup();
    },
    resume: () => resumeAudio(),
    sync: () => syncAudio(),
  };
}

async function run(
  video: HTMLVideoElement,
  url: string,
  Factory: typeof MediaSource,
  options: { startAt?: number; onFail: () => void },
  stopped: () => boolean,
  bind: (hooks: { resume: () => void; sync: () => void; cleanup: () => void }) => void,
): Promise<void> {
  const audio = new Ac3Output(video);
  let media: MediaSource | null = null;
  let objectUrl = "";
  let source: SourceBuffer | null = null;
  let ignoreSeek = false;
  let seekTo: number | null = null;
  let epoch = 0;
  const onSeek = () => {
    if (ignoreSeek || stopped()) return;
    const target = video.currentTime;
    if (!Number.isFinite(target)) return;
    if (source && media && media.readyState === "open" && covers(video, target) && audio.covers(target)) {
      audio.sync();
      return;
    }
    seekTo = target;
    epoch += 1;
  };
  const setDuration = (next: MediaSource, length: number) => {
    if (!Number.isFinite(length) || length <= 0) return;
    ignoreSeek = true;
    try {
      next.duration = length;
    } catch {
      /* the element already has a duration */
    }
    ignoreSeek = false;
  };
  bind({
    resume: () => audio.resume(),
    sync: () => audio.sync(),
    cleanup: () => {
      audio.stop();
      video.removeEventListener("seeking", onSeek);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = "";
    },
  });
  const boot = async (): Promise<MediaSource> => {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    const next = new Factory();
    objectUrl = URL.createObjectURL(next);
    video.src = objectUrl;
    await once(next, "sourceopen", 8000);
    return next;
  };
  media = await boot();
  if (stopped()) return;
  const header = await loadHeader(url);
  if (stopped() || !header.video || header.avcC.length < 7) throw new Error("tracks");
  const mime = `video/mp4; codecs="avc1.${header.codec}"`;
  if (typeof Factory.isTypeSupported === "function" && !Factory.isTypeSupported(mime)) throw new Error("codec");
  source = media.addSourceBuffer(mime);
  video.addEventListener("seeking", onSeek);
  const cuesPromise = loadCues(url, header).catch(() => [] as Cue[]);
  let cues: Cue[] | null = null;
  const cuesReady = async () => {
    if (!cues) cues = await cuesPromise;
    return cues;
  };
  await append(source, initSegment(header));
  const duration = header.durationMs / 1000;
  setDuration(media, duration);
  const startAt = Math.max(0, options.startAt || 0);
  let offset = header.clusterOffset;
  if (startAt > 1) {
    const cue = lastCue(await cuesReady(), startAt * 1000);
    if (cue) offset = cue.offset;
  }
  const pending: Pending = { bytes: new Uint8Array(0), filePos: offset, fetched: offset };
  let sequence = 1;
  let dts = -1;
  let started = false;
  let needKey = true;
  let misses = 0;
  while (!stopped()) {
    const ep = epoch;
    if (seekTo != null) {
      const target = seekTo;
      seekTo = null;
      if (!source || !media || media.readyState !== "open") {
        media = await boot();
        if (stopped()) return;
        source = media.addSourceBuffer(mime);
        await append(source, initSegment(header));
        setDuration(media, duration);
      }
      const buffer = source;
      if (!buffer) continue;
      await idle(buffer);
      if (ep !== epoch || stopped()) continue;
      if (buffer.buffered.length) {
        const end = buffer.buffered.end(buffer.buffered.length - 1);
        buffer.remove(0, end);
        await idle(buffer);
      }
      audio.clear();
      const cue = lastCue(await cuesReady(), target * 1000);
      offset = cue?.offset || header.clusterOffset;
      pending.bytes = new Uint8Array(0);
      pending.filePos = offset;
      pending.fetched = offset;
      dts = -1;
      needKey = true;
      ignoreSeek = true;
      if (Math.abs(video.currentTime - target) > 0.2) video.currentTime = target;
      ignoreSeek = false;
      continue;
    }
    if (offset >= header.fileSize && pending.bytes.length < 16) {
      audio.flush();
      await waitFor(video, stopped, () => epoch !== ep || seekTo != null, 400);
      if (epoch !== ep || seekTo != null) continue;
      if (media && video.currentTime > 1 && duration > 0 && video.currentTime >= duration - 0.75) {
        try {
          if (media.readyState === "open") media.endOfStream();
        } catch {
          /* already ended */
        }
      }
      continue;
    }
    await waitForRoom(video, stopped, () => epoch !== ep);
    if (ep !== epoch || stopped()) continue;
    let cluster: { video: Sample[]; audio: Sample[]; next: number } | null = null;
    try {
      cluster = await nextCluster(url, pending, header, header.audioTrack, header.videoTrack);
      misses = 0;
    } catch {
      misses += 1;
      if (misses >= 8 && !started) throw new Error("network");
      await waitFor(video, stopped, () => epoch !== ep, 400 * Math.min(misses, 5));
      continue;
    }
    if (ep !== epoch || stopped()) continue;
    if (!cluster) {
      offset = header.fileSize;
      pending.bytes = new Uint8Array(0);
      continue;
    }
    offset = cluster.next;
    let frames = cluster.video;
    if (needKey) {
      const keyAt = frames.findIndex((sample) => sample.key);
      if (keyAt < 0) frames = [];
      else {
        frames = frames.slice(keyAt);
        needKey = false;
      }
    }
    if (frames.length && source) {
      if (dts < 0) dts = Math.max(0, Math.round((frames[0].pts * VIDEO_TIMESCALE) / 1000));
      const built = buildFragment(frames, sequence, dts);
      if (built) {
        try {
          await append(source, built.data);
        } catch {
          if (stopped() || ep !== epoch) continue;
          await trim(source, video, 8);
          await append(source, built.data);
        }
        sequence += 1;
        dts = built.nextDts;
      }
    }
    const origin = frames[0]?.pts ?? cluster.audio[0]?.pts ?? 0;
    for (const block of cluster.audio) {
      if (needKey && block.pts < origin) continue;
      audio.push(block.data, block.pts / 1000);
    }
    audio.flush();
    if (source) await trim(source, video, 50);
    if (!started && frames.length) {
      started = true;
      if (media) setDuration(media, duration);
      if (startAt > 1) {
        ignoreSeek = true;
        video.currentTime = startAt;
        ignoreSeek = false;
      }
      audio.resume();
      void video.play().catch(() => undefined);
    }
  }
}

async function waitForRoom(video: HTMLVideoElement, stopped: () => boolean, bumped: () => boolean): Promise<void> {
  while (!stopped() && !bumped() && ahead(video) > 20) await waitFor(video, stopped, bumped, 500);
}

function ahead(video: HTMLVideoElement): number {
  if (!video.buffered.length) return 0;
  return video.buffered.end(video.buffered.length - 1) - video.currentTime;
}

function covers(video: HTMLVideoElement, time: number): boolean {
  for (let index = 0; index < video.buffered.length; index += 1) {
    if (time >= video.buffered.start(index) - 0.15 && time <= video.buffered.end(index) - 0.75) return true;
  }
  return false;
}

async function trim(source: SourceBuffer, video: HTMLVideoElement, keep: number): Promise<void> {
  if (source.updating || !source.buffered.length) return;
  const start = source.buffered.start(0);
  const cut = video.currentTime - keep;
  if (cut - start < 12) return;
  source.remove(start, cut);
  await idle(source);
}

function once(target: EventTarget, type: string, timeout: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      target.removeEventListener(type, onEvent);
      reject(new Error(type));
    }, timeout);
    const onEvent = () => {
      window.clearTimeout(timer);
      resolve();
    };
    target.addEventListener(type, onEvent, { once: true });
  });
}

function waitFor(video: HTMLVideoElement, stopped: () => boolean, bumped: () => boolean, ms: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      video.removeEventListener("timeupdate", finish);
      video.removeEventListener("seeking", finish);
      video.removeEventListener("play", finish);
      resolve();
    };
    const timer = window.setTimeout(finish, ms);
    video.addEventListener("timeupdate", finish);
    video.addEventListener("seeking", finish);
    video.addEventListener("play", finish);
    if (stopped() || bumped()) finish();
  });
}

function idle(source: SourceBuffer): Promise<void> {
  if (!source.updating) return Promise.resolve();
  return new Promise((resolve) => source.addEventListener("updateend", () => resolve(), { once: true }));
}

function append(source: SourceBuffer, chunk: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => {
      cleanup();
      resolve();
    };
    const fail = () => {
      cleanup();
      reject(new Error("append"));
    };
    const cleanup = () => {
      source.removeEventListener("updateend", done);
      source.removeEventListener("error", fail);
    };
    source.addEventListener("updateend", done);
    source.addEventListener("error", fail);
    try {
      source.appendBuffer(chunk.slice().buffer);
    } catch (error) {
      cleanup();
      reject(error instanceof Error ? error : new Error("append"));
    }
  });
}

type Header = {
  fileSize: number;
  segmentStart: number;
  clusterOffset: number;
  durationMs: number;
  codec: string;
  width: number;
  height: number;
  avcC: Uint8Array;
  video: boolean;
  videoTrack: number;
  audioTrack: number;
  cuesOffset: number;
};

async function loadHeader(url: string): Promise<Header> {
  const first = await fetchRange(url, 0, 256 * 1024);
  let header = parseHeader(new Reader(first.data), first.total);
  if (header.clusterOffset > first.data.length) {
    const more = await fetchRange(url, 0, Math.min(first.total - 1, header.clusterOffset + 64));
    header = parseHeader(new Reader(more.data), more.total || first.total);
  }
  if (!header.fileSize) header.fileSize = first.total;
  return header;
}

function parseHeader(reader: Reader, fileSize: number): Header {
  const header: Header = {
    fileSize,
    segmentStart: 0,
    clusterOffset: 0,
    durationMs: 0,
    codec: "640029",
    width: 1280,
    height: 720,
    avcC: new Uint8Array(),
    video: false,
    videoTrack: 1,
    audioTrack: 0,
    cuesOffset: 0,
  };
  let scale = 1_000_000;
  let durationUnits = 0;
  const top = reader.element();
  if (!top || top.id !== 0x1a45dfa3) throw new Error("ebml");
  reader.pos = top.end;
  const segment = reader.element();
  if (!segment || segment.id !== 0x18538067) throw new Error("segment");
  header.segmentStart = reader.pos;
  const segmentEnd = segment.end;
  while (reader.pos + 2 < segmentEnd && reader.pos + 2 < reader.data.length) {
    const element = reader.element();
    if (!element) break;
    if (element.id === 0x1f43b675) {
      header.clusterOffset = element.at;
      break;
    }
    if (element.id === 0x1549a966) {
      const end = Math.min(element.end, reader.data.length);
      while (reader.pos + 2 < end) {
        const child = reader.element();
        if (!child) break;
        if (child.id === 0x2ad7b1) scale = reader.uint(child);
        if (child.id === 0x4489) durationUnits = reader.float(child);
        reader.pos = child.end;
      }
    } else if (element.id === 0x1654ae6b) {
      readTracks(reader, Math.min(element.end, reader.data.length), header);
    } else if (element.id === 0x114d9b74) {
      readSeeks(reader, Math.min(element.end, reader.data.length), header);
    }
    if (element.end > reader.data.length) break;
    reader.pos = element.end;
  }
  header.durationMs = (durationUnits * scale) / 1_000_000;
  if (header.cuesOffset) header.cuesOffset += header.segmentStart;
  return header;
}

function readTracks(reader: Reader, end: number, header: Header): void {
  let spareAudio = 0;
  while (reader.pos + 2 < end) {
    const entry = reader.element();
    if (!entry || entry.id !== 0xae) {
      if (entry) reader.pos = entry.end;
      else break;
      continue;
    }
    let number = 0;
    let type = 0;
    let codec = "";
    let fallback = true;
    let avcC = new Uint8Array();
    const entryEnd = entry.end;
    while (reader.pos + 2 < entryEnd && reader.pos + 2 <= reader.data.length) {
      const child = reader.element();
      if (!child || child.end > reader.data.length) break;
      if (child.id === 0xd7) number = reader.uint(child);
      else if (child.id === 0x83) type = reader.uint(child);
      else if (child.id === 0x86) codec = reader.text(child);
      else if (child.id === 0x88) fallback = reader.uint(child) !== 0;
      else if (child.id === 0x63a2 && codec.startsWith("V_MPEG4")) avcC = new Uint8Array(reader.bytes(child));
      else if (child.id === 0xe0) {
        const boxEnd = child.end;
        while (reader.pos + 2 < boxEnd) {
          const video = reader.element();
          if (!video) break;
          if (video.id === 0xb0) header.width = reader.uint(video);
          if (video.id === 0xba) header.height = reader.uint(video);
          reader.pos = video.end;
        }
      }
      reader.pos = child.end;
    }
    if (type === 1 && codec === "V_MPEG4/ISO/AVC" && avcC.length > 4) {
      header.video = true;
      header.videoTrack = number || 1;
      header.avcC = avcC;
      header.codec = [avcC[1], avcC[2], avcC[3]].map((value) => value.toString(16).padStart(2, "0")).join("");
      const size = spsSize(avcC);
      if (size) {
        header.width = size.width;
        header.height = size.height;
      }
    }
    if (type === 2 && (codec === "A_AC3" || codec === "A_EAC3")) {
      if (!spareAudio) spareAudio = number;
      if (fallback && !header.audioTrack) header.audioTrack = number;
    }
    reader.pos = entryEnd;
  }
  if (!header.audioTrack) header.audioTrack = spareAudio;
}

function readSeeks(reader: Reader, end: number, header: Header): void {
  while (reader.pos + 2 < end) {
    const seek = reader.element();
    if (!seek) break;
    let id = 0;
    let position = 0;
    const seekEnd = seek.end;
    while (reader.pos + 2 < seekEnd) {
      const child = reader.element();
      if (!child) break;
      if (child.id === 0x53ab) id = reader.uint(child);
      if (child.id === 0x53ac) position = reader.uint(child);
      reader.pos = child.end;
    }
    if (id === 0x1c53bb6b) header.cuesOffset = position;
    reader.pos = seekEnd;
  }
}

async function loadCues(url: string, header: Header): Promise<Cue[]> {
  if (!header.cuesOffset || header.cuesOffset >= header.fileSize) return [];
  const range = await fetchRange(url, header.cuesOffset, Math.min(header.fileSize - 1, header.cuesOffset + 80_000));
  const reader = new Reader(range.data);
  const cues = reader.element();
  if (!cues || cues.id !== 0x1c53bb6b) return [];
  const points: Cue[] = [];
  const end = Math.min(cues.end, range.data.length);
  while (reader.pos + 2 < end) {
    const point = reader.element();
    if (!point || point.id !== 0xbb) {
      if (point) reader.pos = point.end;
      else break;
      continue;
    }
    let timeMs = 0;
    let position = 0;
    const pointEnd = Math.min(point.end, range.data.length);
    while (reader.pos + 2 < pointEnd) {
      const child = reader.element();
      if (!child) break;
      if (child.id === 0xb3) timeMs = reader.uint(child);
      else if (child.id === 0xb7) {
        const boxEnd = Math.min(child.end, range.data.length);
        while (reader.pos + 2 < boxEnd) {
          const nested = reader.element();
          if (!nested) break;
          if (nested.id === 0xf1 && !position) position = reader.uint(nested);
          reader.pos = nested.end;
        }
      }
      reader.pos = child.end;
    }
    if (position) points.push({ timeMs, offset: header.segmentStart + position });
    reader.pos = pointEnd;
  }
  return points;
}

function lastCue(cues: Cue[], timeMs: number): Cue | null {
  let chosen: Cue | null = null;
  for (const cue of cues) {
    if (cue.timeMs <= timeMs) chosen = cue;
  }
  return chosen;
}

async function nextCluster(url: string, pending: Pending, header: Header, audioTrack: number, videoTrack: number): Promise<{ video: Sample[]; audio: Sample[]; next: number } | null> {
  while (pending.filePos < header.fileSize) {
    if (pending.bytes.length < 16 && pending.fetched < header.fileSize) {
      const grew = await pull(url, pending, header);
      if (!grew && pending.bytes.length < 16) return null;
    }
    const reader = new Reader(pending.bytes);
    const element = reader.element();
    if (!element) return null;
    if (element.end > pending.bytes.length) {
      if (pending.fetched >= header.fileSize) return null;
      const before = pending.bytes.length;
      await pull(url, pending, header);
      if (pending.bytes.length === before) return null;
      continue;
    }
    const size = element.end;
    if (size <= 0) return null;
    if (element.id === 0x1c53bb6b || element.id === 0x1254c367) return null;
    if (element.id !== 0x1f43b675) {
      pending.bytes = pending.bytes.subarray(size);
      pending.filePos += size;
      continue;
    }
    const data = pending.bytes.subarray(0, size);
    pending.bytes = pending.bytes.subarray(size);
    pending.filePos += size;
    return parseCluster(data, audioTrack, videoTrack, pending.filePos);
  }
  return null;
}

async function pull(url: string, pending: Pending, header: Header): Promise<boolean> {
  if (pending.fetched >= header.fileSize) return false;
  const end = Math.min(header.fileSize - 1, pending.fetched + CHUNK - 1);
  const range = await fetchRange(url, pending.fetched, end);
  if (range.total > header.fileSize) header.fileSize = range.total;
  const merged = new Uint8Array(pending.bytes.length + range.data.length);
  merged.set(pending.bytes, 0);
  merged.set(range.data, pending.bytes.length);
  pending.bytes = merged;
  pending.fetched = end + 1;
  return range.data.length > 0;
}

function parseCluster(data: Uint8Array, audioTrack: number, videoTrack: number, next: number): { video: Sample[]; audio: Sample[]; next: number } {
  const reader = new Reader(data);
  const element = reader.element();
  if (!element || element.id !== 0x1f43b675) return { video: [], audio: [], next };
  let timestamp = 0;
  const video: Sample[] = [];
  const audio: Sample[] = [];
  const limit = Math.min(element.end, data.length);
  while (reader.pos + 2 < limit) {
    const child = reader.element();
    if (!child || child.end > data.length) break;
    if (child.id === 0xe7) timestamp = reader.uint(child);
    else if (child.id === 0xa3) pushBlock(reader.bytes(child), timestamp, true, true, audioTrack, videoTrack, video, audio);
    else if (child.id === 0xa0) {
      let reference = false;
      let block: Uint8Array | null = null;
      const groupEnd = child.end;
      while (reader.pos + 2 < groupEnd) {
        const nested = reader.element();
        if (!nested) break;
        if (nested.id === 0xfb) reference = true;
        if (nested.id === 0xa1) block = reader.bytes(nested);
        reader.pos = nested.end;
      }
      if (block) pushBlock(block, timestamp, false, !reference, audioTrack, videoTrack, video, audio);
    }
    reader.pos = child.end;
  }
  return { video, audio, next };
}

function pushBlock(block: Uint8Array, clusterMs: number, simple: boolean, keyframe: boolean, audioTrack: number, videoTrack: number, video: Sample[], audio: Sample[]): void {
  const reader = new Reader(block);
  const track = reader.vint();
  if (reader.pos + 3 > block.length) return;
  const raw = (block[reader.pos] << 8) | block[reader.pos + 1];
  const relative = (raw << 16) >> 16;
  const flags = block[reader.pos + 2];
  const payload = block.subarray(reader.pos + 3);
  const pts = clusterMs + relative;
  const key = simple ? (flags & 0x80) !== 0 : keyframe;
  const frames = laced(payload, flags);
  frames.forEach((frame, index) => {
    const sample = { pts: pts + index * (track === audioTrack ? 32 : 0), key: key && index === 0, data: frame };
    if (track === videoTrack) video.push(sample);
    else if (track === audioTrack) audio.push(sample);
  });
}

function laced(payload: Uint8Array, flags: number): Uint8Array[] {
  const mode = (flags >> 1) & 3;
  if (mode === 0 || !payload.length) return [payload];
  const count = payload[0] + 1;
  if (mode === 2) {
    const size = Math.floor((payload.length - 1) / count);
    if (size <= 0) return [payload];
    return Array.from({ length: count }, (_, index) => payload.subarray(1 + index * size, 1 + (index + 1) * size));
  }
  if (mode === 1) {
    const sizes: number[] = [];
    let cursor = 1;
    for (let index = 0; index < count - 1; index += 1) {
      let size = 0;
      while (cursor < payload.length && payload[cursor] === 255) {
        size += 255;
        cursor += 1;
      }
      if (cursor >= payload.length) break;
      size += payload[cursor];
      cursor += 1;
      sizes.push(size);
    }
    const frames = sizes.map((size) => {
      const frame = payload.subarray(cursor, Math.min(payload.length, cursor + size));
      cursor += size;
      return frame;
    });
    frames.push(payload.subarray(cursor));
    return frames;
  }
  return [payload];
}

function buildFragment(samples: Sample[], sequence: number, dts: number): { data: Uint8Array; nextDts: number } | null {
  const usable = samples.filter((sample) => sample.data.length);
  if (!usable.length) return null;
  const first = Math.max(0, dts);
  const rows = usable.map((sample, index) => {
    const decode = first + index * FRAME_TICKS;
    const present = Math.max(0, Math.round((sample.pts * VIDEO_TIMESCALE) / 1000));
    return { size: sample.data.length, cto: present - decode, flags: sample.key ? 0x02000000 : 0x00010000, data: sample.data };
  });
  const moof = moofBox(sequence, first, rows);
  const payload = join(rows.map((row) => row.data));
  return { data: join([moof, box("mdat", payload)]), nextDts: first + rows.length * FRAME_TICKS };
}

function initSegment(header: Header): Uint8Array {
  const duration = Math.max(0, Math.round((header.durationMs / 1000) * VIDEO_TIMESCALE));
  const avc1 = visualSample(header);
  const stbl = box("stbl", box("stsd", full(0, u32(1), avc1)), emptyTable("stts"), emptyTable("stsc"), emptyTable("stsz"), emptyTable("stco"));
  const minf = box("minf", box("vmhd", u32(0x00010000)), box("dinf", box("dref", full(0, u32(1), box("url ", u32(1))))), stbl);
  const mdia = box("mdia", mdhd(duration), hdlr(), minf);
  const trak = box("trak", tkhd(header, duration), mdia);
  const moov = box("moov", mvhd(duration), trak, box("mvex", box("trex", u32(0), u32(1), u32(1), u32(0), u32(0), u32(0))));
  return join([box("ftyp", four("isom"), u32(1), four("isom"), four("iso6"), four("avc1")), moov]);
}

function moofBox(sequence: number, dts: number, rows: Array<{ size: number; cto: number; flags: number }>): Uint8Array {
  const trun = trunBox(rows);
  const high = Math.floor(dts / 0x100000000);
  const low = dts >>> 0;
  const traf = box("traf", box("tfhd", u32(0x020000), u32(1)), box("tfdt", u32(0x01000000), u32(high), u32(low)), trun);
  const mfhd = box("mfhd", u32(0), u32(sequence));
  const moof = box("moof", mfhd, traf);
  const view = new DataView(moof.buffer, moof.byteOffset, moof.byteLength);
  view.setUint32(moof.length - trun.length + 16, moof.length + 8);
  return moof;
}

function trunBox(rows: Array<{ size: number; cto: number; flags: number }>): Uint8Array {
  const body = new Uint8Array(12 + rows.length * 16);
  const view = new DataView(body.buffer);
  view.setUint32(0, 0x01000000 | 0x0f01);
  view.setUint32(4, rows.length);
  view.setUint32(8, 0);
  rows.forEach((row, index) => {
    const at = 12 + index * 16;
    view.setUint32(at, FRAME_TICKS);
    view.setUint32(at + 4, row.size);
    view.setUint32(at + 8, row.flags);
    view.setInt32(at + 12, row.cto);
  });
  return box("trun", body);
}

function visualSample(header: Header): Uint8Array {
  const body = new Uint8Array(78);
  const view = new DataView(body.buffer);
  view.setUint16(6, 1);
  view.setUint16(24, header.width);
  view.setUint16(26, header.height);
  view.setUint32(28, 0x00480000);
  view.setUint32(32, 0x00480000);
  view.setUint16(40, 1);
  view.setUint16(74, 0x0018);
  view.setInt16(76, -1);
  return box("avc1", body, box("avcC", header.avcC));
}

function mvhd(duration: number): Uint8Array {
  const body = new Uint8Array(100);
  const view = new DataView(body.buffer);
  view.setUint32(12, VIDEO_TIMESCALE);
  view.setUint32(16, duration);
  view.setUint32(20, 0x00010000);
  view.setUint16(24, 0x0100);
  view.setUint32(36, 0x00010000);
  view.setUint32(52, 0x00010000);
  view.setUint32(68, 0x40000000);
  view.setUint32(96, 2);
  return box("mvhd", body);
}

function tkhd(header: Header, duration: number): Uint8Array {
  const body = new Uint8Array(84);
  const view = new DataView(body.buffer);
  view.setUint32(0, 0x00000007);
  view.setUint32(12, 1);
  view.setUint32(20, duration);
  view.setUint32(40, 0x00010000);
  view.setUint32(56, 0x00010000);
  view.setUint32(72, 0x40000000);
  view.setUint32(76, header.width << 16);
  view.setUint32(80, header.height << 16);
  return box("tkhd", body);
}

function mdhd(duration: number): Uint8Array {
  const body = new Uint8Array(24);
  const view = new DataView(body.buffer);
  view.setUint32(12, VIDEO_TIMESCALE);
  view.setUint32(16, duration);
  view.setUint16(20, 0x55c4);
  return box("mdhd", body);
}

function hdlr(): Uint8Array {
  const name = new TextEncoder().encode("VideoHandler");
  const body = new Uint8Array(25 + name.length);
  const view = new DataView(body.buffer);
  view.setUint32(8, 0x76696465);
  body.set(name, 24);
  return box("hdlr", body);
}

function emptyTable(type: string): Uint8Array {
  if (type === "stsz") return box(type, u32(0), u32(0), u32(0));
  return box(type, u32(0), u32(0));
}

function full(version: number, ...parts: Uint8Array[]): Uint8Array {
  return join([u32(version), ...parts]);
}

function box(type: string, ...parts: Uint8Array[]): Uint8Array {
  const body = join(parts);
  const out = new Uint8Array(8 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, out.length);
  out.set(four(type), 4);
  out.set(body, 8);
  return out;
}

function four(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function u32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value >>> 0);
  return bytes;
}

function join(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

class Ac3Output {
  private video: HTMLVideoElement;
  private context: AudioContext | null = null;
  private gain: GainNode | null = null;
  private decoder: Ac3Decoder | null = null;
  private opening: Promise<void> | null = null;
  private queue: Array<{ start: number; buffer: AudioBuffer }> = [];
  private group: { start: number; left: Float32Array[]; right: Float32Array[]; rate: number } | null = null;
  private active: AudioBufferSourceNode | null = null;
  private activeStart = 0;
  private activeAt = 0;
  private era = 0;
  private closed = false;

  constructor(video: HTMLVideoElement) {
    this.video = video;
  }

  push(frame: Uint8Array, start: number): void {
    if (this.closed || frame.length < 8) return;
    const era = this.era;
    const copy = new Uint8Array(frame);
    void this.open().then(() => {
      if (this.closed || era !== this.era || !this.decoder || !this.context) return;
      try {
        const before = this.decoder.errors;
        const decoded = this.decoder.decode(copy);
        if (this.decoder.errors > before || !decoded.channelData.length || !decoded.channelData[0]?.length) return;
        const channels = decoded.channelData.map((channel) => new Float32Array(channel));
        const mixed = mix(channels);
        this.addPcm(start, mixed.left, mixed.right, decoded.sampleRate || 48000);
        this.sync();
      } catch {
        /* skip a broken frame */
      }
    });
  }

  flush(): void {
    this.flushGroup();
    this.sync();
  }

  covers(time: number): boolean {
    return this.queue.some((item) => time >= item.start - 0.05 && time < item.start + item.buffer.duration - 0.05);
  }

  resume(): void {
    if (this.closed) return;
    void this.open().then(() => this.context?.resume());
  }

  sync(): void {
    const context = this.context;
    if (!context || !this.gain) return;
    if (context.state === "suspended") void context.resume();
    if (this.video.paused) {
      this.stopSource();
      return;
    }
    const now = this.video.currentTime;
    const played = this.active ? this.activeStart + (context.currentTime - this.activeAt) : -1;
    if (this.active && Math.abs(played - now) < 0.3) return;
    const item = this.queue.find((entry) => now >= entry.start && now < entry.start + entry.buffer.duration - 0.04);
    if (!item) return;
    this.stopSource();
    const source = context.createBufferSource();
    source.buffer = item.buffer;
    source.connect(this.gain);
    const offset = Math.max(0, Math.min(item.buffer.duration - 0.01, now - item.start));
    this.active = source;
    this.activeStart = now;
    this.activeAt = context.currentTime;
    source.start(context.currentTime, offset);
    source.onended = () => {
      if (this.active !== source) return;
      this.active = null;
      this.sync();
    };
  }

  clear(): void {
    this.era += 1;
    this.group = null;
    this.queue = [];
    this.stopSource();
  }

  stop(): void {
    this.closed = true;
    this.clear();
    this.decoder?.free();
    this.decoder = null;
    this.video.removeEventListener("volumechange", this.applyVolume);
    this.video.removeEventListener("playing", this.onPlaying);
    void this.context?.close();
    this.context = null;
  }

  private addPcm(start: number, left: Float32Array, right: Float32Array, rate: number): void {
    const count = Math.min(left.length, right.length);
    if (!count) return;
    const group = this.group;
    const expected = group ? group.start + this.groupSamples(group) / group.rate : start;
    if (!group || Math.abs(start - expected) > 0.02) {
      this.flushGroup();
      this.group = { start, left: [left.subarray(0, count)], right: [right.subarray(0, count)], rate };
    } else {
      group.left.push(left.subarray(0, count));
      group.right.push(right.subarray(0, count));
    }
    if (this.group && this.groupSamples(this.group) / this.group.rate >= 0.25) this.flushGroup();
  }

  private groupSamples(group: { left: Float32Array[] }): number {
    return group.left.reduce((sum, chunk) => sum + chunk.length, 0);
  }

  private flushGroup(): void {
    const group = this.group;
    this.group = null;
    if (!group || !this.context) return;
    const total = this.groupSamples(group);
    if (!total) return;
    const left = new Float32Array(total);
    const right = new Float32Array(total);
    let offset = 0;
    group.left.forEach((chunk, index) => {
      left.set(chunk, offset);
      right.set(group.right[index], offset);
      offset += chunk.length;
    });
    const buffer = this.context.createBuffer(2, total, group.rate);
    buffer.copyToChannel(left, 0);
    buffer.copyToChannel(right, 1);
    this.queue.push({ start: group.start, buffer });
    const keep = this.video.currentTime - 20;
    this.queue = this.queue.filter((item) => item.start + item.buffer.duration > keep).slice(-140);
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

  private applyVolume = () => {
    if (!this.gain) return;
    this.gain.gain.value = this.video.muted ? 0 : this.video.volume;
  };

  private onPlaying = () => {
    void this.context?.resume();
    this.sync();
  };

  private open(): Promise<void> {
    if (this.opening) return this.opening;
    this.opening = import("@audio/decode-eac3").then(async (mod) => {
      if (this.closed) return;
      this.decoder = await mod.decoder();
      if (this.closed) return;
      const context = new AudioContext();
      this.context = context;
      this.gain = context.createGain();
      this.gain.connect(context.destination);
      this.applyVolume();
      this.video.addEventListener("volumechange", this.applyVolume);
      this.video.addEventListener("playing", this.onPlaying);
      void context.resume();
    });
    return this.opening;
  }
}

function mix(channels: Float32Array[]): { left: Float32Array; right: Float32Array } {
  const leftIn = channels[0] || new Float32Array();
  const rightIn = channels[1] || leftIn;
  if (channels.length < 3) return { left: leftIn, right: rightIn };
  const center = channels[2] || new Float32Array(leftIn.length);
  const backLeft = channels[4] || new Float32Array(leftIn.length);
  const backRight = channels[5] || new Float32Array(leftIn.length);
  const left = new Float32Array(leftIn.length);
  const right = new Float32Array(leftIn.length);
  const length = Math.min(leftIn.length, rightIn.length, center.length);
  for (let index = 0; index < length; index += 1) {
    left[index] = leftIn[index] + 0.707 * (center[index] + (backLeft[index] || 0));
    right[index] = rightIn[index] + 0.707 * (center[index] + (backRight[index] || 0));
  }
  return { left, right };
}

class Reader {
  data: Uint8Array;
  pos = 0;

  constructor(data: Uint8Array) {
    this.data = data;
  }

  element(): { id: number; at: number; end: number } | null {
    if (this.pos + 2 > this.data.length) return null;
    const at = this.pos;
    const start = this.pos;
    const id = this.id();
    const size = this.vint();
    if (this.pos > this.data.length || this.pos < start || !Number.isFinite(size)) return null;
    const end = size === Number.MAX_SAFE_INTEGER ? this.data.length : this.pos + size;
    return { id, at, end };
  }

  id(): number {
    const mark = this.data[this.pos];
    let length = 1;
    let mask = 0x80;
    while (length < 4 && (mark & mask) === 0) {
      mask >>= 1;
      length += 1;
    }
    if (this.pos + length > this.data.length) {
      this.pos = this.data.length + 1;
      return 0;
    }
    const value = uintBytes(this.data, this.pos, length);
    this.pos += length;
    return value;
  }

  vint(): number {
    if (this.pos >= this.data.length) return Number.NaN;
    const mark = this.data[this.pos];
    let length = 1;
    let mask = 0x80;
    while (length < 8 && (mark & mask) === 0) {
      mask >>= 1;
      length += 1;
    }
    if (this.pos + length > this.data.length) return Number.NaN;
    let value = mark & (mask - 1);
    for (let index = 1; index < length; index += 1) value = value * 256 + this.data[this.pos + index];
    this.pos += length;
    if (value === Math.pow(2, 7 * length) - 1) return Number.MAX_SAFE_INTEGER;
    return value;
  }

  uint(element: { end: number }): number {
    return uintBytes(this.data, this.pos, element.end - this.pos);
  }

  float(element: { end: number }): number {
    const size = element.end - this.pos;
    const view = new DataView(this.data.buffer, this.data.byteOffset + this.pos, size);
    if (size === 4) return view.getFloat32(0);
    if (size === 8) return view.getFloat64(0);
    return 0;
  }

  text(element: { end: number }): string {
    return new TextDecoder().decode(this.data.subarray(this.pos, element.end));
  }

  bytes(element: { end: number }): Uint8Array {
    return this.data.subarray(this.pos, element.end);
  }
}

function uintBytes(data: Uint8Array, offset: number, size: number): number {
  let value = 0;
  const end = Math.min(data.length, offset + size);
  for (let index = offset; index < end; index += 1) value = value * 256 + data[index];
  return value;
}

function spsSize(avcC: Uint8Array): { width: number; height: number } | null {
  if (avcC.length < 8 || avcC[0] !== 1) return null;
  const count = avcC[5] & 0x1f;
  if (!count) return null;
  const length = (avcC[6] << 8) | avcC[7];
  const sps = avcC.subarray(8, 8 + length);
  if (sps.length < 5) return null;
  let bit = 8;
  const profile = bits(sps, bit, 8);
  bit += 24;
  bit = golomb(sps, bit).bit;
  if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134].includes(profile)) {
    const chroma = golomb(sps, bit);
    bit = chroma.bit;
    if (chroma.value === 3) bit += 1;
    bit = golomb(sps, bit).bit;
    bit = golomb(sps, bit).bit;
    bit += 1;
    if (bitAt(sps, bit)) return null;
    bit += 1;
  }
  bit = golomb(sps, bit).bit;
  const order = golomb(sps, bit);
  bit = order.bit;
  if (order.value === 0) bit = golomb(sps, bit).bit;
  else if (order.value === 1) return null;
  bit = golomb(sps, bit).bit;
  bit += 1;
  const width = golomb(sps, bit);
  bit = width.bit;
  const height = golomb(sps, bit);
  bit = height.bit;
  const frame = bitAt(sps, bit);
  bit += 1;
  let pixelWidth = (width.value + 1) * 16;
  let pixelHeight = (height.value + 1) * 16 * (frame ? 1 : 2);
  if (!frame) bit += 1;
  bit += 1;
  if (bitAt(sps, bit)) {
    bit += 1;
    const cropLeft = golomb(sps, bit);
    bit = cropLeft.bit;
    const cropRight = golomb(sps, bit);
    bit = cropRight.bit;
    const cropTop = golomb(sps, bit);
    bit = cropTop.bit;
    const cropBottom = golomb(sps, bit);
    pixelWidth -= (cropLeft.value + cropRight.value) * 2;
    pixelHeight -= (cropTop.value + cropBottom.value) * 2 * (frame ? 1 : 2);
  }
  if (pixelWidth < 16 || pixelHeight < 16) return null;
  return { width: pixelWidth, height: pixelHeight };
}

function bits(data: Uint8Array, bit: number, count: number): number {
  let value = 0;
  for (let index = 0; index < count; index += 1) value = (value << 1) | (bitAt(data, bit + index) ? 1 : 0);
  return value;
}

function golomb(data: Uint8Array, bit: number): { value: number; bit: number } {
  let zeros = 0;
  while (zeros < 32 && !bitAt(data, bit + zeros)) zeros += 1;
  let value = 1;
  for (let index = 0; index < zeros; index += 1) value = (value << 1) | (bitAt(data, bit + zeros + 1 + index) ? 1 : 0);
  return { value: value - 1, bit: bit + zeros + 1 + zeros };
}

function bitAt(data: Uint8Array, bit: number): boolean {
  const byte = data[bit >> 3];
  if (byte === undefined) return false;
  return ((byte >> (7 - (bit & 7))) & 1) === 1;
}

async function fetchRange(url: string, start: number, end: number): Promise<{ data: Uint8Array; total: number }> {
  let last = "network";
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await fetch(url, { cache: "no-store", headers: { Range: `bytes=${start}-${end}` } });
      if (!response.ok && response.status !== 206) throw new Error(String(response.status));
      const total = totalSize(response.headers.get("content-range")) || Number(response.headers.get("content-length")) || end + 1;
      const data = new Uint8Array(await response.arrayBuffer());
      if (!data.byteLength) throw new Error("empty");
      const expected = end - start + 1;
      if (response.status === 200 && start > 0 && data.byteLength > expected + 1024) {
        return { data: data.subarray(start, Math.min(data.length, end + 1)), total: data.length };
      }
      return { data, total };
    } catch (error) {
      last = error instanceof Error ? error.message : "network";
      await new Promise((resolve) => window.setTimeout(resolve, 200 * (attempt + 1)));
    }
  }
  throw new Error(last);
}

function totalSize(header: string | null): number {
  const match = /\/(\d+)\s*$/.exec(header || "");
  return match ? Number(match[1]) : 0;
}


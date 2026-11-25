/**
 * Audio input for the visualizer.
 *
 * MercuryDev Músicas does not play audio: Spotify plays in its own app (Spotify Connect),
 * so there is no HTMLAudioElement to plug into a MediaElementAudioSourceNode. The only way
 * to react to the actual sound is to listen to what comes out of the computer:
 *
 *  - "system": getDisplayMedia with audio (Chrome/Edge on Windows share system audio
 *    when "Entire screen" is chosen); the video track is discarded right away.
 *  - "mic": getUserMedia — works on phones or browsers without system audio capture.
 *
 * The signal only goes to AnalyserNodes; nothing is connected to the destination, so the audio is never
 * played again, duplicated or altered. Nothing is recorded or sent.
 */

export type AudioSourceKind = 'system' | 'mic';
export type AudioState = 'off' | 'requesting' | 'live' | 'error';

export interface AudioStatus {
  state: AudioState;
  source: AudioSourceKind | null;
  /** Error code (text in locales: audio.err.<code>). */
  error: 'denied_system' | 'denied_mic' | 'not_found' | 'unsupported' | 'no_audio' | null;
  sampleRate: number | null;
  stereo: boolean;
}

/** Per-frame data, all derived from the signal (zeros when there is no audio). */
export interface AudioFrame {
  live: boolean;
  /** 64 bands on a logarithmic scale (30 Hz – 16 kHz), 0..1. */
  bands: Float32Array<ArrayBuffer>;
  /** Mono waveform, -1..1. */
  wave: Float32Array<ArrayBuffer>;
  waveL: Float32Array<ArrayBuffer>;
  waveR: Float32Array<ArrayBuffer>;
  /** Energy per region, normalized by automatic gain (0..1). */
  bass: number;
  mid: number;
  treble: number;
  energy: number;
  /** 1 at the moment of a bass peak, decays to 0. */
  beat: number;
  /** Raw level (RMS) before normalization, to measure silence. */
  rms: number;
  t: number;
  dt: number;
}

export const BAND_COUNT = 64;
const WAVE_SIZE = 1024;

export const supportsSystemAudio = typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getDisplayMedia) && !/Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
export const supportsMic = typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia);

class AudioInput {
  private status: AudioStatus = { state: 'off', source: null, error: null, sampleRate: null, stereo: false };
  private listeners = new Set<() => void>();

  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private analyser: AnalyserNode | null = null;
  private analyserL: AnalyserNode | null = null;
  private analyserR: AnalyserNode | null = null;

  private freqBytes: Uint8Array<ArrayBuffer> = new Uint8Array(1024);
  private raw = new Float32Array(BAND_COUNT);
  private bandEdges: [number, number][] = [];

  /** Sensitivity chosen by the user (0.5 – 2). */
  gain = 1;

  readonly frame: AudioFrame = {
    live: false,
    bands: new Float32Array(BAND_COUNT),
    wave: new Float32Array(WAVE_SIZE),
    waveL: new Float32Array(WAVE_SIZE),
    waveR: new Float32Array(WAVE_SIZE),
    bass: 0,
    mid: 0,
    treble: 0,
    energy: 0,
    beat: 0,
    rms: 0,
    t: 0,
    dt: 0,
  };

  // automatic gain per region: a slowly decaying peak
  private peak = { bass: 0.25, mid: 0.2, treble: 0.12, bands: 0.35 };
  // beat detection via spectral flux in the bass (sharp rises, not level)
  private fluxHistory = new Float32Array(48);
  private fluxPos = 0;
  private prevLow = new Float32Array(BAND_COUNT);
  private lastBeatAt = 0;
  private lastT = 0;

  getStatus = (): AudioStatus => this.status;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private set(p: Partial<AudioStatus>) {
    this.status = { ...this.status, ...p };
    this.listeners.forEach((l) => l());
  }

  async connect(kind: AudioSourceKind): Promise<void> {
    this.disconnect(false);
    this.set({ state: 'requesting', source: kind, error: null });
    const audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false } as MediaTrackConstraints;
    let stream: MediaStream;
    try {
      if (kind === 'system') {
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: true, // Chrome requires video to share audio; the track is stopped right below
          audio: { ...audio, suppressLocalAudioPlayback: false } as MediaTrackConstraints,
          // Chrome hints: offer "entire screen" with system audio
          systemAudio: 'include',
          selfBrowserSurface: 'exclude',
          monitorTypeSurfaces: 'include',
        } as DisplayMediaStreamOptions);
      } else {
        stream = await navigator.mediaDevices.getUserMedia({ audio });
      }
    } catch (e) {
      const name = e instanceof DOMException ? e.name : '';
      this.set({
        state: 'error',
        error: name === 'NotAllowedError' ? (kind === 'system' ? 'denied_system' : 'denied_mic') : name === 'NotFoundError' ? 'not_found' : 'unsupported',
      });
      return;
    }

    stream.getVideoTracks().forEach((t) => t.stop());
    const tracks = stream.getAudioTracks();
    if (tracks.length === 0) {
      stream.getTracks().forEach((t) => t.stop());
      this.set({ state: 'error', error: 'no_audio' });
      return;
    }

    const ctx = new AudioContext({ latencyHint: 'interactive' });
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
    const src = ctx.createMediaStreamSource(stream);

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.72;
    analyser.minDecibels = -92;
    analyser.maxDecibels = -18;
    src.connect(analyser);

    const channels = tracks[0]!.getSettings().channelCount ?? src.channelCount;
    const stereo = channels >= 2;
    const splitter = ctx.createChannelSplitter(2);
    const analyserL = ctx.createAnalyser();
    const analyserR = ctx.createAnalyser();
    analyserL.fftSize = analyserR.fftSize = 2048;
    src.connect(splitter);
    splitter.connect(analyserL, 0);
    splitter.connect(analyserR, stereo ? 1 : 0);
    // No node goes to ctx.destination: the sound is not played again.

    this.ctx = ctx;
    this.stream = stream;
    this.analyser = analyser;
    this.analyserL = analyserL;
    this.analyserR = analyserR;
    this.freqBytes = new Uint8Array(analyser.frequencyBinCount);
    this.bandEdges = logBands(BAND_COUNT, 30, 16000, ctx.sampleRate, analyser.fftSize);
    this.peak = { bass: 0.25, mid: 0.2, treble: 0.12, bands: 0.35 };
    this.fluxHistory.fill(0);
    this.prevLow.fill(0);

    tracks[0]!.addEventListener('ended', () => {
      if (this.stream === stream) this.disconnect();
    });
    this.set({ state: 'live', error: null, sampleRate: ctx.sampleRate, stereo });
  }

  disconnect(notify = true) {
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close().catch(() => {});
    this.stream = null;
    this.ctx = null;
    this.analyser = this.analyserL = this.analyserR = null;
    this.clearFrame();
    if (notify) this.set({ state: 'off', source: null, error: null, sampleRate: null, stereo: false });
  }

  private clearFrame() {
    const f = this.frame;
    f.live = false;
    f.bands.fill(0);
    f.wave.fill(0);
    f.waveL.fill(0);
    f.waveR.fill(0);
    f.bass = f.mid = f.treble = f.energy = f.beat = f.rms = 0;
  }

  /** Reads the analysers once per frame (called only by the visualizer loop). */
  sample(nowMs: number): AudioFrame {
    const f = this.frame;
    const dt = this.lastT ? Math.min(0.1, (nowMs - this.lastT) / 1000) : 1 / 60;
    this.lastT = nowMs;
    f.t = nowMs / 1000;
    f.dt = dt;

    const a = this.analyser;
    if (!a || this.status.state !== 'live') {
      if (f.live) this.clearFrame();
      return f;
    }
    f.live = true;

    a.getByteFrequencyData(this.freqBytes);
    a.getFloatTimeDomainData(f.wave);
    this.analyserL!.getFloatTimeDomainData(f.waveL);
    this.analyserR!.getFloatTimeDomainData(f.waveR);

    // signal RMS (real level, no gain)
    let sum = 0;
    for (let i = 0; i < f.wave.length; i++) sum += f.wave[i]! * f.wave[i]!;
    f.rms = Math.sqrt(sum / f.wave.length);

    // logarithmic bands
    const decay = Math.pow(0.5, dt / 6); // the peak halves every ~6 s
    let bandMax = 0;
    const raw = this.raw;
    for (let b = 0; b < BAND_COUNT; b++) {
      const [lo, hi] = this.bandEdges[b]!;
      let s = 0;
      for (let k = lo; k <= hi; k++) s += this.freqBytes[k]!;
      const v = s / (hi - lo + 1) / 255;
      raw[b] = v;
      if (v > bandMax) bandMax = v;
    }
    this.peak.bands = Math.max(bandMax, this.peak.bands * decay, 0.12);
    const g = this.gain;
    for (let b = 0; b < BAND_COUNT; b++) {
      const target = Math.min(1, (raw[b]! / this.peak.bands) * g);
      // fast attack, slow release (like a VU meter)
      const prev = f.bands[b]!;
      f.bands[b] = target > prev ? prev + (target - prev) * Math.min(1, dt * 28) : prev + (target - prev) * Math.min(1, dt * 7);
    }

    // regions (in Hz) — from the raw bands
    const region = (lo: number, hi: number) => {
      let s = 0;
      let n = 0;
      for (let b = 0; b < BAND_COUNT; b++) {
        const hz = bandCenterHz(b);
        if (hz >= lo && hz < hi) {
          s += raw[b]!;
          n++;
        }
      }
      return n ? s / n : 0;
    };
    const bassRaw = region(30, 160);
    const midRaw = region(160, 2200);
    const trebleRaw = region(2200, 16000);
    this.peak.bass = Math.max(bassRaw, this.peak.bass * decay, 0.1);
    this.peak.mid = Math.max(midRaw, this.peak.mid * decay, 0.08);
    this.peak.treble = Math.max(trebleRaw, this.peak.treble * decay, 0.05);
    const smooth = (prev: number, next: number) => prev + (next - prev) * Math.min(1, dt * (next > prev ? 20 : 6));
    f.bass = smooth(f.bass, Math.min(1, (bassRaw / this.peak.bass) * g));
    f.mid = smooth(f.mid, Math.min(1, (midRaw / this.peak.mid) * g));
    f.treble = smooth(f.treble, Math.min(1, (trebleRaw / this.peak.treble) * g));
    f.energy = f.rms < 0.002 ? smooth(f.energy, 0) : smooth(f.energy, Math.min(1, f.bass * 0.45 + f.mid * 0.35 + f.treble * 0.2));
    if (f.rms < 0.002) {
      f.bass = smooth(f.bass, 0);
      f.mid = smooth(f.mid, 0);
      f.treble = smooth(f.treble, 0);
    }

    // beat: positive spectral flux in the bands below ~150 Hz, above the recent average
    let flux = 0;
    let lowN = 0;
    for (let b = 0; b < BAND_COUNT && bandCenterHz(b) < 150; b++) {
      const d = raw[b]! - this.prevLow[lowN]!;
      if (d > 0) flux += d;
      this.prevLow[lowN] = raw[b]!;
      lowN++;
    }
    flux /= Math.max(1, lowN);
    const hist = this.fluxHistory;
    let avg = 0;
    for (let i = 0; i < hist.length; i++) avg += hist[i]!;
    avg /= hist.length;
    hist[this.fluxPos] = flux;
    this.fluxPos = (this.fluxPos + 1) % hist.length;
    f.beat = Math.max(0, f.beat - dt * 3.2);
    if (f.rms > 0.004 && flux > 0.025 && flux > avg * 2.4 && nowMs - this.lastBeatAt > 240) {
      f.beat = 1;
      this.lastBeatAt = nowMs;
    }
    return f;
  }
}

const BAND_LO = 30;
const BAND_HI = 16000;
function bandCenterHz(b: number): number {
  return BAND_LO * Math.pow(BAND_HI / BAND_LO, (b + 0.5) / BAND_COUNT);
}

function logBands(n: number, lo: number, hi: number, sampleRate: number, fftSize: number): [number, number][] {
  const binHz = sampleRate / fftSize;
  const maxBin = fftSize / 2 - 1;
  const out: [number, number][] = [];
  for (let b = 0; b < n; b++) {
    const f0 = lo * Math.pow(hi / lo, b / n);
    const f1 = lo * Math.pow(hi / lo, (b + 1) / n);
    const a = Math.min(maxBin, Math.max(1, Math.floor(f0 / binHz)));
    const z = Math.min(maxBin, Math.max(a, Math.ceil(f1 / binHz) - 1));
    out.push([a, z]);
  }
  return out;
}

export const audioInput = new AudioInput();

if (import.meta.env.DEV) (window as unknown as { __mdAudio: AudioInput }).__mdAudio = audioInput;

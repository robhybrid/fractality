/**
 * Beat detection reads bins from AnalyserNode. The FFT itself runs in the
 * browser audio engine, not in the animation loop. This class only sums a
 * spectral flux over the bass band and peak-picks it.
 */
export class BeatListener {
  constructor() {
    this.ctx = null;
    this.analyser = null;
    this.source = null;
    this.freq = null;
    this.prev = null;
    this.hist = new Float32Array(36);
    this.histCount = 0;
    this.histIndex = 0;
    this.lastBeat = 0;
    this.envelope = 0;
    this.bass = 0;
    this.mid = 0;
    this.high = 0;
    this.bpm = 0;
    this.intervals = [];
    this.label = "Mic off";
    this.active = false;
  }

  async startMic() {
    await this.ensure();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    this.attach(this.ctx.createMediaStreamSource(stream), false);
    this.stream = stream;
    this.label = "Microphone";
    this.active = true;
  }

  async playFile(buffer, name) {
    await this.ensure();
    const audio = await this.ctx.decodeAudioData(buffer.slice(0));
    const node = this.ctx.createBufferSource();
    node.buffer = audio;
    node.loop = true;
    this.attach(node, true);
    node.start();
    this.label = name || "Audio file";
    this.active = true;
  }

  async ensure() {
    if (!this.ctx) this.ctx = new AudioContext();
    if (this.ctx.state === "suspended") await this.ctx.resume();
    this.stopSource();
  }

  attach(node, toSpeakers) {
    if (!this.analyser) {
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0.35;
      this.freq = new Float32Array(this.analyser.frequencyBinCount);
      this.prev = new Float32Array(this.analyser.frequencyBinCount);
    }
    node.connect(this.analyser);
    if (toSpeakers) this.analyser.connect(this.ctx.destination);
    this.source = node;
  }

  stop() {
    this.stopSource();
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
    }
    this.active = false;
    this.label = "Mic off";
    this.envelope = 0;
    this.bass = 0;
    this.mid = 0;
    this.high = 0;
  }

  stopSource() {
    if (!this.source) return;
    try {
      this.source.stop?.();
    } catch {
      /* already stopped */
    }
    try {
      this.source.disconnect();
    } catch {
      /* already disconnected */
    }
    this.source = null;
    try {
      this.analyser?.disconnect();
    } catch {
      /* not connected to destination */
    }
  }

  sample(time, dt) {
    if (!this.analyser) {
      this.envelope *= Math.exp(-3 * dt);
      return this.snapshot(false);
    }
    this.analyser.getFloatFrequencyData(this.freq);
    const nyquist = this.ctx.sampleRate / 2;
    const hzPer = nyquist / this.freq.length;
    let flux = 0;
    let bass = 0;
    let mid = 0;
    let high = 0;
    let bc = 0;
    let mc = 0;
    let hc = 0;
    for (let i = 0; i < this.freq.length; i += 1) {
      const hz = i * hzPer;
      if (hz < 35 || hz > 8000) continue;
      const mag = Math.max(0, (this.freq[i] + 100) / 100);
      const d = mag - this.prev[i];
      if (hz < 160) {
        bass += mag;
        bc += 1;
        if (d > 0) flux += d;
      } else if (hz < 1800) {
        mid += mag;
        mc += 1;
      } else {
        high += mag;
        hc += 1;
      }
      this.prev[i] = mag;
    }
    this.bass = bc ? bass / bc : 0;
    this.mid = mc ? mid / mc : 0;
    this.high = hc ? high / hc : 0;
    this.hist[this.histIndex] = flux;
    this.histIndex = (this.histIndex + 1) % this.hist.length;
    this.histCount = Math.min(this.hist.length, this.histCount + 1);
    let mean = 0;
    for (let i = 0; i < this.histCount; i += 1) mean += this.hist[i];
    mean /= this.histCount || 1;
    let variance = 0;
    for (let i = 0; i < this.histCount; i += 1) {
      const d = this.hist[i] - mean;
      variance += d * d;
    }
    const std = Math.sqrt(variance / (this.histCount || 1));
    const threshold = mean + 1.45 * std;
    let beat = false;
    if (this.active && flux > threshold && flux > 0.45 && time - this.lastBeat > 0.25) {
      beat = true;
      if (this.lastBeat) {
        this.intervals.push(time - this.lastBeat);
        if (this.intervals.length > 8) this.intervals.shift();
        const sorted = [...this.intervals].sort((a, b) => a - b);
        const midI = sorted[Math.floor(sorted.length / 2)];
        this.bpm = midI > 0 ? 60 / midI : 0;
      }
      this.lastBeat = time;
      this.envelope = 1;
    } else {
      this.envelope *= Math.exp(-3.4 * dt);
    }
    return this.snapshot(beat);
  }

  snapshot(beat) {
    return {
      beat,
      bass: this.bass,
      mid: this.mid,
      high: this.high,
      envelope: this.envelope,
      bpm: this.bpm,
      active: this.active,
      label: this.label,
    };
  }
}

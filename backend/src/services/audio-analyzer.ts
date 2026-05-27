const FRAME_SIZE = 160; // 20ms at 8000Hz
const MIN_FRAMES_FOR_ANALYSIS = 10; // need at least 200ms of audio
const HUMAN_VARIANCE_THRESHOLD = 2000000;
const HUMAN_PITCH_VARIANCE_THRESHOLD = 0.65; // IVR TTS: 0.52-0.64, humans on mobile: 0.57-0.70

export interface AudioAnalysisResult {
  isHuman: boolean;
  confidence: number;
  rmsVariance: number;
  pitchVariance: number;
  hasDisfluencies: boolean;
  framesAnalyzed: number;
}

// ITU-T G.711 mulaw decode
function mulawToLinear(mulaw: number): number {
  mulaw = ~mulaw & 0xFF;
  const sign = mulaw & 0x80;
  const exponent = (mulaw >> 4) & 0x07;
  const mantissa = mulaw & 0x0F;
  let value = ((mantissa << 1) + 33) << exponent;
  return sign ? -value : value;
}

function decodeFrame(mulawBuffer: Buffer): number[] {
  const samples: number[] = new Array(mulawBuffer.length);
  for (let i = 0; i < mulawBuffer.length; i++) {
    samples[i] = mulawToLinear(mulawBuffer[i]);
  }
  return samples;
}

function computeRMS(samples: number[]): number {
  if (samples.length === 0) return 0;
  const sumSq = samples.reduce((acc, s) => acc + s * s, 0);
  return Math.sqrt(sumSq / samples.length);
}

// Simplified pitch estimation via autocorrelation
function estimatePitch(samples: number[]): number {
  const minLag = 16;  // ~500Hz at 8kHz
  const maxLag = 133; // ~60Hz at 8kHz
  let maxCorr = 0;
  let bestLag = 0;

  for (let lag = minLag; lag <= maxLag && lag < samples.length; lag++) {
    let corr = 0;
    for (let i = 0; i + lag < samples.length; i++) {
      corr += samples[i] * samples[i + lag];
    }
    if (corr > maxCorr) {
      maxCorr = corr;
      bestLag = lag;
    }
  }

  return bestLag > 0 ? 8000 / bestLag : 0; // Hz
}

export class AudioAnalyzer {
  private audioBuffer: Buffer[] = [];
  private rmsHistory: number[] = [];
  private pitchHistory: number[] = [];
  private totalSamples = 0;

  addChunk(mulawBuffer: Buffer): void {
    this.audioBuffer.push(mulawBuffer);
    this.totalSamples += mulawBuffer.length;

    // Process in frames
    const samples = decodeFrame(mulawBuffer);

    for (let i = 0; i + FRAME_SIZE <= samples.length; i += FRAME_SIZE) {
      const frame = samples.slice(i, i + FRAME_SIZE);
      const rms = computeRMS(frame);

      // Only analyze frames with enough energy (skip silence)
      if (rms > 200) {
        this.rmsHistory.push(rms);
        const pitch = estimatePitch(frame);
        if (pitch > 0) {
          this.pitchHistory.push(pitch);
        }
      }
    }

    // Keep only the last 5 seconds of history
    const maxFrames = 250; // 5 seconds at 20ms frames
    if (this.rmsHistory.length > maxFrames) {
      this.rmsHistory = this.rmsHistory.slice(-maxFrames);
    }
    if (this.pitchHistory.length > maxFrames) {
      this.pitchHistory = this.pitchHistory.slice(-maxFrames);
    }
  }

  analyze(): AudioAnalysisResult | null {
    if (this.rmsHistory.length < MIN_FRAMES_FOR_ANALYSIS) {
      return null;
    }

    const rmsVariance = computeVariance(this.rmsHistory);
    const pitchVariance = this.pitchHistory.length > 5
      ? computeNormalizedVariance(this.pitchHistory)
      : 0;

    // Human speech has natural amplitude and pitch variation
    // IVR/TTS is unnaturally smooth and consistent
    const rmsIsHuman = rmsVariance > HUMAN_VARIANCE_THRESHOLD;
    const pitchIsHuman = pitchVariance > HUMAN_PITCH_VARIANCE_THRESHOLD;

    let confidence = 0.5;
    if (rmsIsHuman && pitchIsHuman) confidence = 0.88;
    else if (rmsIsHuman) confidence = 0.65;
    else if (pitchIsHuman) confidence = 0.62;
    else confidence = 0.15; // Smooth consistent audio → very likely IVR/TTS

    return {
      isHuman: confidence >= 0.6,
      confidence,
      rmsVariance,
      pitchVariance,
      hasDisfluencies: false, // set from transcript analysis
      framesAnalyzed: this.rmsHistory.length,
    };
  }

  reset(): void {
    this.audioBuffer = [];
    this.rmsHistory = [];
    this.pitchHistory = [];
    this.totalSamples = 0;
  }

  getSampleCount(): number {
    return this.totalSamples;
  }
}

function computeVariance(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
}

function computeNormalizedVariance(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (mean === 0) return 0;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / mean; // coefficient of variation
}

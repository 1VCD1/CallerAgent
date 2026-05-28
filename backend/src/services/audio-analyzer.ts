const FRAME_SIZE = 160; // 20ms at 8000Hz
const MIN_FRAMES_FOR_ANALYSIS = 10; // need at least 200ms of audio
const HUMAN_VARIANCE_THRESHOLD = 2000000;
const HUMAN_PITCH_VARIANCE_THRESHOLD = 0.65; // IVR TTS: 0.52-0.64, humans on mobile: 0.57-0.70

// Ring-back / transfer ring detection constants
// Transfer ring = phone ringing during IVR-to-agent handoff (almost always followed by a human)
const RING_MIN_HZ = 360;  // below US 400Hz / international ring tones
const RING_MAX_HZ = 520;  // above US 480Hz dual tone
const RING_CONFIRM_FRAMES = 15;        // 300ms sustained to confirm ring phase
const RING_PITCH_COV_THRESHOLD = 0.07; // pure tone: CoV < 7% (speech > 15%)
const RING_PICKUP_WINDOW_MS = 25000;   // speech within 25s of ring ending = post-ring pickup

export interface AudioAnalysisResult {
  isHuman: boolean;
  confidence: number;
  rmsVariance: number;
  pitchVariance: number;
  hasDisfluencies: boolean;
  framesAnalyzed: number;
  postRingPickup: boolean; // ring tones detected before this utterance → very likely human agent
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

  // Ring tone detection state
  private ringFrameCount = 0;          // consecutive ring-range voiced frames
  private recentRingPitches: number[] = []; // pitch values for CoV check
  private ringPhaseActive = false;     // currently in a ring phase
  private ringPhaseEndedAt: number | null = null; // when ring phase ended (speech started)

  addChunk(mulawBuffer: Buffer): void {
    this.audioBuffer.push(mulawBuffer);
    this.totalSamples += mulawBuffer.length;

    const samples = decodeFrame(mulawBuffer);

    for (let i = 0; i + FRAME_SIZE <= samples.length; i += FRAME_SIZE) {
      const frame = samples.slice(i, i + FRAME_SIZE);
      const rms = computeRMS(frame);

      if (rms > 200) {
        const pitch = estimatePitch(frame);
        const isRingPitch = pitch >= RING_MIN_HZ && pitch <= RING_MAX_HZ;

        if (isRingPitch) {
          this.ringFrameCount++;
          this.recentRingPitches.push(pitch);
          if (this.recentRingPitches.length > 50) this.recentRingPitches.shift();

          // Confirm ring phase: enough sustained frames + pure-tone pitch consistency
          if (!this.ringPhaseActive && this.ringFrameCount >= RING_CONFIRM_FRAMES) {
            const recent = this.recentRingPitches.slice(-RING_CONFIRM_FRAMES);
            const pitchCoV = computeNormalizedVariance(recent);
            if (pitchCoV < RING_PITCH_COV_THRESHOLD) {
              this.ringPhaseActive = true;
              console.log(`[AudioAnalyzer] Ring phase confirmed — pitch CoV=${pitchCoV.toFixed(3)}`);
            }
          }
          // Ring-pitched frames are NOT speech — skip them for speech analysis
        } else {
          // Non-ring voiced frame (speech, hold music, etc.)
          this.ringFrameCount = 0;

          if (this.ringPhaseActive) {
            this.ringPhaseActive = false;
            this.ringPhaseEndedAt = Date.now();
            this.recentRingPitches = [];
            console.log('[AudioAnalyzer] Ring phase ended — speech/audio detected after ring');
          }

          // Include in speech analysis
          this.rmsHistory.push(rms);
          if (pitch > 0) this.pitchHistory.push(pitch);
        }
      }
      // Silence: don't push anything — ring has natural on/off cycles so silence is expected
    }

    // Keep only the last 5 seconds of speech history
    const maxFrames = 250;
    if (this.rmsHistory.length > maxFrames) {
      this.rmsHistory = this.rmsHistory.slice(-maxFrames);
    }
    if (this.pitchHistory.length > maxFrames) {
      this.pitchHistory = this.pitchHistory.slice(-maxFrames);
    }
  }

  analyze(): AudioAnalysisResult | null {
    const sinceRingMs = this.ringPhaseEndedAt ? Date.now() - this.ringPhaseEndedAt : Infinity;
    const postRingPickup = !this.ringPhaseActive && sinceRingMs < RING_PICKUP_WINDOW_MS;

    if (this.rmsHistory.length < MIN_FRAMES_FOR_ANALYSIS) {
      // Not enough speech data yet, but still report ring state
      if (postRingPickup) {
        return {
          isHuman: true, confidence: 0.92, rmsVariance: 0, pitchVariance: 0,
          hasDisfluencies: false, framesAnalyzed: 0, postRingPickup: true,
        };
      }
      return null;
    }

    const rmsVariance = computeVariance(this.rmsHistory);
    const pitchVariance = this.pitchHistory.length > 5
      ? computeNormalizedVariance(this.pitchHistory)
      : 0;

    const rmsIsHuman = rmsVariance > HUMAN_VARIANCE_THRESHOLD;
    const pitchIsHuman = pitchVariance > HUMAN_PITCH_VARIANCE_THRESHOLD;

    let confidence = 0.5;
    if (postRingPickup)           confidence = 0.95; // ring → pickup = almost certain human
    else if (rmsIsHuman && pitchIsHuman) confidence = 0.88;
    else if (rmsIsHuman)          confidence = 0.65;
    else if (pitchIsHuman)        confidence = 0.62;
    else                          confidence = 0.15;

    return {
      isHuman: confidence >= 0.6,
      confidence,
      rmsVariance,
      pitchVariance,
      hasDisfluencies: false,
      framesAnalyzed: this.rmsHistory.length,
      postRingPickup,
    };
  }

  reset(): void {
    this.audioBuffer = [];
    this.rmsHistory = [];
    this.pitchHistory = [];
    this.totalSamples = 0;
    this.ringFrameCount = 0;
    this.recentRingPitches = [];
    this.ringPhaseActive = false;
    this.ringPhaseEndedAt = null;
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

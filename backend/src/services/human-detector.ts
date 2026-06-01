import { AudioAnalysisResult } from './audio-analyzer';

const HUMAN_INDICATORS = [
  // Name introductions — strongest human signal
  /this is [a-z]+ (speaking|here)/i,
  /^(hi|hello|hey)[,.]?\s+this is [a-z]/i,
  /this is [a-z]+[,.]?\s*(how|what|can|is there)/i,
  /my name is [a-z]+[,.]? (how|what)/i,
  // "I am a representative" — agent self-identification
  /i am (a |the )?\w*\s*(representative|agent|specialist|supervisor)/i,
  // Account-specific actions only a human does mid-call
  /let me (pull up|look at|check) your (account|information)/i,
  /what seems to be the (problem|issue)/i,
  /i('ll| will) be (happy|glad) to help/i,
  // Identity questions — human asking who called them
  /who (is this|'s (this|calling|there))/i,
  /who am i (speaking|talking) (to|with)/i,
  // Casual human greetings
  /(yes|yeah)[,.]? (hello|hi|how)/i,
  /\bhello\b.{0,20}\bwho\b/i,
  /\bhello\b.{0,10}\bhow are you\b/i,
  /\b(hi|hey)\b.{0,10}\bhow are you\b/i,
  // Imperative commands — only a human would say these
  /\bstop (pressing|calling|doing|pushing)\b/i,
  /\bdon'?t (press|push|do that|call)\b/i,
  /\b(hey|hello|excuse me)[,!]?\s+(stop|what|why|who)\b/i,
  // "How are you doing?" — human small talk, IVRs never say this
  /how('?s| is) (it going|everything|things)/i,
  /how are you (doing|today)/i,
];

const NON_HUMAN_INDICATORS = [
  /press (or say|[0-9#*])/i,
  /say or (press|enter)/i,
  /please (hold|wait|say|enter|press)/i,
  /your (estimated|approximate) wait/i,
  /for .*, press [0-9]/i,
  /this call may be (recorded|monitored)/i,
  /to (speak to|reach|talk to) a (representative|agent|person)/i,
  /our (menu|options) have changed/i,
  /digital assistant/i,
  /virtual assistant/i,
  /automated (system|assistant|service)/i,
  /enter (the|your) [0-9]+-digit/i,
  /please (say|enter) (the|your) (10|ten|account|phone|zip)/i,
  /thank you for (calling|contacting)/i,
  /for quality (assurance|and training)/i,
  /monitor(ed)? and record/i,
  /calls? (may|will) be recorded/i,
  /\bIVR\b/i,
];

const DISFLUENCY_PATTERNS = [
  /\b(uh|um|uhh|umm|uh-huh|hmm)\b/i,
  /\blet me (check|see|look|pull)/i,
  /\bone moment\b/i,
  /\bjust a (sec|second|moment)\b/i,
];

export interface HumanDetectionResult {
  isHuman: boolean;
  confidence: number;
  signal: string;
  audioConfidence?: number;
  keywordConfidence?: number;
  // Debug fields
  nonHumanPatternsMatched?: string[];
  humanPatternsMatched?: string[];
  disfluencyScore?: number;
}

// Primary: audio pitch/amplitude analysis
// Secondary: keyword matching
// Tertiary: disfluencies and conversational cadence
export function detectHumanCombined(
  transcript: string,
  audioAnalysis: AudioAnalysisResult | null
): HumanDetectionResult {

  // --- Layer 1: Audio Analysis (PRIMARY) ---
  let audioScore = 0.5;
  if (audioAnalysis && audioAnalysis.framesAnalyzed >= 10) {
    audioScore = audioAnalysis.confidence;
    console.log(
      `[HumanDetect] Audio: rmsVar=${audioAnalysis.rmsVariance.toFixed(0)} ` +
      `pitchVar=${audioAnalysis.pitchVariance.toFixed(3)} ` +
      `confidence=${audioScore.toFixed(2)}`
    );

    // If audio very confidently says NOT human (smooth TTS), trust it
    if (!audioAnalysis.isHuman && audioAnalysis.confidence >= 0.85) {
      return { isHuman: false, confidence: audioAnalysis.confidence, signal: 'audio_smooth_tts', audioConfidence: audioScore };
    }
  }

  // --- Layer 2: Keyword matching (SECONDARY) ---
  const nonHumanMatched = NON_HUMAN_INDICATORS.filter(p => p.test(transcript)).map(p => p.source);
  const nonHumanScore = nonHumanMatched.length;

  if (nonHumanScore >= 1) {
    return {
      isHuman: false,
      confidence: Math.min(0.95, 0.7 + nonHumanScore * 0.05),
      signal: 'ivr_keywords',
      audioConfidence: audioScore,
      keywordConfidence: 0.0,
      nonHumanPatternsMatched: nonHumanMatched,
      humanPatternsMatched: [],
      disfluencyScore: 0,
    };
  }

  const humanMatched = HUMAN_INDICATORS.filter(p => p.test(transcript)).map(p => p.source);
  const humanScore = humanMatched.length;

  // --- Layer 3: Disfluencies (TERTIARY) ---
  const disfluencyScore = DISFLUENCY_PATTERNS.reduce(
    (score, pattern) => score + (pattern.test(transcript) ? 1 : 0), 0
  );

  // Combine signals: keywords 65%, disfluencies 25%, audio 10%
  // Audio weight is minimal — phone compression makes pitch/amplitude unreliable for human detection
  const keywordSignal = humanScore > 0 ? 0.7 + humanScore * 0.1 : 0.4;
  const disfluencySignal = disfluencyScore > 0 ? 0.75 : 0.45;

  const combinedConfidence =
    audioScore * 0.10 +
    keywordSignal * 0.65 +
    disfluencySignal * 0.25;

  const isHuman = combinedConfidence >= 0.58;

  console.log(
    `[HumanDetect] Combined: audio=${audioScore.toFixed(2)} ` +
    `keyword=${keywordSignal.toFixed(2)} ` +
    `disfluency=${disfluencySignal.toFixed(2)} ` +
    `→ combined=${combinedConfidence.toFixed(2)} isHuman=${isHuman}`
  );

  return {
    isHuman,
    confidence: combinedConfidence,
    signal: isHuman ? 'combined_human' : 'combined_ivr',
    audioConfidence: audioScore,
    keywordConfidence: keywordSignal,
    nonHumanPatternsMatched: [],
    humanPatternsMatched: humanMatched,
    disfluencyScore,
  };
}

// Legacy keyword-only detector (kept for backward compatibility)
export function detectHuman(transcript: string): HumanDetectionResult {
  return detectHumanCombined(transcript, null);
}

export function isHoldMusic(transcript: string): boolean {
  return transcript.trim().length < 10 && !transcript.match(/[a-z]{3,}/i);
}

export function isOutsideBusinessHours(transcript: string): boolean {
  const patterns = [
    /outside.{0,30}(phone support|business|support|office) hours/i,
    /outside of.{0,20}hours/i,
    /reached us outside/i,
    /call.{0,15}back.{0,20}during.{0,20}(business|support|regular) hours/i,
    /currently (closed|unavailable) for (phone|calls?)/i,
    /not (available|open).{0,20}(at this time|right now).{0,30}hours/i,
    /our (office|support|phone) (is|are) (closed|unavailable)/i,
  ];
  return patterns.some(p => p.test(transcript));
}

export function isCallbackOffer(transcript: string): boolean {
  const t = transcript.toLowerCase();
  const hasCallbackWord = /callback|call.{0,5}back|call you back|return.{0,10}call/.test(t);
  const hasActionCue    = /press|say|option|\byes\b|\bno\b|would you like|prefer|instead/.test(t);
  return hasCallbackWord && hasActionCue;
}

export function isVoicemailGreeting(transcript: string): boolean {
  const t = transcript.toLowerCase();
  return (
    // "leave a message" / "leave a voicemail" anywhere
    /leave.{0,20}(message|voicemail)/.test(t) ||
    // "at/after the tone/beep"
    /(at|after) the (tone|beep)/.test(t) ||
    // "please record your message"
    /please record.{0,30}message/.test(t) ||
    // "you've reached [X]'s voicemail" or "you have reached the voicemail"
    /(you'?ve|you have) reached.{0,40}(voicemail|voice mail)/.test(t) ||
    // "voicemail box" / "mailbox is full"
    /(voicemail|voice mail) (box|full|not available)/.test(t) ||
    // "unable to take your call" with no DTMF options nearby
    /unable to (take|answer).{0,20}call/.test(t) && !/press [0-9]/.test(t)
  );
}

export function isInvalidOrDisconnected(transcript: string): boolean {
  const t = transcript.toLowerCase();
  return (
    /not in service|been disconnected|no longer in service|is not a working number/.test(t) ||
    /number you (have |'ve )?dialed|number you are trying/.test(t) ||
    /check the number|try your call again|invalid number/.test(t) ||
    /this number has been (changed|disconnected|removed)/.test(t)
  );
}

export function extractMenuKeys(transcript: string): string[] {
  const matches = [...transcript.matchAll(/press\s+([0-9*#])/gi)];
  return [...new Set(matches.map(m => m[1]))];
}

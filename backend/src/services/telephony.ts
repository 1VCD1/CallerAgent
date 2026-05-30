import twilio from 'twilio';
import { config } from '../config';

const client = twilio(config.twilio.accountSid, config.twilio.authToken);

export interface OutboundCallOptions {
  to: string;
  callId: string;
}

export async function initiateOutboundCall(options: OutboundCallOptions): Promise<string> {
  const gatherUrl = `${config.app.webhookBaseUrl}/webhooks/twilio/gather?callId=${options.callId}`;
  const streamUrl = `wss://${config.app.baseUrl.replace(/^https?:\/\//, '')}/ws/audio/${options.callId}`;

  const call = await client.calls.create({
    to: options.to,
    from: config.twilio.phoneNumber,
    twiml: buildStreamingGatherTwiML(gatherUrl, streamUrl),
    statusCallback: `${config.app.webhookBaseUrl}/webhooks/twilio/status`,
    statusCallbackMethod: 'POST',
    statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
    record: true,
    recordingStatusCallback: `${config.app.webhookBaseUrl}/webhooks/twilio/recording`,
    recordingStatusCallbackMethod: 'POST',
    recordingChannels: 'dual',
  });

  return call.sid;
}

function buildStreamingGatherTwiML(gatherUrl: string, streamUrl: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Start>
    <Stream url="${streamUrl}" track="both_tracks"/>
  </Start>
  <Gather input="speech dtmf" timeout="8" speechTimeout="0.5" action="${gatherUrl}" method="POST">
    <Pause length="3"/>
  </Gather>
  <Redirect method="POST">${gatherUrl}</Redirect>
</Response>`;
}

export async function sendDTMF(callSid: string, digits: string): Promise<void> {
  await client.calls(callSid).update({
    twiml: `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play digits="${digits}"/>
  <Pause length="1"/>
</Response>`,
  });
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export async function sayPhrase(callSid: string, phrase: string, voice = 'Google.en-US-Chirp3-HD-Fenrir'): Promise<void> {
  await client.calls(callSid).update({
    twiml: `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${voice}">${escapeXml(phrase)}</Say>
  <Pause length="2"/>
</Response>`,
  });
}

export async function createConferenceBridge(
  aiCallSid: string,
  conferenceName: string
): Promise<void> {
  await client.calls(aiCallSid).update({
    twiml: `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial>
    <Conference>${conferenceName}</Conference>
  </Dial>
</Response>`,
  });
}

export async function createConferenceWithHold(
  callSid: string,
  conferenceName: string,
  message?: string,
  voice = 'Google.en-US-Chirp3-HD-Fenrir'
): Promise<void> {
  const sayXml = message ? `<Say voice="${voice}">${escapeXml(message)}</Say>` : '';
  await client.calls(callSid).update({
    twiml: `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${sayXml}
  <Dial>
    <Conference beep="false" startConferenceOnEnter="true" endConferenceOnExit="true" waitUrl="https://twimlets.com/holdmusic?Bucket=com.twilio.music.classical">${conferenceName}</Conference>
  </Dial>
</Response>`,
  });
}

export async function bridgeUserToConference(
  userPhoneNumber: string,
  conferenceName: string,
  message = "You're being connected to a live representative.",
  voice = 'Google.en-US-Chirp3-HD-Fenrir'
): Promise<string> {
  const call = await client.calls.create({
    to: userPhoneNumber,
    from: config.twilio.phoneNumber,
    twiml: `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${voice}">${escapeXml(message)}</Say>
  <Dial>
    <Conference>${conferenceName}</Conference>
  </Dial>
</Response>`,
  });

  return call.sid;
}

export async function endCall(callSid: string): Promise<void> {
  await client.calls(callSid).update({ status: 'completed' });
}

export async function sendSMS(to: string, body: string): Promise<void> {
  await client.messages.create({ to, from: config.twilio.phoneNumber, body });
}

export function getTwilioClient() {
  return client;
}

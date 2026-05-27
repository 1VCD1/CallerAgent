import { Queue, Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import { config } from '../config';
import { recordCallOutcome } from '../services/memory';

const connection = new IORedis(config.redis.url, { maxRetriesPerRequest: null });

export const callQueue = new Queue('calls', { connection });

interface CallOutcomeJob {
  callId: string;
  company: string;
  goal: string;
  humanReached: boolean;
  waitDurationSeconds?: number;
}

export const callWorker = new Worker<CallOutcomeJob>(
  'calls',
  async (job: Job<CallOutcomeJob>) => {
    if (job.name === 'record-outcome') {
      await recordCallOutcome(job.data);
    }
  },
  { connection }
);

callWorker.on('failed', (job, err) => {
  console.error(`[Queue] Job ${job?.id} failed:`, err);
});

export async function enqueueOutcomeRecording(params: CallOutcomeJob): Promise<void> {
  await callQueue.add('record-outcome', params, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
  });
}

import { FastifyRequest, FastifyReply } from 'fastify';
import { getFirebaseAdmin, isFirebaseReady } from '../../services/firebase-admin';
import { query } from '../../db/client';
import { config } from '../../config';

async function findOrCreateUser(firebaseUid: string, email?: string): Promise<string> {
  // Look up by firebase_uid
  const byUid = await query<{ id: string }>(
    `SELECT id FROM users WHERE firebase_uid = $1`,
    [firebaseUid]
  );
  if (byUid[0]) return byUid[0].id;

  // Try to claim an existing anonymous account by email
  if (email) {
    const byEmail = await query<{ id: string }>(
      `SELECT id FROM users WHERE email = $1 AND firebase_uid IS NULL`,
      [email]
    );
    if (byEmail[0]) {
      await query(`UPDATE users SET firebase_uid = $1 WHERE id = $2`, [firebaseUid, byEmail[0].id]);
      return byEmail[0].id;
    }
  }

  // Create a new user
  const created = await query<{ id: string }>(
    `INSERT INTO users (firebase_uid, email) VALUES ($1, $2) RETURNING id`,
    [firebaseUid, email ?? null]
  );
  return created[0].id;
}

export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  // API key bypass — for admin use and local dev without Firebase
  if (config.app.apiKey) {
    const provided =
      (request.headers['x-api-key'] as string) ??
      (request.headers['authorization'] as string | undefined)?.replace(/^Bearer /, '');
    if (provided === config.app.apiKey) return;
  }

  // Firebase not configured → allow through (unauthenticated local dev)
  if (!isFirebaseReady()) return;

  const authHeader = request.headers['authorization'] as string | undefined;
  if (!authHeader?.startsWith('Bearer ')) {
    reply.code(401).send({ error: 'Unauthorized: Bearer token required' });
    return;
  }

  const idToken = authHeader.slice(7);
  try {
    const decoded = await getFirebaseAdmin().auth().verifyIdToken(idToken);
    (request as any).userId = await findOrCreateUser(decoded.uid, decoded.email);
  } catch {
    reply.code(401).send({ error: 'Invalid or expired token' });
  }
}

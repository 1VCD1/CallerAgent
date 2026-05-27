import { FastifyPluginAsync } from 'fastify';
import { requireAuth } from '../middleware/auth';
import { query } from '../../db/client';

const authPlugin: FastifyPluginAsync = async (fastify) => {
  // POST /auth/login — called on app launch after Google sign-in.
  // Verifies the Firebase token, creates the user if first time, returns their profile.
  fastify.post('/auth/login', { preHandler: requireAuth }, async (request, reply) => {
    const userId = (request as any).userId as string | undefined;
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const user = await query<{
      id: string; email: string | null; name: string | null;
      phone_number: string | null; birthday: string | null;
      language: string; push_token: string | null;
    }>(
      `SELECT id, email, name, phone_number, birthday, language, push_token FROM users WHERE id = $1`,
      [userId]
    );

    if (!user[0]) return reply.status(404).send({ error: 'User not found' });
    return user[0];
  });
};

export default authPlugin;

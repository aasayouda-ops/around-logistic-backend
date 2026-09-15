import { query } from '../../db/pool.js';
import { authenticate } from '../../middleware/auth.js';
import { v4 as uuid } from 'uuid';

export default async function notificationsRoutes(fastify) {

  // GET /notifications — my notifications
  fastify.get('/', { preHandler: authenticate }, async (req, reply) => {
    const { rows } = await query(
      `SELECT * FROM notifications WHERE user_id=$1
       ORDER BY created_at DESC LIMIT 30`,
      [req.user.id]
    );
    return rows;
  });

  // PATCH /notifications/read-all — mark all as read
  fastify.patch('/read-all', { preHandler: authenticate }, async (req, reply) => {
    await query(
      'UPDATE notifications SET is_read=TRUE WHERE user_id=$1 AND is_read=FALSE',
      [req.user.id]
    );
    return { message: 'تم تحديد جميع الإشعارات كمقروءة' };
  });

  // PATCH /notifications/:id/read — mark one as read
  fastify.patch('/:id/read', { preHandler: authenticate }, async (req, reply) => {
    await query(
      'UPDATE notifications SET is_read=TRUE WHERE id=$1 AND user_id=$2',
      [req.params.id, req.user.id]
    );
    return { message: 'تم' };
  });

  // GET /notifications/unread-count
  fastify.get('/unread-count', { preHandler: authenticate }, async (req, reply) => {
    const { rows } = await query(
      'SELECT COUNT(*) AS count FROM notifications WHERE user_id=$1 AND is_read=FALSE',
      [req.user.id]
    );
    return { count: parseInt(rows[0].count) };
  });
}

// ── helper used by services to push notifications ─────────────
export async function pushNotification({ userId, shipmentId, channel, title, message }) {
  await query(
    `INSERT INTO notifications (id, user_id, shipment_id, channel, title, message)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [uuid(), userId, shipmentId || null, channel, title || null, message]
  );
}

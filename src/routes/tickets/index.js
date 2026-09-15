import { query } from '../../db/pool.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { v4 as uuid } from 'uuid';
import { z } from 'zod';

const TicketSchema = z.object({
  category:    z.enum(['complaint','inquiry','technical','shipment_issue']),
  subject:     z.string().min(5).max(300),
  message:     z.string().min(10),
  shipment_id: z.string().uuid().optional()
});

function genCode() {
  return `TCK-${Math.floor(1000 + Math.random() * 9000)}`;
}

export default async function ticketsRoutes(fastify) {

  // POST /tickets — create ticket
  fastify.post('/', { preHandler: authenticate }, async (req, reply) => {
    const parsed = TicketSchema.safeParse(req.body);
    if (!parsed.success)
      return reply.code(400).send({ error: parsed.error.errors[0].message });

    const { rows } = await query(
      `INSERT INTO tickets (id, ticket_code, user_id, shipment_id, category, subject, message)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [uuid(), genCode(), req.user.id, parsed.data.shipment_id || null,
       parsed.data.category, parsed.data.subject, parsed.data.message]
    );
    return reply.code(201).send(rows[0]);
  });

  // GET /tickets — my tickets
  fastify.get('/', { preHandler: authenticate }, async (req, reply) => {
    const { rows } = await query(
      `SELECT * FROM tickets WHERE user_id=$1 ORDER BY created_at DESC`,
      [req.user.id]
    );
    return rows;
  });

  // GET /tickets/:id
  fastify.get('/:id', { preHandler: authenticate }, async (req, reply) => {
    const { rows } = await query(
      'SELECT * FROM tickets WHERE id=$1 AND user_id=$2',
      [req.params.id, req.user.id]
    );
    if (!rows[0]) return reply.code(404).send({ error: 'الطلب غير موجود' });
    return rows[0];
  });

  // GET /tickets/admin/all — admin only
  fastify.get('/admin/all', { preHandler: requireRole('admin') }, async (req, reply) => {
    const status = req.query.status;
    const base = `SELECT t.*, u.phone AS user_phone FROM tickets t
                  JOIN users u ON u.id = t.user_id`;
    const { rows } = status
      ? await query(`${base} WHERE t.status=$1 ORDER BY t.created_at DESC`, [status])
      : await query(`${base} ORDER BY t.created_at DESC`);
    return rows;
  });

  // PATCH /tickets/:id/status — admin updates status
  fastify.patch('/:id/status', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { status, admin_note } = req.body;
    const validStatuses = ['open','in_progress','resolved','closed'];
    if (!validStatuses.includes(status))
      return reply.code(400).send({ error: 'حالة غير صحيحة' });

    await query(
      `UPDATE tickets SET status=$1, admin_note=$2,
         resolved_at = CASE WHEN $1 IN ('resolved','closed') THEN NOW() ELSE NULL END
       WHERE id=$3`,
      [status, admin_note || null, req.params.id]
    );
    return { message: 'تم تحديث حالة الطلب' };
  });
}

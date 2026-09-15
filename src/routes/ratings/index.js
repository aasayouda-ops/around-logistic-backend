import { query } from '../../db/pool.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { v4 as uuid } from 'uuid';
import { z } from 'zod';

const RatingSchema = z.object({
  stars:     z.number().int().min(1).max(5),
  comment:   z.string().max(500).optional()
});

export default async function ratingsRoutes(fastify) {

  // POST /ratings/shipment/:shipmentId — submit rating
  fastify.post('/shipment/:shipmentId', { preHandler: authenticate }, async (req, reply) => {
    const parsed = RatingSchema.safeParse(req.body);
    if (!parsed.success)
      return reply.code(400).send({ error: parsed.error.errors[0].message });

    // shipment must be delivered
    const { rows: [ship] } = await query(
      'SELECT store_id, driver_id, status FROM shipments WHERE id=$1',
      [req.params.shipmentId]
    );
    if (!ship) return reply.code(404).send({ error: 'الشحنة غير موجودة' });
    if (ship.status !== 'delivered')
      return reply.code(409).send({ error: 'التقييم متاح فقط بعد التسليم' });

    // prevent double rating
    const dup = await query(
      'SELECT id FROM ratings WHERE shipment_id=$1 AND rater_id=$2',
      [req.params.shipmentId, req.user.id]
    );
    if (dup.rows[0]) return reply.code(409).send({ error: 'لقد قيّمت هذه الشحنة مسبقاً' });

    let target_id, target_type;
    if (req.user.role === 'store') {
      target_id = ship.driver_id;
      target_type = 'driver';
    } else if (req.user.role === 'driver') {
      target_id = ship.store_id;
      target_type = 'store';
    } else {
      return reply.code(403).send({ error: 'Admin لا يملك تقييمات' });
    }
    if (!target_id) return reply.code(409).send({ error: 'لا يوجد طرف لتقييمه' });

    await query(
      `INSERT INTO ratings (id, shipment_id, rater_id, rater_role, target_id, target_type, stars, comment)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [uuid(), req.params.shipmentId, req.user.id, req.user.role,
       target_id, target_type, parsed.data.stars, parsed.data.comment || null]
    );

    // update avg
    if (target_type === 'driver') {
      await query(
        `UPDATE drivers SET
           rating_avg = (SELECT AVG(stars) FROM ratings WHERE target_id=$1 AND target_type='driver'),
           rating_count = (SELECT COUNT(*) FROM ratings WHERE target_id=$1 AND target_type='driver')
         WHERE id=$1`, [target_id]
      );
    } else {
      await query(
        `UPDATE stores SET
           rating_avg = (SELECT AVG(stars) FROM ratings WHERE target_id=$1 AND target_type='store'),
           rating_count = (SELECT COUNT(*) FROM ratings WHERE target_id=$1 AND target_type='store')
         WHERE id=$1`, [target_id]
      );
    }

    return reply.code(201).send({ message: 'تم إرسال التقييم بنجاح' });
  });

  // GET /ratings/driver/:driverId — driver ratings
  fastify.get('/driver/:driverId', { preHandler: authenticate }, async (req, reply) => {
    const { rows } = await query(
      `SELECT r.stars, r.comment, r.created_at, st.store_name AS rater_name
       FROM ratings r
       JOIN stores st ON st.id = r.rater_id
       WHERE r.target_id=$1 AND r.target_type='driver'
       ORDER BY r.created_at DESC LIMIT 20`, [req.params.driverId]
    );
    return rows;
  });

  // GET /ratings/store/:storeId — store ratings
  fastify.get('/store/:storeId', { preHandler: authenticate }, async (req, reply) => {
    const { rows } = await query(
      `SELECT r.stars, r.comment, r.created_at, d.full_name AS rater_name
       FROM ratings r
       JOIN drivers d ON d.id = r.rater_id
       WHERE r.target_id=$1 AND r.target_type='store'
       ORDER BY r.created_at DESC LIMIT 20`, [req.params.storeId]
    );
    return rows;
  });
}

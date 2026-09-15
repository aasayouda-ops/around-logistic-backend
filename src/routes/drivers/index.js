import { query } from '../../db/pool.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { v4 as uuid } from 'uuid';
import { z } from 'zod';

const DriverSchema = z.object({
  full_name:            z.string().min(2),
  id_number:            z.string().regex(/^\d{10}$/, 'رقم الهوية/الإقامة 10 أرقام'),
  driver_type:          z.enum(['individual', 'vehicle']),
  city:                 z.string().min(2),
  vehicle_type:         z.string().optional(),
  plate_number:         z.string().optional(),
  istimara_number:      z.string().optional(),
  transport_license:    z.string().optional(),
  pharma_licensed:      z.boolean().default(false),
  pharma_license_number:z.string().optional(),
  capacity_liters:      z.number().int().positive().optional()
}).refine(d => {
  if (d.driver_type === 'vehicle') {
    return d.vehicle_type && d.plate_number && d.istimara_number && d.transport_license;
  }
  return true;
}, { message: 'بيانات المركبة (النوع، اللوحة، الاستمارة، رخصة النقل) مطلوبة للمركبات' });

export default async function driversRoutes(fastify) {

  // GET /drivers/me — my driver profile
  fastify.get('/me', { preHandler: requireRole('driver') }, async (req, reply) => {
    const { rows } = await query(
      'SELECT * FROM drivers WHERE user_id = $1', [req.user.id]
    );
    if (!rows[0]) return reply.code(404).send({ error: 'بيانات السائق غير مكتملة' });
    return rows[0];
  });

  // POST /drivers — create driver profile
  fastify.post('/', { preHandler: requireRole('driver') }, async (req, reply) => {
    const parsed = DriverSchema.safeParse(req.body);
    if (!parsed.success)
      return reply.code(400).send({ error: parsed.error.errors[0].message });

    const exists = await query('SELECT id FROM drivers WHERE user_id = $1', [req.user.id]);
    if (exists.rows[0])
      return reply.code(409).send({ error: 'ملف السائق موجود — استخدم PUT للتعديل' });

    const idExists = await query('SELECT id FROM drivers WHERE id_number = $1', [parsed.data.id_number]);
    if (idExists.rows[0])
      return reply.code(409).send({ error: 'رقم الهوية/الإقامة مسجّل لسائق آخر' });

    const d = parsed.data;
    const { rows } = await query(
      `INSERT INTO drivers
         (id, user_id, full_name, id_number, driver_type, city,
          vehicle_type, plate_number, istimara_number, transport_license,
          pharma_licensed, pharma_license_number, capacity_liters)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [uuid(), req.user.id, d.full_name, d.id_number, d.driver_type, d.city,
       d.vehicle_type || null, d.plate_number || null, d.istimara_number || null,
       d.transport_license || null, d.pharma_licensed, d.pharma_license_number || null,
       d.capacity_liters || null]
    );
    return reply.code(201).send(rows[0]);
  });

  // PUT /drivers/me — update profile
  fastify.put('/me', { preHandler: requireRole('driver') }, async (req, reply) => {
    const allowed = ['city','vehicle_type','plate_number','istimara_number',
                     'transport_license','pharma_licensed','pharma_license_number','capacity_liters'];
    const fields = [];
    const values = [];
    let i = 1;
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        fields.push(`${key}=$${i++}`);
        values.push(req.body[key]);
      }
    }
    if (!fields.length) return reply.code(400).send({ error: 'لا توجد بيانات للتحديث' });
    values.push(req.user.id);
    await query(`UPDATE drivers SET ${fields.join(',')} WHERE user_id=$${i}`, values);
    return { message: 'تم تحديث بيانات السائق' };
  });

  // PATCH /drivers/me/location — GPS update (called every 30s from mobile)
  fastify.patch('/me/location', { preHandler: requireRole('driver') }, async (req, reply) => {
    const { lat, lng, speed_kmh, shipment_id } = req.body;
    if (!lat || !lng) return reply.code(400).send({ error: 'الإحداثيات مطلوبة' });

    await query(
      `UPDATE drivers SET current_lat=$1, current_lng=$2, last_location_at=NOW()
       WHERE user_id=$3`,
      [lat, lng, req.user.id]
    );

    if (shipment_id) {
      const driver = await query('SELECT id FROM drivers WHERE user_id=$1', [req.user.id]);
      if (driver.rows[0]) {
        await query(
          `INSERT INTO gps_tracks (id, shipment_id, driver_id, lat, lng, speed_kmh)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [uuid(), shipment_id, driver.rows[0].id, lat, lng, speed_kmh || null]
        );
      }
    }
    return { recorded: true };
  });

  // PATCH /drivers/me/availability — toggle online/offline
  fastify.patch('/me/availability', { preHandler: requireRole('driver') }, async (req, reply) => {
    const { is_available } = req.body;
    if (typeof is_available !== 'boolean')
      return reply.code(400).send({ error: 'is_available يجب أن يكون true أو false' });
    await query('UPDATE drivers SET is_available=$1 WHERE user_id=$2', [is_available, req.user.id]);
    return { message: is_available ? 'أنت متاح الآن لاستقبال الطلبات' : 'أنت غير متاح حالياً' };
  });

  // GET /drivers/:id — public profile (for stores)
  fastify.get('/:id', { preHandler: authenticate }, async (req, reply) => {
    const { rows } = await query(
      `SELECT id, full_name, driver_type, city, vehicle_type,
              pharma_licensed, capacity_liters, rating_avg, rating_count,
              is_available, current_lat, current_lng, last_location_at
       FROM drivers WHERE id = $1`, [req.params.id]
    );
    if (!rows[0]) return reply.code(404).send({ error: 'السائق غير موجود' });
    return rows[0];
  });
}

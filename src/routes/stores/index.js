import { query } from '../../db/pool.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { v4 as uuid } from 'uuid';
import { z } from 'zod';

const StoreSchema = z.object({
  store_name:    z.string().min(2),
  cr_number:     z.string().regex(/^\d{10}$/, 'السجل التجاري 10 أرقام'),
  vat_number:    z.string().regex(/^\d{15}$/, 'الرقم الضريبي 15 رقم'),
  activity_type: z.string().min(2),
  city:          z.string().min(2),
  district:      z.string().min(2),
  short_address: z.string().regex(/^[A-Za-z]{4}\d{4}$/, 'العنوان الوطني بصيغة XXXX0000').optional(),
  full_address:  z.string().optional(),
  lat:           z.number().optional(),
  lng:           z.number().optional()
});

export default async function storesRoutes(fastify) {

  // GET /stores/me — my store profile
  fastify.get('/me', { preHandler: requireRole('store') }, async (req, reply) => {
    const { rows } = await query(
      'SELECT * FROM stores WHERE user_id = $1', [req.user.id]
    );
    if (!rows[0]) return reply.code(404).send({ error: 'بيانات المتجر غير مكتملة' });
    return rows[0];
  });

  // POST /stores — create store profile
  fastify.post('/', { preHandler: requireRole('store') }, async (req, reply) => {
    const parsed = StoreSchema.safeParse(req.body);
    if (!parsed.success)
      return reply.code(400).send({ error: parsed.error.errors[0].message });

    const exists = await query('SELECT id FROM stores WHERE user_id = $1', [req.user.id]);
    if (exists.rows[0])
      return reply.code(409).send({ error: 'ملف المتجر موجود مسبقاً — استخدم PUT للتعديل' });

    const crExists = await query('SELECT id FROM stores WHERE cr_number = $1', [parsed.data.cr_number]);
    if (crExists.rows[0])
      return reply.code(409).send({ error: 'رقم السجل التجاري مسجّل لمتجر آخر' });

    const { rows } = await query(
      `INSERT INTO stores
         (id, user_id, store_name, cr_number, vat_number, activity_type,
          city, district, short_address, full_address, lat, lng)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [uuid(), req.user.id, parsed.data.store_name, parsed.data.cr_number,
       parsed.data.vat_number, parsed.data.activity_type, parsed.data.city,
       parsed.data.district, parsed.data.short_address?.toUpperCase() || null,
       parsed.data.full_address || null, parsed.data.lat || null, parsed.data.lng || null]
    );
    return reply.code(201).send(rows[0]);
  });

  // PUT /stores/me — update store profile
  fastify.put('/me', { preHandler: requireRole('store') }, async (req, reply) => {
    const parsed = StoreSchema.partial().safeParse(req.body);
    if (!parsed.success)
      return reply.code(400).send({ error: parsed.error.errors[0].message });

    const d = parsed.data;
    const fields = [];
    const values = [];
    let i = 1;
    if (d.store_name)    { fields.push(`store_name=$${i++}`);    values.push(d.store_name); }
    if (d.activity_type) { fields.push(`activity_type=$${i++}`); values.push(d.activity_type); }
    if (d.city)          { fields.push(`city=$${i++}`);          values.push(d.city); }
    if (d.district)      { fields.push(`district=$${i++}`);      values.push(d.district); }
    if (d.short_address) { fields.push(`short_address=$${i++}`); values.push(d.short_address.toUpperCase()); }
    if (d.full_address)  { fields.push(`full_address=$${i++}`);  values.push(d.full_address); }
    if (d.lat != null)   { fields.push(`lat=$${i++}`);           values.push(d.lat); }
    if (d.lng != null)   { fields.push(`lng=$${i++}`);           values.push(d.lng); }
    if (!fields.length) return reply.code(400).send({ error: 'لا توجد بيانات للتحديث' });
    values.push(req.user.id);
    await query(`UPDATE stores SET ${fields.join(',')} WHERE user_id=$${i}`, values);
    return { message: 'تم تحديث بيانات المتجر' };
  });

  // GET /stores/:id — public profile
  fastify.get('/:id', { preHandler: authenticate }, async (req, reply) => {
    const { rows } = await query(
      `SELECT s.id, s.store_name, s.activity_type, s.city,
              s.rating_avg, s.rating_count, s.created_at
       FROM stores s WHERE s.id = $1`, [req.params.id]
    );
    if (!rows[0]) return reply.code(404).send({ error: 'المتجر غير موجود' });
    return rows[0];
  });
}

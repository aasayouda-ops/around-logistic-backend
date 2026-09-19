import { query } from '../../db/pool.js';
import { requireRole } from '../../middleware/auth.js';
import { generateApiKey } from '../../middleware/api-key.js';
import { v4 as uuid } from 'uuid';
import { z } from 'zod';

export default async function integrationManageRoutes(fastify) {

  fastify.get('/status', { preHandler: requireRole('store') }, async (req, reply) => {
    const { rows } = await query(
      `SELECT platform, is_active, connected_at, external_store_id
       FROM store_integrations WHERE store_id=$1`,
      [req.user.storeId]
    );
    const platforms = ['salla', 'zid', 'shopify', 'woocommerce'];
    const status = Object.fromEntries(platforms.map(p => [p, { connected: false }]));
    rows.forEach(r => {
      status[r.platform] = {
        connected: r.is_active,
        connectedAt: r.connected_at,
        storeId: r.external_store_id
      };
    });
    return status;
  });

  fastify.delete('/:platform', { preHandler: requireRole('store') }, async (req, reply) => {
    await query(
      `UPDATE store_integrations SET is_active=FALSE WHERE store_id=$1 AND platform=$2`,
      [req.user.storeId, req.params.platform]
    );
    return { message: 'تم فصل الربط' };
  });

  fastify.get('/api-keys', { preHandler: requireRole('store') }, async (req, reply) => {
    const { rows } = await query(
      `SELECT id, key_prefix, label, environment, last_used_at, created_at
       FROM api_keys WHERE store_id=$1 AND revoked=FALSE ORDER BY created_at DESC`,
      [req.user.storeId]
    );
    return rows;
  });

  fastify.post('/api-keys', { preHandler: requireRole('store') }, async (req, reply) => {
    const schema = z.object({
      label:       z.string().min(2).max(100).default('Default'),
      environment: z.enum(['live', 'test']).default('live')
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.errors[0].message });
    const key = await generateApiKey(req.user.storeId, parsed.data.label, parsed.data.environment);
    return reply.code(201).send({
      key,
      warning: 'احفظ هذا المفتاح الآن — لن يُعرض مرة أخرى'
    });
  });

  fastify.delete('/api-keys/:id', { preHandler: requireRole('store') }, async (req, reply) => {
    await query(
      `UPDATE api_keys SET revoked=TRUE WHERE id=$1 AND store_id=$2`,
      [req.params.id, req.user.storeId]
    );
    return { message: 'تم إلغاء المفتاح' };
  });

  fastify.get('/rates', { preHandler: requireRole('store') }, async (req, reply) => {
    const { rows } = await query(
      `SELECT * FROM shipping_rates WHERE store_id=$1 ORDER BY priority DESC`,
      [req.user.storeId]
    );
    return rows;
  });

  fastify.post('/rates', { preHandler: requireRole('store') }, async (req, reply) => {
    const schema = z.object({
      name:              z.string().min(2),
      from_city:         z.string().optional(),
      to_city:           z.string().optional(),
      base_price:        z.number().nonnegative(),
      price_per_kg:      z.number().nonnegative().default(0),
      free_above_amount: z.number().nonnegative().optional(),
      payer:             z.enum(['merchant', 'customer']).default('customer'),
      est_hours_min:     z.number().int().positive().default(24),
      est_hours_max:     z.number().int().positive().default(48)
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.errors[0].message });
    const d = parsed.data;
    const { rows } = await query(
      `INSERT INTO shipping_rates
        (id, store_id, name, from_city, to_city, base_price, price_per_kg,
         free_above_amount, payer, est_hours_min, est_hours_max, priority)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,100) RETURNING *`,
      [uuid(), req.user.storeId, d.name, d.from_city || null, d.to_city || null,
       d.base_price, d.price_per_kg, d.free_above_amount || null,
       d.payer, d.est_hours_min, d.est_hours_max]
    );
    return reply.code(201).send(rows[0]);
  });

  fastify.delete('/rates/:id', { preHandler: requireRole('store') }, async (req, reply) => {
    await query('DELETE FROM shipping_rates WHERE id=$1 AND store_id=$2',
      [req.params.id, req.user.storeId]);
    return { message: 'تم حذف التسعيرة' };
  });
}
import { query } from '../../db/pool.js';
import { requireRole } from '../../middleware/auth.js';

export default async function adminRoutes(fastify) {

  // GET /admin/stats — dashboard numbers
  fastify.get('/stats', { preHandler: requireRole('admin') }, async (req, reply) => {
    const [shipments, drivers, stores, revenue, alerts, tickets] = await Promise.all([
      query(`SELECT
               COUNT(*) FILTER (WHERE status='in_transit') AS active,
               COUNT(*) FILTER (WHERE status='delivered')  AS delivered,
               COUNT(*) FILTER (WHERE status='pending')    AS pending,
               COUNT(*)                                    AS total
             FROM shipments`),
      query(`SELECT COUNT(*) AS total,
               COUNT(*) FILTER (WHERE is_available) AS available
             FROM drivers`),
      query('SELECT COUNT(*) AS total FROM stores'),
      query(`SELECT COALESCE(SUM(price_total),0) AS total,
               COALESCE(SUM(vat_amount),0) AS vat
             FROM shipments WHERE payment_status='paid'`),
      query(`SELECT COUNT(*) AS count FROM temperature_readings
             WHERE is_alert=TRUE
               AND recorded_at > NOW() - INTERVAL '1 hour'`),
      query(`SELECT COUNT(*) FILTER (WHERE status='open') AS open,
               COUNT(*) AS total FROM tickets`)
    ]);
    return {
      shipments: shipments.rows[0],
      drivers:   drivers.rows[0],
      stores:    { total: stores.rows[0].total },
      revenue:   revenue.rows[0],
      temp_alerts_last_hour: alerts.rows[0].count,
      tickets:   tickets.rows[0]
    };
  });

  // GET /admin/shipments — all shipments with filters
  fastify.get('/shipments', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { status, city, page = 1, limit = 50 } = req.query;
    const conditions = [];
    const params = [];
    let i = 1;
    if (status) { conditions.push(`s.status=$${i++}`); params.push(status); }
    if (city)   { conditions.push(`(s.from_city=$${i++} OR s.to_city=$${i++})`); params.push(city, city); i--; }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const offset = (page - 1) * limit;
    params.push(limit, offset);
    const { rows } = await query(
      `SELECT s.*, st.store_name, d.full_name AS driver_name
       FROM shipments s
       JOIN stores st ON st.id = s.store_id
       LEFT JOIN drivers d ON d.id = s.driver_id
       ${where} ORDER BY s.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    return rows;
  });

  // GET /admin/drivers — all drivers
  fastify.get('/drivers', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { rows } = await query(
      `SELECT d.*, u.phone, u.is_active
       FROM drivers d JOIN users u ON u.id = d.user_id
       ORDER BY d.created_at DESC`
    );
    return rows;
  });

  // GET /admin/stores — all stores
  fastify.get('/stores', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { rows } = await query(
      `SELECT s.*, u.phone, u.is_active
       FROM stores s JOIN users u ON u.id = s.user_id
       ORDER BY s.created_at DESC`
    );
    return rows;
  });

  // PATCH /admin/users/:id/toggle — activate / deactivate account
  fastify.patch('/users/:id/toggle', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { rows: [u] } = await query('SELECT is_active FROM users WHERE id=$1', [req.params.id]);
    if (!u) return reply.code(404).send({ error: 'المستخدم غير موجود' });
    await query('UPDATE users SET is_active=$1 WHERE id=$2', [!u.is_active, req.params.id]);
    return { message: !u.is_active ? 'تم تفعيل الحساب' : 'تم إيقاف الحساب', is_active: !u.is_active };
  });

  // GET /admin/temp-alerts — recent temperature alerts
  fastify.get('/temp-alerts', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { rows } = await query(
      `SELECT tr.*, s.shipment_code, s.product_name, s.temp_min, s.temp_max
       FROM temperature_readings tr
       JOIN shipments s ON s.id = tr.shipment_id
       WHERE tr.is_alert = TRUE
       ORDER BY tr.recorded_at DESC LIMIT 50`
    );
    return rows;
  });

  // GET /admin/revenue — revenue report by period
  fastify.get('/revenue', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { rows } = await query(
      `SELECT
         DATE_TRUNC('day', delivered_at) AS day,
         COUNT(*) AS shipments,
         SUM(price_total) AS revenue,
         SUM(vat_amount) AS vat
       FROM shipments
       WHERE status='delivered' AND delivered_at IS NOT NULL
       GROUP BY 1 ORDER BY 1 DESC LIMIT 30`
    );
    return rows;
  });
}

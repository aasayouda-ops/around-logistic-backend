import { query } from '../../db/pool.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { publish } from '../../db/redis.js';
import { v4 as uuid } from 'uuid';
import { z } from 'zod';

const CreateShipmentSchema = z.object({
  product_name:   z.string().min(2),
  category:       z.string(),
  weight_kg:      z.number().positive(),
  temp_min:       z.number(),
  temp_max:       z.number(),
  from_city:      z.string(),
  from_address:   z.string().optional(),
  from_short_addr:z.string().optional(),
  from_lat:       z.number().optional(),
  from_lng:       z.number().optional(),
  to_city:        z.string(),
  to_address:     z.string().optional(),
  to_short_addr:  z.string().optional(),
  to_lat:         z.number().optional(),
  to_lng:         z.number().optional(),
  payment_method: z.enum(['mada','apple_pay','bank_transfer','cash_on_delivery']),
  notes:          z.string().optional()
});

const VAT_RATE = 0.15;

function generateCode(prefix) {
  return `${prefix}-${Math.floor(1000 + Math.random() * 9000)}`;
}

function calcPrice(weight_kg) {
  const subtotal = Math.round(35 + weight_kg * 2.2 + Math.random() * 15);
  const vat = Math.round(subtotal * VAT_RATE);
  return { subtotal, vat, total: subtotal + vat };
}

export default async function shipmentsRoutes(fastify) {

  // GET /shipments — list for current user
  fastify.get('/', { preHandler: authenticate }, async (request, reply) => {
    const { role, id } = request.user;
    let rows;

    if (role === 'store') {
      ({ rows } = await query(
        `SELECT s.*, st.store_name, d.full_name AS driver_name
         FROM shipments s
         JOIN stores st ON st.id = s.store_id
         LEFT JOIN drivers d ON d.id = s.driver_id
         WHERE st.user_id = $1
         ORDER BY s.created_at DESC LIMIT 50`,
        [id]
      ));
    } else if (role === 'driver') {
      ({ rows } = await query(
        `SELECT s.*, st.store_name, d.full_name AS driver_name
         FROM shipments s
         JOIN stores st ON st.id = s.store_id
         LEFT JOIN drivers d ON d.id = s.driver_id
         WHERE s.driver_id = (SELECT id FROM drivers WHERE user_id = $1)
         ORDER BY s.created_at DESC LIMIT 50`,
        [id]
      ));
    } else {
      ({ rows } = await query(
        `SELECT s.*, st.store_name, d.full_name AS driver_name
         FROM shipments s
         JOIN stores st ON st.id = s.store_id
         LEFT JOIN drivers d ON d.id = s.driver_id
         ORDER BY s.created_at DESC LIMIT 100`
      ));
    }
    return rows;
  });

  // GET /shipments/available — pending shipments for drivers
  fastify.get('/available', { preHandler: requireRole('driver') }, async (request, reply) => {
    const { rows } = await query(
      `SELECT s.*, st.store_name
       FROM shipments s JOIN stores st ON st.id = s.store_id
       WHERE s.status = 'pending'
       ORDER BY s.created_at DESC`
    );
    return rows;
  });

  // GET /shipments/:id
  fastify.get('/:id', { preHandler: authenticate }, async (request, reply) => {
    const { rows } = await query(
      `SELECT s.*, st.store_name, st.vat_number, st.cr_number,
              d.full_name AS driver_name
       FROM shipments s
       JOIN stores st ON st.id = s.store_id
       LEFT JOIN drivers d ON d.id = s.driver_id
       WHERE s.id = $1`,
      [request.params.id]
    );
    if (!rows[0]) return reply.code(404).send({ error: 'الشحنة غير موجودة' });
    return rows[0];
  });

  // POST /shipments — create new shipment
  fastify.post('/', { preHandler: requireRole('store') }, async (request, reply) => {
    const parsed = CreateShipmentSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.errors[0].message });
    }
    const data = parsed.data;

    const storeResult = await query('SELECT id FROM stores WHERE user_id = $1', [request.user.id]);
    if (!storeResult.rows[0]) return reply.code(404).send({ error: 'بيانات المتجر غير مكتملة' });

    const id = uuid();
    const code = generateCode('SHP');
    const paymentStatus = data.payment_method === 'cash_on_delivery' ? 'due_on_delivery' : 'pending';

    const { rows } = await query(
      `INSERT INTO shipments (
        id, shipment_code, store_id, product_name, category,
        weight_kg, temp_min, temp_max, notes,
        from_city, from_address, from_short_addr, from_lat, from_lng,
        to_city, to_address, to_short_addr, to_lat, to_lng,
        payment_method, payment_status
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,
        $10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21
      ) RETURNING *`,
      [
        id, code, storeResult.rows[0].id, data.product_name, data.category,
        data.weight_kg, data.temp_min, data.temp_max, data.notes || null,
        data.from_city, data.from_address, data.from_short_addr, data.from_lat, data.from_lng,
        data.to_city, data.to_address, data.to_short_addr, data.to_lat, data.to_lng,
        data.payment_method, paymentStatus
      ]
    );

    await publish('shipment:created', { shipmentId: id, storeId: storeResult.rows[0].id });
    return reply.code(201).send(rows[0]);
  });

  // PATCH /shipments/:id/accept — driver accepts
  fastify.patch('/:id/accept', { preHandler: requireRole('driver') }, async (request, reply) => {
    const driverResult = await query(
      'SELECT id, pharma_licensed FROM drivers WHERE user_id = $1',
      [request.user.id]
    );
    if (!driverResult.rows[0]) return reply.code(404).send({ error: 'بيانات السائق غير موجودة' });
    const driver = driverResult.rows[0];

    const shipResult = await query(
      'SELECT id, category, status FROM shipments WHERE id = $1', [request.params.id]
    );
    if (!shipResult.rows[0]) return reply.code(404).send({ error: 'الشحنة غير موجودة' });
    const ship = shipResult.rows[0];

    if (ship.status !== 'pending') return reply.code(409).send({ error: 'الشحنة ليست متاحة' });
    if (ship.category === 'أدوية ولقاحات' && !driver.pharma_licensed) {
      return reply.code(403).send({ error: 'نقل الأدوية يتطلب ترخيص SFDA' });
    }

    await query(
      `UPDATE shipments SET status='accepted', driver_id=$1, accepted_at=NOW()
       WHERE id=$2 AND status='pending'`,
      [driver.id, request.params.id]
    );
    await publish('shipment:accepted', { shipmentId: request.params.id, driverId: driver.id });
    return { message: 'تم قبول الشحنة بنجاح' };
  });

  // PATCH /shipments/:id/start — driver starts trip
  fastify.patch('/:id/start', { preHandler: requireRole('driver') }, async (request, reply) => {
    await query(
      `UPDATE shipments SET status='in_transit', started_at=NOW()
       WHERE id=$1 AND status='accepted'`,
      [request.params.id]
    );
    await publish('shipment:started', { shipmentId: request.params.id });
    return { message: 'بدأت الرحلة' };
  });

  // PATCH /shipments/:id/deliver — driver confirms delivery
  fastify.patch('/:id/deliver', { preHandler: requireRole('driver') }, async (request, reply) => {
    const { rows } = await query(
      'SELECT * FROM shipments WHERE id = $1 AND status = $2',
      [request.params.id, 'in_transit']
    );
    if (!rows[0]) return reply.code(404).send({ error: 'الشحنة غير موجودة أو ليست قيد النقل' });

    const s = rows[0];
    const { subtotal, vat, total } = calcPrice(s.weight_kg);
    const invoiceNum = `INV-${s.shipment_code.split('-')[1]}`;
    const payStatus  = s.payment_method === 'cash_on_delivery' ? 'paid' : s.payment_status;
    const txRef      = s.payment_method === 'cash_on_delivery' ? `COD-${s.shipment_code}` : s.transaction_ref;

    await query(
      `UPDATE shipments SET
        status='delivered', delivered_at=NOW(), progress_pct=100,
        price_subtotal=$1, vat_amount=$2, price_total=$3,
        invoice_number=$4, payment_status=$5, transaction_ref=$6
       WHERE id=$7`,
      [subtotal, vat, total, invoiceNum, payStatus, txRef, s.id]
    );
    await publish('shipment:delivered', { shipmentId: s.id, invoiceNumber: invoiceNum });
    return { message: 'تم تسجيل التسليم', invoiceNumber: invoiceNum, total };
  });

  // POST /shipments/:id/temperature — IoT sensor push
  fastify.post('/:id/temperature', { preHandler: authenticate }, async (request, reply) => {
    const { value_c, sensor_id } = request.body;
    if (value_c === undefined) return reply.code(400).send({ error: 'قيمة الحرارة مطلوبة' });

    const { rows: [ship] } = await query(
      'SELECT temp_min, temp_max FROM shipments WHERE id = $1', [request.params.id]
    );
    if (!ship) return reply.code(404).send({ error: 'شحنة غير موجودة' });

    const is_alert = value_c < ship.temp_min || value_c > ship.temp_max;
    await query(
      `INSERT INTO temperature_readings (id, shipment_id, value_c, is_alert, sensor_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [uuid(), request.params.id, value_c, is_alert, sensor_id || null]
    );

    if (is_alert) {
      await publish('shipment:temp_alert', { shipmentId: request.params.id, value_c, is_alert });
    }
    return { recorded: true, is_alert };
  });

  // GET /shipments/:id/temperature — history
  fastify.get('/:id/temperature', { preHandler: authenticate }, async (request, reply) => {
    const { rows } = await query(
      `SELECT value_c, is_alert, sensor_id, recorded_at
       FROM temperature_readings WHERE shipment_id = $1
       ORDER BY recorded_at DESC LIMIT 100`,
      [request.params.id]
    );
    return rows;
  });

  // GET /shipments/:id/track — GPS history
  fastify.get('/:id/track', { preHandler: authenticate }, async (request, reply) => {
    const { rows } = await query(
      `SELECT lat, lng, speed_kmh, recorded_at
       FROM gps_tracks WHERE shipment_id = $1
       ORDER BY recorded_at DESC LIMIT 200`,
      [request.params.id]
    );
    return rows;
  });
}

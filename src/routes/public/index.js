import { query } from '../../db/pool.js';
import { authenticateApiKey } from '../../middleware/api-key.js';
import { calculateRate, getAvailableOptions, deriveTemperatureRange } from '../../services/rate-calculator.js';
import { publish } from '../../db/redis.js';
import { v4 as uuid } from 'uuid';
import { z } from 'zod';

const ItemSchema = z.object({
  sku:       z.string().optional(),
  name:      z.string(),
  qty:       z.number().int().positive().default(1),
  weight_kg: z.number().positive(),
  temp_min:  z.number().optional(),
  temp_max:  z.number().optional()
});

const RateRequestSchema = z.object({
  to_city:     z.string().min(2),
  to_district: z.string().optional(),
  items:       z.array(ItemSchema).min(1),
  order_value: z.number().nonnegative().default(0)
});

const OrderSchema = z.object({
  external_order_id: z.string().optional(),
  customer_name:     z.string().min(2),
  customer_phone:    z.string().regex(/^05\d{8}$/, 'رقم جوال سعودي غير صحيح'),
  customer_email:    z.string().email().optional(),
  to_city:           z.string().min(2),
  to_district:       z.string().optional(),
  to_address:        z.string().optional(),
  to_short_addr:     z.string().optional(),
  items:             z.array(ItemSchema).min(1),
  order_value:       z.number().nonnegative().default(0),
  payer:             z.enum(['merchant','customer']).optional(),
  notes:             z.string().optional()
});

function genCode(prefix) {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random()*900+100)}`;
}

export default async function publicApiRoutes(fastify) {

  fastify.post('/rates', { preHandler: authenticateApiKey }, async (req, reply) => {
    const parsed = RateRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.errors[0].message });
    }
    const { to_city, items, order_value } = parsed.data;
    const totalWeight = items.reduce((s, i) => s + (i.weight_kg * i.qty), 0);
    const { requiresCooling, tempMin, tempMax } = deriveTemperatureRange(items);

    const options = await getAvailableOptions({
      storeId:    req.merchant.storeId,
      fromCity:   req.merchant.city,
      toCity:     to_city,
      weightKg:   totalWeight,
      category:   null,
      orderValue: order_value
    });

    if (!options.length) {
      return reply.send({
        available: false,
        message: 'عذراً، الشحن المبرّد غير متاح لهذه المنطقة حالياً',
        options: []
      });
    }

    return {
      available: true,
      total_weight_kg: Math.round(totalWeight * 1000) / 1000,
      requires_cooling: requiresCooling,
      temperature_range: requiresCooling ? { min: tempMin, max: tempMax } : null,
      options: options.map(o => ({
        id: o.rateId,
        name: o.name,
        carrier: 'Around Logistic',
        price: o.total,
        price_excl_vat: o.subtotal,
        vat: o.vat,
        currency: 'SAR',
        is_free: o.isFree,
        payer: o.payer,
        estimated_delivery: o.estimatedDelivery,
        description: requiresCooling
          ? `نقل مبرّد (${tempMin}° إلى ${tempMax}°C) مع تتبع الحرارة`
          : 'نقل مبرّد مع تتبع مباشر'
      }))
    };
  });

  fastify.post('/orders', { preHandler: authenticateApiKey }, async (req, reply) => {
    const parsed = OrderSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.errors[0].message });
    }
    const d = parsed.data;

    if (d.external_order_id) {
      const dup = await query(
        'SELECT id, order_code FROM orders WHERE store_id=$1 AND external_order_id=$2',
        [req.merchant.storeId, d.external_order_id]
      );
      if (dup.rows[0]) {
        return reply.code(409).send({
          error: 'هذا الطلب مسجّل مسبقاً',
          order_id: dup.rows[0].id,
          order_code: dup.rows[0].order_code
        });
      }
    }

    const totalWeight = d.items.reduce((s, i) => s + (i.weight_kg * i.qty), 0);
    const { requiresCooling, tempMin, tempMax } = deriveTemperatureRange(d.items);

    const rate = await calculateRate({
      storeId:    req.merchant.storeId,
      fromCity:   req.merchant.city,
      toCity:     d.to_city,
      weightKg:   totalWeight,
      orderValue: d.order_value
    });

    if (!rate.available) {
      return reply.code(422).send({ error: rate.reason });
    }

    const orderId   = uuid();
    const orderCode = genCode('ORD');

    await query(
      `INSERT INTO orders (
        id, order_code, store_id, external_order_id, platform,
        customer_name, customer_phone, customer_email,
        to_city, to_district, to_address, to_short_addr,
        items, total_weight_kg, requires_cooling, temp_min, temp_max, order_value,
        shipping_rate_id, shipping_cost, shipping_vat, shipping_total, payer, status
      ) VALUES (
        $1,$2,$3,$4,'custom',$5,$6,$7,$8,$9,$10,$11,
        $12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,'confirmed'
      )`,
      [
        orderId, orderCode, req.merchant.storeId, d.external_order_id || null,
        d.customer_name, d.customer_phone, d.customer_email || null,
        d.to_city, d.to_district || null, d.to_address || null,
        d.to_short_addr ? d.to_short_addr.toUpperCase() : null,
        JSON.stringify(d.items), totalWeight, requiresCooling, tempMin, tempMax, d.order_value,
        rate.rateId, rate.subtotal, rate.vat, rate.total, d.payer || rate.payer
      ]
    );

    const shipmentId   = uuid();
    const shipmentCode = genCode('SHP');
    const productNames = d.items.map(i => `${i.name} x${i.qty}`).join('، ');

    await query(
      `INSERT INTO shipments (
        id, shipment_code, store_id, order_id, product_name, category,
        weight_kg, temp_min, temp_max, notes,
        from_city, to_city, to_address, to_short_addr,
        customer_name, customer_phone,
        payment_method, payment_status, status
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
        'bank_transfer','pending','pending'
      )`,
      [
        shipmentId, shipmentCode, req.merchant.storeId, orderId,
        productNames.slice(0, 200),
        requiresCooling ? 'مبرّد/طازج (خضار وفواكه)' : 'أخرى',
        totalWeight, tempMin != null ? tempMin : 2, tempMax != null ? tempMax : 8,
        d.notes || null,
        req.merchant.city, d.to_city, d.to_address || null,
        d.to_short_addr ? d.to_short_addr.toUpperCase() : null,
        d.customer_name, d.customer_phone
      ]
    );

    await query('UPDATE orders SET shipment_id=$1 WHERE id=$2', [shipmentId, orderId]);
    await publish('shipment:created', { shipmentId, storeId: req.merchant.storeId });

    return reply.code(201).send({
      order_id: orderId,
      order_code: orderCode,
      shipment_id: shipmentId,
      tracking_code: shipmentCode,
      tracking_url: `${process.env.FRONTEND_URL || 'https://app.aroundlogistic.sa'}/track/${shipmentCode}`,
      shipping: {
        cost: rate.subtotal,
        vat: rate.vat,
        total: rate.total,
        payer: d.payer || rate.payer,
        currency: 'SAR'
      },
      temperature_range: requiresCooling ? { min: tempMin, max: tempMax } : null,
      estimated_delivery: rate.estimatedDelivery,
      status: 'confirmed'
    });
  });

  fastify.get('/track/:code', async (req, reply) => {
    const { rows: [s] } = await query(
      `SELECT s.id, s.shipment_code, s.status, s.progress_pct, s.from_city, s.to_city,
              s.temp_min, s.temp_max, s.created_at, s.accepted_at, s.started_at, s.delivered_at,
              s.product_name, s.invoice_number, s.price_total,
              st.store_name, d.full_name AS driver_name,
              (SELECT value_c FROM temperature_readings
               WHERE shipment_id = s.id ORDER BY recorded_at DESC LIMIT 1) AS current_temp
       FROM shipments s
       JOIN stores st ON st.id = s.store_id
       LEFT JOIN drivers d ON d.id = s.driver_id
       WHERE s.shipment_code = $1`,
      [req.params.code]
    );

    if (!s) return reply.code(404).send({ error: 'رقم التتبع غير موجود' });

    const { rows: tempHistory } = await query(
      `SELECT value_c, is_alert, recorded_at FROM temperature_readings
       WHERE shipment_id = $1 ORDER BY recorded_at DESC LIMIT 20`,
      [s.id]
    );

    const labels = {
      pending: 'بانتظار إسناد سائق', accepted: 'تم إسناد السائق',
      in_transit: 'جاري التوصيل', delivered: 'تم التسليم', cancelled: 'ملغاة'
    };

    const steps = [
      { key: 'created',    label: 'تم استلام الطلب', at: s.created_at,   done: true },
      { key: 'accepted',   label: 'تم إسناد سائق',    at: s.accepted_at,  done: !!s.accepted_at },
      { key: 'in_transit', label: 'في الطريق إليك',   at: s.started_at,   done: !!s.started_at },
      { key: 'delivered',  label: 'تم التسليم',       at: s.delivered_at, done: !!s.delivered_at }
    ];

    return {
      tracking_code: s.shipment_code,
      status: s.status,
      status_label: labels[s.status],
      progress: s.progress_pct,
      product: s.product_name,
      store: s.store_name,
      route: { from: s.from_city, to: s.to_city },
      driver_name: s.driver_name,
      steps,
      temperature: {
        current: s.current_temp != null ? Number(s.current_temp) : null,
        min: Number(s.temp_min),
        max: Number(s.temp_max),
        in_range: s.current_temp == null ? null :
          (Number(s.current_temp) >= Number(s.temp_min) && Number(s.current_temp) <= Number(s.temp_max)),
        history: tempHistory.reverse().map(t => ({
          value: Number(t.value_c), alert: t.is_alert, at: t.recorded_at
        }))
      },
      invoice: s.invoice_number ? {
        number: s.invoice_number,
        total: s.price_total != null ? Number(s.price_total) : null
      } : null,
      created_at: s.created_at,
      delivered_at: s.delivered_at
    };
  });
}
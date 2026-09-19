import { query } from '../../db/pool.js';
import { requireRole } from '../../middleware/auth.js';
import { calculateRate } from '../../services/rate-calculator.js';
import { v4 as uuid } from 'uuid';

const ZID_AUTH_URL = 'https://oauth.zid.sa/oauth/authorize';

function normalizePhone(phone) {
  if (!phone) return '';
  const digits = String(phone).replace(/\D/g, '');
  if (digits.startsWith('9665')) return '0' + digits.slice(3);
  if (digits.startsWith('05'))   return digits;
  if (digits.startsWith('5'))    return '0' + digits;
  return digits;
}

export default async function zidRoutes(fastify) {

  fastify.get('/install', { preHandler: requireRole('store') }, async (req, reply) => {
    const state = uuid();
    await query(
      `INSERT INTO store_integrations (id, store_id, platform, settings)
       VALUES ($1,$2,'zid',$3)
       ON CONFLICT (store_id, platform) DO UPDATE SET settings=$3`,
      [uuid(), req.user.storeId, JSON.stringify({ oauth_state: state })]
    );
    const params = new URLSearchParams({
      client_id:     process.env.ZID_CLIENT_ID || '',
      response_type: 'code',
      redirect_uri:  `${process.env.API_BASE_URL}/integrations/zid/callback`,
      state
    });
    return reply.redirect(`${ZID_AUTH_URL}?${params}`);
  });

  fastify.get('/callback', async (req, reply) => {
    const feUrl = process.env.FRONTEND_URL || 'https://app.aroundlogistic.sa';
    return reply.redirect(`${feUrl}/dashboard/integrations?connected=zid`);
  });

  fastify.post('/webhook', async (req, reply) => {
    const { event, store_id, data } = req.body || {};
    const { rows: [integ] } = await query(
      `SELECT store_id FROM store_integrations
       WHERE platform='zid' AND external_store_id=$1 AND is_active=TRUE`,
      [String(store_id || '')]
    );
    if (!integ) return { received: true };

    if (event === 'order.create' && data) {
      const address = data.shipping_address || {};
      const { rows: [store] } = await query('SELECT city FROM stores WHERE id=$1', [integ.store_id]);
      const items = (data.products || data.items || []).map(it => ({
        name:      it.name || 'منتج',
        qty:       it.quantity || 1,
        weight_kg: it.weight || 0.5
      }));
      const totalWeight = items.reduce((s, i) => s + (i.weight_kg * i.qty), 0);
      const shipmentId   = uuid();
      const shipmentCode = `SHP-${Date.now().toString(36).toUpperCase()}`;
      await query(
        `INSERT INTO shipments (id, shipment_code, store_id, product_name, category,
          weight_kg, temp_min, temp_max, from_city, to_city, to_address,
          customer_name, customer_phone, payment_method, payment_status, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'bank_transfer','pending','pending')`,
        [shipmentId, shipmentCode, integ.store_id,
         items.map(i => i.name).join('، ').slice(0, 200),
         'مبرّد/طازج (خضار وفواكه)', totalWeight, 2, 8,
         store?.city || '', address.city || '', address.line1 || '',
         data.customer?.name || 'عميل',
         normalizePhone(data.customer?.mobile || data.customer?.phone)]
      );
    }
    return { received: true };
  });

  fastify.post('/shipping/rates', async (req, reply) => {
    const { store_id, cart } = req.body || {};
    const { rows: [integ] } = await query(
      `SELECT store_id FROM store_integrations
       WHERE platform='zid' AND external_store_id=$1 AND is_active=TRUE`,
      [String(store_id || '')]
    );
    if (!integ) return { shipping_services: [] };
    const { rows: [store] } = await query('SELECT city FROM stores WHERE id=$1', [integ.store_id]);
    const items = cart?.items || [];
    const totalWeight = items.reduce((s, i) => s + ((i.weight || 0.5) * (i.quantity || 1)), 0);
    const rate = await calculateRate({
      storeId:    integ.store_id,
      fromCity:   store?.city || '',
      toCity:     cart?.shipping_city || '',
      weightKg:   totalWeight,
      orderValue: cart?.total || 0
    });
    if (!rate.available) return { shipping_services: [] };
    return {
      shipping_services: [{
        service_code: 'around_cold_shipping',
        service_name: 'شحن مبرّد — Around Logistic',
        cost:          rate.total,
        currency:      'SAR',
        delivery_time: rate.estimatedDelivery
      }]
    };
  });
}
import { query } from '../../db/pool.js';
import { requireRole } from '../../middleware/auth.js';
import { calculateRate } from '../../services/rate-calculator.js';
import { v4 as uuid } from 'uuid';
import crypto from 'crypto';

const SHOPIFY_API_VERSION = '2024-01';
const SCOPES = 'read_orders,write_orders,read_products';

function normalizePhone(phone) {
  if (!phone) return '';
  const digits = String(phone).replace(/\D/g, '');
  if (digits.startsWith('9665')) return '0' + digits.slice(3);
  if (digits.startsWith('05'))   return digits;
  if (digits.startsWith('5'))    return '0' + digits;
  return digits;
}

export default async function shopifyRoutes(fastify) {

  fastify.get('/install', { preHandler: requireRole('store') }, async (req, reply) => {
    const { shop } = req.query;
    if (!shop || !shop.endsWith('.myshopify.com')) {
      return reply.code(400).send({ error: 'shop غير صالح' });
    }
    const state = uuid();
    await query(
      `INSERT INTO store_integrations (id, store_id, platform, external_store_id, settings)
       VALUES ($1,$2,'shopify',$3,$4)
       ON CONFLICT (store_id, platform) DO UPDATE SET external_store_id=$3, settings=$4`,
      [uuid(), req.user.storeId, shop, JSON.stringify({ oauth_state: state })]
    );
    const params = new URLSearchParams({
      client_id:    process.env.SHOPIFY_API_KEY || '',
      scope:        SCOPES,
      redirect_uri: `${process.env.API_BASE_URL}/integrations/shopify/callback`,
      state
    });
    return reply.redirect(`https://${shop}/admin/oauth/authorize?${params}`);
  });

  fastify.get('/callback', async (req, reply) => {
    const feUrl = process.env.FRONTEND_URL || 'https://app.aroundlogistic.sa';
    const { code, shop, state } = req.query;
    if (!code || !shop) {
      return reply.redirect(`${feUrl}/dashboard/integrations?error=missing_code`);
    }
    try {
      const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id:     process.env.SHOPIFY_API_KEY,
          client_secret: process.env.SHOPIFY_API_SECRET,
          code
        })
      });
      const tokens = await tokenRes.json();
      const accessToken = tokens.access_token;
      if (!accessToken) throw new Error('no token');

      await query(
        `UPDATE store_integrations SET access_token=$1, is_active=TRUE, settings='{}'
         WHERE platform='shopify' AND external_store_id=$2`,
        [accessToken, shop]
      );

      await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/carrier_services.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
        body: JSON.stringify({
          carrier_service: {
            name: 'Around Logistic — شحن مبرّد',
            callback_url: `${process.env.API_BASE_URL}/integrations/shopify/shipping/rates`,
            service_discovery: true
          }
        })
      }).catch(() => {});
    } catch (e) {
      return reply.redirect(`${feUrl}/dashboard/integrations?error=token_failed`);
    }
    return reply.redirect(`${feUrl}/dashboard/integrations?connected=shopify`);
  });

  fastify.post('/shipping/rates', async (req, reply) => {
    const { rate } = req.body || {};
    if (!rate) return { rates: [] };
    const shopDomain = req.headers['x-shopify-shop-domain'] || '';
    const { rows: [integ] } = await query(
      `SELECT store_id FROM store_integrations
       WHERE platform='shopify' AND external_store_id=$1 AND is_active=TRUE`,
      [shopDomain]
    );
    if (!integ) return { rates: [] };
    const { rows: [store] } = await query('SELECT city FROM stores WHERE id=$1', [integ.store_id]);
    const items = rate.items || [];
    const totalWeightKg = items.reduce((s, i) => s + ((i.grams || 500) / 1000 * (i.quantity || 1)), 0);
    const orderValueRiyals = items.reduce((s, i) => s + (Number(i.price || 0) * (i.quantity || 1)), 0) / 100;
    const calc = await calculateRate({
      storeId:    integ.store_id,
      fromCity:   store?.city || '',
      toCity:     rate.destination?.city || '',
      weightKg:   totalWeightKg,
      orderValue: orderValueRiyals
    });
    if (!calc.available) return { rates: [] };
    return {
      rates: [{
        service_name: 'Around Logistic — شحن مبرّد',
        service_code: 'around_cold',
        total_price:  Math.round(calc.total * 100),
        currency:     'SAR',
        description:  calc.estimatedDelivery
      }]
    };
  });

  fastify.post('/webhook', async (req, reply) => {
    const shopDomain = req.headers['x-shopify-shop-domain'] || '';
    const order = req.body || {};
    const { rows: [integ] } = await query(
      `SELECT store_id FROM store_integrations
       WHERE platform='shopify' AND external_store_id=$1 AND is_active=TRUE`,
      [shopDomain]
    );
    if (!integ) return { received: true };
    const address = order.shipping_address || {};
    const { rows: [store] } = await query('SELECT city FROM stores WHERE id=$1', [integ.store_id]);
    const items = order.line_items || [];
    const totalWeight = items.reduce((s, i) => s + ((i.grams || 500) / 1000 * (i.quantity || 1)), 0);
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
       store?.city || '', address.city || '', address.address1 || '',
       `${address.first_name || ''} ${address.last_name || ''}`.trim() || 'عميل',
       normalizePhone(order.phone || address.phone)]
    ).catch(() => {});
    return { received: true };
  });
}
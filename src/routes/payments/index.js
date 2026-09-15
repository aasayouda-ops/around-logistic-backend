// ── Moyasar Payment Service ───────────────────────────────────
// Docs: https://moyasar.com/docs/

import { query } from '../../db/pool.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { pushNotification } from '../notifications/index.js';
import { sendSMS } from '../../services/unifonic.js';
import crypto from 'crypto';

const MOYASAR_API = 'https://api.moyasar.com/v1';
const MOYASAR_KEY = process.env.MOYASAR_API_KEY;

// ── Create Moyasar payment ────────────────────────────────────
export async function createMoyasarPayment({ amount, currency = 'SAR', description, metadata, callbackUrl }) {
  const res = await fetch(`${MOYASAR_API}/payments`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${Buffer.from(`${MOYASAR_KEY}:`).toString('base64')}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      amount: Math.round(amount * 100), // halalas
      currency,
      description,
      callback_url: callbackUrl,
      metadata,
      source: { type: 'creditcard' }
    })
  });
  return res.json();
}

// ── Verify Moyasar webhook signature ─────────────────────────
export function verifyWebhookSignature(payload, signature, secret) {
  const expected = crypto
    .createHmac('sha256', secret)
    .update(JSON.stringify(payload))
    .digest('hex');
  return expected === signature;
}

// ── Routes ───────────────────────────────────────────────────
export default async function paymentsRoutes(fastify) {

  // POST /payments/initiate/:shipmentId — initiate payment
  fastify.post('/initiate/:shipmentId', { preHandler: requireRole('store') }, async (req, reply) => {
    const { rows: [ship] } = await query(
      `SELECT s.*, st.store_name FROM shipments s
       JOIN stores st ON st.id = s.store_id
       WHERE s.id=$1 AND st.user_id=$2`,
      [req.params.shipmentId, req.user.id]
    );
    if (!ship) return reply.code(404).send({ error: 'الشحنة غير موجودة' });
    if (ship.payment_status === 'paid') return reply.code(409).send({ error: 'تم الدفع مسبقاً' });
    if (!ship.price_total) return reply.code(409).send({ error: 'الشحنة لم تُسلَّم بعد' });

    const payment = await createMoyasarPayment({
      amount: ship.price_total,
      description: `شحنة ${ship.shipment_code} — ${ship.product_name}`,
      metadata: { shipment_id: ship.id, store: ship.store_name },
      callbackUrl: `${process.env.API_BASE_URL}/api/payments/callback`
    });

    return { paymentUrl: payment.source?.transaction_url, paymentId: payment.id };
  });

  // POST /payments/webhook — Moyasar webhook (called by Moyasar server)
  fastify.post('/webhook', async (req, reply) => {
    const sig = req.headers['x-moyasar-signature'];
    if (!verifyWebhookSignature(req.body, sig, process.env.MOYASAR_WEBHOOK_SECRET)) {
      return reply.code(401).send({ error: 'Invalid signature' });
    }

    const { id: paymentId, status, metadata } = req.body;
    if (status !== 'paid' || !metadata?.shipment_id) return { ok: true };

    const { rows: [ship] } = await query(
      `SELECT s.*, st.user_id AS store_user_id, u.phone AS store_phone
       FROM shipments s
       JOIN stores st ON st.id = s.store_id
       JOIN users u ON u.id = st.user_id
       WHERE s.id=$1`, [metadata.shipment_id]
    );
    if (!ship) return { ok: true };

    await query(
      `UPDATE shipments SET payment_status='paid', transaction_ref=$1, paid_at=NOW()
       WHERE id=$2`,
      [paymentId, ship.id]
    );

    // push in-app notification + SMS
    await pushNotification({
      userId: ship.store_user_id,
      shipmentId: ship.id,
      channel: 'sms',
      title: 'تم تأكيد الدفع',
      message: `تم استلام دفعة ${ship.price_total} ر.س للشحنة ${ship.shipment_code}.`
    });
    await sendSMS(ship.store_phone,
      `Around Logistic: تم تأكيد دفعتك ${ship.price_total} ر.س للشحنة ${ship.shipment_code}.`
    );

    return { ok: true };
  });

  // GET /payments/callback — redirect after payment (browser)
  fastify.get('/callback', async (req, reply) => {
    const { status, id } = req.query;
    const base = process.env.FRONTEND_URL || 'https://app.aroundlogistic.sa';
    return reply.redirect(`${base}/payment?status=${status}&ref=${id}`);
  });
}

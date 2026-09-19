import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';

import authRoutes          from './routes/auth/index.js';
import shipmentsRoutes     from './routes/shipments/index.js';
import storesRoutes        from './routes/stores/index.js';
import driversRoutes       from './routes/drivers/index.js';
import ratingsRoutes       from './routes/ratings/index.js';
import ticketsRoutes       from './routes/tickets/index.js';
import notificationsRoutes from './routes/notifications/index.js';
import paymentsRoutes      from './routes/payments/index.js';
import adminRoutes         from './routes/admin/index.js';
import publicApiRoutes     from './routes/public/index.js';
import sallaRoutes         from './routes/integrations/salla.js';
import zidRoutes           from './routes/integrations/zid.js';
import shopifyRoutes       from './routes/integrations/shopify.js';
import integrationManageRoutes from './routes/integrations/manage.js';
import { pushNotification } from './routes/notifications/index.js';
import { sendSMS, sendWhatsApp, templates } from './services/unifonic.js';
import { generateInvoice } from './services/zatca.js';
import redisClient, { publish } from './db/redis.js';
import { query } from './db/pool.js';

const fastify = Fastify({
  logger: { level: process.env.NODE_ENV === 'production' ? 'warn' : 'info' }
});

await fastify.register(cors, {
  origin: [
    'https://app.aroundlogistic.sa',
    'https://admin.aroundlogistic.sa',
    'https://around-logistic-frontend.vercel.app',
    'http://localhost:3000'
  ],
  credentials: true
});

await fastify.register(jwt, { secret: process.env.JWT_SECRET });

await fastify.register(rateLimit, {
  max: 120,
  timeWindow: '1 minute',
  errorResponseBuilder: () => ({
    error: 'لقد تجاوزت الحد المسموح به من الطلبات — انتظر دقيقة'
  })
});

await fastify.register(websocket);

fastify.register(authRoutes,          { prefix: '/api/auth' });
fastify.register(shipmentsRoutes,     { prefix: '/api/shipments' });
fastify.register(storesRoutes,        { prefix: '/api/stores' });
fastify.register(driversRoutes,       { prefix: '/api/drivers' });
fastify.register(ratingsRoutes,       { prefix: '/api/ratings' });
fastify.register(ticketsRoutes,       { prefix: '/api/tickets' });
fastify.register(notificationsRoutes, { prefix: '/api/notifications' });
fastify.register(paymentsRoutes,      { prefix: '/api/payments' });
fastify.register(adminRoutes,         { prefix: '/api/admin' });
fastify.register(publicApiRoutes,     { prefix: '/v1' });
fastify.register(sallaRoutes,         { prefix: '/integrations/salla' });
fastify.register(zidRoutes,           { prefix: '/integrations/zid' });
fastify.register(shopifyRoutes,       { prefix: '/integrations/shopify' });
fastify.register(integrationManageRoutes, { prefix: '/api/integrations' });

const wsClients = new Map();

fastify.register(async function wsPlugin(fastify) {
  fastify.get('/ws', { websocket: true }, (socket) => {
    socket.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'subscribe' && msg.shipmentId) {
          if (!wsClients.has(msg.shipmentId)) wsClients.set(msg.shipmentId, new Set());
          wsClients.get(msg.shipmentId).add(socket);
          socket._shipmentId = msg.shipmentId;
          socket.send(JSON.stringify({ type: 'subscribed', shipmentId: msg.shipmentId }));
        }
      } catch {}
    });
    socket.on('close', () => {
      if (socket._shipmentId) {
        wsClients.get(socket._shipmentId)?.delete(socket);
      }
    });
  });
});

function broadcastToShipment(shipmentId, payload) {
  wsClients.get(shipmentId)?.forEach(s => {
    if (s.readyState === 1) s.send(JSON.stringify(payload));
  });
}

const subscriber = redisClient ? redisClient.duplicate() : null;
if (subscriber) await subscriber.connect();

if (subscriber) await subscriber.subscribe('shipment:created', async (raw) => {
  const { shipmentId, storeId } = JSON.parse(raw);
  const { rows: [st] } = await query(
    'SELECT u.id AS uid, u.phone, store_name FROM stores s JOIN users u ON u.id=s.user_id WHERE s.id=$1',
    [storeId]
  );
  if (!st) return;
  await pushNotification({ userId: st.uid, shipmentId, channel: 'sms',
    message: templates.shipmentCreated('SHP-xxxx') });
  await sendSMS(st.phone, templates.shipmentCreated(''));
});

if (subscriber) await subscriber.subscribe('shipment:accepted', async (raw) => {
  const { shipmentId } = JSON.parse(raw);
  const { rows: [s] } = await query(
    `SELECT s.*, st.user_id AS store_uid, su.phone AS store_phone,
            d.full_name AS driver_name, du.phone AS driver_phone, du.id AS driver_uid
     FROM shipments s
     JOIN stores st ON st.id=s.store_id JOIN users su ON su.id=st.user_id
     JOIN drivers d ON d.id=s.driver_id JOIN users du ON du.id=d.user_id
     WHERE s.id=$1`, [shipmentId]
  );
  if (!s) return;
  await pushNotification({ userId: s.store_uid, shipmentId, channel: 'whatsapp',
    message: templates.shipmentAccepted(s.shipment_code, s.driver_name) });
  await sendWhatsApp(s.store_phone, templates.shipmentAccepted(s.shipment_code, s.driver_name));
  broadcastToShipment(shipmentId, { type: 'status_update', status: 'accepted' });
});

if (subscriber) await subscriber.subscribe('shipment:delivered', async (raw) => {
  const { shipmentId, invoiceNumber } = JSON.parse(raw);
  const { rows: [s] } = await query(
    `SELECT s.*, st.store_name, st.vat_number, st.cr_number,
            st.user_id AS store_uid, su.phone AS store_phone
     FROM shipments s
     JOIN stores st ON st.id=s.store_id JOIN users su ON su.id=st.user_id
     WHERE s.id=$1`, [shipmentId]
  );
  if (!s) return;
  const { qr, xml } = generateInvoice(s, s);
  await query('UPDATE shipments SET invoice_qr=$1, invoice_xml=$2 WHERE id=$3',
    [qr, xml, shipmentId]);
  const msg = templates.shipmentDelivered(s.shipment_code, s.price_total);
  await pushNotification({ userId: s.store_uid, shipmentId, channel: 'sms', message: msg });
  await sendSMS(s.store_phone, msg);
  broadcastToShipment(shipmentId, { type: 'status_update', status: 'delivered', invoiceNumber });
});

fastify.get('/health', async () => ({
  status: 'ok',
  version: '1.0.0',
  timestamp: new Date().toISOString()
}));

fastify.setErrorHandler((error, request, reply) => {
  fastify.log.error(error);
  const code = error.statusCode || 500;
  reply.code(code).send({
    error: code === 500
      ? 'حدث خطأ في الخادم — فريقنا على علم ويعمل على حله'
      : error.message
  });
});

const PORT = process.env.PORT || 3001;
try {
  await fastify.listen({ port: PORT, host: '0.0.0.0' });
  console.log(`\n🚀 Around Logistic API  →  http://localhost:${PORT}`);
  console.log(`📡 WebSocket            →  ws://localhost:${PORT}/ws`);
  console.log(`🏥 Health               →  http://localhost:${PORT}/health\n`);
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
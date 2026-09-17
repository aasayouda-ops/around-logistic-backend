import { query } from '../db/pool.js';
import bcrypt from 'bcrypt';
import { v4 as uuid } from 'uuid';
import crypto from 'crypto';

export async function generateApiKey(storeId, label = 'Default', environment = 'live') {
  const raw     = crypto.randomBytes(24).toString('hex');
  const prefix  = environment === 'live' ? 'alk_live_' : 'alk_test_';
  const fullKey = prefix + raw;
  const hash    = await bcrypt.hash(fullKey, 10);

  await query(
    `INSERT INTO api_keys (id, store_id, key_prefix, key_hash, label, environment)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [uuid(), storeId, prefix, hash, label, environment]
  );

  return fullKey;
}

export async function authenticateApiKey(request, reply) {
  const header = request.headers.authorization || '';
  const key    = header.replace(/^Bearer\s+/i, '').trim();

  if (!key || !key.startsWith('alk_')) {
    return reply.code(401).send({
      error: 'مفتاح API مطلوب',
      hint:  'أضف الهيدر: Authorization: Bearer alk_live_xxxxx'
    });
  }

  const prefix = key.startsWith('alk_live_') ? 'alk_live_' : 'alk_test_';

  const { rows } = await query(
    `SELECT ak.id, ak.key_hash, ak.store_id, ak.environment,
            s.store_name, s.city, s.vat_number
     FROM api_keys ak
     JOIN stores s ON s.id = ak.store_id
     WHERE ak.key_prefix = $1 AND ak.revoked = FALSE`,
    [prefix]
  );

  let matched = null;
  for (const row of rows) {
    if (await bcrypt.compare(key, row.key_hash)) { matched = row; break; }
  }

  if (!matched) {
    return reply.code(401).send({ error: 'مفتاح API غير صالح أو ملغى' });
  }

  query('UPDATE api_keys SET last_used_at = NOW() WHERE id = $1', [matched.id]).catch(() => {});

  request.merchant = {
    storeId:     matched.store_id,
    storeName:   matched.store_name,
    city:        matched.city,
    vatNumber:   matched.vat_number,
    environment: matched.environment,
    isTest:      matched.environment === 'test'
  };
}
import { query } from '../../db/pool.js';
import { setEx, get, del } from '../../db/redis.js';
import bcrypt from 'bcrypt';
import { v4 as uuid } from 'uuid';
import { z } from 'zod';

// ── Validation schemas ────────────────────────────────────────

const RegisterSchema = z.object({
  phone:    z.string().regex(/^05\d{8}$/, 'رقم الجوال غير صحيح'),
  password: z.string().min(8, 'كلمة المرور 8 أحرف على الأقل'),
  role:     z.enum(['store', 'driver'])
});

const LoginSchema = z.object({
  phone:    z.string(),
  password: z.string()
});

// ── Generate OTP ──────────────────────────────────────────────
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// ── Routes ───────────────────────────────────────────────────

export default async function authRoutes(fastify) {

  // POST /auth/register
  fastify.post('/register', async (request, reply) => {
    const parsed = RegisterSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.errors[0].message });
    }
    const { phone, password, role } = parsed.data;

    const existing = await query('SELECT id FROM users WHERE phone = $1', [phone]);
    if (existing.rows.length > 0) {
      return reply.code(409).send({ error: 'رقم الجوال مسجّل مسبقاً' });
    }

    const password_hash = await bcrypt.hash(password, 12);
    const { rows } = await query(
      `INSERT INTO users (id, phone, password_hash, role, consent_at)
       VALUES ($1, $2, $3, $4, NOW()) RETURNING id, phone, role`,
      [uuid(), phone, password_hash, role]
    );

    // Send OTP (via Unifonic in production)
    const otp = generateOTP();
    await setEx(`otp:${phone}`, 300, { code: otp, purpose: 'verify' });
    console.log(`OTP for ${phone}: ${otp}`); // dev only

    return reply.code(201).send({
      message: 'تم إنشاء الحساب — أدخل رمز التحقق المرسل لجوالك',
      userId: rows[0].id
    });
  });

  // POST /auth/verify-otp
  fastify.post('/verify-otp', async (request, reply) => {
    const { phone, code } = request.body;
    const stored = await get(`otp:${phone}`);
    if (!stored || stored.code !== code) {
      return reply.code(400).send({ error: 'رمز التحقق غير صحيح أو منتهي الصلاحية' });
    }
    await del(`otp:${phone}`);
    await query('UPDATE users SET is_verified = TRUE WHERE phone = $1', [phone]);
    return { message: 'تم التحقق من رقم الجوال بنجاح' };
  });

  // POST /auth/login
  fastify.post('/login', async (request, reply) => {
    const parsed = LoginSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'بيانات غير صحيحة' });

    const { phone, password } = parsed.data;
    const { rows } = await query(
      'SELECT id, password_hash, role, is_active, is_verified FROM users WHERE phone = $1',
      [phone]
    );

    if (!rows[0]) return reply.code(401).send({ error: 'رقم الجوال أو كلمة المرور غير صحيحة' });
    const user = rows[0];

    if (!user.is_active) return reply.code(403).send({ error: 'الحساب موقوف — تواصل مع الدعم' });
    if (!user.is_verified) return reply.code(403).send({ error: 'لم يتم التحقق من رقم الجوال بعد' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return reply.code(401).send({ error: 'رقم الجوال أو كلمة المرور غير صحيحة' });

    await query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id]);

    const accessToken = fastify.jwt.sign(
      { id: user.id, role: user.role },
      { expiresIn: '7d' }
    );
    const refreshToken = uuid();
    const refreshHash = await bcrypt.hash(refreshToken, 10);
    await query(
      `INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at)
       VALUES ($1, $2, $3, NOW() + INTERVAL '30 days')`,
      [uuid(), user.id, refreshHash]
    );

    return { accessToken, refreshToken, role: user.role };
  });

  // POST /auth/refresh
  fastify.post('/refresh', async (request, reply) => {
    const { refreshToken } = request.body;
    if (!refreshToken) return reply.code(400).send({ error: 'رمز التحديث مطلوب' });

    const { rows } = await query(
      `SELECT rt.id, rt.user_id, rt.token_hash, u.role
       FROM refresh_tokens rt JOIN users u ON u.id = rt.user_id
       WHERE rt.revoked = FALSE AND rt.expires_at > NOW()
       ORDER BY rt.created_at DESC LIMIT 50`
    );

    let match = null;
    for (const row of rows) {
      const ok = await bcrypt.compare(refreshToken, row.token_hash);
      if (ok) { match = row; break; }
    }
    if (!match) return reply.code(401).send({ error: 'رمز التحديث غير صالح أو منتهي' });

    await query('UPDATE refresh_tokens SET revoked = TRUE WHERE id = $1', [match.id]);

    const newAccess = fastify.jwt.sign({ id: match.user_id, role: match.role }, { expiresIn: '7d' });
    const newRefresh = uuid();
    const newHash = await bcrypt.hash(newRefresh, 10);
    await query(
      `INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at)
       VALUES ($1, $2, $3, NOW() + INTERVAL '30 days')`,
      [uuid(), match.user_id, newHash]
    );
    return { accessToken: newAccess, refreshToken: newRefresh };
  });

  // POST /auth/logout
  fastify.post('/logout', async (request, reply) => {
    const { refreshToken } = request.body;
    if (refreshToken) {
      const { rows } = await query(
        'SELECT id, token_hash FROM refresh_tokens WHERE revoked = FALSE AND expires_at > NOW()'
      );
      for (const row of rows) {
        const ok = await bcrypt.compare(refreshToken, row.token_hash);
        if (ok) { await query('UPDATE refresh_tokens SET revoked = TRUE WHERE id = $1', [row.id]); break; }
      }
    }
    return { message: 'تم تسجيل الخروج بنجاح' };
  });
}

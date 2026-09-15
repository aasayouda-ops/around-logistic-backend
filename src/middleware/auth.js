import { query } from '../db/pool.js';

// Verify JWT and attach user to request
export async function authenticate(request, reply) {
  try {
    await request.jwtVerify();
    const { rows } = await query(
      'SELECT id, role, is_active FROM users WHERE id = $1',
      [request.user.id]
    );
    if (!rows[0] || !rows[0].is_active) {
      return reply.code(401).send({ error: 'حساب غير نشط أو غير موجود' });
    }
    request.user = rows[0];
  } catch (err) {
    reply.code(401).send({ error: 'رمز المصادقة غير صالح أو منتهي الصلاحية' });
  }
}

// Role guard
export const requireRole = (...roles) => async (request, reply) => {
  await authenticate(request, reply);
  if (!roles.includes(request.user.role)) {
    return reply.code(403).send({ error: 'ليس لديك صلاحية للوصول لهذه الخدمة' });
  }
};

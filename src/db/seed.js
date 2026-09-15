import 'dotenv/config';
import { query } from './pool.js';
import pool from './pool.js';
import bcrypt from 'bcrypt';
import { v4 as uuid } from 'uuid';

async function seed() {
  console.log('🌱 Seeding database...');

  // Admin user
  const adminId = uuid();
  const adminHash = await bcrypt.hash('Admin@1234', 12);
  await query(`
    INSERT INTO users (id, phone, password_hash, role, is_verified, is_active)
    VALUES ($1,'0500000000',$2,'admin',TRUE,TRUE)
    ON CONFLICT (phone) DO NOTHING`,
    [adminId, adminHash]
  );

  // Test store user
  const storeUserId = uuid();
  const storeHash = await bcrypt.hash('Store@1234', 12);
  await query(`
    INSERT INTO users (id, phone, password_hash, role, is_verified, is_active, consent_at)
    VALUES ($1,'0511111111',$2,'store',TRUE,TRUE,NOW())
    ON CONFLICT (phone) DO NOTHING`,
    [storeUserId, storeHash]
  );

  // Test store profile
  const storeId = uuid();
  await query(`
    INSERT INTO stores
      (id, user_id, store_name, cr_number, vat_number, activity_type, city, district, short_address)
    VALUES ($1,$2,'متجر التجربة','1234567890','123456789012345','مواد غذائية ومشروبات','الرياض','العليا','RUHD2342')
    ON CONFLICT DO NOTHING`,
    [storeId, storeUserId]
  );

  // Test driver user
  const driverUserId = uuid();
  const driverHash = await bcrypt.hash('Driver@1234', 12);
  await query(`
    INSERT INTO users (id, phone, password_hash, role, is_verified, is_active, consent_at)
    VALUES ($1,'0522222222',$2,'driver',TRUE,TRUE,NOW())
    ON CONFLICT (phone) DO NOTHING`,
    [driverUserId, driverHash]
  );

  // Test driver profile
  await query(`
    INSERT INTO drivers
      (id, user_id, full_name, id_number, driver_type, city,
       vehicle_type, plate_number, istimara_number, transport_license, capacity_liters)
    VALUES ($1,$2,'سائق تجريبي','1234567890','vehicle','الرياض',
            'دينا مبردة','أ ب ج 1234','12345678','TL-9999',1200)
    ON CONFLICT DO NOTHING`,
    [uuid(), driverUserId]
  );

  console.log('✅ Seed complete');
  console.log('');
  console.log('Test accounts:');
  console.log('  Admin  → 0500000000 / Admin@1234');
  console.log('  Store  → 0511111111 / Store@1234');
  console.log('  Driver → 0522222222 / Driver@1234');

  await pool.end();
}

seed().catch(err => { console.error(err); process.exit(1); });

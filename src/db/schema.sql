-- ============================================================
-- Around Logistic — PostgreSQL Schema
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── ENUMS ────────────────────────────────────────────────────

CREATE TYPE user_role AS ENUM ('store', 'driver', 'admin');
CREATE TYPE driver_type AS ENUM ('individual', 'vehicle');
CREATE TYPE shipment_status AS ENUM ('pending','accepted','in_transit','delivered','cancelled');
CREATE TYPE payment_status AS ENUM ('pending','due_on_delivery','paid','refunded','failed');
CREATE TYPE payment_method AS ENUM ('mada','apple_pay','bank_transfer','cash_on_delivery');
CREATE TYPE ticket_status AS ENUM ('open','in_progress','resolved','closed');
CREATE TYPE ticket_category AS ENUM ('complaint','inquiry','technical','shipment_issue');
CREATE TYPE notification_channel AS ENUM ('sms','whatsapp','push','in_app');

-- ── USERS ────────────────────────────────────────────────────

CREATE TABLE users (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  phone           VARCHAR(15) UNIQUE NOT NULL,
  password_hash   TEXT NOT NULL,
  role            user_role NOT NULL,
  is_verified     BOOLEAN DEFAULT FALSE,
  is_active       BOOLEAN DEFAULT TRUE,
  nafath_verified BOOLEAN DEFAULT FALSE,
  nafath_id       VARCHAR(20),
  consent_at      TIMESTAMPTZ,
  last_login_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── STORES (المتاجر) ─────────────────────────────────────────

CREATE TABLE stores (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  store_name       VARCHAR(200) NOT NULL,
  cr_number        VARCHAR(10) UNIQUE NOT NULL,   -- السجل التجاري الموحد
  vat_number       VARCHAR(15) UNIQUE NOT NULL,   -- الرقم الضريبي
  activity_type    VARCHAR(100) NOT NULL,
  city             VARCHAR(100) NOT NULL,
  district         VARCHAR(100) NOT NULL,
  short_address    VARCHAR(8),                    -- العنوان الوطني المختصر
  full_address     TEXT,
  lat              DECIMAL(10,8),
  lng              DECIMAL(11,8),
  rating_avg       DECIMAL(3,2) DEFAULT 0,
  rating_count     INT DEFAULT 0,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

-- ── DRIVERS (السائقون) ───────────────────────────────────────

CREATE TABLE drivers (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  full_name             VARCHAR(200) NOT NULL,
  id_number             VARCHAR(10) UNIQUE NOT NULL,  -- هوية/إقامة
  driver_type           driver_type NOT NULL,
  city                  VARCHAR(100) NOT NULL,
  vehicle_type          VARCHAR(100),
  plate_number          VARCHAR(20),
  istimara_number       VARCHAR(30),
  transport_license     VARCHAR(50),
  pharma_licensed       BOOLEAN DEFAULT FALSE,
  pharma_license_number VARCHAR(50),
  capacity_liters       INT,
  is_available          BOOLEAN DEFAULT TRUE,
  current_lat           DECIMAL(10,8),
  current_lng           DECIMAL(11,8),
  last_location_at      TIMESTAMPTZ,
  rating_avg            DECIMAL(3,2) DEFAULT 0,
  rating_count          INT DEFAULT 0,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

-- ── SHIPMENTS (الشحنات) ──────────────────────────────────────

CREATE TABLE shipments (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  shipment_code    VARCHAR(20) UNIQUE NOT NULL,   -- SHP-XXXX عرض للمستخدم
  store_id         UUID NOT NULL REFERENCES stores(id),
  driver_id        UUID REFERENCES drivers(id),
  product_name     VARCHAR(200) NOT NULL,
  category         VARCHAR(100) NOT NULL,
  weight_kg        DECIMAL(8,2) NOT NULL,
  temp_min         DECIMAL(5,2) NOT NULL,
  temp_max         DECIMAL(5,2) NOT NULL,
  notes            TEXT,
  from_city        VARCHAR(100) NOT NULL,
  from_address     TEXT,
  from_short_addr  VARCHAR(8),
  from_lat         DECIMAL(10,8),
  from_lng         DECIMAL(11,8),
  to_city          VARCHAR(100) NOT NULL,
  to_address       TEXT,
  to_short_addr    VARCHAR(8),
  to_lat           DECIMAL(10,8),
  to_lng           DECIMAL(11,8),
  status           shipment_status DEFAULT 'pending',
  progress_pct     SMALLINT DEFAULT 0,
  price_subtotal   DECIMAL(10,2),
  vat_amount       DECIMAL(10,2),
  price_total      DECIMAL(10,2),
  payment_method   payment_method,
  payment_status   payment_status DEFAULT 'pending',
  transaction_ref  VARCHAR(100),
  paid_at          TIMESTAMPTZ,
  invoice_number   VARCHAR(50),
  invoice_xml      TEXT,                  -- ZATCA Phase 2 XML
  invoice_qr       TEXT,                  -- QR Base64
  accepted_at      TIMESTAMPTZ,
  started_at       TIMESTAMPTZ,
  delivered_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

-- ── TEMPERATURE READINGS (قراءات الحرارة) ───────────────────

CREATE TABLE temperature_readings (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  shipment_id UUID NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  value_c     DECIMAL(5,2) NOT NULL,
  is_alert    BOOLEAN DEFAULT FALSE,
  sensor_id   VARCHAR(100),
  recorded_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_temp_shipment ON temperature_readings(shipment_id, recorded_at DESC);

-- ── GPS TRACKING (تتبع الموقع) ───────────────────────────────

CREATE TABLE gps_tracks (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  shipment_id UUID NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  driver_id   UUID NOT NULL REFERENCES drivers(id),
  lat         DECIMAL(10,8) NOT NULL,
  lng         DECIMAL(11,8) NOT NULL,
  speed_kmh   DECIMAL(5,1),
  recorded_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_gps_shipment ON gps_tracks(shipment_id, recorded_at DESC);

-- ── RATINGS (التقييمات) ──────────────────────────────────────

CREATE TABLE ratings (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  shipment_id  UUID NOT NULL REFERENCES shipments(id),
  rater_id     UUID NOT NULL REFERENCES users(id),
  rater_role   user_role NOT NULL,
  target_id    UUID NOT NULL,       -- store_id or driver_id
  target_type  VARCHAR(10) NOT NULL CHECK (target_type IN ('store','driver')),
  stars        SMALLINT NOT NULL CHECK (stars BETWEEN 1 AND 5),
  comment      TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(shipment_id, rater_id)
);

-- ── SUPPORT TICKETS (الدعم والشكاوى) ────────────────────────

CREATE TABLE tickets (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  ticket_code   VARCHAR(20) UNIQUE NOT NULL,
  user_id       UUID NOT NULL REFERENCES users(id),
  shipment_id   UUID REFERENCES shipments(id),
  category      ticket_category NOT NULL,
  subject       VARCHAR(300) NOT NULL,
  message       TEXT NOT NULL,
  admin_note    TEXT,
  status        ticket_status DEFAULT 'open',
  resolved_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── NOTIFICATIONS (الإشعارات) ────────────────────────────────

CREATE TABLE notifications (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id      UUID NOT NULL REFERENCES users(id),
  shipment_id  UUID REFERENCES shipments(id),
  channel      notification_channel NOT NULL,
  title        VARCHAR(200),
  message      TEXT NOT NULL,
  is_read      BOOLEAN DEFAULT FALSE,
  sent_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_notif_user ON notifications(user_id, created_at DESC);

-- ── OTP VERIFICATION ─────────────────────────────────────────

CREATE TABLE otp_codes (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  phone      VARCHAR(15) NOT NULL,
  code       VARCHAR(6) NOT NULL,
  purpose    VARCHAR(50) DEFAULT 'login',
  used       BOOLEAN DEFAULT FALSE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_otp_phone ON otp_codes(phone, expires_at);

-- ── REFRESH TOKENS ───────────────────────────────────────────

CREATE TABLE refresh_tokens (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked    BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── AUDIT LOG ────────────────────────────────────────────────

CREATE TABLE audit_logs (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID REFERENCES users(id),
  action     VARCHAR(100) NOT NULL,
  entity     VARCHAR(50),
  entity_id  UUID,
  metadata   JSONB,
  ip_address INET,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_audit_user ON audit_logs(user_id, created_at DESC);

-- ── AUTO-UPDATE updated_at ───────────────────────────────────

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated      BEFORE UPDATE ON users      FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_stores_updated     BEFORE UPDATE ON stores     FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_drivers_updated    BEFORE UPDATE ON drivers    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_shipments_updated  BEFORE UPDATE ON shipments  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_tickets_updated    BEFORE UPDATE ON tickets    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

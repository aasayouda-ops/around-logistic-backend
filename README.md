# Around Logistic — API Server

## Tech Stack
- **Runtime**: Node.js 20 (ESM)
- **Framework**: Fastify 4
- **Database**: PostgreSQL 16 + Redis 7
- **Auth**: JWT + Refresh Tokens
- **Real-time**: WebSocket

## Quick Start (Development)

```bash
# 1. Copy env
cp .env.example .env
# Edit .env with your values

# 2. Start DB + Redis
docker-compose up postgres redis -d

# 3. Run migrations
node src/db/migrate.js

# 4. Start server
npm run dev
```

## API Endpoints

### Auth
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/auth/register` | تسجيل حساب جديد |
| POST | `/api/auth/verify-otp` | تحقق من رقم الجوال |
| POST | `/api/auth/login` | تسجيل الدخول |
| POST | `/api/auth/refresh` | تجديد رمز المصادقة |
| POST | `/api/auth/logout` | تسجيل الخروج |

### Shipments
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/shipments` | قائمة الشحنات |
| GET | `/api/shipments/available` | الشحنات المتاحة للسائقين |
| POST | `/api/shipments` | إنشاء شحنة جديدة |
| GET | `/api/shipments/:id` | تفاصيل شحنة |
| PATCH | `/api/shipments/:id/accept` | قبول الشحنة |
| PATCH | `/api/shipments/:id/start` | بدء الرحلة |
| PATCH | `/api/shipments/:id/deliver` | تأكيد التسليم |
| POST | `/api/shipments/:id/temperature` | إرسال قراءة حرارة |
| GET | `/api/shipments/:id/temperature` | سجل الحرارة |
| GET | `/api/shipments/:id/track` | مسار GPS |

## WebSocket
```
ws://localhost:3001/ws

// Subscribe to a shipment
{ "type": "subscribe", "shipmentId": "uuid" }

// Server pushes updates on:
// - temperature alerts
// - status changes
// - GPS updates
```

## Docker (Production)
```bash
docker-compose up -d
```

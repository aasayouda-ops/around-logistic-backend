// ── Unifonic Messaging Service ────────────────────────────────
// Docs: https://unifonic.com/docs

const UNIFONIC_URL = 'https://el.cloud.unifonic.com/rest/SMS/messages';
const WA_URL       = 'https://el.cloud.unifonic.com/rest/WhatsApp/messages';

async function unifonicRequest(url, body) {
  if (process.env.NODE_ENV !== 'production') {
    console.log(`[Unifonic DEV] ${url}`, body);
    return { success: true };
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      AppSid:   process.env.UNIFONIC_APP_SID,
      SenderID: process.env.UNIFONIC_SENDER_ID,
      ...body
    })
  });
  return res.json();
}

// ── SMS ───────────────────────────────────────────────────────
export async function sendSMS(phone, message) {
  return unifonicRequest(UNIFONIC_URL, { Recipient: phone, Body: message });
}

// ── WhatsApp ──────────────────────────────────────────────────
export async function sendWhatsApp(phone, message) {
  return unifonicRequest(WA_URL, { Recipient: phone, Body: message });
}

// ── Predefined notification templates ────────────────────────

export const templates = {
  shipmentCreated: (code) =>
    `Around Logistic: تم استلام طلب الشحن ${code} وجاري البحث عن سائق مناسب.`,

  shipmentAccepted: (code, driverName) =>
    `Around Logistic: تم إسناد شحنتك ${code} للسائق ${driverName}.`,

  shipmentStarted: (code) =>
    `Around Logistic: بدأت رحلة شحنتك ${code} — يمكنك متابعة الموقع من التطبيق.`,

  tempAlert: (code, temp) =>
    `⚠️ Around Logistic: تنبيه — حرارة شحنة ${code} خرجت عن النطاق المسموح (${temp}°C).`,

  tempNormal: (code) =>
    `Around Logistic: ✅ عادت حرارة شحنتك ${code} إلى النطاق الطبيعي.`,

  shipmentDelivered: (code, total) =>
    `Around Logistic: ✅ تم تسليم شحنتك ${code} بنجاح. الفاتورة: ${total} ر.س`,

  paymentConfirmed: (code, total) =>
    `Around Logistic: تم استلام دفعتك ${total} ر.س للشحنة ${code}.`,

  driverEarnings: (code, amount) =>
    `Around Logistic: تم تسجيل أرباحك ${amount} ر.س لرحلة ${code}.`
};

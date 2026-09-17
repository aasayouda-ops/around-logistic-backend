import { query } from '../db/pool.js';

const VAT_RATE = 0.15;
const MAJOR_CITIES = ['الرياض','جدة','الدمام','مكة المكرمة','المدينة المنورة','الخبر'];

export async function calculateRate({ storeId, fromCity, toCity, weightKg, category = null, orderValue = 0 }) {
  const { rows: rates } = await query(
    `SELECT * FROM shipping_rates
     WHERE is_active = TRUE
       AND (store_id = $1 OR store_id IS NULL)
       AND (from_city IS NULL OR from_city = $2)
       AND (to_city   IS NULL OR to_city   = $3)
       AND (category  IS NULL OR category  = $4)
       AND (min_weight_kg <= $5)
       AND (max_weight_kg IS NULL OR max_weight_kg >= $5)
     ORDER BY (store_id IS NOT NULL) DESC, priority DESC, base_price ASC`,
    [storeId, fromCity, toCity, category, weightKg]
  );

  if (!rates.length) {
    return { available: false, reason: 'لا توجد تسعيرة متاحة لهذا المسار أو الوزن' };
  }

  const rate = pickBestRate(rates, fromCity, toCity);
  let subtotal = Number(rate.base_price) + (Number(rate.price_per_kg) * weightKg);
  let isFree = false;
  if (rate.free_above_amount && orderValue >= Number(rate.free_above_amount)) {
    subtotal = 0; isFree = true;
  }
  subtotal = Math.round(subtotal * 100) / 100;
  const vat   = Math.round(subtotal * VAT_RATE * 100) / 100;
  const total = Math.round((subtotal + vat) * 100) / 100;

  return {
    available: true,
    rateId: rate.id,
    rateName: rate.name,
    subtotal, vat, total, isFree,
    payer: rate.payer,
    estHoursMin: rate.est_hours_min,
    estHoursMax: rate.est_hours_max,
    estimatedDelivery: formatEta(rate.est_hours_min, rate.est_hours_max)
  };
}

export async function getAvailableOptions({ storeId, fromCity, toCity, weightKg, category, orderValue }) {
  const { rows: rates } = await query(
    `SELECT * FROM shipping_rates
     WHERE is_active = TRUE
       AND (store_id = $1 OR store_id IS NULL)
       AND (from_city IS NULL OR from_city = $2)
       AND (to_city   IS NULL OR to_city   = $3)
       AND (category  IS NULL OR category  = $4)
       AND min_weight_kg <= $5
       AND (max_weight_kg IS NULL OR max_weight_kg >= $5)
     ORDER BY base_price ASC`,
    [storeId, fromCity, toCity, category, weightKg]
  );

  return rates.map(rate => {
    let subtotal = Number(rate.base_price) + (Number(rate.price_per_kg) * weightKg);
    let isFree = false;
    if (rate.free_above_amount && orderValue >= Number(rate.free_above_amount)) {
      subtotal = 0; isFree = true;
    }
    subtotal = Math.round(subtotal * 100) / 100;
    const vat = Math.round(subtotal * VAT_RATE * 100) / 100;
    return {
      rateId: rate.id,
      name: rate.name,
      subtotal, vat,
      total: Math.round((subtotal + vat) * 100) / 100,
      isFree,
      payer: rate.payer,
      estimatedDelivery: formatEta(rate.est_hours_min, rate.est_hours_max)
    };
  });
}

function pickBestRate(rates, fromCity, toCity) {
  const sameCity  = fromCity === toCity;
  const bothMajor = MAJOR_CITIES.includes(fromCity) && MAJOR_CITIES.includes(toCity);
  const storeRate = rates.find(r => r.store_id);
  if (storeRate) return storeRate;
  if (sameCity)  return rates.find(r => r.name.includes('داخل المدينة')) || rates[0];
  if (bothMajor) return rates.find(r => r.name.includes('بين المدن'))    || rates[0];
  return rates.find(r => r.name.includes('نائية')) || rates[rates.length - 1];
}

function formatEta(minHours, maxHours) {
  const toText = (h) => h < 24 ? `${h} ساعة` : `${Math.round(h / 24)} يوم`;
  if (minHours === maxHours) return toText(minHours);
  return `${toText(minHours)} — ${toText(maxHours)}`;
}

export function deriveTemperatureRange(items) {
  const cooled = items.filter(i => i.temp_min != null && i.temp_max != null);
  if (!cooled.length) return { requiresCooling: false, tempMin: null, tempMax: null };
  const tempMin = Math.min(...cooled.map(i => Number(i.temp_min)));
  const tempMax = Math.min(...cooled.map(i => Number(i.temp_max)));
  return { requiresCooling: true, tempMin, tempMax };
}
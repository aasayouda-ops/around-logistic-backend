import { createClient } from 'redis';

let client = null;
let connected = false;

if (process.env.REDIS_URL) {
  try {
    client = createClient({ url: process.env.REDIS_URL });
    client.on('error', () => { connected = false; });
    client.on('connect', () => { connected = true; console.log('Redis connected'); });
    await client.connect();
  } catch (e) {
    console.log('Redis unavailable — running without cache');
    client = null;
  }
} else {
  console.log('Redis disabled — running without cache');
}

export const setEx = async (key, seconds, value) => {
  if (!client || !connected) return null;
  try { return await client.setEx(key, seconds, JSON.stringify(value)); } catch { return null; }
};

export const get = async (key) => {
  if (!client || !connected) return null;
  try {
    const v = await client.get(key);
    return v ? JSON.parse(v) : null;
  } catch { return null; }
};

export const del = async (key) => {
  if (!client || !connected) return null;
  try { return await client.del(key); } catch { return null; }
};

export const publish = async (channel, message) => {
  if (!client || !connected) return null;
  try { return await client.publish(channel, JSON.stringify(message)); } catch { return null; }
};

export default client;
const baseUrl = process.env.SMOKE_URL || 'http://localhost:4000';
const email = process.env.SMOKE_EMAIL || `smoke-${Date.now()}@junvideo.local`;
const password = process.env.SMOKE_PASSWORD || 'junvideo-smoke-123';

async function request(path, init) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers || {}) },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${path} -> ${response.status}: ${payload?.message || 'request failed'}`);
  return payload;
}

const health = await request('/api/health');
if (!health.ok) throw new Error('Health check did not return ok=true');
const auth = await request('/api/auth/register', {
  method: 'POST',
  body: JSON.stringify({ name: 'Smoke Test', email, password }),
});
if (!auth.token) throw new Error('Register did not return a token');
const headers = { authorization: `Bearer ${auth.token}` };
const usage = await request('/api/usage', { headers });
if (usage.limit !== 10 && usage.usage?.limit !== 10) throw new Error('Free quota is not 10');
const platforms = await request('/api/platforms');
const names = JSON.stringify(platforms);
for (const expected of ['douyin', 'xiaohongshu', 'bilibili']) {
  if (!names.includes(expected)) throw new Error(`Platform catalog is missing ${expected}`);
}
console.log(JSON.stringify({ ok: true, email, database: health.database, parser: health.parser }, null, 2));

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'
};

// ── Rate limiting (in-memory) ──────────────────
// Note: resets on function cold start, but good enough for a personal site
const attempts = {}; // { ip: { count, blockedUntil } }
const MAX_ATTEMPTS = 5;
const BLOCK_DURATION = 15 * 60 * 1000; // 15 minutes

function getIP(event) {
  return event.headers['x-forwarded-for']?.split(',')[0].trim() || 'unknown';
}

function isRateLimited(ip) {
  const now = Date.now();
  if (!attempts[ip]) return false;
  const { count, blockedUntil } = attempts[ip];
  if (blockedUntil && now < blockedUntil) return true; // still blocked
  if (blockedUntil && now >= blockedUntil) { delete attempts[ip]; return false; } // block expired
  return false;
}

function recordFailedAttempt(ip) {
  const now = Date.now();
  if (!attempts[ip]) attempts[ip] = { count: 0, blockedUntil: null };
  attempts[ip].count += 1;
  if (attempts[ip].count >= MAX_ATTEMPTS) {
    attempts[ip].blockedUntil = now + BLOCK_DURATION;
    console.warn(`IP ${ip} blocked for 15 minutes after ${MAX_ATTEMPTS} failed attempts`);
  }
}

function clearAttempts(ip) {
  delete attempts[ip];
}

// ── Supabase helper ────────────────────────────
async function supabase(path, method = 'GET', body = null, useServiceKey = false) {
  const key = useServiceKey ? SUPABASE_SERVICE_KEY : SUPABASE_ANON_KEY;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'apikey': key,
      'Authorization': `Bearer ${key}`,
      'Prefer': method === 'POST' ? 'return=representation' : 'return=minimal'
    },
    body: body ? JSON.stringify(body) : null
  });
  if (method === 'DELETE' || method === 'PATCH') return { ok: res.ok };
  return res.json();
}

function isAdmin(event) {
  const auth = event.headers['authorization'] || '';
  const token = auth.replace('Bearer ', '');
  return token === ADMIN_PASSWORD;
}

// ── Handler ────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers };

  const method = event.httpMethod;
  const params = event.queryStringParameters || {};
  const ip = getIP(event);

  // GET — public, no auth needed
  if (method === 'GET') {
    const data = await supabase('posts?select=*&order=created_at.desc');
    return { statusCode: 200, headers, body: JSON.stringify(data) };
  }

  // All write methods require auth — check rate limit first
  if (isRateLimited(ip)) {
    return {
      statusCode: 429,
      headers,
      body: JSON.stringify({ error: 'Too many failed attempts. Try again in 15 minutes.' })
    };
  }

  if (!isAdmin(event)) {
    recordFailedAttempt(ip);
    const remaining = MAX_ATTEMPTS - (attempts[ip]?.count || 0);
    return {
      statusCode: 401,
      headers,
      body: JSON.stringify({ error: `Unauthorized. ${remaining > 0 ? remaining + ' attempts remaining.' : 'You are now blocked for 15 minutes.'}` })
    };
  }

  // Correct password — clear failed attempts
  clearAttempts(ip);

  if (method === 'POST') {
    const { title, excerpt, body } = JSON.parse(event.body || '{}');
    if (!title || !body) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Title and body required' }) };
    const data = await supabase('posts', 'POST', { title, excerpt, body }, true);
    return { statusCode: 201, headers, body: JSON.stringify(data) };
  }

  if (method === 'PUT') {
    const { id, title, excerpt, body } = JSON.parse(event.body || '{}');
    if (!id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'ID required' }) };
    await supabase(`posts?id=eq.${id}`, 'PATCH', { title, excerpt, body }, true);
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  }

  if (method === 'DELETE') {
    const id = params.id;
    if (!id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'ID required' }) };
    await supabase(`posts?id=eq.${id}`, 'DELETE', null, true);
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  }

  return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
};

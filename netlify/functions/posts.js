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

// ── Rate limiting ──────────────────────────────
const attempts = {};
const MAX_ATTEMPTS = 5;
const BLOCK_DURATION = 15 * 60 * 1000;

function getIP(e) { return e.headers['x-forwarded-for']?.split(',')[0].trim() || 'unknown'; }
function isRateLimited(ip) {
  const now = Date.now();
  if (!attempts[ip]) return false;
  const { blockedUntil } = attempts[ip];
  if (blockedUntil && now < blockedUntil) return true;
  if (blockedUntil && now >= blockedUntil) { delete attempts[ip]; return false; }
  return false;
}
function recordFail(ip) {
  if (!attempts[ip]) attempts[ip] = { count: 0, blockedUntil: null };
  attempts[ip].count += 1;
  if (attempts[ip].count >= MAX_ATTEMPTS) attempts[ip].blockedUntil = Date.now() + BLOCK_DURATION;
}
function clearAttempts(ip) { delete attempts[ip]; }

// ── Supabase helper ────────────────────────────
async function sb(path, method = 'GET', body = null, useServiceKey = false) {
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
  return (event.headers['authorization'] || '').replace('Bearer ', '') === ADMIN_PASSWORD;
}

// ── Handler ────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers };

  const method = event.httpMethod;
  const params = event.queryStringParameters || {};
  const resource = params.resource || 'posts';
  const ip = getIP(event);

  // ── Public GET ─────────────────────────────
  if (method === 'GET') {
    if (resource === 'posts') {
      const data = await sb('posts?select=*&order=created_at.desc');
      return { statusCode: 200, headers, body: JSON.stringify(data) };
    }
    if (resource === 'config') {
      const data = await sb('config?select=*');
      // Return as a flat object { key: value }
      const config = {};
      (data || []).forEach(row => { config[row.key] = row.value; });
      return { statusCode: 200, headers, body: JSON.stringify(config) };
    }
  }

  // ── Auth check for writes ──────────────────
  if (isRateLimited(ip)) return { statusCode: 429, headers, body: JSON.stringify({ error: 'Too many attempts. Try again in 15 minutes.' }) };
  if (!isAdmin(event)) {
    recordFail(ip);
    const rem = MAX_ATTEMPTS - (attempts[ip]?.count || 0);
    return { statusCode: 401, headers, body: JSON.stringify({ error: `Unauthorized. ${rem > 0 ? rem + ' attempts remaining.' : 'Blocked for 15 minutes.'}` }) };
  }
  clearAttempts(ip);

  // ── Config upsert ──────────────────────────
  if (resource === 'config' && method === 'POST') {
    const { key, value } = JSON.parse(event.body || '{}');
    if (!key) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Key required' }) };
    await sb('config', 'POST', { key, value }, true);
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  }

  // ── Posts ──────────────────────────────────
  if (resource === 'posts') {
    if (method === 'POST') {
      const { title, excerpt, body } = JSON.parse(event.body || '{}');
      if (!title || !body) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Title and body required' }) };
      const data = await sb('posts', 'POST', { title, excerpt, body }, true);
      return { statusCode: 201, headers, body: JSON.stringify(data) };
    }
    if (method === 'PUT') {
      const { id, title, excerpt, body } = JSON.parse(event.body || '{}');
      if (!id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'ID required' }) };
      await sb(`posts?id=eq.${id}`, 'PATCH', { title, excerpt, body }, true);
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }
    if (method === 'DELETE') {
      const id = params.id;
      if (!id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'ID required' }) };
      await sb(`posts?id=eq.${id}`, 'DELETE', null, true);
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }
  }

  return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
};

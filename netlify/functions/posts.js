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
  if (method === 'DELETE' || method === 'PUT') return { ok: res.ok };
  return res.json();
}

function isAdmin(event) {
  const auth = event.headers['authorization'] || '';
  const token = auth.replace('Bearer ', '');
  return token === ADMIN_PASSWORD;
}

exports.handler = async (event) => {
  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers };
  }

  const method = event.httpMethod;
  const params = event.queryStringParameters || {};

  // GET /posts — public, fetch all posts
  if (method === 'GET') {
    const data = await supabase('posts?select=*&order=created_at.desc');
    return { statusCode: 200, headers, body: JSON.stringify(data) };
  }

  // All other methods require admin password
  if (!isAdmin(event)) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  // POST — create post
  if (method === 'POST') {
    const { title, excerpt, body } = JSON.parse(event.body || '{}');
    if (!title || !body) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Title and body required' }) };
    const data = await supabase('posts', 'POST', { title, excerpt, body }, true);
    return { statusCode: 201, headers, body: JSON.stringify(data) };
  }

  // PUT — update post
  if (method === 'PUT') {
    const { id, title, excerpt, body } = JSON.parse(event.body || '{}');
    if (!id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'ID required' }) };
    await supabase(`posts?id=eq.${id}`, 'PATCH', { title, excerpt, body }, true);
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  }

  // DELETE — delete post
  if (method === 'DELETE') {
    const id = params.id;
    if (!id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'ID required' }) };
    await supabase(`posts?id=eq.${id}`, 'DELETE', null, true);
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  }

  return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
};

const PUBLIC_ACTIONS = new Set(['systemHealth', 'publicConfig', 'lineSessionCreate', 'createOrder', 'orderByRequestId', 'myOrders', 'paymentInfo', 'confirmTransfer']);

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin, env.ALLOWED_ORIGIN);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return json({ ok: false, error: { message: 'Method not allowed' } }, 405, cors);
    if (!originAllowed(origin, env.ALLOWED_ORIGIN)) return json({ ok: false, error: { message: 'Origin not allowed' } }, 403, cors);
    try {
      const body = await request.json();
      if (!PUBLIC_ACTIONS.has(String(body.action || ''))) return json({ ok: false, error: { message: 'Action not allowed' } }, 403, cors);
      const upstream = await fetch(env.GAS_WEB_APP_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body: JSON.stringify({ action: body.action, payload: body.payload || {}, gatewaySecret: env.CF_GATEWAY_SECRET }), redirect: 'follow' });
      return new Response(await upstream.text(), { status: upstream.ok ? 200 : 502, headers: { ...cors, 'Content-Type': 'application/json;charset=UTF-8', 'Cache-Control': 'no-store' } });
    } catch (error) { return json({ ok: false, error: { message: 'Gateway request failed' } }, 502, cors); }
  }
};

function originAllowed(origin, allowed) { return !allowed || allowed === '*' || origin === allowed; }
function corsHeaders(origin, allowed) { const value = allowed === '*' ? '*' : originAllowed(origin, allowed) ? origin : ''; return { 'Access-Control-Allow-Origin': value, 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST,OPTIONS', 'Vary': 'Origin' }; }
function json(value, status, headers) { return new Response(JSON.stringify(value), { status, headers: { ...headers, 'Content-Type': 'application/json;charset=UTF-8' } }); }


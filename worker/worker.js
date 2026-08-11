const PUBLIC_ACTIONS = new Set(['systemHealth', 'publicConfig', 'lineSessionCreate', 'createOrder', 'orderByRequestId', 'myOrders', 'paymentInfo', 'confirmTransfer', 'adminLogin', 'adminRefresh', 'adminChangePassword', 'adminShipOrder', 'adminCancelOrder']);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/ecpay/map' && request.method === 'GET') return ecpayMap(request, env);
    if (url.pathname === '/ecpay/callback' && request.method === 'POST') return ecpayCallback(request, env);
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin, env.ALLOWED_ORIGIN);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return json({ ok: false, error: { message: 'Method not allowed' } }, 405, cors);
    if (!originAllowed(origin, env.ALLOWED_ORIGIN)) return json({ ok: false, error: { message: 'Origin not allowed' } }, 403, cors);
    try {
      const body = await request.json();
      if (!PUBLIC_ACTIONS.has(String(body.action || ''))) return json({ ok: false, error: { message: 'Action not allowed' } }, 403, cors);
      if (body.action === 'adminLogin') body.payload = { ...(body.payload || {}), clientIp: request.headers.get('CF-Connecting-IP') || '' };
      if (body.action === 'publicConfig') {
        const cache = caches.default;
        const cacheKey = new Request(new URL('/__cache/public-config', request.url), { method: 'GET' });
        const cached = await cache.match(cacheKey);
        if (cached) return new Response(await cached.text(), { status: 200, headers: { ...cors, 'Content-Type': 'application/json;charset=UTF-8', 'Cache-Control': 'public, max-age=30' } });
        const text = await callGas(env, body);
        await cache.put(cacheKey, new Response(text, { headers: { 'Content-Type': 'application/json;charset=UTF-8', 'Cache-Control': 'public, max-age=30' } }));
        return new Response(text, { status: 200, headers: { ...cors, 'Content-Type': 'application/json;charset=UTF-8', 'Cache-Control': 'public, max-age=30' } });
      }
      const upstream = await fetch(env.GAS_WEB_APP_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body: JSON.stringify({ action: body.action, payload: body.payload || {}, gatewaySecret: env.CF_GATEWAY_SECRET }), redirect: 'follow' });
      return new Response(await upstream.text(), { status: upstream.ok ? 200 : 502, headers: { ...cors, 'Content-Type': 'application/json;charset=UTF-8', 'Cache-Control': 'no-store' } });
    } catch (error) { return json({ ok: false, error: { message: 'Gateway request failed' } }, 502, cors); }
  }
};

function ecpayMap(request, env) {
  if (!env.ECPAY_MERCHANT_ID || !env.ECPAY_LOGISTICS_SUBTYPE || !env.FRONTEND_URL) return new Response('ECPay logistics is not configured.', { status: 503 });
  const requestUrl = new URL(request.url);
  const serverReplyUrl = `${requestUrl.origin}/ecpay/callback`;
  const tradeNo = `MAP${Date.now().toString(36)}${crypto.randomUUID().replaceAll('-', '').slice(0, 5)}`.slice(0, 20);
  const collection = requestUrl.searchParams.get('collection') === 'N' ? 'N' : 'Y';
  const mapUrl = env.ECPAY_MAP_URL || 'https://logistics.ecpay.com.tw/Express/map';
  const fields = { MerchantID: env.ECPAY_MERCHANT_ID, MerchantTradeNo: tradeNo, LogisticsType: 'CVS', LogisticsSubType: env.ECPAY_LOGISTICS_SUBTYPE, IsCollection: collection, ServerReplyURL: serverReplyUrl, ExtraData: 'liuhe', Device: '1' };
  const inputs = Object.entries(fields).map(([name, value]) => `<input type="hidden" name="${html(name)}" value="${html(value)}">`).join('');
  return new Response(`<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>前往選擇門市</title></head><body><form id="ecpay" method="post" action="${html(mapUrl)}">${inputs}</form><p>正在開啟 7-ELEVEN 門市地圖…</p><script>document.getElementById('ecpay').submit()<\/script></body></html>`, { headers: { 'Content-Type': 'text/html;charset=UTF-8', 'Cache-Control': 'no-store' } });
}

async function ecpayCallback(request, env) {
  if (!env.FRONTEND_URL) return new Response('Frontend URL is not configured.', { status: 503 });
  const form = await request.formData();
  const code = String(form.get('CVSStoreID') || '').trim();
  const name = String(form.get('CVSStoreName') || '').trim();
  const address = String(form.get('CVSAddress') || '').trim();
  if (!code || !name || !address) return new Response('門市資料不完整，請返回重新選擇。', { status: 400 });
  const token = await signStore(env.CF_GATEWAY_SECRET, code, name, address);
  const target = new URL(env.FRONTEND_URL);
  target.searchParams.set('ecpay', 'store'); target.searchParams.set('storeCode', code); target.searchParams.set('storeName', name); target.searchParams.set('storeAddress', address); target.searchParams.set('storeToken', token);
  return Response.redirect(target.toString(), 303);
}

async function signStore(secret, code, name, address) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${code}|${name}|${address}`)));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function html(value) { return String(value).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }

async function callGas(env, body) {
  const upstream = await fetch(env.GAS_WEB_APP_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body: JSON.stringify({ action: body.action, payload: body.payload || {}, gatewaySecret: env.CF_GATEWAY_SECRET }), redirect: 'follow' });
  const text = await upstream.text();
  if (!upstream.ok) throw new Error('GAS request failed');
  return text;
}

function originAllowed(origin, allowed) { return !allowed || allowed === '*' || origin === allowed; }
function corsHeaders(origin, allowed) { const value = allowed === '*' ? '*' : originAllowed(origin, allowed) ? origin : ''; return { 'Access-Control-Allow-Origin': value, 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST,OPTIONS', 'Vary': 'Origin' }; }
function json(value, status, headers) { return new Response(JSON.stringify(value), { status, headers: { ...headers, 'Content-Type': 'application/json;charset=UTF-8' } }); }

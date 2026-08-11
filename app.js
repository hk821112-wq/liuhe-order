const cfg = window.APP_CONFIG;
const state = { config: null, products: [], index: 0, quantities: {}, lineSessionToken: '', lineUser: null, touchStartX: 0 };
const $ = (id) => document.getElementById(id);
const money = (n) => `NT$${Number(n || 0).toLocaleString('zh-TW')}`;

async function api(action, payload = {}) {
  const response = await fetch(cfg.API_BASE_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, payload }) });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data?.error?.message || '連線失敗，請稍後再試');
  return data.result;
}

async function init() {
  bindEvents();
  try {
    state.config = cfg.API_BASE_URL.includes('YOUR-WORKER') ? previewConfig() : await api('publicConfig');
    state.products = state.config.products || [];
    $('merchantName').textContent = state.config.merchantName;
    $('bundlePrice').textContent = `任選三包 ${money(state.config.bundlePrice)}`;
    renderProducts(); renderCurrent(); updateCart();
  } catch (error) { showError(error.message); }
  await initLine();
}

async function initLine() {
  if (!cfg.LIFF_ID || cfg.LIFF_ID.startsWith('YOUR-')) return;
  try {
    await liff.init({ liffId: cfg.LIFF_ID });
    if (!liff.isLoggedIn()) return;
    const profile = await liff.getProfile();
    const result = await api('lineSessionCreate', { idToken: liff.getIDToken(), accessToken: liff.getAccessToken() });
    state.lineSessionToken = result.sessionToken; state.lineUser = profile;
    $('lineLabel').textContent = `${profile.displayName} · 已登入`;
  } catch (error) { showError(`LINE 登入初始化失敗：${error.message}`); }
}

function renderProducts() {
  $('productTrack').innerHTML = state.products.map((product, i) => `<article class="product-card" aria-label="${escapeHtml(product.name)}"><img src="${escapeHtml(product.imageUrl || `./assets/product-${(i % 10) + 1}.png`)}" alt="${escapeHtml(product.name)}" /></article>`).join('');
  $('productDots').innerHTML = state.products.map((_, i) => `<i class="${i === 0 ? 'active' : ''}"></i>`).join('');
}

function renderCurrent() {
  if (!state.products.length) return;
  const p = state.products[state.index];
  $('productTrack').style.transform = `translateX(-${state.index * 100}%)`;
  [...$('productDots').children].forEach((dot, i) => dot.classList.toggle('active', i === state.index));
  $('productName').textContent = p.name; $('productSpec').textContent = p.spec; $('productPrice').textContent = money(p.price);
  $('quantity').textContent = state.quantities[p.id] || 0;
}

function changeQty(delta) {
  const p = state.products[state.index]; if (!p) return;
  state.quantities[p.id] = Math.max(0, Math.min(p.stock, (state.quantities[p.id] || 0) + delta));
  $('quantity').textContent = state.quantities[p.id]; updateCart();
}

function totals() {
  const qty = Object.values(state.quantities).reduce((a, b) => a + b, 0);
  if (!state.config) return { qty: 0, subtotal: 0, shipping: 0, total: 0 };
  const subtotal = Math.floor(qty / 3) * state.config.bundlePrice + (qty % 3) * state.config.singlePrice;
  const shipping = subtotal >= state.config.freeShippingThreshold ? 0 : state.config.shipping711;
  return { qty, subtotal, shipping, total: subtotal + shipping };
}

function updateCart() {
  const t = totals(); $('cartCount').textContent = t.qty ? `已選 ${t.qty} 包商品` : '尚未選購'; $('cartTotal').textContent = money(t.subtotal);
  $('dialogTotal').textContent = money(t.total); $('checkoutButton').disabled = !t.qty || !state.config?.orderOpen;
}

function bindEvents() {
  $('minusButton').addEventListener('click', () => changeQty(-1)); $('plusButton').addEventListener('click', () => changeQty(1));
  $('productTrack').addEventListener('touchstart', (e) => { state.touchStartX = e.changedTouches[0].clientX; }, { passive: true });
  $('productTrack').addEventListener('touchend', (e) => { const dx = e.changedTouches[0].clientX - state.touchStartX; if (Math.abs(dx) < 40) return; state.index = Math.max(0, Math.min(state.products.length - 1, state.index + (dx < 0 ? 1 : -1))); renderCurrent(); });
  $('lineButton').addEventListener('click', () => { if (!cfg.LIFF_ID || cfg.LIFF_ID.startsWith('YOUR-')) return showError('請先在 config.js 設定 LIFF_ID'); if (!liff.isLoggedIn()) liff.login({ redirectUri: location.href.split('#')[0] }); });
  $('checkoutButton').addEventListener('click', () => { if (!state.lineSessionToken) return $('lineButton').click(); updateCart(); $('checkoutDialog').showModal(); });
  document.querySelectorAll('input[name="delivery"]').forEach(el => el.addEventListener('change', updateDelivery));
  $('checkoutForm').addEventListener('submit', submitOrder); $('successClose').addEventListener('click', () => $('successDialog').close());
}

function updateDelivery() {
  const delivery = new FormData($('checkoutForm')).get('delivery'); const home = delivery === '宅配到府';
  $('storeFields').hidden = home; $('homeFields').hidden = !home;
  document.querySelector('input[value="7-11取貨付款"]').disabled = home;
  if (home) document.querySelector('input[value="轉帳付款"]').checked = true;
  const t = totals(); const fee = t.subtotal >= state.config.freeShippingThreshold ? 0 : home ? state.config.shippingHome : state.config.shipping711;
  $('dialogTotal').textContent = money(t.subtotal + fee);
}

async function submitOrder(event) {
  event.preventDefault(); const button = $('submitOrder'); const form = new FormData(event.currentTarget); const delivery = form.get('delivery');
  const payload = Object.fromEntries(form.entries());
  Object.assign(payload, { lineSessionToken: state.lineSessionToken, requestId: crypto.randomUUID().replaceAll('-', ''), storeVerified: delivery === '7-11超商取貨', items: Object.entries(state.quantities).filter(([, qty]) => qty > 0).map(([productId, qty]) => ({ productId, qty })) });
  button.disabled = true; button.textContent = '正在建立訂單…'; $('formError').textContent = '';
  try {
    const result = await api('createOrder', payload); $('checkoutDialog').close();
    $('successOrderNo').textContent = result.orderNo; $('successQty').textContent = `${result.totalQty} 包`; $('successTotal').textContent = money(result.total); $('successMessage').textContent = result.successMessage;
    $('successDialog').showModal(); state.quantities = {}; updateCart(); renderCurrent();
  } catch (error) { $('formError').textContent = error.message; }
  finally { button.disabled = false; button.textContent = '送出訂單'; }
}

function showError(message) { $('formError').textContent = message; console.error(message); }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;' }[c])); }
function previewConfig() {
  return { merchantName: '六合牛軋糖', singlePrice: 200, bundlePrice: 500, shipping711: 60, shippingHome: 120, freeShippingThreshold: 1000, orderOpen: true, products: [
    { id: 'LH002', name: '果乾雪Q餅', spec: '200克', price: 200, stock: 100, imageUrl: './assets/product-1.png' },
    { id: 'LH001', name: '杏仁牛軋糖', spec: '200克', price: 200, stock: 100, imageUrl: './assets/product-9.png' },
    { id: 'LH003', name: '綜合分享盒', spec: '200克', price: 200, stock: 100, imageUrl: './assets/product-8.png' }
  ] };
}
init();

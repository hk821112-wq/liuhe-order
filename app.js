const cfg = window.APP_CONFIG;
const state = { config: null, products: [], index: 0, quantities: {}, lineSessionToken: '', lineUser: null, store: null };
const $ = (id) => document.getElementById(id);
const money = (n) => `NT$${Number(n || 0).toLocaleString('zh-TW')}`;
const isLocalPreview = ['127.0.0.1', 'localhost'].includes(location.hostname);

async function api(action, payload = {}) {
  const response = await fetch(cfg.API_BASE_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, payload }) });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data?.error?.message || '連線失敗，請稍後再試');
  return data.result;
}

async function init() {
  bindEvents();
  if (isLocalPreview) state.lineSessionToken = 'local-preview';
  restoreCheckoutState();
  applyConfig(loadCachedConfig() || previewConfig());
  restoreStoreFromUrl();
  initLine();
  if (!isLocalPreview && !cfg.API_BASE_URL.includes('YOUR-WORKER')) {
    api('publicConfig').then(config => { localStorage.setItem('liuhePublicConfig', JSON.stringify(config)); applyConfig(config); }).catch(error => console.warn('商品資料背景同步失敗：', error.message));
  }
}

function loadCachedConfig() {
  try {
    const config = JSON.parse(localStorage.getItem('liuhePublicConfig') || 'null');
    return config && Array.isArray(config.products) && config.products.length ? config : null;
  } catch (_) {
    localStorage.removeItem('liuhePublicConfig');
    return null;
  }
}

function applyConfig(config) {
  const selectedId = state.products[state.index]?.id || '';
  state.config = config;
  state.products = config.products || [];
  const selectedIndex = state.products.findIndex(product => product.id === selectedId);
  if (selectedIndex >= 0) state.index = selectedIndex;
  if (state.index >= state.products.length) state.index = 0;
  $('merchantName').textContent = config.merchantName || '六合牛軋糖';
  $('bundlePrice').textContent = `任選三包 ${money(config.bundlePrice)}`;
  renderProducts(); renderCurrent(); updateCart(); updateDelivery();
}

async function initLine() {
  if (isLocalPreview) { $('lineLabel').textContent = '本機預覽 · 已登入'; return; }
  if (!cfg.LIFF_ID || cfg.LIFF_ID.startsWith('YOUR-')) return;
  try {
    await liff.init({ liffId: cfg.LIFF_ID });
    if (!liff.isLoggedIn()) {
      $('lineLabel').textContent = '登入中…';
      liff.login({ redirectUri: location.href.split('#')[0] });
      return;
    }
    const profile = await liff.getProfile();
    const result = await api('lineSessionCreate', { idToken: liff.getIDToken(), accessToken: liff.getAccessToken() });
    state.lineSessionToken = result.sessionToken; state.lineUser = profile;
    $('lineLabel').textContent = `${profile.displayName} · 已登入`;
  } catch (error) { showError(`LINE 登入初始化失敗：${error.message}`); }
}

function renderProducts() {
  $('productOptions').innerHTML = state.products.map((product, i) => `<button class="product-option" type="button" data-product-index="${i}" data-active="${i === state.index}" aria-label="選擇${escapeHtml(product.name)}"><span>${escapeHtml(product.name)}</span><small>${escapeHtml(product.spec)} · ${money(product.price)}</small><b class="option-qty" data-empty="true">0</b></button>`).join('');
}

function renderCurrent() {
  if (!state.products.length) return;
  const p = state.products[state.index];
  const image = $('productImage');
  image.classList.add('is-changing');
  image.src = p.imageUrl || `./assets/product-${(state.index % 10) + 1}.webp`;
  image.alt = `${p.name}商品圖`;
  requestAnimationFrame(() => image.classList.remove('is-changing'));
  $('productName').textContent = p.name; $('productSpec').textContent = p.spec; $('productPrice').textContent = money(p.price);
  $('quantity').textContent = state.quantities[p.id] || 0;
  updateProductOptions();
}

function updateProductOptions() {
  document.querySelectorAll('.product-option').forEach((button, i) => {
    const product = state.products[i]; const qty = state.quantities[product.id] || 0; const badge = button.querySelector('.option-qty');
    button.dataset.active = String(i === state.index); button.setAttribute('aria-pressed', String(i === state.index)); badge.textContent = qty; badge.dataset.empty = String(qty === 0);
  });
}

function changeQty(delta) {
  const p = state.products[state.index]; if (!p) return;
  state.quantities[p.id] = Math.max(0, Math.min(p.stock, (state.quantities[p.id] || 0) + delta));
  $('quantity').textContent = state.quantities[p.id]; updateProductOptions(); updateCart();
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
  $('productOptions').addEventListener('click', (event) => { const button = event.target.closest('[data-product-index]'); if (!button) return; state.index = Number(button.dataset.productIndex); renderCurrent(); });
  document.addEventListener('dblclick', (event) => event.preventDefault(), { passive: false });
  document.addEventListener('gesturestart', (event) => event.preventDefault(), { passive: false });
  $('lineButton').addEventListener('click', () => { if (!cfg.LIFF_ID || cfg.LIFF_ID.startsWith('YOUR-')) return showError('請先在 config.js 設定 LIFF_ID'); if (!liff.isLoggedIn()) liff.login({ redirectUri: location.href.split('#')[0] }); });
  $('checkoutButton').addEventListener('click', () => { if (!state.lineSessionToken) return $('lineButton').click(); updateCart(); $('checkoutDialog').showModal(); });
  $('selectStoreButton').addEventListener('click', selectEcpayStore);
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

function selectEcpayStore() {
  saveCheckoutState();
  const payment = new FormData($('checkoutForm')).get('payment');
  const collection = payment === '7-11取貨付款' ? 'Y' : 'N';
  location.assign(`${cfg.API_BASE_URL.replace(/\/$/, '')}/ecpay/map?collection=${collection}`);
}

function saveCheckoutState() {
  const fields = Object.fromEntries(new FormData($('checkoutForm')).entries());
  sessionStorage.setItem('liuheCheckout', JSON.stringify({ quantities: state.quantities, fields }));
}

function restoreCheckoutState() {
  try {
    const saved = JSON.parse(sessionStorage.getItem('liuheCheckout') || 'null');
    if (!saved) return;
    state.quantities = saved.quantities || {};
    Object.entries(saved.fields || {}).forEach(([name, value]) => {
      const candidates = [...document.querySelectorAll(`[name="${CSS.escape(name)}"]`)];
      const input = candidates.find(el => el.type !== 'radio' || el.value === value);
      if (input) input.type === 'radio' ? input.checked = true : input.value = value;
    });
  } catch (_) { sessionStorage.removeItem('liuheCheckout'); }
}

function restoreStoreFromUrl() {
  const params = new URLSearchParams(location.search);
  if (params.get('ecpay') !== 'store') return;
  state.store = { code: params.get('storeCode') || '', name: params.get('storeName') || '', address: params.get('storeAddress') || '', token: params.get('storeToken') || '' };
  if (!state.store.code || !state.store.name || !state.store.address || !state.store.token) return;
  const form = $('checkoutForm');
  form.elements.storeCode.value = state.store.code; form.elements.storeName.value = state.store.name; form.elements.storeAddress.value = state.store.address; form.elements.storeVerificationToken.value = state.store.token;
  $('selectedStoreName').textContent = `${state.store.name}門市 · ${state.store.code}`;
  $('selectedStoreDetail').textContent = state.store.address;
  $('selectedStore').hidden = false; $('selectStoreButton').textContent = '重新選擇門市';
  history.replaceState({}, '', location.pathname);
  requestAnimationFrame(() => $('checkoutDialog').showModal());
}

async function submitOrder(event) {
  event.preventDefault(); const button = $('submitOrder'); const form = new FormData(event.currentTarget); const delivery = form.get('delivery');
  const payload = Object.fromEntries(form.entries());
  if (delivery === '7-11超商取貨' && !payload.storeVerificationToken) { $('formError').textContent = '請先使用綠界電子地圖選擇 7-11 門市。'; return; }
  Object.assign(payload, { lineSessionToken: state.lineSessionToken, requestId: crypto.randomUUID().replaceAll('-', ''), storeVerified: delivery === '7-11超商取貨', items: Object.entries(state.quantities).filter(([, qty]) => qty > 0).map(([productId, qty]) => ({ productId, qty })) });
  button.disabled = true; button.textContent = '正在建立訂單…'; $('formError').textContent = '';
  try {
    const result = await api('createOrder', payload); $('checkoutDialog').close();
    $('successOrderNo').textContent = result.orderNo; $('successQty').textContent = `${result.totalQty} 包`; $('successTotal').textContent = money(result.total); $('successMessage').textContent = result.successMessage;
    $('successDialog').showModal(); state.quantities = {}; sessionStorage.removeItem('liuheCheckout'); updateCart(); renderCurrent();
  } catch (error) { $('formError').textContent = error.message; }
  finally { button.disabled = false; button.textContent = '送出訂單'; }
}

function showError(message) { $('formError').textContent = message; console.error(message); }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;' }[c])); }
function previewConfig() {
  return { merchantName: '六合牛軋糖', singlePrice: 200, bundlePrice: 500, shipping711: 60, shippingHome: 120, freeShippingThreshold: 1000, orderOpen: true, products: [
    { id: 'LH002', name: '果乾雪Q餅', spec: '200克', price: 200, stock: 100, imageUrl: './assets/product-1.webp' },
    { id: 'LH001', name: '杏仁牛軋糖', spec: '200克', price: 200, stock: 100, imageUrl: './assets/product-9.webp' },
    { id: 'LH003', name: '綜合分享盒', spec: '200克', price: 200, stock: 100, imageUrl: './assets/product-8.webp' }
  ] };
}
init();

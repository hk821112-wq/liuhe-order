const API_VERSION = '5.1.0';

const SHEETS = Object.freeze({
  SETTINGS: '系統設定',
  PRODUCTS: '商品管理',
  ORDERS: '訂單主檔',
  ITEMS: '訂單明細',
  LOGS: '操作紀錄'
});

const ORDER_HEADERS = Object.freeze([
  '建立時間', '訂單編號', '訂單狀態', '姓名', '電話',
  'LINE名稱', 'LINE User ID', '配送方式', '付款方式',
  '商品金額', '運費', '總金額',
  '門市名稱', '門市店號', '門市地址', '宅配地址',
  '備註', '出貨時間', '通知預定時間', '通知狀態',
  '物流單號', '取消退庫', '最後更新時間', '請求識別碼',
  '匯款銀行', '匯款帳號後五碼', '匯款人姓名', '買家填寫匯款時間',
  '匯款回報時間', '付款核對狀態', '通知嘗試次數', '通知最後錯誤'
]);

const ITEM_HEADERS = Object.freeze([
  '訂單編號', '商品編號', '商品名稱', '規格',
  '單包原價', '數量', '原價小計', '優惠後分攤金額'
]);

const PRODUCT_HEADERS = Object.freeze([
  '商品編號', '商品名稱', '規格', '單包價格', '三包優惠價',
  '初始庫存', '現有庫存', '上架狀態', '圖片網址', '排序'
]);

const SETTINGS_HEADERS = Object.freeze(['設定項目', '設定值', '說明']);
const LOG_HEADERS = Object.freeze(['時間', '操作類型', '訂單編號', '內容']);

const ORDER_STATUS = Object.freeze([
  '新訂單', '待付款', '已付款', '製作中',
  '待出貨', '已出貨', '已完成', '已取消'
]);

const STATUS_TRANSITIONS = Object.freeze({
  '新訂單': ['製作中', '待出貨', '已取消'],
  '待付款': ['已取消'],
  '已付款': ['製作中', '待出貨', '已取消'],
  '製作中': ['待出貨', '已取消'],
  '待出貨': ['已出貨', '已取消'],
  '已出貨': ['已完成'],
  '已完成': [],
  '已取消': []
});

const PUBLIC_CONFIG_CACHE_KEY = 'PUBLIC_CONFIG_V510';
const PUBLIC_CONFIG_CACHE_SECONDS = 30;
const LINE_SESSION_TTL_SECONDS = 6 * 60 * 60;
const ADMIN_SESSION_TTL_SECONDS = 8 * 60 * 60;
const NOTIFY_MAX_ATTEMPTS = 3;

function doGet() {
  return jsonResponse_({
    ok: true,
    meta: { version: API_VERSION },
    result: {
      service: '六合牛軋糖訂單 API',
      version: API_VERSION,
      status: 'online',
      time: formatDateTime_(new Date())
    }
  });
}

function doPost(e) {
  try {
    const request = parseRequest_(e);
    assertGatewaySecret_(request.gatewaySecret);
    const result = routeApi_(request.action, request.payload || {});
    return jsonResponse_({ ok: true, meta: { version: API_VERSION }, result });
  } catch (error) {
    console.error(error && error.stack ? error.stack : error);
    return jsonResponse_({
      ok: false,
      meta: { version: API_VERSION },
      error: {
        code: String(error && error.code ? error.code : 'BACKEND_ERROR'),
        message: String(error && error.message ? error.message : error || '系統處理失敗')
      }
    });
  }
}

function routeApi_(action, payload) {
  switch (String(action || '')) {
    case 'systemHealth': return getSystemHealth_();
    case 'publicConfig': return getPublicConfig_(Boolean(payload.forceRefresh));
    case 'lineSessionCreate': return createLineSession_(payload);
    case 'createOrder': return createOrder_(payload);
    case 'orderByRequestId': return getOrderByRequestId_(payload);
    case 'myOrders': return getMyOrders_(payload);
    case 'paymentInfo': return getPaymentInfo_(payload);
    case 'confirmTransfer': return confirmTransfer_(payload);
    case 'adminLogin': return adminLogin_(payload);
    case 'adminRefresh': return getAdminDashboard_(requireAdminSession_(payload.adminToken), 300);
    case 'adminChangePassword': return adminChangePassword_(payload);
    case 'adminShipOrder': return adminShipOrder_(payload);
    case 'adminCancelOrder': return adminCancelOrder_(payload);
    case 'updateOrderStatus': return updateOrderStatus_(payload);
    case 'updatePaymentVerification': return updatePaymentVerification_(payload);
    case 'retryShipmentNotification': return retryShipmentNotification_(payload);
    default: throw appError_('不支援的 API 操作。', 'UNSUPPORTED_ACTION');
  }
}

function setupSystem() {
  const ss = getSpreadsheet_();
  const settingsSheet = ensureSheetSchema_(ss, SHEETS.SETTINGS, SETTINGS_HEADERS);
  const productsSheet = ensureSheetSchema_(ss, SHEETS.PRODUCTS, PRODUCT_HEADERS);
  const ordersSheet = ensureSheetSchema_(ss, SHEETS.ORDERS, ORDER_HEADERS);
  const itemsSheet = ensureSheetSchema_(ss, SHEETS.ITEMS, ITEM_HEADERS);
  const logsSheet = ensureSheetSchema_(ss, SHEETS.LOGS, LOG_HEADERS);

  upsertSettings_(settingsSheet, [
    ['商家名稱', '六合牛軋糖店舖', '前端及通知顯示名稱'],
    ['LINE官方帳號', '@228ddkjx', '客服 LINE ID'],
    ['客服電話', '0930233358', '客服聯絡電話'],
    ['單包價格', 200, '每包售價'],
    ['三包優惠價', 500, '牛軋糖與雪Q餅可混搭'],
    ['7-11運費', 60, '未達免運門檻'],
    ['宅配運費', 120, '未達免運門檻'],
    ['滿額免運門檻', 1000, '兩種配送方式都適用'],
    ['接單狀態', '開放', '可填：開放／暫停'],
    ['銀行名稱', '請填寫', '轉帳訂單成立後顯示'],
    ['銀行代碼', '請填寫', '3 位銀行代碼'],
    ['轉帳帳號', '請填寫', '只填數字，可包含分隔符號'],
    ['戶名', '請填寫', '帳戶戶名'],
    ['訂單成立訊息', '訂單已成功送出，商家確認後將依序安排製作與出貨。', '成功頁顯示'],
    ['系統版本', API_VERSION, '請勿任意修改']
  ]);

  upsertProducts_(productsSheet, [
    ['LH001', '牛軋糖', '200克', 200, 500, 1000, 1000, '上架', '', 1],
    ['LH002', '雪Q餅', '200克', 200, 500, 1000, 1000, '上架', '', 2]
  ]);
  syncProductPricing_(settingsSheet, productsSheet);

  const statusRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(ORDER_STATUS, true)
    .setAllowInvalid(false)
    .build();
  ordersSheet.getRange(2, 3, Math.max(ordersSheet.getMaxRows() - 1, 1), 1)
    .setDataValidation(statusRule);

  [settingsSheet, productsSheet, ordersSheet, itemsSheet, logsSheet]
    .forEach(sheet => sheet.setFrozenRows(1));
  ordersSheet.getRange('E:E').setNumberFormat('@');
  ordersSheet.getRange('N:N').setNumberFormat('@');
  ordersSheet.getRange('Z:Z').setNumberFormat('@');

  PropertiesService.getScriptProperties().setProperties({
    SYSTEM_READY: 'true',
    API_VERSION: API_VERSION
  }, false);
  invalidatePublicConfigCache_();

  return {
    ok: true,
    message: '試算表架構檢查與升級完成',
    spreadsheetUrl: ss.getUrl(),
    version: API_VERSION,
    health: getSystemHealth_()
  };
}

function setupNotificationTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(trigger => trigger.getHandlerFunction() === 'processShipmentNotifications')
    .forEach(trigger => ScriptApp.deleteTrigger(trigger));

  ScriptApp.newTrigger('processShipmentNotifications')
    .timeBased()
    .everyMinutes(5)
    .create();

  return '已建立每 5 分鐘檢查一次的出貨通知排程。';
}

function getSystemHealth_() {
  const props = PropertiesService.getScriptProperties();
  const issues = [];
  const warnings = [];
  const schemas = {};

  try {
    const ss = getSpreadsheet_();
    [
      [SHEETS.SETTINGS, SETTINGS_HEADERS],
      [SHEETS.PRODUCTS, PRODUCT_HEADERS],
      [SHEETS.ORDERS, ORDER_HEADERS],
      [SHEETS.ITEMS, ITEM_HEADERS],
      [SHEETS.LOGS, LOG_HEADERS]
    ].forEach(([name, headers]) => {
      try {
        validateSheetSchema_(ss, name, headers);
        schemas[name] = 'ok';
      } catch (error) {
        schemas[name] = 'error';
        issues.push(error.message);
      }
    });
  } catch (error) {
    issues.push(error.message);
  }

  if (props.getProperty('SYSTEM_READY') !== 'true') issues.push('尚未執行 setupSystem()。');
  if (!props.getProperty('CF_GATEWAY_SECRET')) issues.push('缺少 CF_GATEWAY_SECRET。');
  if (!props.getProperty('ADMIN_PIN')) issues.push('缺少 ADMIN_PIN。');
  if (!props.getProperty('LINE_LOGIN_CHANNEL_ID')) issues.push('缺少 LINE_LOGIN_CHANNEL_ID。');
  if (!props.getProperty('LINE_CHANNEL_ACCESS_TOKEN')) warnings.push('尚未設定 LINE_CHANNEL_ACCESS_TOKEN，出貨通知不會發送。');

  let bankReady = false;
  let orderOpen = false;
  try {
    const settings = getSettings_();
    bankReady = isBankReady_(settings);
    orderOpen = String(settings['接單狀態']) === '開放';
    if (!bankReady) warnings.push('轉帳銀行資料尚未完整或格式不正確。');
  } catch (error) {
    issues.push(error.message);
  }

  return {
    version: API_VERSION,
    healthy: issues.length === 0,
    issues,
    warnings,
    schemas,
    bankReady,
    orderOpen,
    notificationReady: Boolean(props.getProperty('LINE_CHANNEL_ACCESS_TOKEN')),
    checkedAt: formatDateTime_(new Date())
  };
}

function getPublicConfig_(forceRefresh) {
  assertSystemReady_();
  const cache = CacheService.getScriptCache();
  const cached = forceRefresh ? null : cache.get(PUBLIC_CONFIG_CACHE_KEY);
  if (cached) {
    try { return JSON.parse(cached); } catch (_) { cache.remove(PUBLIC_CONFIG_CACHE_KEY); }
  }

  const settings = getSettings_();
  const singlePrice = positiveNumber_(settings['單包價格'], '單包價格');
  const bundlePrice = positiveNumber_(settings['三包優惠價'], '三包優惠價');
  const products = getProducts_().filter(product => product.enabled);

  const result = {
    apiVersion: API_VERSION,
    merchantName: String(settings['商家名稱'] || '六合牛軋糖店舖'),
    lineOfficialId: String(settings['LINE官方帳號'] || '@228ddkjx'),
    phone: String(settings['客服電話'] || ''),
    singlePrice,
    bundlePrice,
    shipping711: nonNegativeNumber_(settings['7-11運費'], '7-11運費'),
    shippingHome: nonNegativeNumber_(settings['宅配運費'], '宅配運費'),
    freeShippingThreshold: nonNegativeNumber_(settings['滿額免運門檻'], '滿額免運門檻'),
    orderOpen: String(settings['接單狀態']) === '開放',
    bankReady: isBankReady_(settings),
    successMessage: String(settings['訂單成立訊息'] || '訂單已成功送出。'),
    products: products.map(product => ({
      id: product.id,
      name: product.name,
      spec: product.spec,
      price: singlePrice,
      stock: product.stock,
      enabled: product.enabled,
      imageUrl: product.imageUrl
    }))
  };

  cache.put(PUBLIC_CONFIG_CACHE_KEY, JSON.stringify(result), PUBLIC_CONFIG_CACHE_SECONDS);
  return result;
}


function syncProductPricing_(settingsSheet, productsSheet) {
  if (!settingsSheet || !productsSheet || productsSheet.getLastRow() < 2) return;
  const settingsValues = settingsSheet.getRange(2, 1, Math.max(settingsSheet.getLastRow() - 1, 0), 2).getValues();
  const settings = Object.fromEntries(settingsValues.filter(row => row[0]).map(row => [String(row[0]), row[1]]));
  const singlePrice = Number(settings['單包價格']);
  const bundlePrice = Number(settings['三包優惠價']);
  if (!Number.isFinite(singlePrice) || singlePrice <= 0 || !Number.isFinite(bundlePrice) || bundlePrice <= 0) return;
  const rows = productsSheet.getLastRow() - 1;
  productsSheet.getRange(2, 4, rows, 1).setValues(Array.from({ length: rows }, () => [Math.round(singlePrice)]));
  productsSheet.getRange(2, 5, rows, 1).setValues(Array.from({ length: rows }, () => [Math.round(bundlePrice)]));
}

function invalidatePublicConfigCache_() {
  try { CacheService.getScriptCache().remove(PUBLIC_CONFIG_CACHE_KEY); } catch (_) {}
}

function onEdit(e) {
  try {
    const name = e && e.range && e.range.getSheet().getName();
    if (name === SHEETS.SETTINGS || name === SHEETS.PRODUCTS) {
      const ss = e.source || getSpreadsheet_();
      syncProductPricing_(ss.getSheetByName(SHEETS.SETTINGS), ss.getSheetByName(SHEETS.PRODUCTS));
      invalidatePublicConfigCache_();
    }
  } catch (_) {}
}

function createLineSession_(payload) {
  const identity = verifyLineIdentity_(String(payload.idToken || ''), String(payload.accessToken || ''));
  return {
    sessionToken: createSignedSession_('line', {
      userId: identity.userId,
      name: identity.name
    }, LINE_SESSION_TTL_SECONDS),
    user: { userId: identity.userId, name: identity.name },
    expiresIn: LINE_SESSION_TTL_SECONDS
  };
}

function adminLogin_(payload) {
  const key = adminLoginRateKey_(payload.clientIp);
  const cache = CacheService.getScriptCache();
  const attempts = Number(cache.get(key) || 0);
  if (attempts >= 5) throw appError_('登入失敗次數過多，請 5 分鐘後再試。', 'ADMIN_RATE_LIMITED');
  try {
    checkAdminPin_(payload.pin);
  } catch (error) {
    cache.put(key, String(attempts + 1), 300);
    throw error;
  }
  cache.remove(key);
  return {
    adminToken: createSignedSession_('admin', { role: 'admin', authVersion: getAdminAuthVersion_() }, ADMIN_SESSION_TTL_SECONDS),
    expiresIn: ADMIN_SESSION_TTL_SECONDS,
    dashboard: getAdminDashboard_({ role: 'admin' }, 300)
  };
}

function adminLoginRateKey_(clientIp) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(clientIp || 'unknown'), Utilities.Charset.UTF_8);
  return `ADMIN_LOGIN_${Utilities.base64EncodeWebSafe(bytes).replace(/=+$/g, '').slice(0, 24)}`;
}

function createOrder_(payload) {
  assertSystemReady_();
  const identity = requireLineSession_(payload.lineSessionToken);
  if (!payload || typeof payload !== 'object') throw appError_('訂單資料格式錯誤。', 'INVALID_ORDER');
  if (cleanText_(payload.website, 100)) throw appError_('訂單驗證失敗。', 'BOT_REJECTED');

  const requestId = cleanText_(payload.requestId, 80);
  if (!requestId || !/^[A-Za-z0-9_-]{12,80}$/.test(requestId)) {
    throw appError_('訂單識別碼錯誤，請重新整理頁面後再試。', 'INVALID_REQUEST_ID');
  }

  const settings = getSettings_();
  if (String(settings['接單狀態']) !== '開放') throw appError_('目前暫停接單，請稍後再試或聯繫客服。', 'ORDER_CLOSED');

  const customerName = cleanText_(payload.customerName, 30);
  const phone = normalizePhone_(payload.phone);
  const delivery = cleanText_(payload.delivery, 20);
  const payment = cleanText_(payload.payment, 20);
  const note = cleanText_(payload.note, 300);

  if (customerName.length < 2) throw appError_('請填入與證件相同的真實姓名。', 'INVALID_NAME');
  if (!/^09\d{8}$/.test(phone)) throw appError_('手機號碼格式錯誤，請輸入 09 開頭共 10 碼。', 'INVALID_PHONE');
  if (!['7-11超商取貨', '宅配到府'].includes(delivery)) throw appError_('配送方式錯誤。', 'INVALID_DELIVERY');

  const allowedPayments = delivery === '7-11超商取貨'
    ? ['7-11取貨付款', '轉帳付款']
    : ['轉帳付款'];
  if (!allowedPayments.includes(payment)) throw appError_('此配送方式不支援所選付款方式。', 'INVALID_PAYMENT');
  if (payment === '轉帳付款' && !isBankReady_(settings)) {
    throw appError_('轉帳付款目前尚未開放，請改用其他付款方式或聯繫客服。', 'BANK_NOT_READY');
  }

  const storeName = cleanText_(payload.storeName, 50);
  const storeCode = cleanText_(payload.storeCode, 20);
  const storeAddress = cleanText_(payload.storeAddress, 150);
  const storeVerified = payload.storeVerified === true;
  const storeVerificationToken = cleanText_(payload.storeVerificationToken, 120);
  const homeAddress = cleanText_(payload.homeAddress, 180);
  if (delivery === '7-11超商取貨') {
    if (!storeVerified || !storeName || !storeCode || !storeAddress) {
      throw appError_('7-11 門市資料未通過電子地圖驗證，請重新選擇門市。', 'STORE_NOT_VERIFIED');
    }
    const expectedStoreToken = signValue_(`${storeCode}|${storeName}|${storeAddress}`);
    if (!storeVerificationToken || !constantTimeStringEqual_(storeVerificationToken, expectedStoreToken)) {
      throw appError_('7-11 門市驗證已失效，請重新選擇門市。', 'STORE_TOKEN_INVALID');
    }
  } else if (homeAddress.length < 8) {
    throw appError_('請填寫完整宅配地址。', 'INVALID_ADDRESS');
  }

  const itemMap = aggregateRequestedItems_(payload.items);
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  const ss = getSpreadsheet_();
  const orderSheet = ss.getSheetByName(SHEETS.ORDERS);
  const itemSheet = ss.getSheetByName(SHEETS.ITEMS);
  const productSheet = ss.getSheetByName(SHEETS.PRODUCTS);
  let orderRowNumber = 0;
  let detailStartRow = 0;
  let detailCount = 0;
  const inventoryChanges = [];

  try {
    const existingRow = findOrderByRequestId_(orderSheet, requestId);
    if (existingRow) {
      const existing = orderSheet.getRange(existingRow, 1, 1, ORDER_HEADERS.length).getValues()[0];
      if (String(existing[6] || '') !== identity.userId) throw appError_('訂單識別碼與 LINE 帳號不符。', 'REQUEST_ID_CONFLICT');
      return orderResultFromRow_(existing, true, settings);
    }

    const products = getProducts_();
    const productMap = Object.fromEntries(products.map(product => [product.id, product]));
    const selected = [];
    let totalQty = 0;

    Object.keys(itemMap).forEach(productId => {
      const qty = itemMap[productId];
      const product = productMap[productId];
      if (!product || !product.enabled) throw appError_('部分商品已下架，請重新整理頁面。', 'PRODUCT_DISABLED');
      if (product.stock < qty) throw appError_(`${product.name} 庫存不足，目前剩餘 ${product.stock} 包。`, 'OUT_OF_STOCK');
      selected.push(Object.assign({}, product, { qty }));
      totalQty += qty;
    });

    if (totalQty < 1) throw appError_('請至少選購 1 包商品。', 'NO_ITEMS');
    if (totalQty > 99) throw appError_('單筆訂單最多 99 包，如需大量訂購請聯繫客服。', 'TOO_MANY_ITEMS');

    const singlePrice = positiveNumber_(settings['單包價格'], '單包價格');
    const bundlePrice = positiveNumber_(settings['三包優惠價'], '三包優惠價');
    const subtotal = Math.floor(totalQty / 3) * bundlePrice + (totalQty % 3) * singlePrice;
    const freeThreshold = nonNegativeNumber_(settings['滿額免運門檻'], '滿額免運門檻');
    const shippingFee = subtotal >= freeThreshold
      ? 0
      : delivery === '7-11超商取貨'
        ? nonNegativeNumber_(settings['7-11運費'], '7-11運費')
        : nonNegativeNumber_(settings['宅配運費'], '宅配運費');
    const total = subtotal + shippingFee;
    const now = new Date();
    const orderNo = nextOrderNumber_(now);

    selected.forEach(item => {
      const stockCell = productSheet.getRange(item.row, 7);
      const liveStock = Number(stockCell.getValue());
      if (liveStock < item.qty) throw appError_(`${item.name} 庫存剛被其他訂單使用，請重新確認。`, 'OUT_OF_STOCK');
      inventoryChanges.push({ cell: stockCell, before: liveStock });
      stockCell.setValue(liveStock - item.qty);
    });

    const orderRow = [
      now, orderNo, payment === '轉帳付款' ? '待付款' : '新訂單',
      customerName, phone, identity.name, identity.userId,
      delivery, payment, subtotal, shippingFee, total,
      delivery === '7-11超商取貨' ? storeName : '',
      delivery === '7-11超商取貨' ? storeCode : '',
      delivery === '7-11超商取貨' ? storeAddress : '',
      delivery === '宅配到府' ? homeAddress : '',
      note, '', '', '尚未排程', '', '否', now, requestId,
      '', '', '', '', '', payment === '轉帳付款' ? '尚未回報' : '不適用', 0, ''
    ];

    orderRowNumber = orderSheet.getLastRow() + 1;
    orderSheet.getRange(orderRowNumber, 1, 1, ORDER_HEADERS.length).setValues([orderRow]);

    let allocated = 0;
    const detailRows = selected.map((item, index) => {
      const original = item.qty * singlePrice;
      const share = index === selected.length - 1
        ? subtotal - allocated
        : Math.floor(subtotal * item.qty / totalQty);
      allocated += share;
      return [orderNo, item.id, item.name, item.spec, singlePrice, item.qty, original, share];
    });
    detailStartRow = itemSheet.getLastRow() + 1;
    detailCount = detailRows.length;
    itemSheet.getRange(detailStartRow, 1, detailCount, ITEM_HEADERS.length).setValues(detailRows);

    log_(ss, '建立訂單', orderNo, JSON.stringify({
      customerName, phone, delivery, payment, totalQty, subtotal, shippingFee, total,
      lineUserId: identity.userId, storeCode: delivery === '7-11超商取貨' ? storeCode : ''
    }));
    SpreadsheetApp.flush();
    invalidatePublicConfigCache_();

    return {
      orderNo,
      status: payment === '轉帳付款' ? '待付款' : '新訂單',
      totalQty,
      subtotal,
      shippingFee,
      total,
      delivery,
      payment,
      lineConnected: true,
      successMessage: String(settings['訂單成立訊息'] || '訂單已成功送出。'),
      bank: payment === '轉帳付款' ? getBankDetails_(settings) : null,
      duplicate: false
    };
  } catch (error) {
    if (detailStartRow && detailCount) {
      try { itemSheet.deleteRows(detailStartRow, detailCount); } catch (_) {}
    }
    if (orderRowNumber) {
      try { orderSheet.deleteRow(orderRowNumber); } catch (_) {}
    }
    inventoryChanges.forEach(change => {
      try { change.cell.setValue(change.before); } catch (_) {}
    });
    throw error;
  } finally {
    lock.releaseLock();
  }
}

function getOrderByRequestId_(payload) {
  const identity = requireLineSession_(payload.lineSessionToken);
  const requestId = cleanText_(payload.requestId, 80);
  if (!requestId) throw appError_('缺少訂單識別碼。', 'INVALID_REQUEST_ID');
  const sheet = getSpreadsheet_().getSheetByName(SHEETS.ORDERS);
  const row = findOrderByRequestId_(sheet, requestId);
  if (!row) return { found: false };
  const values = sheet.getRange(row, 1, 1, ORDER_HEADERS.length).getValues()[0];
  if (String(values[6] || '') !== identity.userId) throw appError_('此訂單不屬於目前 LINE 帳號。', 'FORBIDDEN');
  return { found: true, order: orderResultFromRow_(values, true, getSettings_()) };
}

function getMyOrders_(payload) {
  assertSystemReady_();
  const identity = requireLineSession_(payload.lineSessionToken);
  const ss = getSpreadsheet_();
  const sheet = ss.getSheetByName(SHEETS.ORDERS);
  if (sheet.getLastRow() < 2) return { lineName: identity.name, orders: [] };

  const matches = sheet.getRange(2, 7, sheet.getLastRow() - 1, 1)
    .createTextFinder(identity.userId)
    .matchEntireCell(true)
    .findAll()
    .slice(-50)
    .reverse();
  const orderRows = matches.map(cell => cell.getRow());
  const values = orderRows.map(row => sheet.getRange(row, 1, 1, ORDER_HEADERS.length).getValues()[0]);
  const orderNos = values.map(row => String(row[1] || ''));
  const itemMap = getOrderItemSummaryMap_(ss, orderNos);

  const orders = values.map(row => ({
    createdAt: formatDateTime_(row[0]),
    orderNo: String(row[1] || ''),
    status: String(row[2] || ''),
    delivery: String(row[7] || ''),
    payment: String(row[8] || ''),
    subtotal: Number(row[9] || 0),
    shippingFee: Number(row[10] || 0),
    total: Number(row[11] || 0),
    storeName: String(row[12] || ''),
    storeCode: String(row[13] || ''),
    storeAddress: String(row[14] || ''),
    homeAddress: String(row[15] || ''),
    shippedAt: formatDateTime_(row[17]),
    trackingNo: String(row[20] || ''),
    itemsSummary: itemMap[String(row[1] || '')] || '',
    transferReportedAt: formatDateTime_(row[28]),
    paymentVerifyStatus: String(row[29] || '')
  }));

  return { lineName: identity.name, orders };
}

function getPaymentInfo_(payload) {
  const identity = requireLineSession_(payload.lineSessionToken);
  const settings = getSettings_();
  if (!isBankReady_(settings)) throw appError_('商家尚未完成轉帳資料設定。', 'BANK_NOT_READY');

  const ss = getSpreadsheet_();
  const sheet = ss.getSheetByName(SHEETS.ORDERS);
  const orders = [];
  if (sheet.getLastRow() >= 2) {
    const matches = sheet.getRange(2, 7, sheet.getLastRow() - 1, 1)
      .createTextFinder(identity.userId)
      .matchEntireCell(true)
      .findAll()
      .reverse();
    matches.forEach(cell => {
      if (orders.length >= 30) return;
      const row = sheet.getRange(cell.getRow(), 1, 1, ORDER_HEADERS.length).getValues()[0];
      if (String(row[8] || '') !== '轉帳付款') return;
      if (String(row[2] || '') === '已取消') return;
      orders.push({
        orderNo: String(row[1] || ''),
        createdAt: formatDateTime_(row[0]),
        total: Number(row[11] || 0),
        status: String(row[2] || ''),
        paymentVerifyStatus: String(row[29] || ''),
        canReport: !['已核對'].includes(String(row[29] || ''))
      });
    });
  }

  return { lineName: identity.name, bank: getBankDetails_(settings), orders };
}

function confirmTransfer_(payload) {
  assertSystemReady_();
  const identity = requireLineSession_(payload.lineSessionToken);
  const orderNo = cleanText_(payload.orderNo, 30);
  const payerName = cleanText_(payload.payerName, 30);
  const payerBank = cleanText_(payload.payerBank, 30);
  const payerLast5 = String(payload.payerLast5 || '').replace(/\D/g, '').slice(0, 5);
  const transferAt = cleanText_(payload.transferAt, 30);

  if (!/^LH-\d{8}-\d{4}$/.test(orderNo)) throw appError_('請選擇有效的訂單。', 'INVALID_ORDER_NO');
  if (payerName.length < 2) throw appError_('請填寫匯款人姓名。', 'INVALID_PAYER');
  if (payerBank.length < 2) throw appError_('請填寫匯款銀行。', 'INVALID_BANK');
  if (!/^\d{5}$/.test(payerLast5)) throw appError_('匯款帳號後五碼必須是 5 位數字。', 'INVALID_LAST5');

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const ss = getSpreadsheet_();
    const sheet = ss.getSheetByName(SHEETS.ORDERS);
    const row = findOrderRow_(sheet, orderNo);
    if (!row) throw appError_('找不到訂單。', 'ORDER_NOT_FOUND');
    const values = sheet.getRange(row, 1, 1, ORDER_HEADERS.length).getValues()[0];
    if (String(values[6] || '') !== identity.userId) throw appError_('此訂單不屬於目前 LINE 帳號。', 'FORBIDDEN');
    if (String(values[8] || '') !== '轉帳付款') throw appError_('此訂單不是轉帳付款。', 'INVALID_PAYMENT');
    if (String(values[2] || '') === '已取消') throw appError_('此訂單已取消，無法回報轉帳。', 'ORDER_CANCELLED');
    if (String(values[29] || '') === '已核對') throw appError_('此訂單的款項已核對完成。', 'PAYMENT_ALREADY_VERIFIED');

    const now = new Date();
    sheet.getRange(row, 25, 1, 6).setValues([[
      payerBank, payerLast5, payerName, transferAt, now, '待核對'
    ]]);
    sheet.getRange(row, 23).setValue(now);
    log_(ss, '買家回報轉帳', orderNo, JSON.stringify({ payerBank, payerLast5, payerName, transferAt, lineUserId: identity.userId }));
    SpreadsheetApp.flush();
    return { message: '轉帳資料已送出，商家核對入帳後會更新訂單狀態。' };
  } finally {
    lock.releaseLock();
  }
}

function updateOrderStatus_(payload) {
  requireAdminSession_(payload.adminToken);
  const orderNo = cleanText_(payload.orderNo, 30);
  const newStatus = cleanText_(payload.newStatus, 20);
  const trackingNo = cleanText_(payload.trackingNo, 60);
  if (!ORDER_STATUS.includes(newStatus)) throw appError_('訂單狀態不正確。', 'INVALID_STATUS');

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const ss = getSpreadsheet_();
    const sheet = ss.getSheetByName(SHEETS.ORDERS);
    const row = findOrderRow_(sheet, orderNo);
    if (!row) throw appError_('找不到訂單。', 'ORDER_NOT_FOUND');
    const values = sheet.getRange(row, 1, 1, ORDER_HEADERS.length).getValues()[0];
    const oldStatus = String(values[2] || '');
    const allowed = STATUS_TRANSITIONS[oldStatus] || [];
    if (newStatus !== oldStatus && !allowed.includes(newStatus)) {
      throw appError_(`不允許從「${oldStatus}」直接改為「${newStatus}」。`, 'INVALID_TRANSITION');
    }
    if (newStatus === '已付款' && oldStatus === '待付款') {
      throw appError_('轉帳訂單請使用「確認入帳」，不要直接修改為已付款。', 'USE_PAYMENT_VERIFY');
    }

    const alreadyRestocked = String(values[21] || '') === '是';
    if (newStatus === '已取消' && oldStatus !== '已取消' && !alreadyRestocked) {
      restoreInventoryForOrder_(ss, orderNo);
      sheet.getRange(row, 22).setValue('是');
    }

    const now = new Date();
    sheet.getRange(row, 3).setValue(newStatus);
    sheet.getRange(row, 21).setValue(trackingNo);
    sheet.getRange(row, 23).setValue(now);

    if (newStatus === '已出貨' && oldStatus !== '已出貨') {
      sheet.getRange(row, 18).setValue(now);
      sheet.getRange(row, 19).setValue(new Date(now.getTime() + 60 * 60 * 1000));
      sheet.getRange(row, 20).setValue('待發送');
      sheet.getRange(row, 31).setValue(0);
      sheet.getRange(row, 32).setValue('');
    }

    log_(ss, '更新訂單狀態', orderNo, `${oldStatus} → ${newStatus}`);
    SpreadsheetApp.flush();
    if (newStatus === '已取消') invalidatePublicConfigCache_();
    return { message: '訂單狀態已更新。' };
  } finally {
    lock.releaseLock();
  }
}

function adminShipOrder_(payload) {
  requireAdminSession_(payload.adminToken);
  const orderNo = cleanText_(payload.orderNo, 30);
  const trackingNo = cleanText_(payload.trackingNo, 60);
  if (trackingNo.length < 4) throw appError_('請輸入完整物流單號後再確認出貨。', 'TRACKING_REQUIRED');
  const lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    const ss = getSpreadsheet_(); const sheet = ss.getSheetByName(SHEETS.ORDERS); const row = findOrderRow_(sheet, orderNo);
    if (!row) throw appError_('找不到訂單。', 'ORDER_NOT_FOUND');
    const values = sheet.getRange(row, 1, 1, ORDER_HEADERS.length).getValues()[0]; const oldStatus = String(values[2] || '');
    if (oldStatus === '已取消') throw appError_('已取消訂單不可出貨。', 'ORDER_CANCELLED');
    const now = new Date();
    sheet.getRange(row, 3).setValue('已出貨'); sheet.getRange(row, 18).setValue(now); sheet.getRange(row, 19).setValue(new Date(now.getTime() + 60 * 60 * 1000));
    sheet.getRange(row, 20).setValue('待發送'); sheet.getRange(row, 21).setValue(trackingNo); sheet.getRange(row, 23).setValue(now); sheet.getRange(row, 31).setValue(0); sheet.getRange(row, 32).setValue('');
    log_(ss, '商家確認出貨', orderNo, `${oldStatus} → 已出貨；物流單號：${trackingNo}`); SpreadsheetApp.flush();
    return { message: '已標記出貨，物流單號已保存。', orderNo, trackingNo, status: '已出貨' };
  } finally { lock.releaseLock(); }
}

function adminChangePassword_(payload) {
  requireAdminSession_(payload.adminToken);
  const currentPin = String(payload.currentPin || '');
  const newPin = String(payload.newPin || '');
  const confirmPin = String(payload.confirmPin || '');
  checkAdminPin_(currentPin);
  if (!/^\d{4,12}$/.test(newPin)) throw appError_('新密碼必須是 4 到 12 位數字。', 'INVALID_NEW_PIN');
  if (newPin !== confirmPin) throw appError_('兩次輸入的新密碼不一致。', 'PIN_CONFIRM_MISMATCH');
  if (newPin === currentPin) throw appError_('新密碼不可與目前密碼相同。', 'PIN_NOT_CHANGED');
  const props = PropertiesService.getScriptProperties();
  const nextVersion = String(Number(getAdminAuthVersion_()) + 1);
  props.setProperties({ ADMIN_PIN: newPin, ADMIN_AUTH_VERSION: nextVersion }, false);
  log_(getSpreadsheet_(), '修改後台密碼', 'ADMIN', '商家已自行修改管理密碼，所有舊登入階段已失效。');
  return { message: '密碼修改成功，請使用新密碼重新登入。' };
}

function getAdminAuthVersion_() {
  return String(PropertiesService.getScriptProperties().getProperty('ADMIN_AUTH_VERSION') || '1');
}

function adminCancelOrder_(payload) {
  requireAdminSession_(payload.adminToken);
  const orderNo = cleanText_(payload.orderNo, 30); const reason = cleanText_(payload.reason, 200);
  const lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    const ss = getSpreadsheet_(); const sheet = ss.getSheetByName(SHEETS.ORDERS); const row = findOrderRow_(sheet, orderNo);
    if (!row) throw appError_('找不到訂單。', 'ORDER_NOT_FOUND');
    const values = sheet.getRange(row, 1, 1, ORDER_HEADERS.length).getValues()[0]; const oldStatus = String(values[2] || '');
    if (oldStatus === '已取消') return { message: '此訂單已取消。', orderNo, status: '已取消' };
    if (['已出貨', '已完成'].includes(oldStatus)) throw appError_('已出貨訂單不可直接取消，請先處理退貨。', 'SHIPPED_CANNOT_CANCEL');
    if (String(values[21] || '') !== '是') { restoreInventoryForOrder_(ss, orderNo); sheet.getRange(row, 22).setValue('是'); }
    const now = new Date(); sheet.getRange(row, 3).setValue('已取消'); sheet.getRange(row, 23).setValue(now);
    log_(ss, '商家取消訂單', orderNo, reason || '未填寫取消原因'); SpreadsheetApp.flush(); invalidatePublicConfigCache_();
    return { message: '訂單已取消，庫存已恢復。', orderNo, status: '已取消' };
  } finally { lock.releaseLock(); }
}

function updatePaymentVerification_(payload) {
  requireAdminSession_(payload.adminToken);
  const orderNo = cleanText_(payload.orderNo, 30);
  const decision = cleanText_(payload.decision, 20);
  if (!['confirm', 'reject'].includes(decision)) throw appError_('付款核對操作不正確。', 'INVALID_DECISION');

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const ss = getSpreadsheet_();
    const sheet = ss.getSheetByName(SHEETS.ORDERS);
    const row = findOrderRow_(sheet, orderNo);
    if (!row) throw appError_('找不到訂單。', 'ORDER_NOT_FOUND');
    const values = sheet.getRange(row, 1, 1, ORDER_HEADERS.length).getValues()[0];
    if (String(values[8] || '') !== '轉帳付款') throw appError_('此訂單不是轉帳付款。', 'INVALID_PAYMENT');
    if (String(values[2] || '') === '已取消') throw appError_('已取消訂單不可核對付款。', 'ORDER_CANCELLED');

    const hasBuyerReport = Boolean(values[28]);
    if (decision === 'reject' && !hasBuyerReport) {
      throw appError_('買家尚未填寫轉帳回報，無資料可以退回。', 'NO_TRANSFER_REPORT');
    }

    const now = new Date();
    if (decision === 'confirm') {
      // 客人可用網站回報，也可直接透過 LINE 官方帳號告知。
      // 商家確認銀行入帳後，即使沒有網站回報資料，仍可人工完成核對。
      sheet.getRange(row, 30).setValue('已核對');
      if (String(values[2] || '') === '待付款') sheet.getRange(row, 3).setValue('已付款');
      log_(ss, hasBuyerReport ? '確認轉帳入帳' : '人工確認轉帳入帳', orderNo,
        hasBuyerReport ? '依買家回報資料完成付款核對' : '買家透過 LINE／其他方式告知，由商家人工核對入帳');
    } else {
      sheet.getRange(row, 30).setValue('需重新回報');
      log_(ss, '退回轉帳回報', orderNo, '請買家重新確認資料');
    }
    sheet.getRange(row, 23).setValue(now);
    SpreadsheetApp.flush();
    return {
      message: decision === 'confirm'
        ? (hasBuyerReport ? '已確認入帳，訂單更新為已付款。' : '已人工確認入帳，訂單更新為已付款。')
        : '已退回回報資料。',
      manualVerification: decision === 'confirm' && !hasBuyerReport
    };
  } finally {
    lock.releaseLock();
  }
}

function retryShipmentNotification_(payload) {
  requireAdminSession_(payload.adminToken);
  const orderNo = cleanText_(payload.orderNo, 30);
  const sheet = getSpreadsheet_().getSheetByName(SHEETS.ORDERS);
  const row = findOrderRow_(sheet, orderNo);
  if (!row) throw appError_('找不到訂單。', 'ORDER_NOT_FOUND');
  if (String(sheet.getRange(row, 3).getValue()) !== '已出貨') {
    throw appError_('只有已出貨訂單可以重新發送通知。', 'INVALID_STATUS');
  }
  sheet.getRange(row, 19).setValue(new Date());
  sheet.getRange(row, 20).setValue('待發送');
  sheet.getRange(row, 31).setValue(0);
  sheet.getRange(row, 32).setValue('');
  return { message: '已重新排入通知佇列。' };
}

function processShipmentNotifications() {
  assertSystemReady_();
  const token = PropertiesService.getScriptProperties().getProperty('LINE_CHANNEL_ACCESS_TOKEN');
  if (!token) {
    console.warn('尚未設定 LINE_CHANNEL_ACCESS_TOKEN，略過通知排程。');
    return;
  }

  const ss = getSpreadsheet_();
  const sheet = ss.getSheetByName(SHEETS.ORDERS);
  if (sheet.getLastRow() < 2) return;
  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, ORDER_HEADERS.length).getValues();
  const now = new Date();
  const settings = getSettings_();

  for (let i = 0; i < values.length; i++) {
    const rowNumber = i + 2;
    const row = values[i];
    const orderNo = String(row[1] || '');
    const status = String(row[2] || '');
    const lineUserId = String(row[6] || '');
    const notifyAt = row[18] instanceof Date ? row[18] : null;
    const notifyStatus = String(row[19] || '');
    const attempts = Number(row[30] || 0);

    if (status !== '已出貨' || !['待發送', '待重試'].includes(notifyStatus) || !notifyAt || notifyAt > now) continue;
    if (!lineUserId) {
      sheet.getRange(rowNumber, 20).setValue('無法發送：未取得LINE ID');
      sheet.getRange(rowNumber, 32).setValue('訂單沒有 LINE User ID');
      continue;
    }

    const message = buildShipmentFlex_({
      merchantName: settings['商家名稱'],
      orderNo,
      delivery: String(row[7] || ''),
      total: Number(row[11] || 0),
      shippedAt: row[17],
      trackingNo: String(row[20] || ''),
      lineOfficialId: settings['LINE官方帳號']
    });

    try {
      const response = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
        method: 'post',
        contentType: 'application/json',
        headers: { Authorization: `Bearer ${token}` },
        payload: JSON.stringify({ to: lineUserId, messages: [message] }),
        muteHttpExceptions: true
      });
      const code = response.getResponseCode();
      if (code >= 200 && code < 300) {
        sheet.getRange(rowNumber, 20).setValue('已發送');
        sheet.getRange(rowNumber, 31).setValue(attempts + 1);
        sheet.getRange(rowNumber, 32).setValue('');
        log_(ss, 'LINE出貨通知', orderNo, '發送成功');
      } else {
        handleNotificationFailure_(sheet, rowNumber, orderNo, attempts, `HTTP ${code}: ${response.getContentText().slice(0, 160)}`, code === 429 || code >= 500);
      }
    } catch (error) {
      handleNotificationFailure_(sheet, rowNumber, orderNo, attempts, String(error.message || error), true);
    }
  }
}

function handleNotificationFailure_(sheet, row, orderNo, attempts, detail, retryable) {
  const nextAttempts = attempts + 1;
  sheet.getRange(row, 31).setValue(nextAttempts);
  sheet.getRange(row, 32).setValue(detail.slice(0, 300));
  if (retryable && nextAttempts < NOTIFY_MAX_ATTEMPTS) {
    sheet.getRange(row, 19).setValue(new Date(Date.now() + 30 * 60 * 1000));
    sheet.getRange(row, 20).setValue('待重試');
  } else {
    sheet.getRange(row, 20).setValue('發送失敗');
  }
  log_(getSpreadsheet_(), 'LINE出貨通知失敗', orderNo, detail);
}

function getAdminDashboard_(_admin, limit) {
  const ss = getSpreadsheet_();
  const sheet = ss.getSheetByName(SHEETS.ORDERS);
  const lastRow = sheet.getLastRow();
  const count = Math.max(0, lastRow - 1);
  const recentCount = Math.min(Number(limit || 300), count);
  const recentStart = recentCount ? lastRow - recentCount + 1 : 2;
  const recentRows = recentCount
    ? sheet.getRange(recentStart, 1, recentCount, ORDER_HEADERS.length).getValues().reverse()
    : [];
  const orderNos = recentRows.map(row => String(row[1] || '')).filter(Boolean);
  const itemMap = getOrderItemSummaryMap_(ss, orderNos);

  const orders = recentRows.filter(row => row[1]).map(row => {
    const status = String(row[2] || '');
    return {
      createdAt: formatDateTime_(row[0]),
      orderNo: String(row[1] || ''),
      status,
      customerName: String(row[3] || ''),
      phone: String(row[4] || ''),
      lineName: String(row[5] || ''),
      delivery: String(row[7] || ''),
      payment: String(row[8] || ''),
      subtotal: Number(row[9] || 0),
      shippingFee: Number(row[10] || 0),
      total: Number(row[11] || 0),
      storeName: String(row[12] || ''),
      storeCode: String(row[13] || ''),
      storeAddress: String(row[14] || ''),
      homeAddress: String(row[15] || ''),
      note: String(row[16] || ''),
      shippedAt: formatDateTime_(row[17]),
      notificationAt: formatDateTime_(row[18]),
      notificationStatus: String(row[19] || ''),
      trackingNo: String(row[20] || ''),
      itemsSummary: itemMap[String(row[1] || '')] || '',
      payerBank: String(row[24] || ''),
      payerLast5: String(row[25] || ''),
      payerName: String(row[26] || ''),
      transferAt: String(row[27] || ''),
      transferReportedAt: formatDateTime_(row[28]),
      paymentVerifyStatus: String(row[29] || ''),
      notificationAttempts: Number(row[30] || 0),
      notificationError: String(row[31] || ''),
      allowedStatuses: [status].concat(STATUS_TRANSITIONS[status] || [])
    };
  });

  const stats = { todayOrders: 0, todayRevenue: 0, pendingPayment: 0, pendingShipment: 0 };
  if (count) {
    const statsRows = sheet.getRange(2, 1, count, 12).getValues();
    const today = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd');
    statsRows.forEach(row => {
      const createdAt = formatDateTime_(row[0]);
      const status = String(row[2] || '');
      if (createdAt.indexOf(today) === 0) {
        stats.todayOrders++;
        if (status !== '已取消') stats.todayRevenue += Number(row[11] || 0);
      }
      if (status === '待付款') stats.pendingPayment++;
      if (['新訂單', '已付款', '製作中', '待出貨'].includes(status)) stats.pendingShipment++;
    });
  }

  const products = getProducts_().map(product => ({
    id: product.id,
    name: product.name,
    spec: product.spec,
    stock: product.stock,
    enabled: product.enabled
  }));

  return {
    orders,
    products,
    stats,
    statuses: ORDER_STATUS,
    apiVersion: API_VERSION,
    health: getSystemHealth_()
  };
}

function verifyLineIdentity_(idToken, accessToken) {
  const errors = [];
  const channelId = String(PropertiesService.getScriptProperties().getProperty('LINE_LOGIN_CHANNEL_ID') || '').trim();

  if (idToken && channelId) {
    try {
      const response = UrlFetchApp.fetch('https://api.line.me/oauth2/v2.1/verify', {
        method: 'post',
        contentType: 'application/x-www-form-urlencoded',
        payload: { id_token: idToken, client_id: channelId },
        muteHttpExceptions: true
      });
      if (response.getResponseCode() === 200) {
        const data = JSON.parse(response.getContentText());
        if (data.sub) return { userId: String(data.sub), name: String(data.name || '') };
      }
      errors.push(`ID Token HTTP ${response.getResponseCode()}`);
    } catch (error) {
      errors.push(`ID Token ${String(error.message || error)}`);
    }
  } else {
    if (!idToken) errors.push('前端未取得 ID Token');
    if (!channelId) errors.push('未設定 LINE_LOGIN_CHANNEL_ID');
  }

  if (accessToken) {
    try {
      const response = UrlFetchApp.fetch('https://api.line.me/v2/profile', {
        method: 'get',
        headers: { Authorization: `Bearer ${accessToken}` },
        muteHttpExceptions: true
      });
      if (response.getResponseCode() === 200) {
        const data = JSON.parse(response.getContentText());
        if (data.userId) return { userId: String(data.userId), name: String(data.displayName || '') };
      }
      errors.push(`Access Token HTTP ${response.getResponseCode()}`);
    } catch (error) {
      errors.push(`Access Token ${String(error.message || error)}`);
    }
  } else {
    errors.push('前端未取得 Access Token');
  }

  console.warn(`LINE 身分驗證失敗：${errors.join('；')}`);
  throw appError_('LINE 身分驗證失敗。請關閉此頁後，從 LINE 官方帳號重新進入。', 'LINE_AUTH_FAILED');
}

function createSignedSession_(kind, claims, ttlSeconds) {
  const now = Math.floor(Date.now() / 1000);
  const payload = Object.assign({}, claims, {
    kind,
    iat: now,
    exp: now + ttlSeconds,
    nonce: Utilities.getUuid().replace(/-/g, '')
  });
  const payloadPart = Utilities.base64EncodeWebSafe(JSON.stringify(payload), Utilities.Charset.UTF_8).replace(/=+$/g, '');
  const signature = signValue_(payloadPart);
  return `${payloadPart}.${signature}`;
}

function verifySignedSession_(token, expectedKind) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2) throw appError_('登入狀態已失效，請重新登入。', 'SESSION_INVALID');
  const expected = signValue_(parts[0]);
  if (!constantTimeStringEqual_(parts[1], expected)) throw appError_('登入驗證失敗，請重新登入。', 'SESSION_INVALID');

  let payload;
  try {
    const paddedPayload = parts[0] + '='.repeat((4 - parts[0].length % 4) % 4);
    payload = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(paddedPayload)).getDataAsString('UTF-8'));
  } catch (_) {
    throw appError_('登入資料無法解析，請重新登入。', 'SESSION_INVALID');
  }
  if (payload.kind !== expectedKind || Number(payload.exp || 0) <= Math.floor(Date.now() / 1000)) {
    throw appError_('登入狀態已逾期，請重新登入。', 'SESSION_EXPIRED');
  }
  return payload;
}

function requireLineSession_(token) {
  const session = verifySignedSession_(token, 'line');
  if (!session.userId) throw appError_('LINE 登入資料不完整。', 'SESSION_INVALID');
  return session;
}

function requireAdminSession_(token) {
  const session = verifySignedSession_(token, 'admin');
  if (session.role !== 'admin') throw appError_('管理員權限驗證失敗。', 'FORBIDDEN');
  if (String(session.authVersion || '') !== getAdminAuthVersion_()) throw appError_('登入已失效，請使用目前密碼重新登入。', 'ADMIN_SESSION_REVOKED');
  return session;
}

function signValue_(value) {
  const secret = String(PropertiesService.getScriptProperties().getProperty('CF_GATEWAY_SECRET') || '');
  if (secret.length < 24) throw appError_('後端尚未完成安全金鑰設定。', 'GATEWAY_NOT_CONFIGURED');
  const bytes = Utilities.computeHmacSha256Signature(String(value), secret, Utilities.Charset.UTF_8);
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/g, '');
}

function constantTimeStringEqual_(a, b) {
  a = String(a || '');
  b = String(b || '');
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function aggregateRequestedItems_(items) {
  if (!Array.isArray(items) || !items.length) throw appError_('請至少選擇一項商品。', 'NO_ITEMS');
  const result = {};
  items.forEach(item => {
    const productId = cleanText_(item && item.productId, 30);
    const qty = Number(item && item.qty);
    if (!productId || !Number.isInteger(qty) || qty < 0 || qty > 99) throw appError_('商品數量不正確。', 'INVALID_QUANTITY');
    if (!qty) return;
    result[productId] = Number(result[productId] || 0) + qty;
    if (result[productId] > 99) throw appError_('單一商品數量不可超過 99 包。', 'INVALID_QUANTITY');
  });
  if (!Object.keys(result).length) throw appError_('請至少選購 1 包商品。', 'NO_ITEMS');
  return result;
}

function isBankReady_(settings) {
  const bankName = cleanText_(settings['銀行名稱'], 60);
  const bankCode = String(settings['銀行代碼'] || '').replace(/\D/g, '');
  const account = String(settings['轉帳帳號'] || '').replace(/\D/g, '');
  const accountName = cleanText_(settings['戶名'], 60);
  const placeholders = ['請填寫', '未設定', '尚未設定'];
  return bankName && !placeholders.includes(bankName) && /^\d{3}$/.test(bankCode) && /^\d{7,20}$/.test(account) && accountName && !placeholders.includes(accountName);
}

function getBankDetails_(settings) {
  if (!isBankReady_(settings)) throw appError_('商家尚未完成轉帳資料設定。', 'BANK_NOT_READY');
  return {
    bankName: cleanText_(settings['銀行名稱'], 60),
    bankCode: String(settings['銀行代碼'] || '').replace(/\D/g, ''),
    account: String(settings['轉帳帳號'] || '').replace(/\D/g, ''),
    accountName: cleanText_(settings['戶名'], 60)
  };
}

function buildShipmentFlex_(data) {
  const account = String(data.lineOfficialId || '').replace('@', '%40');
  return {
    type: 'flex',
    altText: `訂單 ${data.orderNo} 已完成出貨`,
    contents: {
      type: 'bubble', size: 'kilo',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: '#6C4736', paddingAll: '18px',
        contents: [
          { type: 'text', text: String(data.merchantName || '六合牛軋糖'), color: '#FFFFFF', size: 'lg', weight: 'bold' },
          { type: 'text', text: '您的商品已完成出貨', color: '#F7EBDD', size: 'sm', margin: 'sm' }
        ]
      },
      body: {
        type: 'box', layout: 'vertical', paddingAll: '18px', spacing: 'md',
        contents: [
          flexRow_('訂單編號', data.orderNo, true),
          flexRow_('配送方式', data.delivery, false),
          flexRow_('訂單金額', `NT$ ${Number(data.total || 0).toLocaleString('zh-TW')}`, false),
          flexRow_('出貨時間', formatDateTime_(data.shippedAt) || '已出貨', false),
          ...(data.trackingNo ? [flexRow_('物流單號', data.trackingNo, false)] : []),
          { type: 'separator', margin: 'lg' },
          { type: 'text', text: '請留意物流及到貨通知，感謝您的訂購。', size: 'sm', color: '#6F625A', wrap: true, margin: 'lg' }
        ]
      },
      footer: {
        type: 'box', layout: 'vertical', paddingAll: '14px',
        contents: [{
          type: 'button', style: 'primary', color: '#B87954',
          action: { type: 'uri', label: '聯繫客服', uri: `https://line.me/R/ti/p/${account}` }
        }]
      }
    }
  };
}

function flexRow_(label, value, bold) {
  return {
    type: 'box', layout: 'horizontal',
    contents: [
      { type: 'text', text: label, size: 'sm', color: '#8A7465', flex: 3 },
      { type: 'text', text: String(value || ''), size: 'sm', color: '#3E2F28', weight: bold ? 'bold' : 'regular', align: 'end', flex: 5, wrap: true }
    ]
  };
}

function getOrderItemSummaryMap_(ss, orderNos) {
  const sheet = ss.getSheetByName(SHEETS.ITEMS);
  if (!sheet || sheet.getLastRow() < 2) return {};
  const allowed = orderNos && orderNos.length ? new Set(orderNos) : null;
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, ITEM_HEADERS.length).getValues();
  const map = {};
  rows.forEach(row => {
    const orderNo = String(row[0] || '');
    if (!orderNo || (allowed && !allowed.has(orderNo))) return;
    const text = `${String(row[2] || '')} ${Number(row[5] || 0)}包`;
    map[orderNo] = map[orderNo] ? `${map[orderNo]}、${text}` : text;
  });
  return map;
}

function getProducts_() {
  const sheet = getSpreadsheet_().getSheetByName(SHEETS.PRODUCTS);
  if (!sheet || sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, PRODUCT_HEADERS.length)
    .getValues()
    .map((row, index) => ({ rowData: row, sheetRow: index + 2 }))
    .filter(item => item.rowData[0])
    .map(item => {
      const row = item.rowData;
      return {
        row: item.sheetRow,
        id: String(row[0] || ''),
        name: String(row[1] || ''),
        spec: String(row[2] || ''),
        price: Number(row[3] || 0),
        bundlePrice: Number(row[4] || 0),
        initialStock: Number(row[5] || 0),
        stock: Math.max(0, Number(row[6] || 0)),
        enabled: String(row[7] || '') === '上架',
        imageUrl: String(row[8] || ''),
        sort: Number(row[9] || 999)
      };
    })
    .sort((a, b) => a.sort - b.sort);
}

function getSettings_() {
  const sheet = getSpreadsheet_().getSheetByName(SHEETS.SETTINGS);
  if (!sheet || sheet.getLastRow() < 2) return {};
  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues();
  return Object.fromEntries(values.filter(row => row[0]).map(row => [String(row[0]), row[1]]));
}

function restoreInventoryForOrder_(ss, orderNo) {
  const itemSheet = ss.getSheetByName(SHEETS.ITEMS);
  const productSheet = ss.getSheetByName(SHEETS.PRODUCTS);
  const items = itemSheet.getDataRange().getValues().slice(1)
    .filter(row => String(row[0]) === orderNo)
    .map(row => ({ productId: String(row[1]), qty: Number(row[5] || 0) }));
  const productValues = productSheet.getRange(2, 1, Math.max(productSheet.getLastRow() - 1, 0), PRODUCT_HEADERS.length).getValues();
  const rowMap = {};
  productValues.forEach((row, index) => { rowMap[String(row[0])] = index + 2; });
  items.forEach(item => {
    const row = rowMap[item.productId];
    if (!row) return;
    const cell = productSheet.getRange(row, 7);
    cell.setValue(Number(cell.getValue()) + item.qty);
  });
}

function orderResultFromRow_(row, duplicate, settings) {
  const orderNo = String(row[1] || '');
  const itemMap = getOrderItemSummaryMap_(getSpreadsheet_(), [orderNo]);
  const quantities = String(itemMap[orderNo] || '').match(/(\d+)包/g) || [];
  const totalQty = quantities.reduce((sum, value) => sum + Number(value.replace('包', '')), 0);
  const payment = String(row[8] || '');
  return {
    orderNo,
    status: String(row[2] || ''),
    totalQty,
    subtotal: Number(row[9] || 0),
    shippingFee: Number(row[10] || 0),
    total: Number(row[11] || 0),
    delivery: String(row[7] || ''),
    payment,
    lineConnected: Boolean(row[6]),
    successMessage: String(settings['訂單成立訊息'] || '訂單已成功送出。'),
    bank: payment === '轉帳付款' && isBankReady_(settings) ? getBankDetails_(settings) : null,
    duplicate: Boolean(duplicate)
  };
}

function nextOrderNumber_(date) {
  const dateKey = Utilities.formatDate(date, 'Asia/Taipei', 'yyyyMMdd');
  const props = PropertiesService.getScriptProperties();
  const key = `ORDER_COUNTER_${dateKey}`;
  const next = Number(props.getProperty(key) || 0) + 1;
  props.setProperty(key, String(next));
  return `LH-${dateKey}-${String(next).padStart(4, '0')}`;
}

function checkAdminPin_(pin) {
  const expected = PropertiesService.getScriptProperties().getProperty('ADMIN_PIN');
  if (!expected) throw appError_('尚未設定管理後台密碼 ADMIN_PIN。', 'ADMIN_NOT_CONFIGURED');
  if (String(pin || '') !== String(expected)) throw appError_('管理密碼錯誤。', 'ADMIN_LOGIN_FAILED');
}

function findOrderRow_(sheet, orderNo) {
  if (sheet.getLastRow() < 2) return 0;
  const finder = sheet.getRange(2, 2, sheet.getLastRow() - 1, 1)
    .createTextFinder(String(orderNo)).matchEntireCell(true).findNext();
  return finder ? finder.getRow() : 0;
}

function findOrderByRequestId_(sheet, requestId) {
  if (sheet.getLastRow() < 2) return 0;
  const finder = sheet.getRange(2, 24, sheet.getLastRow() - 1, 1)
    .createTextFinder(String(requestId)).matchEntireCell(true).findNext();
  return finder ? finder.getRow() : 0;
}

function ensureSheetSchema_(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  if (sheet.getMaxColumns() < headers.length) sheet.insertColumnsAfter(sheet.getMaxColumns(), headers.length - sheet.getMaxColumns());

  if (sheet.getLastRow() === 0 || !sheet.getRange(1, 1).getValue()) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  } else {
    const existing = sheet.getRange(1, 1, 1, Math.min(sheet.getLastColumn(), headers.length)).getValues()[0];
    for (let i = 0; i < existing.length; i++) {
      if (String(existing[i] || '') && String(existing[i]) !== String(headers[i] || '')) {
        throw appError_(`${name} 第 ${i + 1} 欄應為「${headers[i]}」，目前是「${existing[i]}」。為避免資料錯位，系統已停止升級。`, 'SCHEMA_MISMATCH');
      }
    }
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
  styleHeader_(sheet, headers.length);
  return sheet;
}

function validateSheetSchema_(ss, name, headers) {
  const sheet = ss.getSheetByName(name);
  if (!sheet) throw appError_(`缺少工作表「${name}」。`, 'SCHEMA_MISSING');
  const existing = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
  headers.forEach((header, index) => {
    if (String(existing[index] || '') !== header) throw appError_(`${name} 第 ${index + 1} 欄標題不正確。`, 'SCHEMA_MISMATCH');
  });
}

function upsertSettings_(sheet, defaults) {
  const existing = {};
  if (sheet.getLastRow() >= 2) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues()
      .forEach((row, index) => { if (row[0]) existing[String(row[0])] = index + 2; });
  }
  defaults.forEach(item => {
    if (existing[item[0]]) {
      if (item[0] === '系統版本') sheet.getRange(existing[item[0]], 2).setValue(API_VERSION);
    } else {
      sheet.appendRow(item);
    }
  });
  sheet.autoResizeColumns(1, SETTINGS_HEADERS.length);
}

function upsertProducts_(sheet, defaults) {
  const existing = {};
  if (sheet.getLastRow() >= 2) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues()
      .forEach((row, index) => { if (row[0]) existing[String(row[0])] = index + 2; });
  }
  defaults.forEach(item => { if (!existing[item[0]]) sheet.appendRow(item); });
  sheet.autoResizeColumns(1, PRODUCT_HEADERS.length);
}

function styleHeader_(sheet, columns) {
  sheet.getRange(1, 1, 1, columns)
    .setFontWeight('bold')
    .setBackground('#6C4736')
    .setFontColor('#FFFFFF')
    .setHorizontalAlignment('center');
}

function log_(ss, action, orderNo, content) {
  ss.getSheetByName(SHEETS.LOGS).appendRow([new Date(), action, orderNo || '', content || '']);
}

function getSpreadsheet_() {
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (id) return SpreadsheetApp.openById(id);
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (!active) throw appError_('找不到 Google 試算表。請設定 SPREADSHEET_ID。', 'SPREADSHEET_NOT_FOUND');
  return active;
}

function assertSystemReady_() {
  if (PropertiesService.getScriptProperties().getProperty('SYSTEM_READY') !== 'true') {
    throw appError_('系統尚未初始化，請先執行 setupSystem()。', 'SYSTEM_NOT_READY');
  }
}

function assertGatewaySecret_(provided) {
  const expected = PropertiesService.getScriptProperties().getProperty('CF_GATEWAY_SECRET');
  if (!expected || String(expected).length < 24) throw appError_('後端尚未設定 CF_GATEWAY_SECRET。', 'GATEWAY_NOT_CONFIGURED');
  if (!constantTimeStringEqual_(provided, expected)) throw appError_('Cloudflare 閘道驗證失敗。', 'GATEWAY_AUTH_FAILED');
}

function parseRequest_(e) {
  const raw = e && e.postData && e.postData.contents ? e.postData.contents : '';
  if (!raw) throw appError_('API 請求內容為空。', 'EMPTY_REQUEST');
  let parsed;
  try { parsed = JSON.parse(raw); } catch (_) { throw appError_('API JSON 格式錯誤。', 'INVALID_JSON'); }
  if (!parsed || typeof parsed !== 'object') throw appError_('API 請求格式錯誤。', 'INVALID_REQUEST');
  return parsed;
}

function jsonResponse_(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}

function appError_(message, code) {
  const error = new Error(message);
  error.code = code || 'APP_ERROR';
  return error;
}

function cleanText_(value, maxLength) {
  return String(value == null ? '' : value).replace(/[<>]/g, '').trim().slice(0, maxLength);
}

function normalizePhone_(value) {
  return String(value || '').replace(/\D/g, '').slice(0, 10);
}

function positiveNumber_(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw appError_(`${label}設定不正確。`, 'INVALID_SETTING');
  return Math.round(number);
}

function nonNegativeNumber_(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw appError_(`${label}設定不正確。`, 'INVALID_SETTING');
  return Math.round(number);
}

function formatDateTime_(value) {
  if (!(value instanceof Date) || isNaN(value.getTime())) return '';
  return Utilities.formatDate(value, 'Asia/Taipei', 'yyyy-MM-dd HH:mm');
}

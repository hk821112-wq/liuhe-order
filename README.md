# 六合牛軋糖｜LINE 動畫下單站

手機優先的靜態前端，可部署至 GitHub Pages。瀏覽器只呼叫 Cloudflare Worker；Worker 注入私密金鑰後再轉送至 Google Apps Script。

## 架構

```text
GitHub Pages + LINE LIFF
          ↓
Cloudflare Worker（保存 CF_GATEWAY_SECRET）
          ↓
Google Apps Script Web App
          ↓
Google 試算表
```

## 1. 前端設定

編輯 `config.js`：

```js
window.APP_CONFIG = {
  API_BASE_URL: 'https://你的-worker.workers.dev',
  LIFF_ID: '你的 LIFF ID'
};
```

把 `outputs/order-app` 內容放入 GitHub repository，於 Settings → Pages 選擇由 branch 發布。

## 2. Cloudflare Worker

進入 `worker/`：

```bash
npx wrangler secret put GAS_WEB_APP_URL
npx wrangler secret put CF_GATEWAY_SECRET
npx wrangler deploy
```

`ALLOWED_ORIGIN` 請在 `worker/wrangler.toml` 改成實際 GitHub Pages 網址。

## 3. GAS

使用附件中的 GAS 5.1.0 程式，設定 Script Properties：

- `SPREADSHEET_ID`
- `CF_GATEWAY_SECRET`（必須與 Worker secret 相同）
- `LINE_LOGIN_CHANNEL_ID`
- `ADMIN_PIN`
- `LINE_CHANNEL_ACCESS_TOKEN`（需要出貨通知時）

執行 `setupSystem()`，再部署為 Web App：執行身分選擇自己，存取權選擇任何人。

## 4. LINE Developers

建立 LINE Login channel 與 LIFF App，Endpoint URL 填 GitHub Pages 完整網址。Scope 至少開啟 `profile` 與 `openid`。

## 本機預覽

LIFF 登入需要在已登記的 HTTPS Endpoint 執行；純本機可先檢視版面：

```bash
python -m http.server 4173
```

## 注意

- `CF_GATEWAY_SECRET` 絕不可寫入 `config.js` 或提交 GitHub。
- 正式 7-11 電子地圖需另接物流商／電子地圖回傳流程；目前畫面提供門市資料欄位，後端仍會驗證必要欄位。
- 商品、價格、庫存均由 GAS `publicConfig` 取得；前端顯示金額不作為後端計價依據。

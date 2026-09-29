/**
 * 后端连接配置。
 *
 * ⚠️ 为什么需要手填而不是自动发现：
 *   控制台（Web）能拿到令牌，是因为服务端在 `/` 路由把 `window.__AUTH_TOKEN__`
 *   注入进了 HTML —— 那是**同源**页面才有的待遇。小程序不是同源页面，
 *   拿不到这个全局变量，所以只能由用户在「连接后端」页手工粘贴一次，
 *   之后存进本机 Storage，后续所有请求自动带上。
 *
 * 令牌在哪：部署后端的机器上，文件 `data/.auth_token`（48 位十六进制）。
 *   后端启动时会打印提示；控制台侧栏底部也能看到后端地址。
 *
 * 关于鉴权何时才需要：
 *   仅当后端 `HOST` 不是回环地址（例如用 `start_lan.bat` 起的 `0.0.0.0`）时，
 *   鉴权才会开启。这种情况**必然**发生 —— 手机/小程序要连后端，后端就得监听局域网。
 *   所以：小程序场景下，写接口**一定**需要令牌；
 *   另有两个 GET 也带真实副作用（见 request.js 的 SIDE_EFFECT_GET_PATHS），同样要令牌。
 *   统一「所有请求都带令牌」是最省心的做法，本文件即按此实现。
 */

const STORAGE_KEY_BASE = 'ow_base_url';
const STORAGE_KEY_TOKEN = 'ow_auth_token';

// 默认后端地址：留空表示「还没配过」，首次进入会引导到「连接后端」页。
// 本机常见值形如 http://10.10.45.157:4400（用 start_lan.bat 启动时会把地址打印出来）。
const DEFAULT_BASE_URL = '';

/**
 * 规范化用户输入的后端地址：
 *   - 补齐协议（只填 IP:端口 时补 http://）
 *   - 去掉尾部斜杠（否则拼出 //api/ping）
 *   - 去掉末尾多余的 / 路径
 */
function normalizeBaseUrl(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  s = s.replace(/\/+$/, '');
  return s;
}

function getBaseUrl() {
  const saved = wx.getStorageSync(STORAGE_KEY_BASE);
  return normalizeBaseUrl(saved || DEFAULT_BASE_URL);
}

function setBaseUrl(url) {
  const v = normalizeBaseUrl(url);
  wx.setStorageSync(STORAGE_KEY_BASE, v);
  return v;
}

function getToken() {
  return String(wx.getStorageSync(STORAGE_KEY_TOKEN) || '').trim();
}

function setToken(t) {
  const v = String(t || '').trim();
  wx.setStorageSync(STORAGE_KEY_TOKEN, v);
  return v;
}

function clearAll() {
  wx.removeStorageSync(STORAGE_KEY_BASE);
  wx.removeStorageSync(STORAGE_KEY_TOKEN);
}

function isConfigured() {
  return !!getBaseUrl();
}

/**
 * 把用户从后端看到的提示语翻译成可操作的话。
 * 之所以单独一个函数：小程序端最容易卡住的不是代码而是「地址/令牌填错」，
 * 报错必须直接说清下一步做什么，而不是抛一个 -1。
 */
function describeError(err) {
  const msg = String((err && (err.errMsg || err.message)) || err || '');
  if (/url not in domain list/i.test(msg)) {
    return '域名校验未通过：请在微信开发者工具「详情 → 本地设置」勾选「不校验合法域名」，真机请在微信后台配置合法域名（需 HTTPS）。';
  }
  if (/request:fail timeout/i.test(msg)) {
    return '连接超时：确认后端已启动、手机与电脑在同一 Wi-Fi、地址里的 IP 填的是电脑的局域网 IP。';
  }
  if (/request:fail/i.test(msg)) {
    return '连不上后端：检查地址是否正确（含 http:// 与端口 4400），以及后端是否正在运行。';
  }
  return msg || '未知错误';
}

module.exports = {
  STORAGE_KEY_BASE,
  STORAGE_KEY_TOKEN,
  DEFAULT_BASE_URL,
  normalizeBaseUrl,
  getBaseUrl,
  setBaseUrl,
  getToken,
  setToken,
  clearAll,
  isConfigured,
  describeError,
};

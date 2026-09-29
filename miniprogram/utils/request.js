/**
 * wx.request 的 Promise 封装。
 *
 * 设计要点（都是为了对齐后端真实行为，不是通用模板）：
 *
 * 1. **所有请求都带 X-Auth-Token。**
 *    后端 `isAuthEnabled(HOST)` 在非回环地址下开启鉴权，而小程序连的必然是局域网地址。
 *    更关键的是：后端把两个 **GET** 也列进了副作用清单
 *    （`SIDE_EFFECT_GET_PATHS = ['/api/auto-reply/run', '/api/apply/record']`），
 *    它们会真的发消息。所以「GET 就不带令牌」这种省事写法会 401。
 *    统一带令牌，让规则只有一条。
 *
 * 2. **不吞错，但也不让调用方直接面对 wx 的原始错误串。**
 *    抛出的 Error 带 `statusCode` / `data` / `friendly`，页面按需展示。
 *
 * 3. **401 单独识别**，因为它的解法是「去连接页填令牌」而不是「重试」。
 *    识别后自动跳转连接页，避免用户对着「投递失败」发呆。
 *
 * 4. **超时给足。** 后端有些接口很慢：全量平台健康探测约 12.7s、
 *    登录态检查有 8s 护栏、批量投递会流式跑很久。默认 30s，
 *    流式/长任务接口由调用方自行传更大的 timeout。
 */

const config = require('./config.js');

const DEFAULT_TIMEOUT = 30000;
const CONNECT_PAGE = '/pages/connect/connect';

// 与后端 server/services/authToken.ts 的 SIDE_EFFECT_GET_PATHS 保持同步。
// 这里再列一遍不是为了校验（服务端才是真相源），而是为了让「哪些 GET 不能被缓存/重试」
// 在小程序侧也是显式的，避免以后有人给 GET 加缓存时误伤。
const SIDE_EFFECT_GET_PATHS = ['/api/auto-reply/run', '/api/apply/record'];

let redirectingToConnect = false;

function buildHeaders(extra) {
  const h = Object.assign({ 'Content-Type': 'application/json' }, extra || {});
  const token = config.getToken();
  if (token) h['X-Auth-Token'] = token;
  return h;
}

/**
 * @param {object} opts
 * @param {string} opts.url            以 / 开头的后端路径，如 /api/ping
 * @param {string} [opts.method]       GET/POST/PUT/PATCH/DELETE，默认 GET
 * @param {object} [opts.data]         body 或 query（GET 时自动转 query）
 * @param {object} [opts.header]       额外请求头
 * @param {number} [opts.timeout]
 * @param {boolean} [opts.silent]      true 时不自动跳转连接页（用于连接页自身的探活）
 * @returns {Promise<any>} resolve 服务端返回的 JSON（或原始 data）
 */
function request(opts) {
  const method = String(opts.method || 'GET').toUpperCase();
  const base = config.getBaseUrl();
  const path = String(opts.url || '');

  return new Promise((resolve, reject) => {
    if (!base) {
      const err = new Error('尚未配置后端地址');
      err.code = 'NO_BASE_URL';
      err.friendly = '请先在「连接后端」页填写后端地址。';
      reject(err);
      return;
    }

    const url = base + path;
    const isBodyless = method === 'GET' || method === 'HEAD';

    // 🔴 GET 的 query 必须**拼进 URL**，不能交给 `data` —— 实测（开发者工具 3.17.3）：
    //   data: 'limit=200&level=ERROR'  → 后端收到 total=32（参数被整个丢掉，筛选失效）
    //   data: { limit: 200, level: 'ERROR' } → 后端收到 total=1（正确）
    //   即：`wx.request` 对 GET 只认**对象**形式的 data；给**字符串**时它不拼 URL 也不报错。
    //   原先这里把 data 序列化成字符串再传，导致日志页的级别/日期/关键词筛选、看板的 days
    //   全部静默失效 —— 页面照常渲染，只是筛了个寂寞（最危险的一类 bug）。
    //   所以统一自己拼，两条路径（对象/字符串）都归一到 URL 上。
    const query = method === 'GET' ? serializeQuery(opts.data) : '';
    const fullUrl = query ? (url + (url.indexOf('?') >= 0 ? '&' : '?') + query) : url;

    wx.request({
      url: fullUrl,
      method,
      // 非 GET 才用 body；GET 的 query 已经拼进 URL，这里必须留空否则又会覆盖
      data: isBodyless ? undefined : opts.data,
      header: buildHeaders(opts.header),
      timeout: opts.timeout || DEFAULT_TIMEOUT,
      dataType: 'json',
      success(res) {
        const { statusCode, data } = res;

        if (statusCode >= 200 && statusCode < 300) {
          resolve(data);
          return;
        }

        const err = new Error(extractError(data) || ('HTTP ' + statusCode));
        err.statusCode = statusCode;
        err.data = data;

        if (statusCode === 401) {
          err.friendly = '后端开启了访问令牌鉴权，当前令牌缺失或无效。请在「连接后端」页粘贴 data/.auth_token 的内容。';
          if (!opts.silent) maybeGoConnect();
        } else if (statusCode === 403) {
          // 后端来源守卫拦下的跨站请求。小程序正常不会触发，出现即说明有中间层
          // （代理/网关）改写了请求头；直接把后端原话给用户。
          err.friendly = extractError(data) || '请求被后端来源守卫拒绝（403）。';
        } else {
          err.friendly = extractError(data) || ('后端返回 ' + statusCode);
        }
        reject(err);
      },
      fail(e) {
        const err = new Error((e && e.errMsg) || 'request:fail');
        err.code = 'NETWORK';
        err.friendly = config.describeError(e);
        reject(err);
      },
    });
  });
}

/**
 * 把对象序列化成 query 串（支持数组展开、跳过空值）。
 * 结果由调用方拼进 URL —— **不要**交给 `wx.request` 的 `data`（见上面的实测说明）。
 */
function serializeQuery(data) {
  if (!data || typeof data !== 'object') return data || '';
  const parts = [];
  Object.keys(data).forEach((k) => {
    const v = data[k];
    if (v === undefined || v === null || v === '') return;
    if (Array.isArray(v)) {
      v.forEach((item) => parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(item)));
    } else {
      parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
    }
  });
  return parts.join('&');
}

/** 后端错误体统一是 { error: '...' }，但少数是 { error: { message } }，都兜一下。 */
function extractError(data) {
  if (!data) return '';
  if (typeof data === 'string') return data;
  const e = data.error || data.message;
  if (!e) return '';
  if (typeof e === 'string') return e;
  return e.message || JSON.stringify(e);
}

function maybeGoConnect() {
  if (redirectingToConnect) return;
  const pages = getCurrentPages();
  const cur = pages.length ? pages[pages.length - 1].route : '';
  if (cur === 'pages/connect/connect') return;
  redirectingToConnect = true;
  wx.navigateTo({
    url: CONNECT_PAGE,
    complete() {
      setTimeout(() => { redirectingToConnect = false; }, 800);
    },
  });
}

// ── 便捷方法 ────────────────────────────────────────────────────────────────
const get = (url, data, opts) => request(Object.assign({ url, method: 'GET', data }, opts));
const post = (url, data, opts) => request(Object.assign({ url, method: 'POST', data }, opts));
const put = (url, data, opts) => request(Object.assign({ url, method: 'PUT', data }, opts));
const patch = (url, data, opts) => request(Object.assign({ url, method: 'PATCH', data }, opts));
const del = (url, data, opts) => request(Object.assign({ url, method: 'DELETE', data }, opts));

/** 给页面用的统一错误 toast：优先说人话（friendly），其次原始信息。 */
function toastError(err, fallback) {
  const msg = (err && (err.friendly || err.message)) || fallback || '操作失败';
  wx.showToast({ title: msg.length > 60 ? msg.slice(0, 58) + '…' : msg, icon: 'none', duration: 3000 });
}

module.exports = {
  request,
  get,
  post,
  put,
  patch,
  del,
  toastError,
  SIDE_EFFECT_GET_PATHS,
};

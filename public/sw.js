/* OfferWhere PWA Service Worker —— 刻意做成「极简 + 不缓存 API」。
 *
 * 设计取舍（每一条都是刻意的，改动前请先读）：
 *
 * 1) **不缓存任何 /api/ 响应**。
 *    这个应用的手机端与桌面端连的是**同一个后端、同一份 SQLite**。
 *    一旦 SW 给 API 做 stale-while-revalidate，手机上看到的投递记录就会是
 *    「上一次打开时」的旧数据 —— 双端互通的语义当场碎掉。
 *    HTTP 层本来就没有为 API 配任何 Cache-Control，网络直连即最新。
 *
 * 2) **不预缓存任何页面资源**（没有 precache 清单）。
 *    控制台是单文件 console.html，且后端是本地常驻进程 —— 离线缓存的收益近乎为零，
 *    但代价很大：改了 console.html 之后用户手机上还跑着旧副本，
 *    而这是本项目最常见的迭代形态（「改了页面没生效」）。
 *    保持 passthrough，刷新即最新，永不需要「清理缓存」。
 *
 * 3) SW 存在的唯一理由是**满足 PWA 可安装性**（Chrome 要求有 fetch handler 的 SW）。
 *    所以 fetch 监听器只做一件事：让请求原样走网络。
 *
 * 注意：Service Worker 只在**安全上下文**（https / localhost）注册。
 * 通过 http://<局域网IP>:4400 访问时浏览器会直接拒绝注册 —— 此时
 * manifest 依然生效（可添加到主屏幕、全屏运行），只是没有 SW。
 * 这是浏览器的硬规则，不是本文件的 bug。
 */

self.addEventListener('install', (event) => {
  // 立刻接管，不等待旧 SW 的客户端关闭
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // 清掉历史版本可能留下的缓存（本文件从不写入缓存，这里纯属兜底）
    try {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith('offerwhere-')).map((k) => caches.delete(k)));
    } catch (_) { /* 缓存 API 不可用时忽略 */ }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // 只处理同源 GET；其余（POST 投递、SSE 流、跨域）一律不拦截。
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (_) { return; }
  if (url.origin !== self.location.origin) return;

  // 明确兜一层：即使将来有人误加缓存逻辑，API 也必须直连网络。
  if (url.pathname.startsWith('/api/')) return;

  // 其余资源：passthrough，交给浏览器 HTTP 缓存。不调用 respondWith 即为直连。
});

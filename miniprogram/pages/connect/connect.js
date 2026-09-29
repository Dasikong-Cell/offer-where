/**
 * 「连接后端」页 —— 整个小程序的入口前置。
 *
 * 为什么它是第一优先级页面：
 *   小程序的每一页都依赖后端，而小程序**不可能**自动发现后端地址与访问令牌
 *   （令牌在服务端 `data/.auth_token` 里，只对同源页面注入）。
 *   所以必须有一个地方让用户一次性填好，这里的体验直接决定小程序能不能用起来。
 *
 * 交互设计：
 *   - 地址输入框支持「只填 IP:端口」，会自动补 http://（后端用户常见写法）
 *   - 点「测试连接」→ 调 /api/ping 探活 → 成功后顺势拉 /api/version 与 /api/lan
 *   - /api/lan 若返回本机网卡地址，直接渲染成可点列表，省掉手打 IP
 *   - 令牌一栏给出「在哪找」的原话（data/.auth_token），因为这是最卡人的一步
 */

const config = require('../../utils/config.js');
const req = require('../../utils/request.js');

Page({
  data: {
    baseUrl: '',
    token: '',
    tokenVisible: false,
    testing: false,
    /** null=还没测过；{ok:true,...} 或 {ok:false,error} */
    result: null,
    lanUrls: [],
    version: null,
  },

  onLoad() {
    this.setData({
      baseUrl: config.getBaseUrl(),
      token: config.getToken(),
    });
  },

  onShow() {
    // 每次进入都同步一次（用户可能从别处改了 Storage）
    this.setData({
      baseUrl: config.getBaseUrl(),
      token: config.getToken(),
    });
    // 已配置过就直接探一次，省去用户手点
    if (config.getBaseUrl()) this.test();
  },

  onUrlInput(e) {
    this.setData({ baseUrl: e.detail.value });
  },

  onTokenInput(e) {
    this.setData({ token: e.detail.value });
  },

  toggleTokenVisible() {
    this.setData({ tokenVisible: !this.data.tokenVisible });
  },

  /** 清空所有本地配置（换后端时用） */
  onReset() {
    wx.showModal({
      title: '清除连接配置',
      content: '将清空已保存的后端地址与访问令牌，需要重新填写。',
      success: (r) => {
        if (!r.confirm) return;
        config.clearAll();
        this.setData({ baseUrl: '', token: '', result: null, lanUrls: [], version: null });
        wx.showToast({ title: '已清除', icon: 'none' });
      },
    });
  },

  /** 把 /api/lan 返回的某个地址填进输入框 */
  onPickLanUrl(e) {
    const url = e.currentTarget.dataset.url;
    this.setData({ baseUrl: url });
    wx.showToast({ title: '已填入，请点测试连接', icon: 'none' });
  },

  /**
   * 测试连接。
   * 顺序有讲究：先存后测 —— 因为 req.get 是从 Storage 读地址的，
   * 不先落盘就会用旧地址去测（这是很容易踩的坑，注释在此说明）。
   */
  async test() {
    const baseUrl = config.setBaseUrl(this.data.baseUrl);
    const token = config.setToken(this.data.token);

    if (!baseUrl) {
      this.setData({ result: { ok: false, error: '请先填写后端地址' } });
      return;
    }
    this.setData({ testing: true, result: null });

    try {
      const ping = await req.get('/api/ping', null, { timeout: 8000, silent: true });

      // 探活成功后再补两个「有了更好」的信息，任一失败都不影响连接判定
      let version = null;
      let lan = null;
      try {
        version = await req.get('/api/version', null, { timeout: 8000, silent: true });
      } catch (e) { /* 忽略 */ }
      try {
        lan = await req.get('/api/lan', null, { timeout: 8000, silent: true });
      } catch (e) { /* 忽略 */ }

      const app = getApp();
      app.globalData.serverInfo = { version, lan };

      this.setData({
        testing: false,
        version,
        lanUrls: (lan && lan.urls) || [],
        result: {
          ok: true,
          uptimeMs: ping && ping.uptimeMs,
          authEnabled: lan ? !!lan.authEnabled : null,
          exposed: lan ? !!lan.exposed : null,
          hint: (lan && lan.hint) || '',
          // 若鉴权开着但没填令牌，这里就要预警：否则用户后续写操作全 401，
          // 却以为是「功能坏了」。
          tokenMissing: !!(lan && lan.authEnabled && !token),
        },
      });
    } catch (err) {
      this.setData({
        testing: false,
        result: { ok: false, error: err.friendly || err.message || '连接失败', statusCode: err.statusCode },
      });
    }
  },

  goDashboard() {
    wx.switchTab({ url: '/pages/dashboard/dashboard' });
  },
});

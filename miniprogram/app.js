/**
 * 小程序入口。
 *
 * globalData 只放「跨页共享且不适合反复读 Storage」的少量状态，
 * 真正的配置读写仍以 utils/config.js 为准（它直接落到 Storage，避免双份真相）。
 */

const config = require('./utils/config.js');

App({
  globalData: {
    /** 最近一次成功探活拿到的后端信息：{ version, commit, lan } */
    serverInfo: null,
    /** 从 /api/lan 拿到的可用地址列表，供连接页做「一键填入」 */
    lanUrls: [],
    /** 系统信息，用于判断是否为小屏（决定部分布局） */
    sysInfo: null,
  },

  onLaunch() {
    try {
      this.globalData.sysInfo = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
    } catch (e) {
      this.globalData.sysInfo = null;
    }

    // 已配置过后端就直接静默探活一次；失败不打扰用户（各页面自己会提示）。
    if (config.isConfigured()) {
      this.ping().catch(() => {});
    }
  },

  /**
   * 探活。用 /api/ping 而不是 /api/health：
   * /api/ping 不碰数据库、不看 AI、不起浏览器，是最轻的一个，适合频繁调用。
   * @returns {Promise<{ok:boolean, uptimeMs:number}>}
   */
  ping() {
    const req = require('./utils/request.js');
    return req.get('/api/ping', null, { timeout: 8000, silent: true });
  },

  /**
   * 拉取后端地址信息（/api/lan）。返回体不含任何秘密，可安全展示。
   * @returns {Promise<{exposed:boolean, host:string, port:number, authEnabled:boolean, urls:string[], hint:string}>}
   */
  fetchLanInfo() {
    const req = require('./utils/request.js');
    return req.get('/api/lan', null, { timeout: 8000, silent: true }).then((r) => {
      this.globalData.lanUrls = (r && r.urls) || [];
      return r;
    });
  },
});

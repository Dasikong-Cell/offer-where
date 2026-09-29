/**
 * 简历中心。
 *
 * 数据源：GET /api/resume/current → { status, original:{exists,size,fileName,uploadedAt,url}, optimized:{...} }
 *
 * 为什么「预览 PDF」在小程序里做成「复制链接」而不是打开：
 *   后端 `GET /api/resume/file?version=original|optimized` 返回 `application/pdf`。
 *   小程序里打开 PDF 有两条路，都有硬约束：
 *     1. `wx.downloadFile` + `wx.openDocument` —— 需要把后端域名加进
 *        **downloadFile 合法域名**白名单（开发者工具里需勾「不校验合法域名」）；
 *     2. `web-view` —— 需要业务域名备案，个人/测试号根本用不了。
 *   对「用小程序看简历」这个低频需求，最稳的是给出链接让用户在电脑或手机浏览器打开。
 *   所以这里默认给复制链接，并把限制写在界面上，避免用户以为是功能缺失。
 *   等确认后端可被小程序访问后，再补 openDocument 路径（见 README 的待办）。
 */

const req = require('../../utils/request.js');
const config = require('../../utils/config.js');

Page({
  data: {
    loading: true,
    configured: true,
    error: '',
    status: null,
    original: null,
    optimized: null,
    copying: false,
  },

  onLoad() {
    this.refresh();
  },

  onShow() {
    if (!this.data.original && !this.data.loading) this.refresh();
  },

  onPullDownRefresh() {
    this.refresh(true).then(() => wx.stopPullDownRefresh());
  },

  async refresh(silent) {
    if (!config.isConfigured()) {
      this.setData({ loading: false, configured: false });
      return;
    }
    if (!silent) this.setData({ loading: true, configured: true, error: '' });

    try {
      const r = await req.get('/api/resume/current');
      this.setData({
        loading: false,
        status: r.status || null,
        original: decorate(r.original, '原始简历'),
        optimized: decorate(r.optimized, '优化简历'),
      });
    } catch (err) {
      this.setData({ loading: false, error: err.friendly || err.message });
    }
  },

  onVersionTap(e) {
    const v = e.currentTarget.dataset.version;
    const item = v === 'optimized' ? this.data.optimized : this.data.original;
    if (!item || !item.exists) {
      wx.showToast({ title: '该版本还不存在', icon: 'none' });
      return;
    }
    this.copyFileUrl(v);
  },

  copyFileUrl(version) {
    const base = config.getBaseUrl();
    if (!base) {
      wx.showToast({ title: '还没配置后端地址', icon: 'none' });
      return;
    }
    const url = base + '/api/resume/file?version=' + version;
    wx.setClipboardData({
      data: url,
      success: () => {
        wx.showToast({ title: '链接已复制，用浏览器打开', icon: 'none', duration: 2500 });
      },
    });
  },

  /**
   * 尝试用小程序原生方式打开 PDF。
   * 失败时不静默：把原因讲清楚（多半是合法域名没配），并保留复制链接这条退路。
   */
  openNative(e) {
    const version = e.currentTarget.dataset.version;
    const base = config.getBaseUrl();
    if (!base) return;

    const url = base + '/api/resume/file?version=' + version;
    wx.showLoading({ title: '下载中…' });
    wx.downloadFile({
      url,
      header: buildTokenHeader(),
      success(res) {
        wx.hideLoading();
        if (res.statusCode !== 200) {
          wx.showModal({
            title: '下载失败',
            content: '后端返回 ' + res.statusCode + '，可能是令牌无效或该版本不存在。',
            showCancel: false,
          });
          return;
        }
        wx.openDocument({
          filePath: res.tempFilePath,
          fileType: 'pdf',
          showMenu: true,
          fail(err) {
            wx.showModal({
              title: '打不开 PDF',
              content: '当前环境无法预览（' + ((err && err.errMsg) || '未知') + '）。可以先复制链接到浏览器打开。',
              showCancel: false,
            });
          },
        });
      },
      fail(err) {
        wx.hideLoading();
        wx.showModal({
          title: '下载失败',
          content: config.describeError(err) + '\n\n需要在微信后台把该地址加入 downloadFile 合法域名，或开发时勾选「不校验合法域名」。',
          showCancel: false,
        });
      },
    });
  },

  goConnect() {
    wx.navigateTo({ url: '/pages/connect/connect' });
  },
});

function buildTokenHeader() {
  const t = config.getToken();
  return t ? { 'X-Auth-Token': t } : {};
}

/**
 * 后端对每个版本给 { exists, size, fileName, uploadedAt, url }。
 * 这里补上人类可读的体量与时间；不存在时也给出明确文案，
 * 因为「原始简历一片空白」和「后端挂了」在 UI 上必须区分开。
 */
function decorate(v, fallbackName) {
  if (!v) return { exists: false, name: fallbackName, meta: '未检测到' };
  const exists = !!v.exists;
  const kb = v.size ? Math.round(v.size / 1024) : 0;
  return {
    exists,
    name: v.fileName || fallbackName,
    sizeText: exists ? (kb >= 1024 ? (kb / 1024).toFixed(1) + ' MB' : kb + ' KB') : '',
    timeText: exists ? fmtTime(v.uploadedAt) : '',
    meta: exists ? '' : '还没有这个版本',
  };
}

function fmtTime(ts) {
  if (!ts) return '';
  const t = typeof ts === 'number' ? ts : Date.parse(String(ts).replace(' ', 'T'));
  if (!t || isNaN(t)) return String(ts).slice(0, 16);
  const d = new Date(t);
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
    p(d.getHours()) + ':' + p(d.getMinutes());
}

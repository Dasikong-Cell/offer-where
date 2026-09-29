/**
 * 首页看板。
 *
 * 数据来自三个接口，各自独立失败（一个挂了不该让整页白板）：
 *   /api/stats/funnel  漏斗与投递质量
 *   /api/stats/trend   近 N 天投递趋势（画成一条极简折线，不引第三方图表库 ——
 *                      小程序里引 canvas 图表库会显著增加包体，而这里只需要看趋势）
 *   /api/apply/quota   各平台配额与封禁状态（有封禁就要在最显眼处提醒）
 *
 * 「投递状态」的口径有意做成**两级**：
 *   - 「已投递」= applied
 *   - 「已处理」= applied + candidate（candidate 是已建立沟通但还没正式投）
 *   因为用户真正关心的是「有没有进展」，而不是状态字段怎么分的。
 */

const req = require('../../utils/request.js');
const config = require('../../utils/config.js');

const STATUS_LABEL = {
  applied: '已投递',
  candidate: '沟通中',
  unavailable: '不可投',
};

Page({
  data: {
    loading: true,
    configured: true,
    error: '',
    funnel: null,
    trend: null,
    quota: null,
    /** 折线图预处理后的点串，供 wxml 直接画 polyline */
    trendPoints: '',
    trendLabels: [],
    updatedAt: '',
    statusRows: [],
    topSources: [],
  },

  onLoad() {
    this.refresh();
  },

  onShow() {
    // 从别的页面回来时若没有数据就补一次（不无条件重刷，避免频繁打接口）
    if (!this.data.funnel && !this.data.loading) this.refresh();
  },

  onPullDownRefresh() {
    this.refresh().then(() => wx.stopPullDownRefresh());
  },

  async refresh() {
    if (!config.isConfigured()) {
      this.setData({ loading: false, configured: false });
      return;
    }
    this.setData({ loading: true, configured: true, error: '' });

    // 三个接口并发，各自 catch 成 null，最后统一判定
    const [funnel, trend, quota] = await Promise.all([
      req.get('/api/stats/funnel').catch(() => null),
      req.get('/api/stats/trend', { days: 7 }).catch(() => null),
      req.get('/api/apply/quota').catch(() => null),
    ]);

    if (!funnel && !trend && !quota) {
      this.setData({
        loading: false,
        error: '拿不到数据。请检查后端是否运行、或在「连接后端」页重新测试。',
      });
      return;
    }

    const patch = {
      loading: false,
      funnel,
      trend,
      quota,
      updatedAt: this.nowText(),
    };

    if (trend && trend.items && trend.items.length) {
      patch.trendPoints = buildPolyline(trend.items, trend.max);
      patch.trendLabels = [trend.items[0].date.slice(5), trend.items[trend.items.length - 1].date.slice(5)];
    }

    if (funnel && funnel.byStatus) {
      patch.statusRows = Object.keys(STATUS_LABEL).map((k) => ({
        key: k,
        label: STATUS_LABEL[k],
        value: funnel.byStatus[k] || 0,
      }));
    }

    if (funnel && Array.isArray(funnel.bySource)) {
      patch.topSources = funnel.bySource.slice(0, 5).map((s) => ({
        name: s.source || s.platform || '未知',
        count: s.count || s.total || 0,
      }));
    }

    this.setData(patch);
  },

  nowText() {
    const d = new Date();
    const p = (n) => (n < 10 ? '0' + n : '' + n);
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  },

  goConnect() {
    wx.navigateTo({ url: '/pages/connect/connect' });
  },

  goRecords() {
    wx.switchTab({ url: '/pages/records/records' });
  },
});

/**
 * 把趋势数据转成 SVG polyline 的 points 串。
 * 用 viewBox="0 0 300 80" 的坐标系，两边各留 4 的边距，避免线贴边被裁。
 */
function buildPolyline(items, max) {
  const W = 300;
  const H = 80;
  const PAD = 4;
  const n = items.length;
  const peak = Math.max(1, max || 1);
  const step = n > 1 ? (W - PAD * 2) / (n - 1) : 0;
  return items
    .map((it, i) => {
      const x = PAD + step * i;
      const y = H - PAD - (it.count / peak) * (H - PAD * 2);
      return x.toFixed(1) + ',' + y.toFixed(1);
    })
    .join(' ');
}

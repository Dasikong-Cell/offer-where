/**
 * 运行日志。
 *
 * 数据源：GET /api/logs/run?q=&level=&date=&limit=
 *   → { dates[], date, level, q, total, lines:[{ts,level,msg}] }（最新在前）
 *
 * 设计考虑：
 *   - 日志是「排查用」页面，所以筛选项（日期 / 级别 / 关键词）都放在最上面，
 *     并且改了立刻重拉 —— 不做本地过滤，因为日志体量大且分页由后端控制。
 *   - 级别用颜色区分：ERROR 红、WARN 橙、INFO 灰。这个配色沿用控制台。
 *   - 自动滚动到顶部：最新在前，用户关心最新的。
 */

const req = require('../../utils/request.js');
const config = require('../../utils/config.js');

const LEVELS = [
  { key: '', label: '全部' },
  { key: 'ERROR', label: '错误' },
  { key: 'WARN', label: '警告' },
  { key: 'INFO', label: '信息' },
];

const LIMIT = 200;

Page({
  data: {
    loading: true,
    configured: true,
    error: '',
    levels: LEVELS,
    level: '',
    keyword: '',
    date: '',
    dates: [],
    lines: [],
    total: 0,
  },

  onLoad() {
    this.refresh();
  },

  onShow() {
    if (!this.data.lines.length && !this.data.loading) this.refresh();
  },

  onPullDownRefresh() {
    this.refresh(true).then(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    // 日志已由后端限制条数，翻页意义不大；这里改为「加载更多条」
    if (this.data.lines.length >= this.data.total) return;
    this.refresh(true, this.data.lines.length + LIMIT);
  },

  async refresh(silent, limit) {
    if (!config.isConfigured()) {
      this.setData({ loading: false, configured: false });
      return;
    }
    if (!silent) this.setData({ loading: true, configured: true, error: '' });

    const params = { limit: limit || LIMIT };
    if (this.data.level) params.level = this.data.level;
    if (this.data.date) params.date = this.data.date;
    if (this.data.keyword) params.q = this.data.keyword;

    try {
      const r = await req.get('/api/logs/run', params);
      const lines = ((r && r.lines) || []).map(decorateLine);
      this.setData({
        loading: false,
        lines,
        total: (r && r.total) || lines.length,
        dates: (r && r.dates) || [],
        date: (r && r.date) || this.data.date,
      });
    } catch (err) {
      this.setData({ loading: false, error: err.friendly || err.message });
    }
  },

  onLevelTap(e) {
    this.setData({ level: e.currentTarget.dataset.key });
    this.refresh();
  },

  onDateTap(e) {
    const d = e.currentTarget.dataset.date;
    // 再点一次同一个日期 = 取消筛选
    this.setData({ date: d === this.data.date ? '' : d });
    this.refresh();
  },

  onKeyword(e) {
    this.setData({ keyword: e.detail.value });
  },

  onSearchConfirm() {
    this.refresh();
  },

  onClearKeyword() {
    this.setData({ keyword: '' });
    this.refresh();
  },

  copyLine(e) {
    const idx = e.currentTarget.dataset.idx;
    const line = this.data.lines[idx];
    if (!line) return;
    wx.setClipboardData({
      data: line.ts + ' [' + line.level + '] ' + line.msg,
      success() { wx.showToast({ title: '已复制', icon: 'none' }); },
    });
  },

  goConnect() {
    wx.navigateTo({ url: '/pages/connect/connect' });
  },
});

/** 补上颜色 class 与时间缩写；长消息保留原文（复制时要用完整的）。 */
function decorateLine(l) {
  const lv = String(l.level || 'INFO').toUpperCase();
  return {
    ts: fmtTs(l.ts),
    level: lv,
    levelCls: lv === 'ERROR' ? 'lv-error' : lv === 'WARN' ? 'lv-warn' : 'lv-info',
    msg: String(l.msg || ''),
  };
}

/** 后端给的多是 "2026-09-29 22:14:03"；只留时间部分让每行更短。 */
function fmtTs(ts) {
  const s = String(ts || '');
  const m = s.match(/(\d{2}:\d{2}:\d{2})/);
  return m ? m[1] : s;
}

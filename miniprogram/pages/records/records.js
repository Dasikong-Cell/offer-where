/**
 * 职位记录。
 *
 * 数据源：GET /api/jobs?source=&status= → { jobs[], total }
 *
 * ⚠️ 字段名是**数据库原始列名（snake_case）**，不是驼峰 —— 后端该接口直接
 * 转发 `db.listJobs()` 的返回行，没有做字段映射。实测确认的真实字段：
 *   id, source, company, position, city, jd, requirements, salary, apply_url,
 *   deadline, match_score, match_detail, status, created_at, updated_at,
 *   quarantine, skip_reason, card_text, jd_images, jd_source, ocr_status, remote
 * 特别注意：是 `position` 不是 `title`、是 `apply_url` 不是 `jobUrl`、
 * 是 `created_at` 不是 `createdAt`。写错不报错，只是页面一片空白。
 * （这条正是靠 scripts/_mp_api_probe.mts 抓到的，静态检查发现不了。）
 *
 * 分页策略：后端该接口一次性返回全集（没有 limit/offset 参数），
 * 所以分页在**前端**做 —— 这在小程序里反而更好：翻页无网络等待。
 * ⚠️ 但要清楚它不是全库：`db.listJobs()` 的 SQL 是
 *   `... ORDER BY (match_score IS NULL), match_score DESC, created_at DESC LIMIT ?`
 * 且 `params.push(opts.limit || 1000)` —— **默认上限写死 1000**，与库大小无关。
 * 所以界面上把「本地条数」显示出来：如果你知道库里不止这些，那就是被这个 LIMIT 截断了。
 * （另注：排序是「先按有无匹配分分组、再按匹配分降序」，所以记录页的顺序
 *   不是时间序 —— 想让用户按时间找岗位时要靠搜索框，不能靠滚动。）
 *
 * 搜索同样在前端做（匹配公司/职位/城市），这样做的好处是输入即时响应。
 */

const req = require('../../utils/request.js');
const config = require('../../utils/config.js');

const PAGE_SIZE = 20;

const STATUS_META = {
  applied: { label: '已投递', cls: 'badge-ok' },
  candidate: { label: '沟通中', cls: 'badge-info' },
  unavailable: { label: '不可投', cls: 'badge-muted' },
  pending: { label: '待处理', cls: 'badge-warn' },
  skipped: { label: '已跳过', cls: 'badge-muted' },
};

const SOURCE_FILTERS = [
  { key: '', label: '全部' },
  { key: 'boss', label: 'BOSS' },
  { key: 'zhilian', label: '智联' },
  { key: 'job51', label: '51job' },
  { key: 'nowcoder', label: '牛客' },
  { key: 'offerbiu', label: 'OfferBiu' },
];

Page({
  data: {
    loading: true,
    configured: true,
    error: '',
    keyword: '',
    source: '',
    sourceFilters: SOURCE_FILTERS,
    /** 全量 */
    all: [],
    /** 过滤后 */
    filtered: [],
    /** 当前渲染 */
    visible: [],
    total: 0,
    hasMore: false,
  },

  onLoad() {
    this.refresh();
  },

  onShow() {
    if (!this.data.all.length && !this.data.loading) this.refresh();
  },

  onPullDownRefresh() {
    this.refresh(true).then(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    this.loadMore();
  },

  async refresh(silent) {
    if (!config.isConfigured()) {
      this.setData({ loading: false, configured: false });
      return;
    }
    if (!silent) this.setData({ loading: true, configured: true, error: '' });

    try {
      const r = await req.get('/api/jobs');
      const jobs = (r && r.jobs) || [];
      const decorated = jobs.map(decorateJob);
      this.setData({
        loading: false,
        all: decorated,
        // 后端内部有行数上限（实测 1000），total 是它返回的条数而非库里总数。
        // 界面同时显示「本地条数」，两者不等就说明被截断了 —— 不做静默忽略。
        total: (r && r.total) || jobs.length,
      });
      this.applyFilter();
    } catch (err) {
      this.setData({ loading: false, error: err.friendly || err.message });
    }
  },

  onKeyword(e) {
    this.setData({ keyword: e.detail.value });
    this.applyFilter();
  },

  onClearKeyword() {
    this.setData({ keyword: '' });
    this.applyFilter();
  },

  onSourceTap(e) {
    this.setData({ source: e.currentTarget.dataset.key });
    this.applyFilter();
  },

  applyFilter() {
    const kw = String(this.data.keyword || '').trim().toLowerCase();
    const src = this.data.source;
    const filtered = this.data.all.filter((j) => {
      if (src && j.source !== src) return false;
      if (!kw) return true;
      return (
        (j.title || '').toLowerCase().indexOf(kw) >= 0 ||
        (j.company || '').toLowerCase().indexOf(kw) >= 0 ||
        (j.city || '').toLowerCase().indexOf(kw) >= 0
      );
    });
    this.setData({ filtered });
    this.renderFirstPage();
  },

  renderFirstPage() {
    const visible = this.data.filtered.slice(0, PAGE_SIZE);
    this.setData({ visible, hasMore: this.data.filtered.length > visible.length });
  },

  loadMore() {
    if (!this.data.hasMore) return;
    const cur = this.data.visible.length;
    const next = this.data.filtered.slice(0, cur + PAGE_SIZE);
    this.setData({ visible: next, hasMore: this.data.filtered.length > next.length });
  },

  onJobTap(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: '/pages/job-detail/job-detail?id=' + id });
  },

  goConnect() {
    wx.navigateTo({ url: '/pages/connect/connect' });
  },
});

/**
 * 把后端原始行（snake_case）映射成界面字段。
 * ⚠️ 所有字段名都以实测返回为准 —— 见文件头注释。
 */
function decorateJob(j) {
  const meta = STATUS_META[j.status] || { label: j.status || '未知', cls: 'badge-muted' };
  const score = j.match_score;
  return {
    id: j.id,
    // 后端列名是 position，界面文案叫「职位」
    title: j.position || '',
    company: stripCompanySuffix(j.company),
    city: j.city || '',
    salary: j.salary || '',
    source: j.source || '',
    statusRaw: j.status || '',
    statusLabel: meta.label,
    statusCls: meta.cls,
    timeText: relTime(j.created_at || j.updated_at),
    initial: firstChar(stripCompanySuffix(j.company) || j.position || '?'),
    scoreText: score === null || score === undefined ? '' : String(score),
    quarantined: !!j.quarantine,
  };
}

/**
 * 采集器把「在招 5 个职位 >」这类页面噪音一起抓进了 company
 * （实测：`北京智合联创科技有限公司 在招5个职位 >`）。
 * 在列表里这会挤掉真正有用的信息，所以展示前清掉。
 * 注意只影响列表展示，详情页仍读原始值，避免用户以为数据被改了。
 */
function stripCompanySuffix(s) {
  return String(s || '')
    .replace(/\s*在招\s*\d+\s*个职位\s*>?\s*$/, '')
    .replace(/\s*>\s*$/, '')
    .trim();
}

function firstChar(s) {
  return String(s || '?').trim().slice(0, 1).toUpperCase();
}

/**
 * 相对时间。列表里看「3 分钟前」比看「2026-09-29 22:14」更快理解；
 * 超过 7 天则退回日期，因为「15 天前」这种表达反而不精确。
 */
function relTime(ts) {
  if (!ts) return '';
  const t = typeof ts === 'number' ? ts : Date.parse(String(ts).replace(' ', 'T'));
  if (!t || isNaN(t)) return String(ts).slice(0, 16);
  const diff = Date.now() - t;
  if (diff < 0) return '刚刚';
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return min + ' 分钟前';
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr + ' 小时前';
  const day = Math.floor(hr / 24);
  if (day <= 7) return day + ' 天前';
  const d = new Date(t);
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

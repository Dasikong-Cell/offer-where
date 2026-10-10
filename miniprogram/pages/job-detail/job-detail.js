/**
 * 职位详情。
 *
 * 数据来源：
 *   列表页只带了摘要字段，详情页用 `GET /api/jobs` 拉回全集后按 id 命中。
 *   后端没有 `/api/jobs/:id` 这样的单条接口，所以只能这样取 —— 这在小程序里代价可接受
 *   （数据量小，且字段名与列表页共用同一套映射语义）。
 *
 * ⚠️ 字段名与列表页同源，都是**数据库原始列名**：position / apply_url /
 *   match_score / created_at / jd / requirements。写错不报错，只是页面空白。
 *
 * JD 展示：
 *   JD 文本可能非常长（实测有 3000+ 字，且常混入页面噪音如「企业简介」「客服热线」），
 *   直接铺开会把页面撑爆且难读，所以默认折叠、点「展开全文」再看 —— 移动端读长文的标准做法。
 *
 * 「清理噪音」按钮：
 *   实测采集到的 JD 尾部常带一大段公司简介与页脚（客户服务热线、ICP 备案号等），
 *   这些对判断岗位毫无价值。这里给一个纯本地的裁剪（不动后端数据），
 *   规则明确写在 cleanJdText 里，用户可预期。
 */

const req = require('../../utils/request.js');

const JD_COLLAPSE_CHARS = 220;

Page({
  data: {
    id: '',
    job: null,
    loading: true,
    error: '',
    jdExpanded: false,
    /** JD 是否需要折叠（文本长度超过阈值才显示按钮） */
    jdLong: false,
    /** 是否用了清理后的 JD（清理按钮的状态） */
    jdCleaned: false,
    jdRaw: '',
    jdText: '',
  },

  onLoad(query) {
    const id = (query && query.id) || '';
    this.setData({ id });
    this.load(id);
  },

  async load(id) {
    if (!id) {
      this.setData({ loading: false, error: '缺少职位 id' });
      return;
    }
    try {
      const r = await req.get('/api/jobs');
      const jobs = (r && r.jobs) || [];
      // id 可能是数字或字符串，统一按字符串比
      const raw = jobs.find((j) => String(j.id) === String(id));
      if (!raw) {
        this.setData({ loading: false, error: '找不到这条记录（可能已被删除）' });
        return;
      }
      const jd = String(raw.jd || '');
      this.setData({
        loading: false,
        jdRaw: jd,
        jdText: jd,
        jdLong: jd.length > JD_COLLAPSE_CHARS,
        job: {
          id: raw.id,
          title: posLabel(raw.position, ''),
          company: raw.company || '',
          companyClean: stripCompanySuffix(raw.company),
          city: raw.city || '',
          salary: raw.salary || '',
          source: raw.source || '',
          requirements: raw.requirements || '',
          applyUrl: raw.apply_url || '',
          matchScore: raw.match_score,
          matchDetail: raw.match_detail || '',
          statusLabel: statusLabel(raw.status),
          statusCls: statusCls(raw.status),
          statusRaw: raw.status || '',
          timeText: fmtTime(raw.created_at || raw.updated_at),
          deadline: raw.deadline || '',
          skipReason: raw.skip_reason || '',
          quarantined: !!raw.quarantine,
          remote: raw.remote === 1,
          jdSource: raw.jd_source || '',
          ocrStatus: raw.ocr_status || '',
        },
      });
      wx.setNavigationBarTitle({ title: (posLabel(raw.position, '') || '职位详情').slice(0, 16) });
    } catch (err) {
      this.setData({ loading: false, error: err.friendly || err.message });
    }
  },

  toggleJd() {
    this.setData({ jdExpanded: !this.data.jdExpanded });
  },

  /**
   * 裁剪 JD 噪音。纯本地操作，可逆（再点一次恢复原文）。
   * 规则（都来自实测数据的形态，不做模糊猜测）：
   *   1. 截断到「公司信息」/「企业简介」/「公司简介」这几个标题之前 ——
   *      这些之后基本都是公司宣传，与岗位无关
   *   2. 再截断到「客户服务」/「投诉」/「ICP」/「公众号 小程序」等页脚关键词之前
   *   3. 折叠多余空行
   */
  toggleCleanJd() {
    if (this.data.jdCleaned) {
      this.setData({ jdCleaned: false, jdText: this.data.jdRaw });
      return;
    }
    const cleaned = cleanJdText(this.data.jdRaw);
    const saved = this.data.jdRaw.length - cleaned.length;
    this.setData({ jdCleaned: true, jdText: cleaned });
    wx.showToast({
      title: saved > 0 ? `已裁掉约 ${saved} 字公司简介` : '没找到可裁剪的内容',
      icon: 'none',
    });
  },

  copyUrl() {
    const url = this.data.job && this.data.job.applyUrl;
    if (!url) {
      wx.showToast({ title: '这条记录没有链接', icon: 'none' });
      return;
    }
    wx.setClipboardData({
      data: url,
      success() { wx.showToast({ title: '链接已复制', icon: 'none' }); },
    });
  },
});

/**
 * 岗位名输出侧清洗 —— 与 `server/services/apply/jobText.ts` 的 `jobPositionLabel`、
 * 以及 `public/console.html` 的 `posLabel` **同口径**（三处必须一致，合约测试有锚定）。
 *
 * 为什么小程序也要：**后端 `/api/*` 返回的是数据库原始行**，position 由采集器原样入库。
 * 写库口那道清洗（server/db.ts 的 sanitizePosition）只治新增、治不了存量，也**不管反斜杠、
 * 不管长度、允许空**。三处失真在小屏上更明显：
 *   ① 反斜杠残留（`软件工程师Java\C#（3-6个月长期出差）`）；
 *   ② 超长「多岗位并列」串（最长 80 字，实测 138/3200 条超 40 字）直接把列表项挤成两行；
 *   ③ 空值 → 卡片标题空白。
 * ⚠️ 只清洗**展示**：详情页的 JD / 表单提交仍用原始值。
 */
function posLabel(v, fb) {
  var d = (fb === undefined ? '该岗位' : fb);
  if (v === null || v === undefined) return d;
  var s = String(v)
    .replace(/\s*\\+\s*/g, '/')
    .replace(/[\u200B-\u200F\uFEFF]/g, '')
    .replace(/[\u0000-\u001F\u007F\u2028\u2029]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return d;
  if (s.length <= 40) return s;
  var head = s.slice(0, 40);
  var min = 20;
  var cut = -1;
  ['、', '，', ',', '/', '|', '·'].forEach(function (sep) {
    var i = head.lastIndexOf(sep);
    if (i > cut) cut = i;
  });
  if (cut < min) {
    var sp = head.lastIndexOf(' ');
    cut = (sp >= min ? sp : -1);
  }
  var body = (cut >= min ? head.slice(0, cut) : head);
  return body.replace(/[\s、，,/|·]+$/, '') + '\u2026';
}

/** 见 records.js 的同名函数（两边都保留一份，避免小程序里引 shared 造成打包复杂度） */
function stripCompanySuffix(s) {
  return String(s || '')
    .replace(/\s*在招\s*\d+\s*个职位\s*>?\s*$/, '')
    .replace(/\s*>\s*$/, '')
    .trim();
}

function cleanJdText(text) {
  let s = String(text || '');
  // 1. 公司信息段之前截断
  const companyHead = s.search(/公司信息|企业简介|公司简介|公司介绍/);
  if (companyHead > 100) s = s.slice(0, companyHead);
  // 2. 页脚关键词之前截断
  const footer = s.search(/客户服务|投诉及违法举报|ICP|公众号\s+小程序|用户帮助|隐私政策|用户协议/);
  if (footer > 100) s = s.slice(0, footer);
  // 3. 折叠空行与多余空格
  return s.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function statusLabel(s) {
  return {
    applied: '已投递', candidate: '沟通中', unavailable: '不可投',
    pending: '待处理', skipped: '已跳过',
  }[s] || s || '未知';
}

function statusCls(s) {
  return {
    applied: 'badge-ok', candidate: 'badge-info', unavailable: 'badge-muted',
    pending: 'badge-warn', skipped: 'badge-muted',
  }[s] || 'badge-muted';
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

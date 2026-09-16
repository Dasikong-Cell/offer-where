/**
 * 对 offerbiu 岗位池中「软件相关」的候选岗位自动投递。
 *
 * 用法: tsx scripts/offerbiu_apply.ts [最多投递数]
 *   例: tsx scripts/offerbiu_apply.ts 12
 *
 * 说明：逐个调 POST /api/apply {platform:'offerbiu', jobId, channel:'auto'}。
 *       - channel='auto' 由后端按 apply_url 路由：微信推文 → 邮箱通道（解析 HR 邮箱发简历），
 *         企业官网 → 官网通道（邮箱验证码登录 → 点投递 → 传简历）。
 *       - 邮箱验证码/发信依赖 mail_config（库配置优先于 .env），需已配置授权码。
 *       - 官网通道无 dryRun，调用即真投；失败会返回 need_manual 由人工兜底。
 */
const API = 'http://127.0.0.1:4400';

const KEYWORDS = [
  '软件', '前端', '后端', '全栈', '开发', '程序', 'java', '测试', '算法', '数据',
  '人工智能', 'AI', '机器学习', '计算机', 'web', 'python', '嵌入式', '安卓', 'android', 'ios',
  '研发', '技术', 'IT', '系统', '网络', '运维', '云计算', '大数据', '芯片', '半导体',
];
const EXCLUDE = [
  '销售', '市场', '营销', '运营', '人力', 'HR', '财务', '会计', '行政', '客服',
  '护士', '教师', '老师', '导购', '司机', '普工', '操作工', '机械', '结构', '硬件',
  '电气', '化工', '材料', '工艺', '飞行器', '动力', '泵', '阀', '制造', '生产',
  '质量', '供应链', '采购', '物流', '仓储', '土建', '建筑', '医学', '临床', '生物',
  '制药', '金融', '投资', '银行', '保险', '信托',
];

function isSoftwareRelated(position: string): boolean {
  const p = (position || '').toLowerCase();
  if (!p) return false;
  if (EXCLUDE.some((e) => p.includes(e.toLowerCase()))) return false;
  return KEYWORDS.some((k) => p.toLowerCase().includes(k.toLowerCase()));
}

(async () => {
  const max = Number(process.argv[2] || 10);
  const r = await fetch(`${API}/api/jobs`);
  const body: any = await r.json();
  const jobs: any[] = body.jobs || body || [];

  const cand = jobs
    .filter((j) => j.source === 'offerbiu' && j.status === 'candidate')
    .filter((j) => isSoftwareRelated(j.position || ''));

  // 优先投官网 / 标准化招聘系统：微信推文正文常加载不出来（微信风控），成功率低，排到最后
  const isWechat = (u: string) => (u || '').includes('mp.weixin.qq.com') || (u || '').includes('mp.weixinbridge.com');
  const ordered = [...cand].sort((a, b) => Number(isWechat(a.apply_url || '')) - Number(isWechat(b.apply_url || '')));

  console.log(`offerbiu 软件相关待投岗位：${cand.length} 个，本次最多投 ${max} 个（官网/招聘系统优先）\n`);

  let applied = 0, manual = 0, other = 0;
  for (const j of ordered.slice(0, max)) {
    console.log(`>>> ${j.company} | ${(j.position || '').slice(0, 50)}`);
    console.log(`    ${(j.apply_url || '').slice(0, 90)}`);
    try {
      const res = await fetch(`${API}/api/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: 'offerbiu', jobId: j.id, channel: 'auto', realSend: true }),
      });
      const out: any = await res.json();
      console.log(`    => ${out.status} | ${out.message || ''}`);
      if (out.status === 'applied') applied++;
      else if (out.status === 'need_manual') manual++;
      else other++;
    } catch (e: any) {
      console.log(`    => 请求失败 ${e?.message || e}`);
      other++;
    }
    console.log('');
  }

  console.log(`=== 投递完成：成功 ${applied} / 需人工 ${manual} / 其他 ${other} ===`);
})();

import { useState, useEffect } from 'react';
import {
  Card, Button, Tag, Loading, MessagePlugin, Input, Dialog, Select, Checkbox,
} from 'tdesign-react';
import { SearchIcon, BrowseIcon, RefreshIcon, UsergroupIcon } from 'tdesign-icons-react';

interface Profile {
  name?: string;
  phone?: string;
  email?: string;
  expected_positions?: string;
  expected_city?: string;
  resume_path?: string;
  skills?: string;
}

interface MatchDetail {
  matched: string[];
  missing: string[];
  suggestions: string[];
}

interface Job {
  id: string;
  source: string;
  company: string | null;
  position: string | null;
  city: string | null;
  salary: string | null;
  apply_url: string | null;
  jd: string | null;
  match_score: number | null;
  match_detail: string | MatchDetail | null;
  status: string;
}

export function JobMatchPage() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [mailConfig, setMailConfig] = useState<{ hasAuthCode: boolean } | null>(null);
  const [parseResult, setParseResult] = useState<any>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(false);
  const [collecting, setCollecting] = useState(false);
  const [matching, setMatching] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [addForm, setAddForm] = useState({ company: '', position: '', city: '', salary: '', applyUrl: '', jd: '' });
  const [applying, setApplying] = useState<string | null>(null); // 正在投递的 jobId
  const [result, setResult] = useState<any>(null);
  const [showResult, setShowResult] = useState(false);

  // 自动连投向导状态
  const [showBatch, setShowBatch] = useState(false);
  const [batching, setBatching] = useState(false);        // 正在流式连投
  const [batchStarted, setBatchStarted] = useState(false); // 已开始（dialog 内显示进度）
  const [batchForm, setBatchForm] = useState({ platform: '', source: 'offerbiu', keywords: '', city: '', minScore: '', limit: '10', intervalMs: '20000', collect: true, action: '', hrGroupId: '' });
  const [batchProgress, setBatchProgress] = useState({ index: 0, total: 0, current: '' });
  const [batchLog, setBatchLog] = useState<{ status: 'ok' | 'warn' | 'err'; text: string }[]>([]);
  // 缺失配置补填弹窗（"三步"中的输入步骤）
  const [showResumeDlg, setShowResumeDlg] = useState(false);
  const [resumeInput, setResumeInput] = useState('');
  const [showAuthDlg, setShowAuthDlg] = useState(false);
  const [authInput, setAuthInput] = useState('');
  // 运行期需要人工输入的弹窗（验证码 / 滑块 / 人工）
  const [inputDlg, setInputDlg] = useState<{ title: string; body: string } | null>(null);

  const PLATFORM_LABEL: Record<string, string> = {
    boss: 'BOSS直聘', zhilian: '智联招聘', job51: '前程无忧', liepin: '猎聘', nowcoder: '牛客网', offerbiu: '企业官网',
  };

  const api = (p: string, opt?: RequestInit) => fetch(`/api${p}`, {
    headers: { 'Content-Type': 'application/json' }, ...opt,
  }).then(async r => {
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `请求失败 ${r.status}`);
    return data;
  });

  const loadProfile = async () => {
    try { setProfile(await api('/profile')); } catch { /* ignore */ }
  };
  const loadMailConfig = async () => {
    try { setMailConfig(await api('/mail/config')); } catch { /* ignore */ }
  };
  const loadJobs = async () => {
    try { const d = await api('/jobs'); setJobs(d.jobs || []); } catch { /* ignore */ }
  };

  useEffect(() => { loadProfile(); loadMailConfig(); loadJobs(); }, []);

  // 解析简历
  const handleParse = async () => {
    setLoading(true);
    try {
      const d = await api('/resume/parse', { method: 'POST', body: '{}' });
      setParseResult(d);
      setProfile((p) => ({ ...(p || {}), name: d.name, skills: d.skills?.join('，') }));
      MessagePlugin.success(`简历解析完成：${d.skills?.length || 0} 项技能`);
      await loadProfile();
    } catch (e: any) {
      MessagePlugin.error(e.message || '解析失败');
    } finally { setLoading(false); }
  };

  // 从 Offerbiu 采集
  const handleCollect = async () => {
    setCollecting(true);
    try {
      const d = await api('/offerbiu/collect', { method: 'POST', body: JSON.stringify({ limit: 50 }) });
      MessagePlugin.success(`已从 Offerbiu 采集 ${d.collected || 0} 个岗位`);
      await loadJobs();
    } catch (e: any) {
      MessagePlugin.warning(e.message || '采集失败（请先登录 Offerbiu）');
    } finally { setCollecting(false); }
  };

  // 一键匹配打分
  const handleMatch = async () => {
    setMatching(true);
    try {
      const d = await api('/jobs/match', { method: 'POST', body: JSON.stringify({}) });
      setJobs(d.jobs || []);
      MessagePlugin.success(`已对 ${d.total || 0} 个岗位完成匹配`);
    } catch (e: any) {
      MessagePlugin.error(e.message || '匹配失败');
    } finally { setMatching(false); }
  };

  const openApply = (job: Job) => {
    if (job.apply_url) window.open(job.apply_url, '_blank');
    else MessagePlugin.warning('该岗位暂无投递入口');
  };

  /** 由岗位来源/链接推断投递平台（用于求职信/复聊等动作） */
  const jobPlatformOf = (job: Job): string => {
    const src = (job.source || '').toLowerCase();
    if (['boss', 'zhilian', 'job51', 'liepin', 'nowcoder', 'offerbiu'].includes(src)) return src;
    const u = (job.apply_url || '').toLowerCase();
    if (u.includes('zhipin.com')) return 'boss';
    if (u.includes('zhaopin.com')) return 'zhilian';
    if (u.includes('51job.com') || u.includes('jobs.51job')) return 'job51';
    if (u.includes('liepin.com')) return 'liepin';
    return 'boss';
  };

  // 标记已投递 -> 写入投递记录
  const markApplied = async (job: Job) => {
    try {
      await api('/applications', {
        method: 'POST',
        body: JSON.stringify({
          platform: job.source || 'manual',
          company: job.company || '',
          position: job.position || '',
          salary: job.salary || '',
          city: job.city || '',
          jobUrl: job.apply_url || '',
          status: 'applied',
          loginMethod: 'email',
          message: `由岗位匹配页发起投递（匹配分 ${job.match_score ?? '—'}）`,
        }),
      });
      await api(`/jobs/${job.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'applied' }) });
      setJobs((js) => js.map((j) => (j.id === job.id ? { ...j, status: 'applied' } : j)));
      MessagePlugin.success('已记录投递');
    } catch (e: any) {
      MessagePlugin.error(e.message || '记录失败');
    }
  };

  const addJob = async () => {
    if (!addForm.company && !addForm.position) { MessagePlugin.warning('公司/岗位至少填一个'); return; }
    try {
      await api('/jobs', { method: 'POST', body: JSON.stringify(addForm) });
      setShowAdd(false); setAddForm({ company: '', position: '', city: '', salary: '', applyUrl: '', jd: '' });
      await loadJobs(); MessagePlugin.success('岗位已加入池');
    } catch (e: any) { MessagePlugin.error(e.message || '添加失败'); }
  };

  // 专用投递（BOSS / 智联 / 51job / 猎聘 / 牛客 / 官网；action 可选 hello/letter/again）
  const applyOnPlatform = async (job: Job, platform: string, action: string = 'hello') => {
    if (!profile?.email) { MessagePlugin.warning('请先在「我的档案」填写邮箱与授权码'); return; }
    // hello 沿用旧 key，保证原有按钮 loading 状态不串；其余动作带 action 后缀
    setApplying(action === 'hello' ? `${job.id}:${platform}` : `${job.id}:${platform}:${action}`);
    try {
      const d = await api('/apply', {
        method: 'POST',
        body: JSON.stringify({
          platform,
          action,
          jobId: job.id,
          jobUrl: job.apply_url || undefined,
          jdText: job.jd || undefined,
        }),
      });
      setResult(d);
      setShowResult(true);
      const label = PLATFORM_LABEL[platform] || platform;
      if (d.status === 'applied') {
        MessagePlugin.success(`已在${label}投递成功`);
        await loadJobs();
      } else if (d.status === 'need_captcha') {
        MessagePlugin.warning('请在打开的浏览器中完成滑块验证后，再次点击该平台投递按钮');
      } else if (d.status === 'need_manual') {
        MessagePlugin.warning(d.message || '需人工在浏览器中完成');
      } else {
        MessagePlugin.error(d.message || '投递失败');
      }
    } catch (e: any) {
      MessagePlugin.error(e.message || '投递请求失败');
    } finally {
      setApplying(null);
    }
  };

  const detailOf = (job: Job): MatchDetail | null => {
    if (!job.match_detail) return null;
    try { return typeof job.match_detail === 'string' ? JSON.parse(job.match_detail) : job.match_detail; }
    catch { return null; }
  };

  // ============ 自动筛选 + 批量连投（向导 + 弹窗） ============

  /** 保存简历路径后继续连投 */
  const saveResume = async () => {
    if (!resumeInput.trim()) { MessagePlugin.warning('请填写简历文件绝对路径'); return; }
    try {
      await api('/profile', { method: 'PUT', body: JSON.stringify({ resume_path: resumeInput.trim() }) });
      await loadProfile();
      setShowResumeDlg(false);
      MessagePlugin.success('简历路径已保存，继续连投');
      startBatch();
    } catch (e: any) { MessagePlugin.error(e.message || '保存失败'); }
  };

  /** 保存 QQ 邮箱授权码后继续连投 */
  const saveAuth = async () => {
    if (!authInput.trim()) { MessagePlugin.warning('请填写 QQ 邮箱授权码'); return; }
    try {
      await api('/mail/config', {
        method: 'POST',
        body: JSON.stringify({ email: profile?.email, authCode: authInput.trim() }),
      });
      await loadMailConfig();
      setShowAuthDlg(false);
      MessagePlugin.success('授权码已保存，继续连投');
      startBatch();
    } catch (e: any) { MessagePlugin.error(e.message || '保存失败'); }
  };

  /** 处理流式事件：实时进度 + 需要输入时弹窗 */
  const onBatchEvent = async (e: any) => {
    if (e.type === 'start') {
      setBatchProgress({ index: 0, total: e.total, current: '开始' });
    } else if (e.type === 'progress') {
      setBatchProgress({ index: e.index + 1, total: e.total, current: `${e.company || ''} ${e.position || ''}` });
    } else if (e.type === 'need_input') {
      // 弹窗提示用户：此刻需要人工输入 / 操作
      const body = e.inputType === 'captcha'
        ? `平台：${PLATFORM_LABEL[e.platform] || e.platform}\n岗位：${e.company || ''} ${e.position || ''}\n\n请在自动打开的浏览器窗口中完成滑块 / 图形 / 短信验证，完成后点击下方「我已处理」即可（该岗位若超时未过验证会自动跳过，其余岗位继续投）。`
        : `平台：${PLATFORM_LABEL[e.platform] || e.platform}\n岗位：${e.company || ''} ${e.position || ''}\n\n${e.message || '请在浏览器中完成本步操作'}\n完成后点击「我已处理」继续。`;
      setInputDlg({ title: e.inputType === 'captcha' ? '需要验证码 / 滑块验证' : '需要人工处理', body });
      setBatchLog((l) => [...l, { status: 'warn', text: `⚠ 需人工：${e.company || ''} ${e.position || ''} — ${e.message || ''}` }]);
    } else if (e.type === 'result') {
      setBatchLog((l) => [...l, {
        status: e.status === 'applied' ? 'ok' : e.status === 'error' ? 'err' : 'warn',
        text: `${(e.status === 'applied' ? '✓' : e.status === 'error' ? '✗' : '•')} ${e.message || ''}`,
      }]);
    } else if (e.type === 'done') {
      setResult(e.summary);
      setShowResult(true);
      setShowBatch(false);
      setBatchStarted(false);
      setBatching(false);
      await loadJobs();
      MessagePlugin.success(e.summary.message || '批量投递完成');
    } else if (e.type === 'error') {
      MessagePlugin.error(e.message || '批量投递失败');
    }
  };

  /** 流式拉取 SSE（POST + ReadableStream） */
  const runStream = async () => {
    setBatching(true);
    setBatchStarted(true);
    setBatchLog([]);
    setBatchProgress({ index: 0, total: 0, current: '' });

    // 职得鸭全套：选择了「动作模式」(auto/keyword/search/again/letter) → 走统一引擎（直接投不过滤）
    if (batchForm.action) {
      try {
        if (!batchForm.platform) throw new Error('请选择投递平台');
        const body = {
          platform: batchForm.platform,
          action: batchForm.action,
          keyword: batchForm.keywords.trim() || undefined,
          maxPages: Number(batchForm.limit) || 5,
          hrGroupId: batchForm.action === 'again' ? (batchForm.hrGroupId.trim() || undefined) : undefined,
        };
        setBatchLog((l) => [...l, { status: 'ok', text: `▶ 启动引擎动作：${batchForm.action} @ ${PLATFORM_LABEL[batchForm.platform] || batchForm.platform}` }]);
        const d = await api('/apply', { method: 'POST', body: JSON.stringify(body) });
        setBatchLog((l) => [...l, { status: d.status === 'applied' ? 'ok' : d.status === 'error' ? 'err' : 'warn', text: `${(d.status === 'applied' ? '✓' : d.status === 'error' ? '✗' : '•')} ${d.message || d.status}` }]);
        if (Array.isArray(d.foundJobs) && d.foundJobs.length) {
          setBatchLog((l) => [...l, { status: 'ok', text: `🔎 收集到 ${d.foundJobs.length} 个岗位：` }]);
          d.foundJobs.slice(0, 30).forEach((j: any) => setBatchLog((l) => [...l, { status: 'warn', text: `  - ${j.title}  ${j.url}` }]));
        }
        setResult(d);
        setShowResult(true);
        setBatching(false);
        setBatchStarted(false);
        setShowBatch(false);
        MessagePlugin.success(d.message || '引擎动作完成');
        return;
      } catch (e: any) {
        MessagePlugin.error(e.message || '引擎动作失败');
        setBatching(false);
        return;
      }
    }

    const body = {
      platform: batchForm.platform || undefined,
      source: batchForm.source || undefined,
      collect: batchForm.collect ? 'offerbiu' : false,
      limit: Number(batchForm.limit) || 10,
      intervalMs: Number(batchForm.intervalMs) || 20000,
      criteria: {
        keywords: batchForm.keywords.split(/[,，、\s]+/).map(s => s.trim()).filter(Boolean),
        city: batchForm.city.trim() || undefined,
        minScore: batchForm.minScore ? Number(batchForm.minScore) : undefined,
      },
      stream: true,
    };
    try {
      const resp = await fetch('/api/apply/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        const d = await resp.json().catch(() => ({}));
        throw new Error(d.error || `请求失败 ${resp.status}`);
      }
      const reader = resp.body!.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const blocks = buf.split('\n\n');
        buf = blocks.pop() || '';
        for (const b of blocks) {
          const dataLine = b.split('\n').find((l) => l.startsWith('data:'));
          if (!dataLine) continue;
          let evt: any;
          try { evt = JSON.parse(dataLine.slice(5).trim()); } catch { continue; }
          onBatchEvent(evt);
        }
      }
    } catch (e: any) {
      MessagePlugin.error(e.message || '批量投递失败');
      setBatching(false);
    }
  };

  /**
   * 开始连投向导：
   *  - 缺简历路径 → 弹窗要简历路径
   *  - 缺邮箱授权码 → 弹窗要授权码
   *  - 都齐 → 启动流式连投
   */
  const startBatch = async () => {
    if (!profile?.email) { MessagePlugin.warning('请先在「我的档案」填写邮箱'); return; }
    if (!profile.resume_path) {
      setResumeInput(profile.resume_path || '');
      setShowResumeDlg(true);
      return;
    }
    const mc = mailConfig || (await api('/mail/config').catch(() => ({ hasAuthCode: false })));
    if (!mc.hasAuthCode) {
      setShowAuthDlg(true);
      return;
    }
    await runStream();
  };

  const ScoreTag = ({ score }: { score: number | null }) => {
    if (score == null) return <Tag theme="default" variant="light">未匹配</Tag>;
    const theme = score >= 70 ? 'success' : score >= 45 ? 'warning' : 'danger';
    return <Tag theme={theme as any} variant="light">匹配 {score}</Tag>;
  };

  return (
    <div style={{ padding: 24, maxWidth: 1080, margin: '0 auto' }}>
      <div className="flex items-center justify-between" style={{ marginBottom: 16 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 22, fontWeight: 600 }}>
            <SearchIcon style={{ marginRight: 8, verticalAlign: '-3px', color: 'var(--td-brand-color)' }} />
            岗位匹配 · 自动投递
          </h2>
          <p style={{ margin: '6px 0 0', color: 'var(--td-text-color-secondary)', fontSize: 13 }}>
            解析简历 → 从 Offerbiu/手动录入岗位 → 自动打分 → 一键跨平台（BOSS/智联/51job/牛客/官网）自动投递
          </p>
        </div>
        <div className="flex gap-2">
          <Button icon={<RefreshIcon />} loading={loading} onClick={handleParse}>解析简历</Button>
          <Button icon={<UsergroupIcon />} loading={collecting} onClick={handleCollect}>Offerbiu 采集</Button>
          <Button theme="primary" icon={<SearchIcon />} loading={matching} onClick={handleMatch}>一键匹配</Button>
          <Button theme="success" icon={<UsergroupIcon />} onClick={() => { setBatchLog([]); setBatchStarted(false); setShowBatch(true); }}>自动筛选连投</Button>
          <Button variant="outline" onClick={() => setShowAdd(true)}>手动加岗</Button>
        </div>
      </div>

      {/* 简历画像 */}
      <Card title="简历画像" style={{ marginBottom: 16 }}>
        {loading ? <Loading /> : (
          <div>
            <div className="flex gap-2 flex-wrap" style={{ marginBottom: 8 }}>
              <Tag theme="primary" variant="light">{(parseResult?.name) || profile?.name || '未解析'}</Tag>
              {profile?.email && <Tag variant="light">{profile.email}</Tag>}
              {profile?.expected_city && <Tag variant="light">期望城市：{profile.expected_city}</Tag>}
            </div>
            <div className="flex gap-1.5 flex-wrap">
              {(parseResult?.skills || (profile?.skills ? profile.skills.split(/[,，、]/).filter(Boolean) : [])).map((s: string) => (
                <Tag key={s} variant="light" theme="success">{s}</Tag>
              ))}
              {!parseResult?.skills?.length && !profile?.skills && <span style={{ color: 'var(--td-text-color-placeholder)' }}>尚未解析简历，点「解析简历」生成技能画像</span>}
            </div>
            {profile?.resume_path && <p style={{ marginTop: 8, fontSize: 12, color: 'var(--td-text-color-placeholder)' }}>简历文件：{profile.resume_path}</p>}
            {!profile?.resume_path && <p style={{ marginTop: 8, fontSize: 12, color: 'var(--td-warning-color)' }}>⚠ 未配置简历路径，连投前会弹窗要求填写</p>}
            {mailConfig && !mailConfig.hasAuthCode && <p style={{ marginTop: 4, fontSize: 12, color: 'var(--td-warning-color)' }}>⚠ 未配置 QQ 邮箱授权码，连投前会弹窗要求填写</p>}
          </div>
        )}
      </Card>

      {/* 岗位池 */}
      <Card title={`岗位池（${jobs.length}）`}>
        {jobs.length === 0 ? (
          <p style={{ color: 'var(--td-text-color-placeholder)' }}>暂无岗位。点「Offerbiu 采集」或「手动加岗」导入，再点「一键匹配」打分。</p>
        ) : (
          <div style={{ display: 'grid', gap: 12 }}>
            {jobs.map((job) => {
              const d = detailOf(job);
              return (
                <div key={job.id} style={{
                  border: '1px solid var(--td-component-border)',
                  borderRadius: 8, padding: 14,
                }}>
                  <div className="flex items-center justify-between" style={{ marginBottom: 6 }}>
                    <div>
                      <strong style={{ fontSize: 15 }}>{job.position || job.company || '岗位'}</strong>
                      {job.company && <span style={{ color: 'var(--td-text-color-secondary)', marginLeft: 8, fontSize: 13 }}>{job.company}</span>}
                      {job.city && <Tag size="small" variant="light" style={{ marginLeft: 8 }}>{job.city}</Tag>}
                      {job.salary && <Tag size="small" theme="warning" variant="light" style={{ marginLeft: 6 }}>{job.salary}</Tag>}
                    </div>
                    <div className="flex gap-2 items-center">
                      <ScoreTag score={job.match_score} />
                      {job.status === 'applied' && <Tag theme="success" size="small">已投递</Tag>}
                    </div>
                  </div>
                  {d && (
                    <div style={{ fontSize: 12, marginBottom: 8 }}>
                      {d.matched?.length > 0 && <div style={{ color: 'var(--td-success-color)' }}>✓ 命中：{d.matched.join('、')}</div>}
                      {d.missing?.length > 0 && <div style={{ color: 'var(--td-warning-color)' }}>✗ 缺失：{d.missing.join('、')}</div>}
                    </div>
                  )}
                  <div className="flex gap-2" style={{ marginTop: 4, flexWrap: 'wrap' }}>
                    <Button size="small" icon={<BrowseIcon />} onClick={() => openApply(job)}>投递入口</Button>
                    <Button size="small" theme="primary" variant="outline" loading={applying === `${job.id}:boss`} onClick={() => applyOnPlatform(job, 'boss')}>BOSS 投递</Button>
                    <Button size="small" theme="warning" variant="outline" loading={applying === `${job.id}:zhilian`} onClick={() => applyOnPlatform(job, 'zhilian')}>智联投递</Button>
                    <Button size="small" theme="success" variant="outline" loading={applying === `${job.id}:job51`} onClick={() => applyOnPlatform(job, 'job51')}>51job 投递</Button>
                    <Button size="small" theme="warning" variant="outline" loading={applying === `${job.id}:liepin`} onClick={() => applyOnPlatform(job, 'liepin')}>猎聘投递</Button>
                    <Button size="small" theme="default" variant="outline" loading={applying === `${job.id}:nowcoder`} onClick={() => applyOnPlatform(job, 'nowcoder')}>牛客投递</Button>
                    {job.apply_url && (
                      <Button size="small" theme="primary" variant="text" loading={applying === `${job.id}:offerbiu`} onClick={() => applyOnPlatform(job, 'offerbiu')}>官网投递</Button>
                    )}
                    {/* 职得鸭全套：求职信 / 复聊（沟通型平台 boss·liepin 效果最佳） */}
                    <Button size="small" theme="default" variant="outline" loading={applying === `${job.id}:${jobPlatformOf(job)}:letter`} onClick={() => applyOnPlatform(job, jobPlatformOf(job), 'letter')}>求职信</Button>
                    {(['boss', 'liepin'].includes(jobPlatformOf(job)) || job.apply_url) && (
                      <Button size="small" theme="default" variant="outline" loading={applying === `${job.id}:${jobPlatformOf(job)}:again`} onClick={() => applyOnPlatform(job, jobPlatformOf(job), 'again')}>复聊</Button>
                    )}
                    {job.status !== 'applied' && <Button size="small" theme="default" variant="outline" onClick={() => markApplied(job)}>标记已投递</Button>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* 自动筛选 + 批量连投向导 */}
      <Dialog
        header="自动筛选 + 批量连投"
        visible={showBatch}
        onClose={() => { if (!batching) { setShowBatch(false); setBatchStarted(false); } }}
        onConfirm={batching ? undefined : startBatch}
        confirmBtn={batching ? null : '开始连投'}
      >
        {!batchStarted ? (
          <>
            <div style={{ fontSize: 12, marginBottom: 10 }}>
              <Tag theme={profile?.email ? 'success' : 'warning'} variant="light">{profile?.email ? `邮箱 ${profile.email}` : '邮箱未填'}</Tag>
              <Tag theme={profile?.resume_path ? 'success' : 'warning'} variant="light" style={{ marginLeft: 6 }}>{profile?.resume_path ? '简历已配置' : '简历未配置(将弹窗要求)'}</Tag>
              <Tag theme={mailConfig?.hasAuthCode ? 'success' : 'warning'} variant="light" style={{ marginLeft: 6 }}>{mailConfig?.hasAuthCode ? '授权码已配置' : '授权码未配置(将弹窗要求)'}</Tag>
            </div>
            <Select label="投递平台" value={batchForm.platform} onChange={(v) => setBatchForm({ ...batchForm, platform: v as string })} clearable style={{ marginBottom: 10 }} options={[
              { label: '自动(按来源)', value: '' },
              { label: '自动(按链接域名路由)', value: 'auto' },
              { label: 'BOSS直聘', value: 'boss' },
              { label: '智联招聘', value: 'zhilian' },
              { label: '前程无忧', value: 'job51' },
              { label: '猎聘', value: 'liepin' },
              { label: '牛客网', value: 'nowcoder' },
              { label: '企业官网', value: 'offerbiu' },
            ]} />
            <Select label="动作模式" value={batchForm.action} onChange={(v) => setBatchForm({ ...batchForm, action: v as string })} clearable style={{ marginBottom: 10 }} options={[
              { label: '批量连投(旧·按匹配分筛选)', value: '' },
              { label: '一键批量投递(不过滤·auto)', value: 'auto' },
              { label: '关键词批量投递(keyword)', value: 'keyword' },
              { label: '仅搜索收集岗位(search)', value: 'search' },
              { label: '发求职信(letter)', value: 'letter' },
              { label: 'HR 复聊(again)', value: 'again' },
            ]} />
            {batchForm.action === 'again' && (
              <Input label="HR 会话链接" value={batchForm.hrGroupId} onChange={(v) => setBatchForm({ ...batchForm, hrGroupId: v as string })} placeholder="HR 会话/消息组 URL（复聊用）" style={{ marginBottom: 10 }} />
            )}
            <Select label="岗位来源" value={batchForm.source} onChange={(v) => setBatchForm({ ...batchForm, source: v as string })} clearable style={{ marginBottom: 10 }} options={[
              { label: '全部', value: '' },
              { label: 'Offerbiu', value: 'offerbiu' },
              { label: '手动', value: 'manual' },
            ]} />
            <Input label="关键词" value={batchForm.keywords} onChange={(v) => setBatchForm({ ...batchForm, keywords: v as string })} placeholder="空格/逗号分隔，如 Java 深圳" style={{ marginBottom: 10 }} />
            <Input label="城市" value={batchForm.city} onChange={(v) => setBatchForm({ ...batchForm, city: v as string })} placeholder="如 深圳" style={{ marginBottom: 10 }} />
            <Input label="匹配分下限" value={batchForm.minScore} onChange={(v) => setBatchForm({ ...batchForm, minScore: v as string })} placeholder="0-100，留空不限制" style={{ marginBottom: 10 }} />
            <Input label="投递上限" value={batchForm.limit} onChange={(v) => setBatchForm({ ...batchForm, limit: v as string })} style={{ marginBottom: 10 }} />
            <Input label="间隔(ms)" value={batchForm.intervalMs} onChange={(v) => setBatchForm({ ...batchForm, intervalMs: v as string })} placeholder="两次投递间隔，默认20000" style={{ marginBottom: 10 }} />
            <Checkbox checked={batchForm.collect} onChange={(v) => setBatchForm({ ...batchForm, collect: v as boolean })}>投递前先从 Offerbiu 采集岗位</Checkbox>
            <p style={{ fontSize: 12, color: 'var(--td-text-color-placeholder)', marginTop: 8 }}>
              点击「开始连投」后若缺配置会弹窗要求填写；运行中遇滑块/验证码会弹窗提示你去浏览器窗口处理。
            </p>
          </>
        ) : (
          <div>
            <div style={{ marginBottom: 10, fontSize: 13 }}>
              进度：{batchProgress.index} / {batchProgress.total}
              {batchProgress.current && <span style={{ color: 'var(--td-text-color-secondary)', marginLeft: 8 }}>当前：{batchProgress.current}</span>}
            </div>
            <div style={{ fontSize: 12, maxHeight: 300, overflowY: 'auto', background: 'var(--td-bg-color-component)', padding: 10, borderRadius: 6 }}>
              {batchLog.length === 0 && <span style={{ color: 'var(--td-text-color-placeholder)' }}>准备中…</span>}
              {batchLog.map((l, i) => (
                <div key={i} style={{ color: l.status === 'ok' ? 'var(--td-success-color)' : l.status === 'err' ? 'var(--td-error-color)' : 'var(--td-warning-color)' }}>
                  {l.text}
                </div>
              ))}
            </div>
            <p style={{ fontSize: 12, color: 'var(--td-text-color-placeholder)', marginTop: 8 }}>
              运行中请勿关闭本弹窗；遇验证码会在新窗口弹出提示，处理完点「我已处理」即可。
            </p>
          </div>
        )}
      </Dialog>

      {/* 缺失配置：简历路径弹窗 */}
      <Dialog header="填写简历文件绝对路径" visible={showResumeDlg} onClose={() => setShowResumeDlg(false)} onConfirm={saveResume}>
        <Input value={resumeInput} onChange={(v) => setResumeInput(v as string)} placeholder="如 C:\Users\吉学静\Desktop\resume.pdf" />
        <p style={{ fontSize: 12, color: 'var(--td-text-color-placeholder)', marginTop: 8 }}>需本机真实存在的简历文件（PDF/Word），用于自动上传投递。</p>
      </Dialog>

      {/* 缺失配置：QQ 邮箱授权码弹窗 */}
      <Dialog header="填写 QQ 邮箱授权码" visible={showAuthDlg} onClose={() => setShowAuthDlg(false)} onConfirm={saveAuth}>
        <Input type="password" value={authInput} onChange={(v) => setAuthInput(v as string)} placeholder="QQ 邮箱设置→账户→IMAP 生成的 16 位授权码（非登录密码）" />
        <p style={{ fontSize: 12, color: 'var(--td-text-color-placeholder)', marginTop: 8 }}>用于自动读取登录验证码。当前邮箱：{profile?.email || '未填'}</p>
      </Dialog>

      {/* 运行期：需要人工输入/操作的弹窗 */}
      <Dialog
        header={inputDlg?.title || '需要你的操作'}
        visible={!!inputDlg}
        onClose={() => setInputDlg(null)}
        onConfirm={() => setInputDlg(null)}
        confirmBtn="我已处理"
      >
        {inputDlg && <div style={{ whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 1.7 }}>{inputDlg.body}</div>}
      </Dialog>

      {/* 手动添加岗位 */}
      <Dialog header="手动添加岗位" visible={showAdd} onClose={() => setShowAdd(false)} onConfirm={addJob}>
        <Input label="公司" value={addForm.company} onChange={(v) => setAddForm({ ...addForm, company: v as string })} style={{ marginBottom: 10 }} />
        <Input label="岗位" value={addForm.position} onChange={(v) => setAddForm({ ...addForm, position: v as string })} style={{ marginBottom: 10 }} />
        <Input label="城市" value={addForm.city} onChange={(v) => setAddForm({ ...addForm, city: v as string })} style={{ marginBottom: 10 }} />
        <Input label="薪资" value={addForm.salary} onChange={(v) => setAddForm({ ...addForm, salary: v as string })} style={{ marginBottom: 10 }} />
        <Input label="投递链接" value={addForm.applyUrl} onChange={(v) => setAddForm({ ...addForm, applyUrl: v as string })} style={{ marginBottom: 10 }} />
        <Input label="JD" value={addForm.jd} onChange={(v) => setAddForm({ ...addForm, jd: v as string })} />
      </Dialog>

      {/* 投递结果（含批量汇总） */}
      <Dialog header="投递结果" visible={showResult} onClose={() => setShowResult(false)} onConfirm={() => setShowResult(false)}>
        {result && (
          <div>
            <div style={{ marginBottom: 10 }}>
              <Tag theme={result.status === 'applied' ? 'success' : result.status === 'error' ? 'danger' : 'warning'} variant="light">
                {result.status || (Array.isArray(result.results) ? '批量' : '—')}
              </Tag>
              <span style={{ marginLeft: 8 }}>{result.message}</span>
            </div>
            {result.screenshot && (
              <img src={result.screenshot} alt="screenshot" style={{ maxWidth: '100%', borderRadius: 6, marginBottom: 10, border: '1px solid var(--td-component-border)' }} />
            )}
            <div style={{ fontSize: 12, maxHeight: 240, overflowY: 'auto', background: 'var(--td-bg-color-component)', padding: 10, borderRadius: 6 }}>
              {(result.logs || []).map((l: any, i: number) => (
                <div key={i} style={{ color: l.ok ? 'var(--td-success-color)' : 'var(--td-error-color)' }}>
                  {l.ok ? '✓' : '✗'} {l.step}{l.detail ? ` — ${l.detail}` : ''}
                </div>
              ))}
            </div>
            {result.status === 'need_captcha' && (
              <p style={{ marginTop: 8, fontSize: 12, color: 'var(--td-warning-color)' }}>
                请在自动打开的浏览器窗口中完成滑块/图形验证，然后再次点击对应平台的「投递」按钮即可继续。
              </p>
            )}
            {Array.isArray(result.results) && result.results.length > 0 && (
              <div style={{ fontSize: 12, maxHeight: 220, overflowY: 'auto', background: 'var(--td-bg-color-component)', padding: 10, borderRadius: 6, marginTop: 8 }}>
                {result.results.map((r: any, i: number) => (
                  <div key={i} style={{ color: r.status === 'applied' ? 'var(--td-success-color)' : r.status === 'error' ? 'var(--td-error-color)' : 'var(--td-warning-color)' }}>
                    {(r.status === 'applied' ? '✓' : r.status === 'error' ? '✗' : '•')} [{r.platform}] {r.company || ''} {r.position || ''} — {r.message}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </Dialog>
    </div>
  );
}

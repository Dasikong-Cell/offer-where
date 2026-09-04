import { useState, useEffect, useCallback } from 'react';
import { Input, Button, Textarea, MessagePlugin, Select, Tag, Loading, DialogPlugin } from 'tdesign-react';
import { SaveIcon, MailIcon, CheckCircleIcon, RefreshIcon } from 'tdesign-icons-react';

interface ProfileForm {
  name: string;
  gender: string;
  phone: string;
  email: string;
  age: string;
  city: string;
  expectedPositions: string;
  expectedCity: string;
  expectedSalary: string;
  workYears: string;
  education: string;
  school: string;
  major: string;
  skills: string;
  workExperience: string;
  projectExperience: string;
  selfIntro: string;
  resumePath: string;
  jobUrls: string;
}

const EMPTY_FORM: ProfileForm = {
  name: '', gender: '', phone: '', email: '', age: '', city: '',
  expectedPositions: '', expectedCity: '', expectedSalary: '', workYears: '',
  education: '', school: '', major: '', skills: '', workExperience: '',
  projectExperience: '', selfIntro: '', resumePath: '', jobUrls: '',
};

interface MailConfigState {
  email: string;
  authCode: string;
  imapHost: string;
  imapPort: number;
  useSsl: boolean;
  hasAuthCode: boolean;
}

const EMPTY_MAIL: MailConfigState = {
  email: '', authCode: '', imapHost: 'imap.qq.com', imapPort: 993, useSsl: true, hasAuthCode: false,
};

function Field({ label, required, hint, children }: {
  label: string; required?: boolean; hint?: string; children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--td-text-color-primary)' }}>
        {label}
        {required && <span style={{ color: 'var(--td-error-color)' }}> *</span>}
      </label>
      {children}
      {hint && (
        <p className="text-xs mt-1" style={{ color: 'var(--td-text-color-placeholder)' }}>{hint}</p>
      )}
    </div>
  );
}

function SectionTitle({ title, desc }: { title: string; desc: string }) {
  return (
    <div className="mb-4">
      <h3 className="text-base font-semibold" style={{ color: 'var(--td-text-color-primary)' }}>{title}</h3>
      <p className="text-xs mt-0.5" style={{ color: 'var(--td-text-color-placeholder)' }}>{desc}</p>
    </div>
  );
}

export function ProfilePage() {
  const [form, setForm] = useState<ProfileForm>(EMPTY_FORM);
  const [mail, setMail] = useState<MailConfigState>(EMPTY_MAIL);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [autofillRows, setAutofillRows] = useState<Array<{ id: string; label: string; value: string }>>([]);

  const seedAutofill = (af?: Record<string, string>): Array<{ id: string; label: string; value: string }> => {
    const defaults: Array<{ label: string; value: string }> = [
      { label: '籍贯', value: '' },
      { label: '健康状况', value: '' },
      { label: '婚姻状况', value: '' },
      { label: '身高(cm)', value: '' },
      { label: '体重(kg)', value: '' },
      { label: '院系', value: '' },
      { label: '受教育类型', value: '' },
      { label: '语言能力', value: '' },
    ];
    const merged = [...defaults];
    if (af) {
      for (const [k, v] of Object.entries(af)) {
        const hit = merged.find(r => r.label === k);
        if (hit) hit.value = String(v ?? '');
        else merged.push({ label: k, value: String(v ?? '') });
      }
    }
    return merged.map(r => ({ id: Math.random().toString(36).slice(2), ...r }));
  };

  const updateRow = (id: string, patch: Partial<{ label: string; value: string }>) =>
    setAutofillRows(prev => prev.map(r => (r.id === id ? { ...r, ...patch } : r)));
  const addRow = () => setAutofillRows(prev => [...prev, { id: Math.random().toString(36).slice(2), label: '', value: '' }]);
  const removeRow = (id: string) => setAutofillRows(prev => prev.filter(r => r.id !== id));

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [pRes, mRes] = await Promise.all([fetch('/api/profile'), fetch('/api/mail/config')]);
      const pData = await pRes.json();
      const mData = await mRes.json();

      const p = pData?.profile ?? {};
      setForm({ ...EMPTY_FORM, ...(p as Partial<ProfileForm>), resumePath: (p.resume_path as string) || (p.resumePath as string) || '' });
      setAutofillRows(seedAutofill(p.autofill as Record<string, string> | undefined));

      const m = mData?.config ?? {};
      setMail({
        email: m.email || '',
        authCode: '',
        imapHost: m.imapHost || 'imap.qq.com',
        imapPort: m.imapPort || 993,
        useSsl: m.useSsl !== false,
        hasAuthCode: Boolean(m.hasAuthCode),
      });
    } catch (e: any) {
      MessagePlugin.error(`加载失败：${e?.message || e}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const update = (key: keyof ProfileForm, value: string) => setForm(prev => ({ ...prev, [key]: value }));

  const handleSaveProfile = async () => {
    if (!form.name || !form.phone || !form.email) {
      MessagePlugin.warning('姓名、手机号、邮箱为必填项（登录招聘平台需要用到）');
      return;
    }
    setSaving(true);
    try {
      const autofill: Record<string, string> = {};
      for (const r of autofillRows) {
        if (r.label.trim() && r.value.trim()) autofill[r.label.trim()] = r.value.trim();
      }
      const res = await fetch('/api/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile: { ...form, resume_path: form.resumePath || undefined, autofill } }),
      });
      const data = await res.json();
      if (data?.success) MessagePlugin.success('档案已保存');
      else MessagePlugin.error(data?.error || '保存失败');
    } catch (e: any) {
      MessagePlugin.error(`保存失败：${e?.message || e}`);
    } finally {
      setSaving(false);
    }
  };

  const handleSaveMail = async () => {
    if (!mail.email) {
      MessagePlugin.warning('请填写邮箱地址');
      return;
    }
    if (!mail.authCode && !mail.hasAuthCode) {
      MessagePlugin.warning('请填写 IMAP 授权码（不是邮箱登录密码）');
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const payload: any = {
        email: mail.email,
        imapHost: mail.imapHost,
        imapPort: Number(mail.imapPort),
        useSsl: mail.useSsl,
      };
      if (mail.authCode) payload.authCode = mail.authCode;

      const res = await fetch('/api/mail/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (data?.test?.ok) {
        setTestResult({ ok: true, message: data.message || '邮箱连接成功' });
        MessagePlugin.success('邮箱配置已保存并验证通过');
        setMail(prev => ({ ...prev, authCode: '', hasAuthCode: true }));
      } else {
        setTestResult({ ok: false, message: data?.warning || data?.test?.error || '连接失败' });
        MessagePlugin.warning('配置已保存，但连接测试未通过');
      }
    } catch (e: any) {
      setTestResult({ ok: false, message: e?.message || '请求失败' });
    } finally {
      setTesting(false);
    }
  };

  const handleTestOnly = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch('/api/mail/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mail.authCode
          ? { email: mail.email, authCode: mail.authCode, imapHost: mail.imapHost, imapPort: mail.imapPort, useSsl: mail.useSsl }
          : {}),
      });
      const data = await res.json();
      setTestResult({ ok: Boolean(data?.ok), message: data?.ok ? `连接成功（${data.host}）` : (data?.error || '连接失败') });
    } catch (e: any) {
      setTestResult({ ok: false, message: e?.message || '请求失败' });
    } finally {
      setTesting(false);
    }
  };

  const openQqGuide = () => {
    const alert = DialogPlugin({
      header: 'QQ 邮箱授权码获取步骤',
      body: (
        <ol className="text-sm leading-7 pl-4" style={{ color: 'var(--td-text-color-secondary)' }}>
          <li>1. 登录 QQ 邮箱网页版（mail.qq.com）</li>
          <li>2. 顶部进入「设置」→「账户」</li>
          <li>3. 找到「POP3/IMAP/SMTP/Exchange/CardDAV/CalDAV服务」，开启「IMAP/SMTP服务」</li>
          <li>4. 按提示用密保手机发送短信验证，页面会生成一串 16 位「授权码」</li>
          <li>5. 把这串授权码粘贴到下方「IMAP 授权码」输入框（注意：不是 QQ 登录密码）</li>
        </ol>
      ),
      confirmBtn: '知道了',
      onConfirm: () => alert.hide(),
    });
  };

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loading size="large" text="加载中..." />
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-4xl mx-auto p-6 space-y-6">

        {/* 基本信息 */}
        <section className="rounded-xl p-6" style={{ backgroundColor: 'var(--td-bg-color-container)' }}>
          <SectionTitle title="基本信息" desc="Agent 登录招聘平台、填写申请表时会直接读取这些字段" />
          <div className="grid grid-cols-2 gap-4">
            <Field label="姓名" required><Input value={form.name} onChange={v => update('name', v as string)} placeholder="张三" /></Field>
            <Field label="性别"><Input value={form.gender} onChange={v => update('gender', v as string)} placeholder="男 / 女" /></Field>
            <Field label="手机号" required><Input value={form.phone} onChange={v => update('phone', v as string)} placeholder="13800138000" /></Field>
            <Field label="邮箱" required hint="招聘官网验证码登录时使用的邮箱，建议与下方邮箱配置一致">
              <Input value={form.email} onChange={v => update('email', v as string)} placeholder="123456@qq.com" />
            </Field>
            <Field label="年龄"><Input value={form.age} onChange={v => update('age', v as string)} placeholder="25" /></Field>
            <Field label="现居城市"><Input value={form.city} onChange={v => update('city', v as string)} placeholder="深圳" /></Field>
            <Field label="最高学历">
              <Select
                value={form.education || undefined}
                onChange={v => update('education', String(v ?? ''))}
                placeholder="请选择"
                options={['大专', '本科', '硕士', '博士', '其他'].map(o => ({ label: o, value: o }))}
                clearable
              />
            </Field>
            <Field label="工作年限"><Input value={form.workYears} onChange={v => update('workYears', v as string)} placeholder="3 年" /></Field>
            <Field label="毕业院校"><Input value={form.school} onChange={v => update('school', v as string)} placeholder="XX 大学" /></Field>
            <Field label="专业"><Input value={form.major} onChange={v => update('major', v as string)} placeholder="计算机科学与技术" /></Field>
          </div>
        </section>

        {/* 求职意向 */}
        <section className="rounded-xl p-6" style={{ backgroundColor: 'var(--td-bg-color-container)' }}>
          <SectionTitle title="求职意向" desc="Agent 检索岗位时的默认筛选条件" />
          <div className="grid grid-cols-2 gap-4">
            <Field label="期望岗位" required hint="多个岗位用顿号或逗号分隔，如：Java 后端、后端开发工程师">
              <Input value={form.expectedPositions} onChange={v => update('expectedPositions', v as string)} placeholder="Java 后端开发工程师" />
            </Field>
            <Field label="期望城市" hint="多个城市用逗号分隔"><Input value={form.expectedCity} onChange={v => update('expectedCity', v as string)} placeholder="深圳、广州" /></Field>
            <Field label="期望薪资"><Input value={form.expectedSalary} onChange={v => update('expectedSalary', v as string)} placeholder="15-25K" /></Field>
            <Field label="简历文件绝对路径" hint="投递遇到附件上传时，Agent 会用这个文件；留空则需要手动上传">
              <Input value={form.resumePath} onChange={v => update('resumePath', v as string)} placeholder="C:\\Users\\me\\resume.pdf" />
            </Field>
          </div>
        </section>

        {/* 能力经历 */}
        <section className="rounded-xl p-6" style={{ backgroundColor: 'var(--td-bg-color-container)' }}>
          <SectionTitle title="能力与经历" desc="Agent 填写开放式问题（自我介绍、项目描述）时只使用这里的真实素材" />
          <div className="space-y-4">
            <Field label="专业技能" hint="用逗号分隔，如：Java, Spring Boot, MySQL, Redis">
              <Textarea value={form.skills} onChange={v => update('skills', v as string)} autosize={{ minRows: 2 }} placeholder="Java, Spring Boot, MySQL, Redis, Kafka" />
            </Field>
            <Field label="工作经历"><Textarea value={form.workExperience} onChange={v => update('workExperience', v as string)} autosize={{ minRows: 4 }} placeholder="2021.07 - 至今  XX 公司  Java 后端工程师&#10;- 负责 XXX 系统设计与开发&#10;- 主导 XXX 重构，QPS 提升 3 倍" /></Field>
            <Field label="项目经历"><Textarea value={form.projectExperience} onChange={v => update('projectExperience', v as string)} autosize={{ minRows: 4 }} placeholder="项目名称 / 技术栈 / 职责 / 产出" /></Field>
            <Field label="自我评价"><Textarea value={form.selfIntro} onChange={v => update('selfIntro', v as string)} autosize={{ minRows: 3 }} placeholder="简短客观的自我介绍" /></Field>
            <Field label="常用招聘站点" hint="Agent 会优先去这些站点投递，每行一个">
              <Textarea value={form.jobUrls} onChange={v => update('jobUrls', v as string)} autosize={{ minRows: 3 }} placeholder="https://www.zhipin.com&#10;https://www.zhaopin.com" />
            </Field>
          </div>
        </section>

        {/* 智联简历必填项（自动填写） */}
        <section className="rounded-xl p-6" style={{ backgroundColor: 'var(--td-bg-color-container)' }}>
          <SectionTitle
            title="智联简历必填项（自动填写）"
            desc="投递智联校招岗时，简历里「个人信息 / 教育经历 / 语言能力」等模块常标着「未完成」而拦截投递。在这里按页面上的真实标签填好值，脚本会自动点「编辑」回填并保存。标签要和智联页面一致（如页面写「身高」就填「身高」，不要带单位）。"
          />
          <div className="space-y-3">
            <div className="grid grid-cols-[1fr_1.4fr_auto] gap-3 text-xs" style={{ color: 'var(--td-text-color-placeholder)' }}>
              <span>页面标签（如：籍贯 / 身高 / 婚姻状况）</span>
              <span>填写值（与页面选项/单位一致）</span>
              <span />
            </div>
            {autofillRows.map(r => (
              <div key={r.id} className="grid grid-cols-[1fr_1.4fr_auto] gap-3 items-center">
                <Input value={r.label} onChange={v => updateRow(r.id, { label: v as string })} placeholder="页面标签" />
                <Input value={r.value} onChange={v => updateRow(r.id, { value: v as string })} placeholder="填写值（如：未婚 / 175 / 云南省-昆明市）" />
                <Button variant="text" theme="danger" size="small" onClick={() => removeRow(r.id)}>删除</Button>
              </div>
            ))}
            <Button variant="outline" size="small" onClick={addRow}>+ 添加字段</Button>
          </div>
        </section>

        <div className="flex justify-end">
          <Button theme="primary" icon={<SaveIcon />} loading={saving} onClick={handleSaveProfile}>
            保存档案
          </Button>
        </div>

        {/* 邮箱验证码配置 */}
        <section className="rounded-xl p-6" style={{ backgroundColor: 'var(--td-bg-color-container)' }}>
          <div className="flex items-start justify-between mb-4">
            <SectionTitle title="邮箱验证码配置" desc="用于招聘官网「邮箱验证码登录」时自动读取验证码并回填" />
            <Button variant="text" theme="primary" size="small" onClick={openQqGuide}>
              QQ 邮箱授权码怎么拿？
            </Button>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Field label="邮箱地址" required>
              <Input value={mail.email} onChange={v => setMail(p => ({ ...p, email: v as string }))} placeholder="123456@qq.com" prefixIcon={<MailIcon />} />
            </Field>
            <Field label="IMAP 授权码" required hint={mail.hasAuthCode && !mail.authCode ? '已保存授权码，留空表示不修改' : '16 位授权码，不是邮箱登录密码'}>
              <Input type="password" value={mail.authCode} onChange={v => setMail(p => ({ ...p, authCode: v as string }))} placeholder={mail.hasAuthCode ? '已配置，留空则不修改' : '粘贴 16 位授权码'} />
            </Field>
            <Field label="IMAP 服务器"><Input value={mail.imapHost} onChange={v => setMail(p => ({ ...p, imapHost: v as string }))} placeholder="imap.qq.com" /></Field>
            <Field label="端口"><Input value={String(mail.imapPort)} onChange={v => setMail(p => ({ ...p, imapPort: Number(v) || 993 }))} placeholder="993" /></Field>
          </div>

          {testResult && (
            <div className="mt-4">
              <Tag theme={testResult.ok ? 'success' : 'danger'} variant="light" icon={testResult.ok ? <CheckCircleIcon /> : undefined}>
                {testResult.message}
              </Tag>
            </div>
          )}

          <div className="flex gap-3 mt-5">
            <Button theme="primary" icon={<SaveIcon />} loading={testing} onClick={handleSaveMail}>
              保存并验证连接
            </Button>
            <Button variant="outline" icon={<RefreshIcon />} loading={testing} onClick={handleTestOnly}>
              仅测试连接
            </Button>
          </div>
        </section>

      </div>
    </div>
  );
}

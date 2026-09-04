import { useState, useEffect, useCallback, useMemo } from 'react';
import { Button, Select, Tag, Loading, MessagePlugin, DialogPlugin, Input } from 'tdesign-react';
import { DeleteIcon, DownloadIcon, RefreshIcon, LinkIcon } from 'tdesign-icons-react';
import { PLATFORMS, APPLICATION_STATUS, PLATFORM_LABEL, STATUS_LABEL } from '../config';

interface Application {
  id: string;
  platform: string;
  company: string | null;
  position: string | null;
  salary: string | null;
  city: string | null;
  job_url: string | null;
  status: string;
  login_method: string | null;
  message: string | null;
  created_at: string;
  updated_at: string;
}

const STATUS_THEME: Record<string, 'default' | 'primary' | 'success' | 'warning' | 'danger'> = {
  pending: 'default',
  applied: 'primary',
  interview: 'success',
  offer: 'success',
  failed: 'danger',
  need_human: 'warning',
  rejected: 'default',
};

function statusTheme(status: string) {
  return STATUS_THEME[status] || 'default';
}

function formatTime(iso: string) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function ApplicationsPage() {
  const [list, setList] = useState<Application[]>([]);
  const [loading, setLoading] = useState(true);
  const [platformFilter, setPlatformFilter] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [keyword, setKeyword] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (platformFilter) params.set('platform', platformFilter);
      if (statusFilter) params.set('status', statusFilter);
      const res = await fetch(`/api/applications?${params.toString()}`);
      const data = await res.json();
      setList(data?.applications ?? []);
    } catch (e: any) {
      MessagePlugin.error(`加载失败：${e?.message || e}`);
    } finally {
      setLoading(false);
    }
  }, [platformFilter, statusFilter]);

  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    if (!keyword.trim()) return list;
    const kw = keyword.trim().toLowerCase();
    return list.filter(a =>
      [a.company, a.position, a.city, a.message].some(v => (v || '').toLowerCase().includes(kw))
    );
  }, [list, keyword]);

  const stats = useMemo(() => {
    const s: Record<string, number> = {};
    for (const a of list) s[a.status] = (s[a.status] || 0) + 1;
    return s;
  }, [list]);

  const updateStatus = async (id: string, status: string) => {
    try {
      const res = await fetch(`/api/applications/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) throw new Error('更新失败');
      setList(prev => prev.map(a => (a.id === id ? { ...a, status } : a)));
    } catch (e: any) {
      MessagePlugin.error(e?.message || '更新失败');
    }
  };

  const remove = (item: Application) => {
    const dialog = DialogPlugin.confirm({
      header: '删除记录',
      body: `确认删除「${item.company || '未知公司'} - ${item.position || '未知岗位'}」这条投递记录？`,
      confirmBtn: { theme: 'danger', content: '删除' },
      onConfirm: async () => {
        const res = await fetch(`/api/applications/${item.id}`, { method: 'DELETE' });
        const data = await res.json();
        if (data?.success) {
          MessagePlugin.success('已删除');
          load();
        }
        dialog.hide();
      },
    });
  };

  const exportCsv = () => {
    if (filtered.length === 0) {
      MessagePlugin.warning('没有可导出的记录');
      return;
    }
    const header = ['平台', '公司', '岗位', '薪资', '城市', '状态', '时间', '备注', '岗位链接'];
    const escape = (v: string) => `"${(v || '').replace(/"/g, '""')}"`;
    const rows = filtered.map(a => [
      PLATFORM_LABEL[a.platform] || a.platform,
      a.company, a.position, a.salary, a.city,
      STATUS_LABEL[a.status] || a.status,
      formatTime(a.created_at), a.message, a.job_url,
    ].map(v => escape(String(v ?? ''))).join(','));

    // BOM 保证 Excel 打开中文不乱码
    const csv = '\uFEFF' + [header.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `投递记录_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-6xl mx-auto p-6">

        {/* 统计卡 */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
          <div className="rounded-xl p-4" style={{ backgroundColor: 'var(--td-bg-color-container)' }}>
            <div className="text-xs mb-1" style={{ color: 'var(--td-text-color-placeholder)' }}>总投递记录</div>
            <div className="text-2xl font-semibold" style={{ color: 'var(--td-text-color-primary)' }}>{list.length}</div>
          </div>
          {APPLICATION_STATUS.filter(s => ['applied', 'interview', 'need_human'].includes(s.value)).map(s => (
            <div key={s.value} className="rounded-xl p-4" style={{ backgroundColor: 'var(--td-bg-color-container)' }}>
              <div className="text-xs mb-1" style={{ color: 'var(--td-text-color-placeholder)' }}>{s.label}</div>
              <div className="text-2xl font-semibold" style={{ color: 'var(--td-text-color-primary)' }}>{stats[s.value] || 0}</div>
            </div>
          ))}
        </div>

        {/* 工具栏 */}
        <div className="flex flex-wrap items-center gap-3 mb-4">
          <Select
            value={platformFilter || undefined}
            onChange={v => setPlatformFilter(String(v ?? ''))}
            placeholder="全部平台"
            clearable
            style={{ width: 150 }}
            options={PLATFORMS.map(p => ({ label: p.label, value: p.value }))}
          />
          <Select
            value={statusFilter || undefined}
            onChange={v => setStatusFilter(String(v ?? ''))}
            placeholder="全部状态"
            clearable
            style={{ width: 150 }}
            options={APPLICATION_STATUS.map(s => ({ label: s.label, value: s.value }))}
          />
          <Input
            value={keyword}
            onChange={v => setKeyword(String(v ?? ''))}
            placeholder="搜索公司 / 岗位 / 城市"
            clearable
            style={{ width: 220 }}
          />
          <div className="flex-1" />
          <Button variant="outline" icon={<RefreshIcon />} onClick={load}>刷新</Button>
          <Button variant="outline" icon={<DownloadIcon />} onClick={exportCsv}>导出 CSV</Button>
        </div>

        {/* 列表 */}
        <div className="rounded-xl overflow-hidden" style={{ backgroundColor: 'var(--td-bg-color-container)' }}>
          {loading ? (
            <div className="py-16 flex justify-center"><Loading size="large" text="加载中..." /></div>
          ) : filtered.length === 0 ? (
            <div className="py-16 text-center" style={{ color: 'var(--td-text-color-placeholder)' }}>
              暂无投递记录。回到对话页让 Agent 开始投递，记录会自动出现在这里。
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr style={{ backgroundColor: 'var(--td-bg-color-component)' }}>
                  {['平台', '公司', '岗位', '薪资', '城市', '状态', '时间', '备注', '操作'].map(h => (
                    <th key={h} className="text-left px-4 py-3 font-medium" style={{ color: 'var(--td-text-color-secondary)' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map(item => (
                  <tr key={item.id} style={{ borderTop: '1px solid var(--td-component-border)' }}>
                    <td className="px-4 py-3">
                      <Tag variant="light" theme="primary">{PLATFORM_LABEL[item.platform] || item.platform}</Tag>
                    </td>
                    <td className="px-4 py-3" style={{ color: 'var(--td-text-color-primary)' }}>{item.company || '-'}</td>
                    <td className="px-4 py-3" style={{ color: 'var(--td-text-color-primary)' }}>
                      <div className="flex items-center gap-1.5">
                        <span>{item.position || '-'}</span>
                        {item.job_url && (
                          <a href={item.job_url} target="_blank" rel="noreferrer" style={{ color: 'var(--td-brand-color)' }}>
                            <LinkIcon size={14} />
                          </a>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3" style={{ color: 'var(--td-text-color-secondary)' }}>{item.salary || '-'}</td>
                    <td className="px-4 py-3" style={{ color: 'var(--td-text-color-secondary)' }}>{item.city || '-'}</td>
                    <td className="px-4 py-3">
                      <Select
                        value={item.status}
                        onChange={v => updateStatus(item.id, String(v))}
                        style={{ width: 110 }}
                        size="small"
                        options={APPLICATION_STATUS.map(s => ({ label: s.label, value: s.value }))}
                      />
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap" style={{ color: 'var(--td-text-color-placeholder)' }}>
                      {formatTime(item.created_at)}
                    </td>
                    <td className="px-4 py-3 max-w-[220px] truncate" style={{ color: 'var(--td-text-color-secondary)' }} title={item.message || ''}>
                      {item.message || '-'}
                    </td>
                    <td className="px-4 py-3">
                      <Button variant="text" shape="circle" theme="danger" icon={<DeleteIcon />} onClick={() => remove(item)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {!loading && filtered.length > 0 && (
          <p className="text-xs mt-3 text-right" style={{ color: 'var(--td-text-color-placeholder)' }}>
            共 {filtered.length} 条记录
          </p>
        )}
      </div>
    </div>
  );
}

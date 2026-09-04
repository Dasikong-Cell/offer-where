import { Input } from 'tdesign-react';
import { FolderOpenIcon } from 'tdesign-icons-react';
import { Bot } from 'lucide-react';
import { APP_CONFIG } from '../config';
import { Model, Agent, PermissionMode } from '../types';
import { ICON_MAP } from '../utils/iconMap';

/** 快捷指令：一键填充到输入框 */
const QUICK_PROMPTS = [
  '帮我在 BOSS 直聘上投递「Java 后端开发工程师」，城市深圳，薪资 15-25K，最多投 15 个',
  '先去智联招聘登录（用邮箱验证码），然后筛选广州的后端岗位，给出匹配度评分',
  '打开前程无忧，搜索「Java 开发」，把前 10 个匹配岗位整理成表格并逐个投递',
  '检查这几个平台的登录状态：BOSS直聘、智联招聘、前程无忧',
];

interface NewChatViewProps {
  agents: Agent[];
  models: Model[];
  selectedModel: string;
  newChatAgentId: string;
  newChatCwd: string;
  newChatPermissionMode: PermissionMode;
  onSelectModel: (modelId: string) => void;
  onSelectAgent: (agentId: string) => void;
  onSetCwd: (cwd: string) => void;
  onSetPermissionMode: (mode: PermissionMode) => void;
  onQuickPrompt?: (text: string) => void;
}

export function NewChatView({
  agents,
  newChatAgentId,
  newChatCwd,
  onSelectAgent,
  onSetCwd,
  onSetPermissionMode,
  onQuickPrompt,
}: NewChatViewProps) {
  const selectedAgent = agents.find(a => a.id === newChatAgentId);

  return (
    <div className="flex flex-col items-center justify-center min-h-full py-8">
      <div className="w-full max-w-lg">
        {/* Logo 和标题 */}
        <div className="text-center mb-8">
          <div 
            className="w-16 h-16 rounded-2xl flex items-center justify-center mb-4 shadow-lg mx-auto"
            style={{ 
              background: 'linear-gradient(135deg, var(--td-brand-color), var(--td-brand-color-hover))'
            }}
          >
            <span className="text-3xl font-bold text-white">{APP_CONFIG.nameInitial}</span>
          </div>
          <h2 
            className="text-2xl font-semibold mb-2"
            style={{ color: 'var(--td-text-color-primary)' }}
          >
            {APP_CONFIG.name}
          </h2>
          <p style={{ color: 'var(--td-text-color-secondary)' }}>
            选择一个 Agent 开始对话
          </p>
        </div>
        
        {/* Agent 选择 */}
        <div className="mb-6">
          <label className="block text-sm font-medium mb-3" style={{ color: 'var(--td-text-color-primary)' }}>
            选择 Agent
          </label>
          <div className="grid grid-cols-2 gap-3 max-h-[280px] overflow-y-auto">
            {agents.map(agent => {
              const AgentIcon = ICON_MAP[agent.icon || 'Bot'] || Bot;
              const isSelected = agent.id === newChatAgentId;
              return (
                <div
                  key={agent.id}
                  className="p-3 rounded-xl cursor-pointer transition-all border-2"
                  style={{
                    borderColor: isSelected ? (agent.color || 'var(--td-brand-color)') : 'transparent',
                    backgroundColor: isSelected ? 'var(--td-brand-color-light)' : 'var(--td-bg-color-component)',
                  }}
                  onClick={() => {
                    onSelectAgent(agent.id);
                    // 自动应用 Agent 的默认权限模式
                    if (agent.permissionMode) {
                      onSetPermissionMode(agent.permissionMode);
                    }
                  }}
                >
                  <div className="flex items-center gap-3">
                    <div 
                      className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0"
                      style={{ backgroundColor: agent.color || '#0052d9' }}
                    >
                      <AgentIcon size={20} color="white" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate" style={{ color: 'var(--td-text-color-primary)' }}>
                        {agent.name}
                      </div>
                      {agent.description && (
                        <div className="text-xs truncate mt-0.5" style={{ color: 'var(--td-text-color-placeholder)' }}>
                          {agent.description}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* 工作目录 */}
        <div className="mb-6">
          <label className="block text-sm font-medium mb-2" style={{ color: 'var(--td-text-color-primary)' }}>
            工作目录 <span style={{ color: 'var(--td-text-color-placeholder)' }}>(可选)</span>
          </label>
          <Input
            value={newChatCwd}
            onChange={(v) => onSetCwd(v as string)}
            placeholder="例如：/Users/username/projects/my-app"
            prefixIcon={<FolderOpenIcon />}
          />
          <p className="text-xs mt-1.5" style={{ color: 'var(--td-text-color-placeholder)' }}>
            指定 Agent 的工作目录，用于文件操作等
          </p>
        </div>

        {/* 选中的 Agent 预览 */}
        {selectedAgent && (
          <div 
            className="p-4 rounded-xl"
            style={{ backgroundColor: 'var(--td-bg-color-component)' }}
          >
            <div className="flex items-center gap-2 mb-2">
              {(() => {
                const Icon = ICON_MAP[selectedAgent.icon || 'Bot'] || Bot;
                return (
                  <>
                    <div 
                      className="w-6 h-6 rounded-md flex items-center justify-center"
                      style={{ backgroundColor: selectedAgent.color || '#0052d9' }}
                    >
                      <Icon size={14} color="white" />
                    </div>
                    <span className="text-sm font-medium" style={{ color: 'var(--td-text-color-primary)' }}>
                      {selectedAgent.name}
                    </span>
                  </>
                );
              })()}
            </div>
            <p className="text-xs line-clamp-2" style={{ color: 'var(--td-text-color-secondary)' }}>
              {selectedAgent.systemPrompt}
            </p>
          </div>
        )}
        
        {/* 快捷指令 */}
        {onQuickPrompt && (
          <div className="mb-6">
            <label className="block text-sm font-medium mb-3" style={{ color: 'var(--td-text-color-primary)' }}>
              快捷指令
            </label>
            <div className="space-y-2">
              {QUICK_PROMPTS.map(text => (
                <div
                  key={text}
                  className="px-3 py-2.5 rounded-lg cursor-pointer text-sm transition-colors"
                  style={{
                    backgroundColor: 'var(--td-bg-color-component)',
                    color: 'var(--td-text-color-secondary)',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor = 'var(--td-bg-color-component-hover)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = 'var(--td-bg-color-component)';
                  }}
                  onClick={() => onQuickPrompt(text)}
                >
                  {text}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 提示文字 */}
        <p className="text-center text-xs mt-6" style={{ color: 'var(--td-text-color-placeholder)' }}>
          开始前请先到「我的档案」填写简历信息并配置邮箱验证码，模型和权限模式可在输入框下方切换
        </p>
      </div>
    </div>
  );
}

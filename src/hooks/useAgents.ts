import { useState, useEffect, useCallback } from 'react';
import { CustomAgent } from '../types';
import { v4 as uuidv4 } from 'uuid';
import { JOB_APPLY_AGENT_PROMPT, JOB_ANALYST_AGENT_PROMPT } from '../../shared/agentPrompt';

const STORAGE_KEY = 'customAgents';

// 内置的简历自动投递 Agent（默认）
const DEFAULT_AGENT: CustomAgent = {
  id: 'default',
  name: '简历自动投递助手',
  description: '自动登录招聘平台、检索岗位、投递简历并记录进度',
  systemPrompt: JOB_APPLY_AGENT_PROMPT,
  icon: 'Briefcase',
  color: '#0052d9',
  createdAt: new Date(),
  updatedAt: new Date(),
};

// 内置的岗位匹配分析师
const ANALYST_AGENT: CustomAgent = {
  id: 'job-analyst',
  name: '岗位匹配分析师',
  description: '投递前先筛岗位：匹配度评分、风险提示、简历优化建议',
  systemPrompt: JOB_ANALYST_AGENT_PROMPT,
  icon: 'Search',
  color: '#00a6a7',
  createdAt: new Date(),
  updatedAt: new Date(),
};

// 内置 Agent 的基础定义（用于版本升级时刷新提示词）
const BUILTIN_AGENTS: CustomAgent[] = [DEFAULT_AGENT, ANALYST_AGENT];

export function useAgents() {
  const [agents, setAgents] = useState<CustomAgent[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        const custom = parsed
          .filter((a: any) => a.id !== 'default' && a.id !== 'job-analyst')
          .map((a: any) => ({
            ...a,
            createdAt: new Date(a.createdAt),
            updatedAt: new Date(a.updatedAt),
          }));
        // 内置 Agent 始终使用最新提示词
        return [...BUILTIN_AGENTS, ...custom];
      }
    } catch (e) {
      console.error('Failed to load agents:', e);
    }
    return BUILTIN_AGENTS;
  });

  // 首次加载时把内置 Agent 写回 localStorage，保证刷新后顺序稳定
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    const custom = saved ? JSON.parse(saved).filter((a: any) => a.id !== 'default' && a.id !== 'job-analyst') : [];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(custom));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 保存到 localStorage（排除内置 agent）
  const saveAgents = useCallback((newAgents: CustomAgent[]) => {
    const toSave = newAgents.filter(a => a.id !== 'default' && a.id !== 'job-analyst');
    localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
  }, []);

  const addAgent = useCallback((agent: Omit<CustomAgent, 'id' | 'createdAt' | 'updatedAt'>) => {
    const newAgent: CustomAgent = {
      ...agent,
      id: uuidv4(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    setAgents(prev => {
      const updated = [...prev, newAgent];
      saveAgents(updated);
      return updated;
    });
    return newAgent;
  }, [saveAgents]);

  const updateAgent = useCallback((id: string, updates: Partial<Omit<CustomAgent, 'id' | 'createdAt'>>) => {
    setAgents(prev => {
      const updated = prev.map(a =>
        a.id === id ? { ...a, ...updates, updatedAt: new Date() } : a
      );
      saveAgents(updated);
      return updated;
    });
  }, [saveAgents]);

  const deleteAgent = useCallback((id: string) => {
    if (id === 'default' || id === 'job-analyst') return; // 内置 agent 不可删除
    setAgents(prev => {
      const updated = prev.filter(a => a.id !== id);
      saveAgents(updated);
      return updated;
    });
  }, [saveAgents]);

  const getAgent = useCallback((id: string) => {
    return agents.find(a => a.id === id) || agents.find(a => a.id === 'default');
  }, [agents]);

  return {
    agents,
    addAgent,
    updateAgent,
    deleteAgent,
    getAgent,
    defaultAgent: DEFAULT_AGENT,
  };
}

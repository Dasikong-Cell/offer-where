/**
 * 应用配置文件
 * 统一管理应用名称和其他全局配置
 */

export const APP_CONFIG = {
  /** 应用名称 */
  name: '简历投递 Agent',

  /** 应用名称首字母（用于 Logo） */
  nameInitial: 'J',

  /** 应用描述 */
  description: '自动登录招聘平台、检索岗位、投递简历',

  /** 版本号 */
  version: '1.0.0',
};

/** 支持的招聘平台 */
export const PLATFORMS = [
  { value: 'boss', label: 'BOSS直聘', color: '#00a6a7' },
  { value: 'zhaopin', label: '智联招聘', color: '#3d7eff' },
  { value: 'job51', label: '前程无忧', color: '#ff6b00' },
  { value: 'official', label: '企业招聘官网', color: '#7c5cff' },
  { value: 'other', label: '其他平台', color: '#8c8c8c' },
] as const;

export const PLATFORM_LABEL: Record<string, string> = PLATFORMS.reduce(
  (acc, p) => ({ ...acc, [p.value]: p.label }),
  {} as Record<string, string>
);

/** 投递状态 */
export const APPLICATION_STATUS = [
  { value: 'pending', label: '待投递', theme: 'default' as const },
  { value: 'applied', label: '已投递', theme: 'primary' as const },
  { value: 'interview', label: '已约面', theme: 'success' as const },
  { value: 'offer', label: '已 Offer', theme: 'success' as const },
  { value: 'failed', label: '投递失败', theme: 'danger' as const },
  { value: 'need_human', label: '需人工', theme: 'warning' as const },
  { value: 'rejected', label: '已淘汰', theme: 'default' as const },
] as const;

export const STATUS_LABEL: Record<string, string> = APPLICATION_STATUS.reduce(
  (acc, s) => ({ ...acc, [s.value]: s.label }),
  {} as Record<string, string>
);

export default APP_CONFIG;

/**
 * 本机环境探测：Chrome 路径等「与机器绑定」的事实，集中一处。
 *
 * 背景：`browserHealth.ts` 的兜底里曾硬编码开发机的绝对路径
 * （`C:/Users/<作者>/AppData/Local/Google/Chrome/Application/chrome.exe`），
 * 分发给他人后 Chrome 缺失时会拿这个路径去 spawn、必然失败，农场自愈静默失效。
 * 检测顺序与 `setenv.bat` 保持一致，避免「启动器能找到 Chrome、服务进程找不到」的错位。
 */
import fs from 'fs';
import path from 'path';

/** 按标准安装位置探测 Chrome，返回绝对路径；都找不到返回 null。 */
export function detectChromePath(): string | null {
  const env = process.env;
  const candidates = [
    env['ProgramFiles'] && path.join(env['ProgramFiles'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
    env['ProgramFiles(x86)'] && path.join(env['ProgramFiles(x86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
    env['LOCALAPPDATA'] && path.join(env['LOCALAPPDATA'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ].filter(Boolean) as string[];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch { /* 忽略权限等异常 */ }
  }
  return null;
}

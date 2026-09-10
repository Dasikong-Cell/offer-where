/**
 * 各平台「浏览器连接」探测
 *
 * 投递能否真正执行，取决于对应平台的真实 Chrome 调试窗口是否已打开
 * （data/browser/cdp.json 中为每平台配置了独立调试端口，如 BOSS=9223）。
 * 本模块逐一探测这些 CDP 端口是否可达（/json/version 能返回），
 * 用于控制台「自动识别有连接的投递」：只勾选/只投递已连接的平台，
 * 自动跳过未打开 Chrome 窗口的平台，避免空跑报错。
 *
 * 注意：这里的「连接」= 该平台的调试 Chrome 窗口已启动且端口可达。
 * 不探测登录态 —— 因为命中 CDP 后新开标签会被 BOSS/猎聘判为未登录
 * （养熟标签才认登录态），用新标签探登录会误报，且易触发反爬。
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_ROOT = path.join(__dirname, '..', '..', 'data', 'browser');
const CDP_CONFIG_PATH = path.join(DATA_ROOT, 'cdp.json');

/** 控制台可投递平台（与 public/console.html 的 PLATFORMS 保持一致） */
export const DELIVERY_PLATFORMS = ['boss', 'job51', 'liepin', 'zhilian'];

function getCdpEndpoint(key: string): string | null {
  try {
    if (!fs.existsSync(CDP_CONFIG_PATH)) return null;
    const cfg = JSON.parse(fs.readFileSync(CDP_CONFIG_PATH, 'utf-8'));
    const ep = cfg && typeof cfg === 'object' ? cfg[key] : null;
    return typeof ep === 'string' && ep.trim() ? ep.trim() : null;
  } catch {
    return null;
  }
}

function httpGetJson(url: string, timeoutMs = 2000): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'GET' }, res => {
      let d = '';
      res.on('data', (c: any) => (d += c));
      res.on('end', () => {
        try { resolve(d ? JSON.parse(d) : {}); } catch { reject(new Error('bad json')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

export interface PlatformConnection {
  platform: string;
  endpoint: string | null;
  connected: boolean;
  browser?: string;
  error?: string;
}

/** 探测全部可投递平台的 CDP 端口是否可达，返回 { platform: {connected,...} } */
export async function probePlatformConnections(): Promise<Record<string, PlatformConnection>> {
  const result: Record<string, PlatformConnection> = {};
  await Promise.all(
    DELIVERY_PLATFORMS.map(async (platform) => {
      const endpoint = getCdpEndpoint(platform);
      if (!endpoint) {
        result[platform] = { platform, endpoint: null, connected: false, error: '未配置 CDP 端口' };
        return;
      }
      try {
        const ver = await httpGetJson(`${endpoint}/json/version`, 2000);
        result[platform] = {
          platform,
          endpoint,
          connected: true,
          browser: typeof ver?.Browser === 'string' ? ver.Browser : undefined,
        };
      } catch (e: any) {
        result[platform] = {
          platform,
          endpoint,
          connected: false,
          error: e?.message || '连接失败',
        };
      }
    })
  );
  return result;
}

/**
 * 各平台「浏览器连接」探测
 *
 * 投递能否真正执行，取决于对应平台的真实 Chrome 调试窗口是否已打开
 * （端口表见 `platformPorts.ts`；`data/browser/cdp.json` 可按需覆盖）。
 * 本模块逐一探测这些 CDP 端口是否可达（/json/version 能返回），
 * 用于控制台「自动识别有连接的投递」：只勾选/只投递已连接的平台，
 * 自动跳过未打开 Chrome 窗口的平台，避免空跑报错。
 *
 * 注意：这里的「连接」= 该平台的调试 Chrome 窗口已启动且端口可达。
 * 不探测登录态 —— 因为命中 CDP 后新开标签会被 BOSS/猎聘判为未登录
 * （养熟标签才认登录态），用新标签探登录会误报，且易触发反爬。
 */
import http from 'http';
import { resolveCdpEndpoint } from './platformPorts.js';

/**
 * 控制台可投递平台（与 `public/console.html` 的 PLATFORMS、`platformPorts.ts` 的
 * `DEFAULT_CDP_PORTS` 保持一致）
 *  offerbiu = 企业官网通道（offerbiu.com 采集 + 企业官网表单投递），与 official 共用 9227 窗口。
 *  ⚠️ 新增平台必须同步：types.ts / platformPorts.ts / console.html / start_platforms.bat
 *     （合约测试「平台注册完整性」会校验一致性）。 */
export const DELIVERY_PLATFORMS = [
  'boss', 'job51', 'liepin', 'zhilian', 'offerbiu', 'nowcoder',
  // 2026-09-21 新增登记（窗口/巡检已就绪，采集与投递实现待各自实机校准）
  'easyzhipin', 'job58', 'chinahr', 'dianzhang', 'yupao', 'maimai', 'ganji', 'iguopin', 'yingjiesheng',
];

/**
 * 取平台 CDP 端点。**统一走 `platformPorts.ts`**：
 * `cdp.json` 覆盖值 > 内置默认端口（与启动脚本一致）。
 *
 * 历史坑：本文件此前自带一份「文件不存在就返回 null」的实现 —— 而 `data/` 不随分发包走，
 * 于是新机器上所有平台都判为「未配置 CDP 端口」。端口表已收敛为一份，勿再本地复制逻辑。
 */
function getCdpEndpoint(key: string): string | null {
  return resolveCdpEndpoint(key);
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

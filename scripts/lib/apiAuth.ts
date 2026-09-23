/**
 * 脚本侧访问令牌（与 server/services/authToken.ts 共用同一文件）
 * ==========================================================================
 * 服务端启用鉴权时（REQUIRE_AUTH=1 或 HOST 非回环），写接口需带 `X-Auth-Token`。
 * 本模块从 `data/.auth_token` 读取令牌，供各脚本的 fetch 复用。
 * 未启用鉴权时文件可能不存在 → 返回空对象，调用方无感。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_PATH = path.join(__dirname, '..', '..', 'data', '.auth_token');

/** 读取令牌对应的请求头；读不到则返回 {}（未启用鉴权时正常） */
export function authHeaders(): Record<string, string> {
  try {
    const t = String(fs.readFileSync(TOKEN_PATH, 'utf8')).trim();
    return t ? { 'X-Auth-Token': t } : {};
  } catch {
    return {};
  }
}

/** 便捷合并：authHeaders({...自定义头}) */
export function withAuth(headers: Record<string, string> = {}): Record<string, string> {
  return Object.assign({}, headers, authHeaders());
}

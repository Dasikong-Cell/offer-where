/**
 * 极简 .env 加载器（无第三方依赖）
 * ─────────────────────────────────────────────────────────────
 * 本服务以 `tsx server/index.ts` 直接运行，Node 默认不会读取项目根目录的 .env。
 * 这里手动解析 .env 注入 process.env，使 LLM_ / MAIL_ / CODEBUDDY_ 等配置真正生效。
 *
 * 设计：
 *  - 只在变量「尚未存在于环境」时写入，避免覆盖 shell 已导出的真实值。
 *  - 任何解析失败都静默忽略，绝不影响主流程。
 *  - 在 server/index.ts 最顶部 `import './env.js'` 触发，先于其它模块求值。
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

export function loadEnvFile(): void {
  const p = resolve(process.cwd(), '.env');
  if (!existsSync(p)) return;
  try {
    const txt = readFileSync(p, 'utf8');
    for (const raw of txt.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      const key = m[1];
      let val = m[2].trim();
      // 去首尾引号
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = val;
    }
  } catch {
    /* 忽略解析错误 */
  }
}

loadEnvFile();

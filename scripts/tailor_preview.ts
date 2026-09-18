/**
 * 一岗一简历 —— 命令行预览
 * ==========================================================================
 * 便捷验证「按 JD 定制简历」效果，不依赖前端与后端服务。
 *
 * 用法：
 *   # 指定岗位 id
 *   ./node/node.exe node_modules/tsx/dist/cli.mjs scripts/tailor_preview.ts <jobId>
 *   # 或按来源取匹配分最高的 N 个岗位
 *   ./node/node.exe node_modules/tsx/dist/cli.mjs scripts/tailor_preview.ts --source boss --limit 3
 *   # 也可直接用一段 JD 试跑（无需入库）
 *   ./node/node.exe node_modules/tsx/dist/cli.mjs scripts/tailor_preview.ts --jd "招聘Java开发，要求Spring Boot/MySQL/Redis" --position "Java开发工程师"
 */
import '../server/env.js'; // 载入 .env（LLM_* 生效）
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { tailorResume } from '../server/services/apply/resumeTailor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(path.join(__dirname, '..', 'data', 'chat.db'));

const profileRow = db.prepare('SELECT data FROM profile LIMIT 1').get() as any;
const profile: Record<string, any> = profileRow?.data ? JSON.parse(profileRow.data) : {};

const args = process.argv.slice(2);
const getFlag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

let jobs: Array<{ id?: string; company?: string | null; position?: string | null; jd?: string | null; requirements?: string | null }> = [];

if (getFlag('--jd')) {
  jobs = [{ position: getFlag('--position') || '目标岗位', jd: getFlag('--jd'), requirements: getFlag('--requirements') }];
} else if (args[0] && !args[0].startsWith('--')) {
  const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(args[0]) as any;
  if (!row) { console.error('岗位不存在：' + args[0]); process.exit(1); }
  jobs = [row];
} else {
  const source = getFlag('--source');
  const limit = Number(getFlag('--limit') || 3);
  const sql = source
    ? "SELECT * FROM jobs WHERE source = ? AND status = 'candidate' ORDER BY COALESCE(match_score,-1) DESC LIMIT ?"
    : "SELECT * FROM jobs WHERE status = 'candidate' ORDER BY COALESCE(match_score,-1) DESC LIMIT ?";
  jobs = (source ? db.prepare(sql).all(source, limit) : db.prepare(sql).all(limit)) as any[];
}

if (!jobs.length) { console.error('没有可用岗位，请传 jobId / --jd / --source'); process.exit(1); }

console.log(`档案：${profile.name || '(未填)'} ｜ 技能 ${String(profile.skills || '').split(/[,，、;；/|]+/).filter(Boolean).length} 项 ｜ 岗位 ${jobs.length} 个\n`);

for (const j of jobs) {
  const r = await tailorResume(profile, j);
  console.log(r.markdown);
  console.log('\n' + '─'.repeat(72) + '\n');
}
console.log(`完成：${jobs.length} 份定制简历（LLM ${jobs.length && '按需调用；失败自动回退本地规则'}）`);
db.close();
process.exit(0);

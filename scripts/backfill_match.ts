/**
 * 回填岗位匹配分（规则引擎，零 LLM 成本）
 * 仅对 match_score 为空的岗位用本地 matchResumeToJob 计算，让投递漏斗看板的「匹配度」覆盖全池。
 * 精准语义评分仍可用 /api/jobs/match（走 LLM）按需触发。
 *
 * 运行：node 后用 tsx 跑 -> tsx scripts/backfill_match.ts
 */
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { matchResumeToJob } from '../server/services/match.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(path.join(__dirname, '..', 'data', 'chat.db'));

// 简历背景：用档案里的技能 + 基本资料拼一段归一化文本（无需解析 PDF）
const profileRow = db.prepare("SELECT data FROM profile LIMIT 1").get() as any;
const p: Record<string, any> = profileRow?.data ? JSON.parse(profileRow.data) : {};
const resumeSkills: string[] = String(p.skills || p.pfSkills || '').split(/[,，、\s]+/).map((s: string) => s.trim()).filter(Boolean);
const resumeBlob = [p.name, p.school, p.major, p.education, p.city, resumeSkills.join(' ')].filter(Boolean).join(' ');

const rows = db.prepare("SELECT id, jd, requirements, position FROM jobs WHERE match_score IS NULL").all() as any[];
console.log(`待回填岗位：${rows.length}，技能词 ${resumeSkills.length} 个`);

let done = 0;
const update = db.prepare("UPDATE jobs SET match_score=?, match_detail=? WHERE id=?");
for (const r of rows) {
  const res = matchResumeToJob(resumeBlob, resumeSkills, r.jd || '', r.requirements || '', r.position || '');
  update.run(res.score, JSON.stringify({ matched: res.matched || [], missing: res.missing || [], rule: true }), r.id);
  done++;
  if (done % 200 === 0) console.log(`  ...${done}/${rows.length}`);
}
console.log(`回填完成：${done} 个岗位已写入 match_score`);
const cov = db.prepare("SELECT COUNT(*) c, AVG(match_score) avg FROM jobs WHERE match_score IS NOT NULL").get() as any;
console.log(`当前覆盖：${cov.c} 个，均值 ${Math.round(cov.avg)}`);

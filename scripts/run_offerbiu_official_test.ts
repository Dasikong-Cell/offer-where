/**
 * Offerbiu 官网通道真实试投运行器
 *
 * 邮箱通道（runOfferbiuEmail）只适用于「招聘推文里给了 HR 邮箱」的岗位；
 * 其余 offerbiu 岗位 apply_url 是企业官网/网申/智联/微信推文，需走 runOfferbiu（官网通道）。
 * 本脚本对仍为 candidate 的 offerbiu 岗位逐个调 runOfferbiu 真实试投：
 *   - 导航官网 → 尝试邮箱验证码登录（验证码走 QQ 邮箱 IMAP 自动读）→ 找投递入口 → 传简历 → 提交
 *   - 只有页面出现「投递成功」类字样才标记 applied，否则 need_manual（人工兜底）
 */
import * as db from '../server/db.js';
import { runOfferbiu } from '../server/services/apply/offerbiu.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const profile = db.getProfile() as Record<string, any> | undefined;
  if (!profile?.email) {
    console.log('档案未配置邮箱，官网验证码登录无法进行；请先在「我的档案」填邮箱与授权码');
    process.exit(1);
  }
  const jobs = (db.listJobs as any)({ source: 'offerbiu', status: 'candidate' }) as any[];
  // 仅保留明显是「官网/网申/智联/微信推文」的岗位（邮箱类上一步已投），这里全量跑，runOfferbiu 自己判断
  console.log(`官网通道待试投 offerbiu 候选岗: ${jobs.length} 个\n`);

  let applied = 0;
  let manual = 0;
  let error = 0;
  for (const j of jobs) {
    console.log(`\n===== [${j.company}] ${j.position} =====`);
    console.log(`  url: ${j.apply_url}`);
    try {
      const r = await runOfferbiu({
        platform: 'offerbiu',
        jobUrl: j.apply_url,
        job: { id: j.id, company: j.company, position: j.position, apply_url: j.apply_url },
        profile: { ...(profile as any), resume_path: (profile as any).resume_path },
        sinceMinutes: 10,
      });
      console.log(`  结果: ${r.status} | ${r.message || ''}`);
      if (r.status === 'applied') {
        applied++;
        try { db.updateJob(j.id, { status: 'applied' }); } catch { /* ignore */ }
      } else if (r.status === 'error') {
        error++;
      } else {
        manual++;
      }
    } catch (e: any) {
      error++;
      console.log(`  异常: ${e?.message || e}`);
    }
    await sleep(2500); // 间隔，降低风控概率
  }

  console.log(`\n===== 汇总 =====`);
  console.log(`官网通道试投: 成功(applied)=${applied}, 需人工(need_manual)=${manual}, 失败(error)=${error}, 合计=${jobs.length}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error('FATAL', e); process.exit(1); });

/**
 * Offerbiu 邮箱投递 预览测试（dryRun，不真实发送）：
 * 对每个 offerbiu candidate 岗调用 runOfferbiuEmail({dryRun:true})，
 * 提取 HR 邮箱、按推文标题格式拼标题、生成邮件正文，并把预览打印出来。
 *
 * 目的：在无 SMTP 配置（无 .env）情况下，先把 8 个岗的邮件内容跑出来确认；
 * 同时区分「可邮箱投递」(返回 preview) 与「实为官网岗」(返回 need_manual，无 HR 邮箱)。
 *
 * 真实发送需 server/mail.ts 的 SMTP 配置（.env 中 SMTP_USER/SMTP_PASS 等），本脚本不涉及。
 */
import * as db from '../server/db.js';
import { runOfferbiuEmail } from '../server/services/apply/offerbiu.js';

(async () => {
  const profile: any = db.getProfile();
  const safeKeys = profile ? Object.keys(profile).filter((k) => !/(pass|auth|code|token|secret)/i.test(k)) : [];
  console.log('== 档案字段 ==', JSON.stringify(safeKeys));
  console.log('== 档案(email/name/resume) ==',
    JSON.stringify({
      email: profile?.email || '(空)',
      name: profile?.name || '(空)',
      resume_path: profile?.resume_path || '(空)',
    }));

  const jobs: any[] = db.listJobs({ source: 'offerbiu', status: 'candidate' }) as any[];
  console.log(`\n== offerbiu 待投候选岗共 ${jobs.length} 个 ==\n`);

  let emailOk = 0;
  let officialOnly = 0;
  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    console.log(`\n[${i + 1}/${jobs.length}] ${job.company} / ${job.position}`);
    console.log(`   url: ${job.apply_url}`);
    try {
      const r: any = await runOfferbiuEmail({
        profile,
        job: { id: job.id, company: job.company, position: job.position, apply_url: job.apply_url },
        jobUrl: job.apply_url,
        dryRun: true,
      });
      console.log(`   状态: ${r.status}  ${r.message || ''}`);
      if (r.preview) {
        emailOk++;
        console.log(`   收件人: ${r.preview.to}`);
        console.log(`   标题:   ${r.preview.subject}`);
        console.log(`   附件:   ${r.preview.attachment || '无'}`);
        console.log(`   正文(前200):\n${(r.preview.body || '').slice(0, 200)}`);
      } else if (r.status === 'need_manual') {
        officialOnly++;
      }
    } catch (e: any) {
      console.log(`   异常: ${e?.message || e}`);
    }
  }
  console.log(`\n===== 汇总: 可邮箱投递(有预览) ${emailOk} 个, 实为官网岗/无邮箱 ${officialOnly} 个 =====`);
  process.exit(0);
})();

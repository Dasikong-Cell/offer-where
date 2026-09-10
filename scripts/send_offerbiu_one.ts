/**
 * 真实发送 offerbiu 中可邮箱投递的「中大咨询集团」那 1 个岗位。
 * 复用 runOfferbiuEmail 真实路径（重新提取 HR 邮箱确保最新），发送成功后更新岗位状态。
 * 发信不可逆——调用前需用户确认。
 */
import * as db from '../server/db.js';
import { runOfferbiuEmail } from '../server/services/apply/offerbiu.js';

(async () => {
  const profile: any = db.getProfile();
  const jobs: any[] = db.listJobs({ source: 'offerbiu', status: 'candidate' }) as any[];
  const target = jobs.find((j) => /中大咨询/.test(j.company || ''));
  if (!target) {
    console.log('未找到「中大咨询」候选岗');
    process.exit(1);
  }
  console.log(`\n== 真实发送: ${target.company} / ${target.position} ==`);
  console.log(`   url: ${target.apply_url}`);
  const r: any = await runOfferbiuEmail({
    profile,
    job: { id: target.id, company: target.company, position: target.position, apply_url: target.apply_url },
    jobUrl: target.apply_url,
    dryRun: false,
  });
  console.log(`   结果: ${r.status}  ${r.message || ''}`);
  if (r.preview) console.log(`   收件人: ${r.preview.to}  标题: ${r.preview.subject}`);
  if (r.status === 'applied') {
    db.updateJob(target.id, { status: 'applied' });
    console.log('   已更新岗位状态 = applied（避免重复投递）');
  } else {
    console.log('   未成功（未更新状态），请检查上方面板日志');
  }
  process.exit(0);
})();

import { cleanupData, type AutoLimitMode } from '../server/services/dataCleanup.js';

function argNum(name: string, def: number): number {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  if (!a) return def;
  const v = Number(a.split('=')[1]);
  return Number.isFinite(v) && v >= 0 ? v : def;
}

function argStr(name: string, def: string): string {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=')[1] : def;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  // 自动限额档位：off（只告警）/ safe（收紧保留期，默认）/ full（再清调试产物与过期 JD 图）
  const mode = argStr('auto-limit', 'safe') as AutoLimitMode;
  const report = await cleanupData({
    dryRun,
    autoLimit: mode,
    screenshotDays: argNum('screenshot-days', 14),
    keepDbBackups: argNum('keep-db', 3),
    keepResumeBackups: argNum('keep-resume', 2),
    runLogDays: argNum('log-days', 30),
    jdImageDays: argNum('jd-days', 30),
  });
  console.log(`══════ data 清理报告${dryRun ? '（dry-run，未真正删除）' : ''} ══════`);
  console.log(JSON.stringify(report, null, 2));
  if (report.autoLimit.triggered && report.autoLimit.stillOver) {
    // 非 0 退出码：超阈值且清理后仍超 ⇒ 让调用方（脚本/定时任务）能据此告警
    console.log('\n[!] 清理后仍超阈值，请人工处置（见报告 autoLimit.topDirs）。');
    process.exitCode = 2;
  }
}

main().catch((e) => {
  console.error(String(e?.stack || e));
  process.exitCode = 1;
});

import { cleanupData } from '../server/services/dataCleanup.js';

function argNum(name: string, def: number): number {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  if (!a) return def;
  const v = Number(a.split('=')[1]);
  return Number.isFinite(v) && v >= 0 ? v : def;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const report = await cleanupData({
    dryRun,
    screenshotDays: argNum('screenshot-days', 14),
    keepDbBackups: argNum('keep-db', 3),
    runLogDays: argNum('log-days', 30),
  });
  console.log(`══════ data 清理报告${dryRun ? '（dry-run，未真正删除）' : ''} ══════`);
  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error(String(e?.stack || e));
  process.exitCode = 1;
});

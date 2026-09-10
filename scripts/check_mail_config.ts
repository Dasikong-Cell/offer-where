import * as db from '../server/db.js';
const cfg: any = db.getMailConfig();
if (!cfg) {
  console.log('mail_config: 空(未配置)');
  process.exit(0);
}
console.log('mail_config:', JSON.stringify({ ...cfg, auth_code: cfg.auth_code ? '<已填>' : '空' }));
console.log('email:', cfg.email || '(空)', '| auth_code 已填:', !!(cfg.auth_code && String(cfg.auth_code).length > 0));

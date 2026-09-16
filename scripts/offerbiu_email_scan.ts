/**
 * 采集型探针：遍历 offerbiu 全部岗位（含微信推文）：
 *  - 输出登录线索（phoneText/emailText，用于自证探针有效）
 *  - 抓取页面内出现的邮箱地址 → 这些岗位可走「HR 邮箱直投」（无需登录，自动化可跑通）
 * 只读：不填表、不提交。
 */
import * as db from '../server/db.js';
import { execAction } from '../server/services/browser.js';
import { pageText } from '../server/services/apply/common.js';

const DETECT = `(function(){
  var t = document.body ? document.body.innerText : '';
  var emailInput = document.querySelector('input[type=email],input[name*=email i],input[id*=email i],input[placeholder*=邮箱],input[placeholder*=mail i]');
  var emailText = /邮箱登录|邮箱验证|邮箱地址|邮件登录|邮箱验证码|使用邮箱/.test(t);
  var phoneText = /手机号|手机登录|扫码登录|微信扫码|短信验证码|手机验证/.test(t);
  return JSON.stringify({ hasEmailInput: !!emailInput, emailText: emailText, phoneText: phoneText, len: t.length });
})()`;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const BAD = /(example|sentry|w3\.org|qcloud|tencent|qq\.com$)/i;

export function extractEmails(text: string): string[] {
  const found = (text.match(EMAIL_RE) || []).filter(e => !BAD.test(e));
  return Array.from(new Set(found));
}

(async () => {
  const jobs = db.listJobs({ source: 'offerbiu' }).filter((j: any) => j.apply_url);
  const n = Number(process.argv[2] || 20);
  const start = Number(process.argv[3] || 0);
  const slice = jobs.slice(start, start + n);
  console.log('offerbiu 岗位总数:', jobs.length, ' 本次处理:', slice.length, `(offset ${start})`);
  const withMail: any[] = [];
  for (const j of slice) {
    let host = '';
    try { host = new URL(j.apply_url).hostname; } catch { /* ignore */ }
    try {
      await execAction('official', 'navigate', { url: j.apply_url, timeout: 25000 }).catch(() => undefined);
      await sleep(2500);
      const r: any = await execAction('official', 'eval', { script: DETECT }).catch(() => undefined);
      let d: any = {};
      try { d = JSON.parse(String(r?.data || '{}')); } catch { /* ignore */ }
      const text = await pageText('official').catch(() => '');
      const mails = extractEmails(text || '');
      if (mails.length) withMail.push({ j, mails });
      const tag = d.hasEmailInput ? 'EMAIL-LOGIN✓' : (d.emailText ? 'EMAIL-TEXT' : (d.phoneText ? 'phone/sms' : '-'));
      console.log(String(tag).padEnd(12), '|', String(host).slice(0, 28).padEnd(28), '| len=', String(d.len || 0).padStart(6), '| mail:', mails.slice(0, 2).join(',') || '-', '|', (j.company || '').slice(0, 16));
    } catch (e: any) {
      console.log('ERR         |', String(host).slice(0, 28), '|', e?.message);
    }
  }
  console.log('\n=== 页面出现邮箱（可走邮箱直投） ===');
  withMail.forEach(x => console.log(x.j.id, '|', x.j.company, '|', x.j.position, '|', x.mails.join(','), '|', x.j.apply_url));
})();

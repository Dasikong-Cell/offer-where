/**
 * 页面透视调试工具：查看某平台当前 CDP 标签的 URL / 正文 / 可见按钮 / 上传框。
 *
 * 用途：投递失败时快速看清「页面到底长什么样」，据此调整选择器，
 *      不必靠猜。只读，不点击、不投递。
 *
 * 用法:
 *   tsx scripts/peek_page.ts boss
 *   tsx scripts/peek_page.ts job51 800
 */
const API = process.env.API_BASE || 'http://127.0.0.1:4400';

const platform = process.argv[2];
const maxLen = Number(process.argv[3]) || 500;

if (!platform) {
  console.error('用法: tsx scripts/peek_page.ts <platform> [maxLen]');
  process.exit(1);
}

async function ex(action: string, args: Record<string, any> = {}) {
  const r = await fetch(`${API}/api/browser/exec`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ platform, action, ...args }),
  });
  return r.json() as Promise<Record<string, any>>;
}

const SCRIPT = `
JSON.stringify({
  url: location.href,
  title: document.title,
  text: document.body ? (document.body.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, ${maxLen}) : '',
  buttons: Array.prototype.slice.call(document.querySelectorAll('button, a, [role="button"]'))
    .map(function(x){ return (x.innerText || x.textContent || '').trim(); })
    .filter(function(t){ return t && t.length < 24; })
    .slice(0, 45),
  fileInputs: Array.prototype.slice.call(document.querySelectorAll('input[type=file]'))
    .map(function(x){ return x.getAttribute('ka') || x.name || x.id || '(file)'; })
    .slice(0, 10),
  frames: document.querySelectorAll('iframe').length,
})
`;

(async () => {
  const r = await ex('eval', { script: SCRIPT });
  if (!r.ok) {
    console.log('调用失败:', r.error || JSON.stringify(r).slice(0, 300));
    process.exit(1);
  }
  let d: any = r.data;
  if (typeof d === 'string') { try { d = JSON.parse(d); } catch { /* keep raw */ } }
  if (typeof d !== 'object' || !d) {
    console.log('原始返回:', String(r.data).slice(0, 500));
    process.exit(1);
  }
  console.log(`平台       : ${platform}`);
  console.log(`URL        : ${d.url}`);
  console.log(`标题       : ${d.title}`);
  console.log(`iframe 数量: ${d.frames}`);
  console.log(`\n--- 正文前 ${maxLen} 字 ---`);
  console.log(d.text || '(空)');
  console.log('\n--- 可见按钮/链接文本 ---');
  const uniq = Array.from(new Set(d.buttons || []));
  if (!uniq.length) console.log('(无)');
  else uniq.forEach((t, i) => console.log(`  ${String(i + 1).padStart(2)}. ${t}`));
  console.log('\n--- 文件上传输入框 ---');
  const fi = d.fileInputs || [];
  if (!fi.length) console.log('(无)');
  else fi.forEach((t: string, i: number) => console.log(`  ${i + 1}. ${t}`));
  process.exit(0);
})();

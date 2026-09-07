/* 精确探测：51job 用平台内置规则(排除 /all/)；猎聘查卡片真实链接格式 */
const B = 'http://127.0.0.1:4400/api/browser/exec';
const ex = (platform: string, b: any) => fetch(B, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ platform, ...b }),
}).then((r) => r.json());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function scroll(p: string, times = 5) {
  for (let i = 0; i < times; i++) { await ex(p, { action: 'eval', script: 'window.scrollBy(0,900);"ok"' }); await sleep(800); }
}

(async () => {
  // ---- 51job：内置规则 ----
  await ex('job51', { action: 'navigate', url: 'https://we.51job.com/pc/search?keyword=' + encodeURIComponent('Java开发'), waitUntil: 'domcontentloaded' });
  await sleep(4500);
  await scroll('job51');
  const j = await ex('job51', {
    action: 'eval',
    script: `(() => {
      const set = new Set();
      document.querySelectorAll('a[href]').forEach(a => {
        const h = a.href || '';
        if (/jobs\\.51job\\.com\\//.test(h) && !/jobs\\.51job\\.com\\/all\\//.test(h) && !/jobs\\.51job\\.com\\/campus\\//.test(h) && !/jobs\\.51job\\.com\\/[^/]+\\/co/.test(h) && /jobs\\.51job\\.com\\/[^/]+\\/[^/]+\\.html/.test(h)) set.add(h.split('?')[0]);
      });
      const item = document.querySelector('.joblist-item, .job-item, [class*="joblist"]');
      return { count: set.size, sample: Array.from(set).slice(0, 5), itemHtml: item ? item.outerHTML.slice(0, 1500) : 'NO_ITEM' };
    })()`,
  });
  console.log('===== 51job(内置规则) =====');
  console.log('真实岗位链接数:', j.data?.count);
  console.log('样本:', JSON.stringify(j.data?.sample, null, 1));
  console.log('--- 列表项 HTML ---');
  console.log(j.data?.itemHtml);

  // ---- 猎聘：卡片链接格式 ----
  await ex('liepin', { action: 'navigate', url: 'https://www.liepin.com/zhaopin/?key=' + encodeURIComponent('Java开发') + '&curPage=0', waitUntil: 'domcontentloaded' });
  await sleep(4500);
  await scroll('liepin');
  const l = await ex('liepin', {
    action: 'eval',
    script: `(() => {
      const box = document.querySelector('.job-list-box, .job-card-pc-container, [class*="job-list"], [class*="job-card"]');
      const hrefs = [];
      document.querySelectorAll('a').forEach(a => { const h = a.getAttribute('href'); if (h && h !== '#' && h !== 'javascript:;') hrefs.push(h); });
      return {
        boxFound: !!box,
        boxHtml: box ? box.outerHTML.slice(0, 2200) : 'NO_BOX',
        hrefSample: [...new Set(hrefs)].slice(0, 20),
      };
    })()`,
  });
  console.log('\n===== 猎聘 =====');
  console.log('卡片容器存在:', l.data?.boxFound);
  console.log('href 样本:', JSON.stringify(l.data?.hrefSample, null, 1));
  console.log('--- 卡片 HTML ---');
  console.log(l.data?.boxHtml);
})();

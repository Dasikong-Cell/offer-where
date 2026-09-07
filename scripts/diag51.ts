/* 诊断 51job 列表页：为什么 EXTRACT_51 抓不到岗位 */
const B = 'http://127.0.0.1:4400/api/browser/exec';
const ex = (platform: string, b: any) => fetch(B, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ platform, ...b }),
}).then((r) => r.json());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const kw = 'Java开发';
  await ex('job51', { action: 'navigate', url: `https://we.51job.com/pc/search?keyword=${encodeURIComponent(kw)}`, waitUntil: 'domcontentloaded' });
  await sleep(5000);
  const before = await ex('job51', {
    action: 'eval',
    script: `(() => ({
      url: location.href,
      itemCount: document.querySelectorAll('.joblist-item').length,
      anyJobLinks: document.querySelectorAll('a[href*="jobs.51job.com"]').length,
      bodyText: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 200),
    }))()`,
  });
  console.log('=== 滚动前 ===', JSON.stringify(before.data, null, 1));

  for (let i = 0; i < 4; i++) { await ex('job51', { action: 'eval', script: 'window.scrollBy(0,900);"ok"' }); await sleep(900); }
  await sleep(1500);

  const after = await ex('job51', {
    action: 'eval',
    script: `(() => {
      const items = document.querySelectorAll('.joblist-item');
      const first = items[0];
      const hrefs = first ? Array.from(first.querySelectorAll('a[href]')).map(a => a.getAttribute('href')).slice(0, 12) : [];
      const ABS = (h) => { try { return new URL(h, location.href).href; } catch (e) { return ''; } };
      const abs = hrefs.map(ABS).filter(Boolean);
      return {
        url: location.href,
        itemCount: items.length,
        firstItemHrefs: hrefs,
        firstItemAbs: abs.slice(0, 8),
        matched: abs.filter(h => /jobs\\.51job\\.com\\/[^/]+\\/[^/]+\\.html/.test(h) && !/\\/all\\/|\\/campus\\//.test(h)).slice(0, 5),
        sensorsOk: first ? !!(first.querySelector('[sensorsdata]')) : false,
      };
    })()`,
  });
  console.log('=== 滚动后 ===', JSON.stringify(after.data, null, 1));
})();

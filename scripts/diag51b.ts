/* 验证 51job 公司聚合页 /all/coXXX.html 是否列出真实岗位直链 */
const B = 'http://127.0.0.1:4400/api/browser/exec';
const ex = (platform: string, b: any) => fetch(B, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ platform, ...b }),
}).then((r) => r.json());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const comp = 'https://jobs.51job.com/all/coVjJUNwVkU2UEZQxvXT8.html';
  await ex('job51', { action: 'navigate', url: comp, waitUntil: 'domcontentloaded' });
  await sleep(4500);
  for (let i = 0; i < 4; i++) { await ex('job51', { action: 'eval', script: 'window.scrollBy(0,900);"ok"' }); await sleep(800); }
  await sleep(1000);
  const r = await ex('job51', {
    action: 'eval',
    script: `(() => {
      const ABS = (h) => { try { return new URL(h, location.href).href; } catch (e) { return ''; } };
      const all = Array.from(document.querySelectorAll('a[href]')).map(a => ABS(a.getAttribute('href'))).filter(Boolean);
      const real = [...new Set(all.filter(h => /jobs\\.51job\\.com\\/[^/]+\\/[^/]+\\.html/.test(h) && !/\\/all\\/|\\/campus\\//.test(h)))];
      return {
        url: location.href,
        totalAnchors: all.length,
        realCount: real.length,
        sample: real.slice(0, 8),
        bodyText: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 180),
      };
    })()`,
  });
  console.log(JSON.stringify(r.data, null, 1));
})();

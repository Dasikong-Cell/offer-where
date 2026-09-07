/* 并行探测 51job / 猎聘 搜索列表页 DOM：岗位链接、卡片结构、职位名/公司名选择器 */
const B = 'http://127.0.0.1:4400/api/browser/exec';
const ex = (platform: string, b: any) => fetch(B, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ platform, ...b }),
}).then((r) => r.json());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function probe(p: string, url: string, reSrc: string) {
  await ex(p, { action: 'navigate', url, waitUntil: 'domcontentloaded' });
  await sleep(4500);
  for (let i = 0; i < 5; i++) { await ex(p, { action: 'eval', script: 'window.scrollBy(0,900);"ok"' }); await sleep(800); }
  await sleep(1200);
  const d = await ex(p, {
    action: 'eval',
    script: `(() => {
      const rx = ${reSrc};
      const anchors = Array.from(document.querySelectorAll('a')).filter(a => rx.test(a.href || ''));
      const uniq = [...new Set(anchors.map(a => a.href.split('?')[0]))];
      const cls = new Set();
      document.querySelectorAll('[class]').forEach(e => { if (typeof e.className === 'string') e.className.split(' ').forEach(c => { if (/job|post|position|card/i.test(c)) cls.add(c); }); });
      const firstCard = anchors[0] ? (anchors[0].closest('[class]') || anchors[0]).outerHTML.slice(0, 1600) : 'NO_CARD';
      return { count: uniq.length, sample: uniq.slice(0, 5), classes: Array.from(cls).slice(0, 30), firstCard };
    })()`,
  });
  console.log(`\n===== ${p} =====`);
  console.log('链接数:', d.data?.count, '样本:', JSON.stringify(d.data?.sample?.slice(0, 3)));
  console.log('候选 class:', JSON.stringify(d.data?.classes));
  console.log('--- 首卡片 HTML ---');
  console.log(d.data?.firstCard);
}

(async () => {
  await Promise.all([
    probe('job51', 'https://we.51job.com/pc/search?keyword=' + encodeURIComponent('Java开发'), '/jobs\\.51job\\.com\\/[^/]+\\/[^/]+\\.html/'),
    probe('liepin', 'https://www.liepin.com/zhaopin/?key=' + encodeURIComponent('Java开发') + '&curPage=0', '/liepin\\.com\\/job\\//'),
  ]);
})();

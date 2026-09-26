/**
 * 城市表拼音生成器：为 cityData.ts 的 373 个城市补齐「拼音 + 首字母」，供控制台城市搜索用。
 *
 * 为什么保留在仓库里：cityData.ts 标注「自动生成，勿手改」，那就必须留下**可再生**的路径，
 * 否则下次 BOSS 城市树更新时只能手抄 321 行拼音。
 *
 * ⚠️ 需要 pinyin-pro（**未随本项目 node_modules 提供**，生成是一次性的、不该进运行时依赖）：
 *      npm i pinyin-pro        # 装在任意目录
 *      然后让 CJS 解析到它（NODE_PATH 对 require 有效）：
 *      NODE_PATH=<该目录>/node_modules ./node/node.exe scripts/gen_city_pinyin.cjs [--write]
 *    不加 --write 只做 dry-run：打印统计 + 多音字抽查表（重庆/厦门/蚌埠/东莞/佛山…），不落盘。
 *
 * 口语化约定：
 *   · ü → v（吕梁 → lvliang），与中文输入法一致
 *   · 已有拼音原样保留（人工值优先，避免多音字被库改坏）；abbr 一律重算
 */
const fs = require('node:fs');
const path = require('node:path');
const { pinyin } = require('pinyin-pro');

const ROOT = path.join(__dirname, '..');
const FILE = path.join(ROOT, 'server', 'services', 'cityData.ts');
const WRITE = process.argv.includes('--write');

const src = fs.readFileSync(FILE, 'utf8');
// 3~5 元组都要认：老表是 [名, 省, 码] 或 [名, 省, 码, 拼音]，本工具写回的是 5 元组。
// ⚠️ 曾经只认 4 个字段 ⇒ 对自己写出的 5 元组「城市行数=0」，静默什么都不做还报成功。
const ROW = /^(\s*)\["([^"]+)",\s*"([^"]+)",\s*(\d+)(?:,\s*"([^"]*)")?(?:,\s*"([^"]*)")?\],\s*$/;

const lines = src.split('\n');
const out = [];
let total = 0;
let kept = 0;
let computed = 0;
const seen = new Set();
const bad = [];

function py(name) {
  return pinyin(name, { toneType: 'none', type: 'array' }).join('').replace(/ü/g, 'v');
}
function ab(name) {
  return pinyin(name, { toneType: 'none', pattern: 'first', type: 'array' }).join('').replace(/ü/g, 'v');
}

for (const line of lines) {
  const m = line.match(ROW);
  if (!m) { out.push(line); continue; }
  const [, indent, name, prov, code, existing] = m;
  total++;
  if (seen.has(name)) bad.push('重名: ' + name);
  seen.add(name);

  let p = existing;
  if (p) kept++;
  else { p = py(name); computed++; }
  const a = ab(name);

  if (!/^[a-z]+$/.test(p)) bad.push('拼音含非 a-z: ' + name + ' -> ' + p);
  if (!/^[a-z]+$/.test(a)) bad.push('首字母含非 a-z: ' + name + ' -> ' + a);

  out.push(indent + '["' + name + '", "' + prov + '", ' + code + ', "' + p + '", "' + a + '"],');
}

console.log('城市行数=' + total + '  保留人工拼音=' + kept + '  新生成=' + computed);
console.log('重名/字符异常=' + bad.length);
bad.forEach((b) => console.log('  ! ' + b));

// ── 多音字/地名抽查：这些是最容易错的地方 ──
const TRAPS = [
  ['重庆', 'chongqing'], ['长春', 'changchun'], ['长沙', 'changsha'], ['厦门', 'xiamen'],
  ['六盘水', 'liupanshui'], ['蚌埠', 'bengbu'], ['亳州', 'bozhou'], ['儋州', 'danzhou'],
  ['濮阳', 'puyang'], ['台州', 'taizhou'], ['丽江', 'lijiang'], ['乐山', 'leshan'],
  ['东莞', 'dongguan'], ['佛山', 'foshan'], ['莆田', 'putian'], ['汕头', 'shantou'],
  ['珠海', 'zhuhai'], ['赤峰', 'chifeng'], ['包头', 'baotou'], ['阿坝藏族羌族自治州', 'abazangzuqiangzuzizhizhou'],
  ['香港', 'xianggang'], ['澳门', 'aomen'], ['台湾', 'taiwan'], ['东沙群岛', 'dongshaqundao'],
  ['蚌埠', 'bengbu'], ['汕头', 'shantou'], ['洛阳', 'luoyang'], ['单县', 'shanxian'],
];
console.log('\n多音字抽查（期望值 vs 生成值）：');
const map = new Map();
for (const line of lines) {
  const m = line.match(ROW);
  if (m) map.set(m[2], m[5] ? m[5] : py(m[2]));
}
for (const [name, want] of TRAPS) {
  if (!map.has(name)) { console.log('  – ' + name + '（不在表中，跳过）'); continue; }
  const got = map.get(name);
  console.log('  ' + (got === want ? 'OK  ' : '❌  ') + name + '  生成=' + got + '  期望=' + want);
}

if (WRITE) {
  const head = src.slice(0, src.indexOf('export const CN_CITIES'));
  // 重写头部注释里的类型说明，保持与新增字段一致
  const lines2 = head.split('\n').map((l) =>
    l.startsWith('/** [城市名, 省份, BOSS城市码, 拼音?] */')
      ? '/** [城市名, 省份, BOSS城市码, 拼音, 拼音首字母] */'
      : l,
  );
  const body = out.slice(out.indexOf('export const CN_CITIES: CityRow[] = ['));
  // ⚠️ 必须把结尾的换行收敛成「恰好一个」：src.split('\n') 会给末尾留一个空元素，
  // 直接 join 再补 '\n' ⇒ 每跑一次多一个空行，文件不幂等（连跑两次 md5 就变）。
  const text = (lines2.join('\n') + body.join('\n')).replace(/\n+$/, '\n');
  // 原子写：先编码成功再落 .tmp，最后 os.replace
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, Buffer.from(text, 'utf8'));
  fs.renameSync(tmp, FILE);
  console.log('\n已写入 ' + FILE + '（' + Buffer.byteLength(text, 'utf8') + ' 字节）');
} else {
  console.log('\n(dry-run，未落盘；加 --write 生效)');
}

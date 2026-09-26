/**
 * 城市选择与「城市名 → 各平台城市码」解析
 * ==========================================================================
 * 为什么需要：各平台的「城市」参数形态完全不同，过去是**硬编码**在采集脚本里
 * （如 `collect_boss.ts: const CITY = '101290100'`），导致换城市要改代码。
 *
 * 现在统一走这里：
 *   · 城市主表 = `cityData.ts`（从 BOSS 官方城市树接口抓取生成，373 个城市，权威）
 *   · 平台差异 = `resolveCityCode(platform, cityName)`：返回该平台可用的城市标识
 *   · 平台特有 id（如鱼泡 `a367`）放在 `PLATFORM_CITY_EXTRA`，**只放实测验证过的**
 *
 * ⚠️ 未收录的城市 id 一律返回 null，调用方应回退到「全国 + 关键词搜索」而不是瞎猜一个 id
 *    （猜错的城市码会把北京岗位当昆明采集，是比缺失更糟的错）。
 */

import { CN_CITIES, type CityRow } from './cityData.js';

export interface CityInfo {
  name: string;
  province: string;
  /** 拼音（城市搜索用；58同城/赶集也用 {pinyin}.58.com 子域） */
  pinyin?: string;
  /** 拼音首字母（城市搜索用，如 bj / sh / sz） */
  abbr?: string;
  /** BOSS 城市码（市级） */
  boss: number;
}

/** 默认城市（与原硬编码保持一致） */
export const DEFAULT_CITY = '昆明';

const ALL: CityInfo[] = CN_CITIES.map((r: CityRow) => ({
  name: r[0], province: r[1], boss: r[2], pinyin: r[3], abbr: r[4],
}));

/** 全部城市（控制台一次性拉全量、本地过滤用） */
export function allCities(): CityInfo[] {
  return ALL;
}

/**
 * 平台专有城市 id —— **只登记实测验证过的**。
 * 来源：实机探针（见 docs/PLATFORM_PROBE_2026-09-21.md）
 */
export const PLATFORM_CITY_EXTRA: Record<string, Record<string, string>> = {
  // 鱼泡直聘：城市 id 在列表页路径里（/zhaogong/{id}/），昆明实测为 a367
  yupao: { 昆明: 'a367' },
};

/**
 * 城市列表（可按关键词过滤）。
 *
 * 关键词同时匹配 5 条路径，让「全国 373 城」真的能被找到 —— 否则只能靠肉眼滚动：
 *   ① 城市名（汉字）      昆明
 *   ② 省份名（汉字）      云南      → 命中该省全部城市
 *   ③ 全拼                 kunming
 *   ④ 拼音首字母（前缀）   km / sh / bj
 *   ⑤ BOSS 城市码         101290100
 *
 * ⚠️ 同一口径在控制台 `cityMatch()` 里有一份本地副本（要即时过滤，不能每敲一键打一次接口）。
 *    改这里请同步改那里，合约测试会断言二者一致。
 */
export function listCities(keyword?: string): CityInfo[] {
  const k = String(keyword || '').trim().toLowerCase();
  if (!k) return ALL;
  const latin = /^[a-z]+$/.test(k);
  return ALL.filter((c) => cityMatches(c, k, latin));
}

/** 单条匹配规则（供 listCities 与控制台/测试共用同一口径） */
export function cityMatches(c: CityInfo, k: string, latin = /^[a-z]+$/.test(k)): boolean {
  return (
    c.name.includes(k) ||
    c.province.includes(k) ||
    (c.pinyin || '').includes(k) ||
    (latin && (c.abbr || '').startsWith(k)) ||
    String(c.boss).includes(k)
  );
}

/** 城市数量（供接口/文档展示） */
export function cityCount(): number {
  return ALL.length;
}

/**
 * 按名称找城市（容错：「昆明市」→「昆明」；「云南昆明」→「昆明」）。
 * 找不到返回 null —— 调用方应把它当「自定义城市」处理，而不是猜。
 */
export function findCity(cityName: string): CityInfo | null {
  const raw = String(cityName || '').trim();
  if (!raw) return null;
  const norm = (s: string) => s.replace(/[市区县\s·]/g, '');
  const target = norm(raw);
  // 1) 精确（去后缀）
  let hit = ALL.find((c) => norm(c.name) === target);
  if (hit) return hit;
  // 2) 城市名包含在被查询串里（如「云南省昆明」）
  hit = ALL.find((c) => target.includes(norm(c.name)));
  if (hit) return hit;
  // 3) 反向：被查询串是城市名的一部分
  hit = ALL.find((c) => norm(c.name).includes(target) && target.length >= 2);
  return hit || null;
}

/**
 * 解析「某平台用哪个城市标识」。
 * @returns boss 返回数字城市码；yupao 返回 'a367' 这类字符串 id；
 *          52/智联/国聘等未收录的平台返回 null（调用方回退全国）
 */
export function resolveCityCode(platform: string, cityName: string): string | number | null {
  const city = findCity(cityName);
  const name = city?.name || String(cityName || '').trim();
  if (!name) return null;

  const extra = PLATFORM_CITY_EXTRA[platform];
  if (extra && extra[name]) return extra[name];

  switch (platform) {
    case 'boss':
      return city ? city.boss : null;
    case 'iguopin':
      // 国聘接口不接城市参数，用「名称客户端过滤」（采集器里按 district 匹配）
      return name;
    default:
      return null;
  }
}

/** 该城市是否被某平台支持（用于界面上灰掉/提示） */
export function isCitySupported(platform: string, cityName: string): boolean {
  return resolveCityCode(platform, cityName) !== null;
}

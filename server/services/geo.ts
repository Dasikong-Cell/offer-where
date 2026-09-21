/**
 * 定位（IP 归属地）
 * ==========================================================================
 * 用途：控制台「📍定位」按钮 —— 一键把目标城市设为当前所在城市，免手选。
 *
 * 实现策略（多源回退，全部免 key）：
 *   ① BOSS 官方城市树接口的 `locationCity` 字段 —— 实测可直接拿到基于出口 IP 的城市，
 *      且我们本来就用这个接口生成城市表，**零新增依赖**
 *   ② `https://ipapi.co/json/`（免费、无需 key）
 *   ③ `https://ipinfo.io/json`（免费额度）
 * 任一命中即返回，并标注来源，便于排查「定位到别的城市」（通常是代理/VPN 导致）。
 *
 * ⚠️ 结果只作为**建议值**返回，不直接改用户档案 —— 由前端确认后再写入（避免静默覆盖用户设置）。
 */

export interface GeoLocation {
  city: string | null;
  region: string | null;
  country: string | null;
  ip?: string | null;
  /** 命中的来源，便于排查 */
  source: string;
  /** 命中的原始字段（便于排查） */
  raw?: string;
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';

async function fetchJson(url: string, headers: Record<string, string> = {}, timeoutMs = 8000): Promise<any | null> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, signal: ctl.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** 规范化城市名：去掉「市」后缀，便于与城市表比对 */
function normCity(s: unknown): string | null {
  const t = String(s || '').replace(/[市\s]/g, '').trim();
  return t || null;
}

/**
 * 通过出口 IP 定位当前城市。
 * 依次尝试多个来源，第一个成功即返回。
 */
export async function locateByIp(): Promise<GeoLocation> {
  // ① BOSS 城市树自带的 IP 定位（复用已有依赖，最省）
  {
    const j = await fetchJson('https://www.zhipin.com/wapi/zpCommon/data/city.json', {
      Referer: 'https://www.zhipin.com/',
    });
    const loc = j?.zpData?.locationCity;
    if (loc && loc.name) {
      return {
        city: normCity(loc.name),
        region: null,
        country: '中国',
        ip: null,
        source: 'boss-city-tree(locationCity)',
        raw: `${loc.name}${loc.code ? ` code=${loc.code}` : ''}`,
      };
    }
  }

  // ② ipapi.co
  {
    const j = await fetchJson('https://ipapi.co/json/');
    if (j && (j.city || j.region)) {
      return {
        city: normCity(j.city),
        region: j.region || null,
        country: j.country_name || j.country || null,
        ip: j.ip || null,
        source: 'ipapi.co',
        raw: `${j.city || ''}/${j.region || ''}`,
      };
    }
  }

  // ③ ipinfo.io
  {
    const j = await fetchJson('https://ipinfo.io/json');
    if (j && (j.city || j.region)) {
      return {
        city: normCity(j.city),
        region: j.region || null,
        country: j.country || null,
        ip: j.ip || null,
        source: 'ipinfo.io',
        raw: `${j.city || ''}/${j.region || ''}`,
      };
    }
  }

  return { city: null, region: null, country: null, source: 'none' };
}

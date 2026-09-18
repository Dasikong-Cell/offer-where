/**
 * 交换联系方式状态机（对标职得鸭猎聘专有 `handleExchangeActions`）
 * ─────────────────────────────────────────────────────────────
 * 猎聘聊天页有「发简历 / 交换手机号 / 交换微信号」三个动作按钮，且都有**状态**：
 *   · 正常可点          → 直接点
 *   · `im-ui-action-button-disabled`（索要中）→ 已发起过，**跳过**（重复点会刷屏）
 *   · 带 `.ant-im-badge`（交换中，对方已发起）→ 需要点进去**同意**
 *
 * 这三态如果只判断"按钮在不在"就会出错：对 disabled 的按钮猛点，或对
 * 对方已发起的请求视而不见 —— 职得鸭踩过的坑我们照抄其解法并补了确认弹层处理。
 */
import { bexec, ApplyLogger, sleep } from './common.js';
import { kvGetJson, kvSetJson } from '../../db.js';

export type ExchangeAction = 'sendResume' | 'changePhone' | 'changeWechat';

export const EXCHANGE_SELECTORS: Record<ExchangeAction, string> = {
  sendResume: '.action-resume',
  changePhone: '.action-phone',
  changeWechat: '.action-wechat',
};

export const EXCHANGE_LABELS: Record<ExchangeAction, string> = {
  sendResume: '发送简历',
  changePhone: '交换手机号',
  changeWechat: '交换微信号',
};

const VALID_ACTIONS: readonly ExchangeAction[] = ['sendResume', 'changePhone', 'changeWechat'];

/** 归一化用户配置（兼容字符串数组 / 逗号串 / 非法值） */
export function parseExchangeActions(raw: unknown): ExchangeAction[] {
  const arr = Array.isArray(raw)
    ? raw
    : String(raw || '').split(/[，,\s]+/);
  const out: ExchangeAction[] = [];
  for (const a of arr) {
    const s = String(a || '').trim() as ExchangeAction;
    if (VALID_ACTIONS.includes(s) && !out.includes(s)) out.push(s);
  }
  return out;
}

const KV_KEY = 'exchange:actions';

/** 全局默认勾选项（控制台配置） */
export function getExchangeActions(): ExchangeAction[] {
  return parseExchangeActions(kvGetJson<string[]>(KV_KEY, []));
}

export function setExchangeActions(actions: unknown): ExchangeAction[] {
  const list = parseExchangeActions(actions);
  kvSetJson(KV_KEY, list);
  return list;
}

export type ExchangeOutcome = 'clicked' | 'agreed' | 'pending' | 'missing' | 'failed';

export interface ExchangeResult {
  action: ExchangeAction;
  label: string;
  outcome: ExchangeOutcome;
  detail: string;
}

interface ButtonState {
  found: boolean;
  disabled: boolean;
  badge: boolean;
}

/**
 * 探测某个动作按钮的状态（三态判定的唯一依据）。
 * 返回的 JSON 由页面内脚本产出，解析失败按「未找到」处理，不臆测。
 */
function stateEval(action: ExchangeAction): string {
  const sel = EXCHANGE_SELECTORS[action];
  return `(function(){
    var el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return JSON.stringify({ found: false, disabled: false, badge: false });
    var cls = String(el.className || '');
    var disabled = el.classList.contains('im-ui-action-button-disabled') || cls.indexOf('disabled') >= 0;
    var badge = !!el.querySelector('.ant-im-badge');
    return JSON.stringify({ found: true, disabled: disabled, badge: badge });
  })()`;
}

/**
 * 同意对方的交换请求：按钮本身点开后通常会弹确认层，
 * 需要在弹层里再点一次「同意/确认/确定」。找不到弹层则视为按钮本身已生效。
 */
async function confirmExchange(platform: string, logs: ApplyLogger): Promise<boolean> {
  for (const text of ['同意', '确认', '确定', '接受']) {
    const r = await bexec(platform, 'realClick', { text, timeout: 2500 }, logs, `点击弹层「${text}」`);
    if (r.ok) return true;
  }
  return false;
}

/**
 * 执行一组交换动作。**逐个动作独立容错**：一个失败不影响后面的。
 * 只在猎聘上有效（其他平台没有这套按钮）。
 */
export async function runExchangeActions(
  platform: string,
  actions: ExchangeAction[],
  logs: ApplyLogger = new ApplyLogger(),
): Promise<ExchangeResult[]> {
  const results: ExchangeResult[] = [];
  const list = parseExchangeActions(actions);

  if (!list.length) return results;
  if (platform !== 'liepin') {
    return list.map((a) => ({
      action: a, label: EXCHANGE_LABELS[a], outcome: 'failed',
      detail: `${platform} 不支持交换联系方式（仅猎聘有该能力）`,
    }));
  }

  for (const action of list) {
    const label = EXCHANGE_LABELS[action];
    try {
      const pr = await bexec(platform, 'eval', { script: stateEval(action) }, undefined, `${label} 状态探测`);
      let st: ButtonState = { found: false, disabled: false, badge: false };
      try { st = JSON.parse(String(pr.data || '{}')) as ButtonState; } catch { /* 按未找到处理 */ }

      if (!st.found) {
        results.push({ action, label, outcome: 'missing', detail: `页面没有「${label}」按钮` });
        logs.step(`${label} 不可用`, false, '按钮不存在');
        continue;
      }
      if (st.disabled) {
        results.push({ action, label, outcome: 'pending', detail: '已在索要中，跳过（避免重复请求）' });
        logs.step(`${label} 跳过`, true, '已在索要中');
        continue;
      }

      const clicked = await bexec(platform, 'realClick', { selector: EXCHANGE_SELECTORS[action], timeout: 6000 }, logs, `点击「${label}」`);
      if (!clicked.ok) {
        results.push({ action, label, outcome: 'failed', detail: clicked.error || '点击失败' });
        continue;
      }
      await sleep(900);

      if (st.badge) {
        // 对方已发起 → 需要同意
        const ok = await confirmExchange(platform, logs);
        results.push({
          action, label,
          outcome: ok ? 'agreed' : 'clicked',
          detail: ok ? '对方已发起，已点同意' : '对方已发起，已点按钮（未发现确认弹层）',
        });
      } else {
        results.push({ action, label, outcome: 'clicked', detail: '已发起交换请求' });
      }
      await sleep(600);
    } catch (e: any) {
      results.push({ action, label, outcome: 'failed', detail: e?.message || String(e) });
      logs.step(`${label} 异常`, false, e?.message || String(e));
    }
  }
  return results;
}

/** 把结果汇总成一句话（日志/接口回包用） */
export function summarizeExchange(results: ExchangeResult[]): string {
  if (!results.length) return '未配置交换动作';
  const cnt = new Map<ExchangeOutcome, number>();
  for (const r of results) cnt.set(r.outcome, (cnt.get(r.outcome) || 0) + 1);
  const parts: string[] = [];
  const label: Record<ExchangeOutcome, string> = {
    clicked: '已发起', agreed: '已同意', pending: '已在索要中', missing: '无此按钮', failed: '失败',
  };
  for (const [k, v] of cnt) parts.push(`${label[k]} ${v}`);
  const detail = results.map((r) => `${r.label}:${r.detail}`).join('；');
  return `${parts.join('，')} —— ${detail}`;
}

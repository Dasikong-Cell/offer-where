/**
 * 平台级会话独占锁（解决「投递 / 自动回复」互抢同一 Chrome 标签）
 *
 * 问题：自动回复监视器会后台 navigate 到聊天页、批量投递会 navigate 到职位列表页，
 * 二者操作同一平台的同一个 CDP 标签。若同时跑，页面会被彼此冲掉——表现就是
 * 「投递只投了一两份就开始被监视器抢走」「自动回复跑到一半页面被切走」。
 *
 * 方案：同一 platform 同一时刻只允许一个持有者（'apply' 或 'reply'）占用浏览器。
 *  - 任意投递（手动 / 后台监视）都持 'apply'；
 *  - 任意回复（手动 / 后台监视）都持 'reply'。
 * 两者不同持有者 → 互斥 -> tryAcquire 失败方本轮跳过，下一轮再试，互不打架。
 */

const holders = new Map<string, string>();

/** 尝试获取某平台锁；已被别的持有者占用则返回 false */
export function tryAcquire(platform: string, holder: string): boolean {
  const cur = holders.get(platform);
  if (cur && cur !== holder) return false;
  holders.set(platform, holder);
  return true;
}

/** 同 tryAcquire（语义化别名） */
export function acquire(platform: string, holder: string): boolean {
  return tryAcquire(platform, holder);
}

/** 释放锁（仅当持有者匹配，避免误释他人锁） */
export function release(platform: string, holder: string): void {
  if (holders.get(platform) === holder) holders.delete(platform);
}

/** 查询某平台当前持有者（调试用） */
export function holderOf(platform: string): string | null {
  return holders.get(platform) || null;
}

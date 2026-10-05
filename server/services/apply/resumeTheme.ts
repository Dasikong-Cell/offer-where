/**
 * 简历主题（配色白名单）
 * ==========================================================================
 * 🔴 为什么是「key 白名单」而不是让用户填任意颜色串：
 *    `theme.accent` 会被拼进 CSS。放行任意串就是给用户一个 CSS/HTML 注入面
 *    （`red;} body{display:none` 这类 payload 在模板字符串里完全成立）。
 *    白名单把取值空间锁死在下面这几个常量上，注入面被结构性消除。
 *
 * 🔴 默认色必须**等于既有版式的强调色 `#1d4ed8`**：
 *    「简历制作」是新链路，但用户看到的默认观感应与「一岗一简历」的产物一致，
 *    否则换条路径就换张脸，会被当成两套产品。
 */
export interface ResumeAccent {
  key: string;
  label: string;
  /** 6 位十六进制（渲染时会拼 `14`/`33` 两位透明度） */
  color: string;
}

export const RESUME_ACCENTS: ResumeAccent[] = [
  { key: 'blue', label: '深蓝（默认）', color: '#1d4ed8' },
  { key: 'teal', label: '青绿', color: '#0f766e' },
  { key: 'graphite', label: '石墨灰', color: '#374151' },
  { key: 'maroon', label: '赭红', color: '#9f1239' },
];

export const DEFAULT_ACCENT_KEY = 'blue';

/**
 * 版式模板白名单（对齐主流简历制作台的「模板」概念）。
 * 🔴 同配色一样：`theme.variant` 决定渲染走哪套页眉/标题 CSS，必须是**白名单 key**，
 *    不认任意串 —— 渲染器里是 `if (variant === 'xxx')` 分发，任意串进去只会静默落到默认。
 * 🔴 默认必须 `std`：它就是首个上线的版式，老草稿没有 variant 字段时渲染结果与升级前完全一致。
 */
export interface ResumeVariant {
  key: string;
  label: string;
  /** 一句话说明（下发给界面上的按钮副文案） */
  desc: string;
}

export const RESUME_VARIANTS: ResumeVariant[] = [
  { key: 'std', label: '标准版', desc: '左色条标题 + 通栏分隔线' },
  { key: 'line', label: '线条标题', desc: '标题下划线，正文极简' },
  { key: 'arc', label: '弧形页眉', desc: '页头圆弧色块，视觉更醒目' },
  { key: 'badge', label: '徽标细线', desc: '姓名徽标 + 细分隔线' },
];

export const DEFAULT_VARIANT_KEY = 'std';


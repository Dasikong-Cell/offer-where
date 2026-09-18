# Offerbiu 邮箱直投「一轮」结果（2026-09-18）

## 环境恢复
- 后端 `PORT=4400` + Chrome `9227`(official profile) 已重启（上次 502 中断后）。

## 全池扫描（858 个 offerbiu 岗位）
- 分页 5×limit200、workers=4、并发扫描，**仅 26 个**岗位页面含可用招聘邮箱。
- 命中率极低的原因：offerbiu 绝大多数岗位是微信推文 / 官网表单（页面无可用邮箱），邮箱直投只能覆盖这 26 个。
- 候选落盘：`data/offerbiu_round_candidates.json`（26 个；9 已投 + 17 新）。

## 人工筛选（防串号）
扫描存在**跨公司串号**（邮箱域名≠公司域名），已 quarantine 7 个可疑新候选：
- 科大讯飞 → `campus@dameng.com`（达梦）、Google → `hr@apogeei.com`、广合科技 → `campus@mpgroup.cn`、泰康 → `jobs@baiontcapital.com`、协合运维 → `recruiting@jbxnah.com`、满帮/移动杭州 → `2635593782@qq.com`（个人QQ垃圾）。
- 保留 **10 个高置信候选** → `data/offerbiu_round_candidates_curated.json`。

## 本轮回投
- ✅ 成功 4 封：浙江华东光电、山东北方光学、长强系统、邦盛科技（新岗位）。
- ⏸️ 6 个微信推文返回 `need_manual`（批量扫 858 页后微信对 9227 限流，正文加载不出、抽不到邮箱）。

## 微信限流修复（关键改进）
- 根因：`runOfferbiuEmail` 每次都**重新打开页面抽邮箱**，微信限流时必然失败。
- 修复：新增 `ApplyInput.email` **预取证邮箱覆盖**——投递时直接传入扫描阶段已核验的邮箱，跳过页面重抽。
  `server/services/apply/offerbiu.ts` 用覆盖邮箱投递；`/api/offerbiu/email-apply` 接受 `emails:{jobId:email}`；`scripts/offerbiu_email_round.ts` 投递时传入。
- 重启后端后重投 6 个微信岗位：**全部成功**（hr@droneyee.com、at-hr@atmoto.cn、szhr@tf-amd.com、contact@hrsaas.com、hr@szidd.cn、talent@icekredit.com）。
- offerbiu 累计投递：**47 → 51 → 57**。

## 投递真实性（IMAP 验证）
- 近 3 天 **10 封 HR 自动回复 / 收讫确认**，**0 退信**。邮箱直投链路端到端可达。

## 待你决策
1. 6 个微信限流岗位：是否冷却后由我重投（已确证邮箱），还是你手动在浏览器验证后投？
2. 7 个 quarantine 岗位：邮箱疑似串号/垃圾，是否跳过（推荐）还是仍要投？

## 文件
- `data/offerbiu_round_candidates.json` — 全池 26 个邮箱命中（含已投）
- `data/offerbiu_round_candidates_curated.json` — 本轮回投的 10 个高置信候选
- `data/offerbiu_round_results.json` — 本轮回投逐条状态
- `scripts/offerbiu_email_round.ts` — 扫描→落盘→分批投递编排脚本（已修 postSSE 状态捕获）

# 参考「职得鸭」(gagajob) 自动化源码 —— 解析结论与已落地的改进

## 一、解析对象
- 来源：`D:\新建文件夹\gagajob\resources\app.asar`（职得鸭 Electron 应用，54MB）
- 自定义 ASAR 格式：头部 16 字节偏移 12 处为 headerSize，偏移 16 为 JSON 头，文件数据 4 字节对齐。
- 已抽取其**自有脚本**（非 node_modules 依赖）到 `_gaga_app/`：
  - `puppeteer/zhilianHello.js`（智联投递主流程）、`zhilianSearch.js`（搜索/进公司页）、`zhilianKeyword.js`
  - `boss*` / `job51*` / `liepin*`（Boss / 前程 / 猎聘）
  - `utils/pageHelper.js`（安全操作封装）、`utils.js`（typeSlowly 等）、`main.js`

## 二、关键结论（最重要的 3 条）
1. **它根本不填表。** 智联唯一投递路径 `zhilianHello.js` 只做：进 JD → 提取 JD 文本 → 调 AI 判断是否匹配 → 点击 `.summary-planes__action` 里的「立即投递」按钮 → 完成。**全程不碰任何 input / select / cascader**，完全依赖账号里**已填好的在线简历**做一键投递。
2. **校招向导的级联选择器是行业公认的硬骨头。** 职得鸭对"需要填表/级联"的岗位直接跳过（找不到「立即投递」可点按钮就 `continue`）。也就是说：**商业工具也不自动填籍贯级联**——这正是我们卡住的地方。
3. **抗风控手法**：`puppeteer-real-browser`（`fingerprint:true`）+ 每平台独立 `userDataDir` + **逐字符慢速输入**（`typeSlowly`，每字随机 100–150ms 延迟）。

## 三、与我们项目（job-apply-agent）的对照
| 维度 | 职得鸭 | 我们的 job-apply-agent |
|---|---|---|
| 浏览器 | puppeteer-real-browser | Playwright `launchPersistentContext`（`--disable-blink-features=AutomationControlled`，已含基础 stealth） |
| 智联投递 | 仅一键「立即投递」 | 一键 + 校招向导自动填写（更全，但难） |
| 级联填写 | 不做 | 做（籍贯等）——当前主战场 |
| 输入方式 | 逐字符慢速 | 之前用 `fill` 一次性赋值 ❌ |

## 四、已落地的代码改进（`server/services/apply/zhilian.ts`）
1. **级联选择器改用逐字符 `type`（而非 `fill`）。**
   可搜索级联（籍贯）的建议面板只在真实 `input` 事件下渲染；`fill` 一次性设值后下拉不出现，导致之前"点了没反应 / 选不中"。现改为 `bexec('type', {delay:120})`，与职得鸭 `typeSlowly` 一致，触发建议列表。
2. **投递按钮检测优先用职得鸭式作用域选择器**：先 `.summary-planes__action button.a-button`（跳过 `disabled`/`a--disabled`，文本含"投递/申请"即点），再回退到按文本点，更稳不易误触。

## 五、仍存在的真问题（需你拍板）
- **简历里没有「籍贯」字段**（PDF 只含：男/2004.02、云南工商学院软件工程本科、求职意向）。当前库里 `籍贯=云南-昆明-五华区`、`身高=175`、`体重=65` 都是猜测值。级联选择器要求**省-市-区精确匹配**，猜错就选不中。
- **陕飞是校招岗**，受智联"每公司仅 1 个志愿"限制（你账号已有一个博士志愿），向导可能在"选择志愿"步就被拦。
- 职得鸭的经验表明：**校招向导级联自动化是最不划算的投入**；更稳的方案是先把"籍贯/身高/体重"等一次性补全进智联**在线简历**，之后校招向导会自动预填，只需确认保存。

## 六、建议的下一步（见对话中的提问）
A. 先把籍贯等补全进智联在线简历（最稳，避开级联）  
B. 继续强攻陕飞校招向导（需你提供准确籍贯）  
C. 改用社招岗走一键投递（职得鸭同款思路，完全避开级联）

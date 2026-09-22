# MMBoard F01/F02 针对性最终复核报告

- 复核日期：2026-09-23
- 复核身份：独立评审方
- 复核范围：上一份最终复审报告 §7 指定的最小范围，仅复核 F01、F02、版本关系、范围证明及必要构建检查
- 功能提交：`7e55f94205039e065bb1421144c854a97dbbd8e9`
- 当前本地/GitHub HEAD：`5d7d063fac88a3ec137c0ecc6f0b5e7cc2635952`（纯文档提交）
- 生产 `/api/version`：`7e55f94`
- 最终裁定：**PASS。F01、F02 均关闭；未发现本次变更引入的新 P0/P1，满足停止标准，集中整改可以结束。**

## 1. 版本与范围核验

| 检查项 | 结果 | 证据 |
|---|---|---|
| 本地 main/HEAD | PASS | 当前为 `5d7d063`，其父级功能提交为 `7e55f94` |
| GitHub main | PASS | `git ls-remote origin refs/heads/main` 返回 `5d7d063fac88a3ec137c0ecc6f0b5e7cc2635952` |
| 生产版本 | PASS | `/api/version` 返回 commit `7e55f94`、builtAt `2026-09-22T22:22:03.857Z` |
| 文档提交未改变代码树 | PASS | `git diff --quiet 7e55f94..HEAD -- server src tools scripts deploy` 为空 |
| 本轮功能变更范围 | PASS | 相对 `6c9a255` 的产品/测试修改限于 `scripts/verify_batch_a.cjs`、`server/llm.cjs`、`server/minutes-template.cjs`、`server/server.cjs`；另有交付文档更新 |
| diff 格式检查 | PASS | `git diff --check 6c9a255..7e55f94` 无错误 |

版本表述需按两层理解：GitHub main 的实际 HEAD 是纯文档提交 `5d7d063`；GitHub main 对应的最新功能代码、生产运行代码及生产 `/api/version` 均为 `7e55f94`。该关系一致且可追溯。

## 2. F01 复核 — PASS

### 2.1 实现证据

- `analyzeChunked` 为每个失败分块记录结构化 `chunkFailures: [{ index, reason }]`。
- map 调用经 `mapChunkWithRetry` 执行两次尝试；带 `noRetry` 的确定性错误立即失败，瞬态错误或解析错误在首次失败后重试。
- reduce 完成后，只要 `chunkFailures` 非空，就在返回前强制写入 `result.partial = true` 和 `result.chunkFailures`。该操作发生在 reduce 结果生成之后，reduce 返回完整字段也无法覆盖失败状态。
- `normalizeAnalysis` 规范化并透传 `chunkFailures`，使字段可随 `analysis.json` 保存并在后续纯重渲染时继续存在。
- `noticeBannerHtml` 直接依据结构化失败字段生成 `role="note"` 横幅，明确显示失败块编号、“纪要可能缺失”和“建议重跑分析”；不依赖 LLM 是否保留自然语言提示。

### 2.2 运行期证据

独立复跑 `node scripts/verify_batch_a.cjs`，结果为 **182 通过、0 失败**。其中与 F01 直接相关的断言均通过：

1. 正常 2 块和 3 块会议保持 `partial=false`，无 `chunkFailures`。
2. 非标记块空响应：关键决议仍存在，同时强制 `partial=true` 并记录第 1 块。
3. 标记块坏 JSON：决议不伪造，强制 `partial=true` 并记录第 2 块。
4. 模板实际包含“第 2 块提取失败，纪要可能缺失”。
5. 瞬态 503 首次失败后重试成功：两块共发生 3 次 map 请求，最终结果完整且中段决议保留。
6. 503 重试耗尽：第 1、2 块均进入结构化失败列表，最终结果为 partial。

上述证据覆盖了上一份报告 §7 要求的四组故障注入、正常路径和模板可见性。原 P1 的静默不完整风险已经关闭。

## 3. F02 复核 — PASS

### 3.1 实现证据

上传前中间件现在按以下顺序同步执行：

1. 读取 `Content-Length` 并检查单文件大小。
2. 检查磁盘水位。
3. 调用 `quotaExceeded(cl)`，计算“已用空间 + 已有在途预留 + 本次上传”。
4. 检查通过后才调用 `reserveUploadQuota(cl)`。

检查与预留之间没有 `await`，在当前单 Node.js 进程事件循环内不会被另一个请求插入，因此既消除了本次大小重复计算，也保留了并发预留防线。

### 3.2 运行期证据

182 项脚本中的 F02 断言全部通过：

- 剩余额度恰好等于 incoming 时接受。
- 超出 1 字节时拒绝。
- 第一个并发 6B 请求检查并预留后，第二个 6B 请求被拒绝，两个请求不能共同越界。
- HTTP 级边界用例在余量恰好等于上传体积时返回 201，不再因重复计算误报 503。

原 P2 已关闭。

## 4. 必要验证

| 验证 | 结果 |
|---|---:|
| `node scripts/verify_batch_a.cjs` | 182/182，PASS |
| `npm run typecheck` | PASS |
| `npm run build` | PASS；Vite 完成 65 个模块构建 |
| `git diff --quiet 7e55f94..HEAD -- server src tools scripts deploy` | PASS，代码树无变化 |

`build` 仍提示 `./fonts/noto.css` 在构建时不存在并留待运行时解析。该提示在本轮修改前已存在，不属于 F01/F02 范围，也未造成构建失败。

根据上一份报告 §7 的约定，`src/`、`tools/`、`server/local.cjs` 和 `deploy/` 未修改，因此本轮不要求重新执行真实 FunASR、30 项基础回归和完整浏览器矩阵。交付方额外复跑的回归和浏览器结果可作为补充证据，但不作为本次裁定的必要前提。

## 5. 最终验收决定

本轮未发现新的 P0/P1。F01 的结构化失败传播、强制 partial、重试策略和用户可见警告均成立；F02 的配额计算与并发边界均成立。

**最终验收通过。MMBoard 本轮集中整改正式结束。** 后续代理层限制、镜像扫描 CI 门禁、NVDA 抽样和凭据轮换继续按既定决策进入正常产品迭代，不再纳入本轮整改闭环。

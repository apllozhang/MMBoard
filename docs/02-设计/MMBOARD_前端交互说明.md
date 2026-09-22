# MMBoard 前端交互说明

| 项 | 值 |
|---|---|
| 优先级 | P2 |
| 状态 | 骨架(章节与素材指引就位,待填实) |
| 日期 | 2026-09-23 |
| 基线 | `7e55f94` |

> 填写约定:素材指引标注了内容来源(代码/文档/脚本);填实后把状态改为"✅ 成文"并同步 docs/README.md 台账。

> 素材:src/pages/MeetingBoardPage.tsx、src/components/(Dialog/ModelSettings/DataTable)、browser_matrix.mjs 断言。
1. 页面结构:登录门 → 看板(上传/任务表/统计)→ 详情弹窗 → 纪要查看 → 设置弹窗
2. 弹窗层级约定:双层弹窗 inert/aria-hidden、Esc、焦点圈闭
3. 键盘可达性:纯键盘完成 上传→打开详情→标注→重跑 全链路
4. 响应式:320px 无横向滚动(表格容器内滚动)、420px 低高度弹窗内滚
5. i18n 约定:zh/en 词条文件、key 命名

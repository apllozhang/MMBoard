/**
 * LLM 分析适配层 —— OpenAI 兼容协议(/chat/completions)
 * 智谱 GLM / DeepSeek / 通义 / 本地 vLLM/Ollama(OpenAI 兼容端点)通吃:
 * 配置 meeting.secret.json → llm: { baseUrl, apiKey, model },无配置走 mock。
 * 输出统一为结构化 JSON(纪要骨架),失败时抛错由流水线标记 failed。
 */
"use strict";

/** 分析转写文本 → 结构化纪要数据(双协议:anthropic Messages / openai chat.completions) */
async function analyze(transcript, cfg, log = console.log) {
  const provider = cfg?.provider === "anthropic" ? "anthropic" : "openai";
  const usable = cfg && cfg.baseUrl && cfg.apiKey && cfg.model && !cfg.apiKey.startsWith("在此");
  if (!usable) {
    log("[llm] 未配置 → mock 分析");
    return { ...mockAnalysis(transcript), mock: true };
  }
  const prompt = buildPrompt(transcript);
  const system = "你是专业的会议纪要分析师。只输出 JSON,不要输出任何其他文字。";

  let res, j;
  if (provider === "anthropic") {
    // Anthropic Messages 协议(智谱 anthropic 兼容端点等)
    res = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": cfg.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: 8192,
        system,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) throw new Error(`LLM API HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    j = await res.json();
    const content = (j.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");
    return { ...extractJson(content), mock: false };
  }

  // OpenAI 兼容协议
  res = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model: cfg.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
      temperature: 0.3,
    }),
  });
  if (!res.ok) throw new Error(`LLM API HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  j = await res.json();
  const content = j.choices?.[0]?.message?.content ?? "";
  return { ...extractJson(content), mock: false };
}

function buildPrompt(transcript) {
  return `请把以下会议转写整理成深度结构化纪要,严格只输出一个 JSON(不要任何其他文字)。
结构分两大部分:「记录」(必有)与「点评」(内容支撑得起才输出,支撑不起则对应字段给空数组)。
所有分析必须引用转写里的真实细节(可用「」引用原话),禁止编造。字段全部保留:

{
  "title": "会议标题(≤20字)",
  "summary": "整体摘要,2-4 句,概括议程与结论",
  "topics": [{ "heading": "议题/板块名", "person": "主讲人,无则空串", "detail": "讨论要点,2-3 句" }],
  "decisions": ["达成的决议,每条一句"],
  "actions": [{ "owner": "负责人", "item": "待办事项", "due": "时间节点,无则空串" }],
  "risks": ["风险与待确认事项"],
  "highlights": ["亮点点评,每条一句,引用具体细节"],
  "strengths": [{ "person": "讲者/部门名", "items": [{ "title": "维度名(如 能力拆分/实用价值/高光环节)", "detail": "具体分析,2-3句" }] }],
  "weaknesses": [{ "person": "讲者/部门名", "items": ["1. 缺点,一句概括+具体依据(重点:客观、可执行)"] }],
  "comparison": [{ "dimension": "对比维度(如 最有故事感)", "best": "表现最佳者", "reason": "理由一句话" }],
  "suggestions": [{ "person": "对象", "items": [{ "title": "建议/改稿方案名", "detail": "可执行做法,含时间/步骤则写明" }] }]
}

会议转写:
${transcript.slice(0, 24000)}`;
}

/** 宽容解析:模型偶尔包 ```json 围栏 */
function extractJson(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("LLM 未返回 JSON: " + text.slice(0, 120));
  return JSON.parse(m[0]);
}

function mockAnalysis(transcript) {
  return {
    title: "平台组周例会(mock)",
    summary: "本次会议过上周行动项,围绕报表分页缺陷修复、客户培训演示环境准备与服务器扩容预算进行了讨论,并明确了各项负责人与时间节点。(当前为 mock 分析,接入 LLM 后自动生成真实内容)",
    topics: [
      { heading: "上周行动项回顾", detail: "登录接口 415 错误已修复合入主干,回归测试全绿。" },
      { heading: "季度报表分页缺陷", detail: "定位为前端分页参数未随筛选联动,本周出修复方案。" },
      { heading: "客户培训准备", detail: "需要脱敏样本数据的演示环境,由环境组搭建。" },
      { heading: "服务器扩容", detail: "预算已批复,走采购流程,不影响上线计划。" },
    ],
    decisions: [
      "登录接口修复方案通过并合并",
      "演示环境统一使用脱敏样本数据",
      "扩容采购下周内完成",
    ],
    actions: [
      { owner: "李娜", item: "输出报表分页修复方案", due: "本周五" },
      { owner: "王强", item: "搭建客户培训演示环境", due: "下周五" },
      { owner: "主持人", item: "整理会议纪要并发邮件", due: "今日" },
    ],
    risks: [
      "报表分页缺陷影响季度数据导出,需在季度结算前修复",
      "演示环境数据脱敏标准待市场部确认",
    ],
  };
}

module.exports = { analyze };

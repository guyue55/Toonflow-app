import { Socket } from "socket.io";
import { tool, jsonSchema } from "ai";
import { z } from "zod";
import u from "@/utils";
import Memory from "@/utils/agent/memory";
import { persistScriptPlanDataFromResponse, mergeScriptPlanData } from "@/utils/agent/planData";
import useTools from "@/agents/scriptAgent/tools";
import ResTool from "@/socket/resTool";
import * as fs from "fs";
import path from "path";

export interface AgentContext {
  socket: Socket;
  isolationKey: string;
  text: string;
  userMessageTime?: number;
  abortSignal?: AbortSignal;
  resTool: ResTool;
  msg: ReturnType<ResTool["newMessage"]>;
  thinkConfig: {
    think: boolean;
    thinlLevel: 0 | 1 | 2 | 3;
  };
}

function buildMemPrompt(mem: Awaited<ReturnType<Memory["get"]>>): string {
  let memoryContext = "";
  if (mem.rag.length) {
    memoryContext += `[相关记忆]\n${mem.rag.map((r) => r.content).join("\n")}`;
  }
  if (mem.summaries.length) {
    if (memoryContext) memoryContext += "\n\n";
    memoryContext += `[历史摘要]\n${mem.summaries.map((s, i) => `${i + 1}. ${s.content}`).join("\n")}`;
  }
  if (mem.shortTerm.length) {
    if (memoryContext) memoryContext += "\n\n";
    memoryContext += `[近期对话]\n${mem.shortTerm.map((m) => `${m.role}: ${m.content}`).join("\n")}`;
  }
  return `## Memory\n以下是你对用户的记忆，可作为参考但不要主动提及：\n${memoryContext}`;
}

export async function runDecisionAI(ctx: AgentContext) {
  const { isolationKey, text, userMessageTime, abortSignal, resTool } = ctx;
  const memory = new Memory("scriptAgent", isolationKey);
  await memory.add("user", text, { createTime: userMessageTime });

  const skill = path.join(u.getPath("skills"), "script_agent_decision.md");
  const prompt = await fs.promises.readFile(skill, "utf-8");

  const mem = buildMemPrompt(await memory.get(text));

  const projectData = await u.db("o_project").where("id", resTool.data.projectId).first();

  const novelData = await u.db("o_novel").where("projectId", resTool.data.projectId).select("chapterIndex");

  const projectInfo = [
    "## 项目信息",
    `小说名称：${projectData?.name ?? "未知"}`,
    `小说类型：${projectData?.type ?? "未知"}`,
    `小说简介：${projectData?.intro ?? "无"}`,
    `目标改编影视视觉手册|画风：${projectData?.artStyle ?? "无"}`,
    `目标改编视频画幅：${projectData?.videoRatio ?? "16:9"}`,
    `章节数量：${novelData.length}章`,
  ].join("\n");

  const { fullStream } = await u.Ai.Text("scriptAgent:decisionAgent", ctx.thinkConfig.think, ctx.thinkConfig.thinlLevel).stream({
    messages: [
      { role: "system", content: prompt },
      { role: "assistant", content: projectInfo + "\n" + mem },
      { role: "user", content: text },
    ],
    abortSignal,
    tools: {
      ...memory.getTools(),
      ...useTools({ resTool: ctx.resTool, msg: ctx.msg }),
      ...createSubAgent(ctx),
    },
    onFinish: async (completion) => {
      await memory.add("assistant:decision", removeAllXmlTags(completion.text));
    },
  });

  let currentMsg = ctx.msg;
  await consumeFullStream(fullStream, currentMsg, () => {
    if (ctx.msg === currentMsg) return currentMsg;
    currentMsg.complete();
    currentMsg = ctx.msg;
    return currentMsg;
  });
}

function createSubAgent(parentCtx: AgentContext) {
  const { resTool, abortSignal } = parentCtx;
  const memory = new Memory("scriptAgent", parentCtx.isolationKey);

  /**
   * 服务端兜底：解析子Agent回复中的工作区XML标签并落库。
   * 正常情况下前端解析标签后已保存，这里合并写入相同内容，幂等无害；
   * 若模型丢掉XML格式导致前端没保存，这里就是唯一的落库通道。
   * 返回解析到的字段，供调用方判断是否触发格式补写重试。
   */
  async function persistFromResponse(subMsg: ReturnType<ResTool["newMessage"]>, fullResponse: string) {
    const thinking = subMsg.thinking("正在保存工作区数据...");
    try {
      const patch = await persistScriptPlanDataFromResponse(resTool.data.projectId, fullResponse);
      const savedKeys = Object.keys(patch);
      if (savedKeys.length > 0) {
        thinking.appendText(`已保存工作区字段: ${savedKeys.join(", ")}`);
        thinking.updateTitle("工作区数据已保存");
      } else {
        thinking.updateTitle("未检测到工作区数据标签");
      }
      thinking.complete();
      return patch;
    } catch (e) {
      thinking.appendText(`工作区数据保存失败: ${u.error(e).message}`);
      thinking.updateTitle("工作区数据保存失败");
      thinking.error();
      throw e;
    }
  }

  /**
   * 格式补写重试：模型回复完整但丢失了XML标签时，用非流式补写请求
   * 让模型仅输出标签内容。成本低（无工具、无思考），内容已有，只是重排版。
   */
  async function repairMissingTags(
    subMsg: ReturnType<ResTool["newMessage"]>,
    key: string,
    label: string,
    tag: string,
    prompt: string,
    fullResponse: string,
  ): Promise<string | null> {
    const thinking = subMsg.thinking(`检测到${label}内容未按XML格式输出，正在补写格式...`);
    // scriptItem 需要 name 属性；单值标签（骨架/策略）不带属性
    const isScript = tag === "scriptItem";
    const formatSpec = isScript
      ? `<${tag} name="剧本名称">剧本内容</${tag}>`
      : `<${tag}>${label}内容</${tag}>`;
    const extractRe = isScript
      ? new RegExp(`<${tag}(\\s[^>]*)?>([\\s\\S]*?)</${tag}>`)
      : new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`);
    try {
      const { text } = await u.Ai.Text(key as any).invoke({
        system: `你之前的回复内容完整，但缺少必需的XML标签格式。请把该内容原样套上XML标签输出，不要增删或改写任何内容，不要输出其他任何文字。${isScript ? "name 属性取剧本文件头首行标题（不含#）。" : ""}输出格式：\n${formatSpec}`,
        messages: [{ role: "user", content: `任务：${prompt}\n\n你之前的回复：\n${fullResponse}` }],
      });
      const repaired = text.trim();
      const extracted = repaired.match(extractRe);
      const content = isScript ? extracted?.[2] : extracted?.[1];
      if (extracted && content && content.trim().length > 0) {
        thinking.appendText(`格式补写成功，${label}长度: ${content.trim().length}`);
        thinking.updateTitle(`${label}格式已补写`);
        thinking.complete();
        return isScript ? `<${tag}${extracted[1] ?? ""}>${content.trim()}</${tag}>` : content.trim();
      }
      thinking.appendText("格式补写未能提取到内容");
      thinking.updateTitle(`${label}格式补写失败`);
      thinking.complete();
      return null;
    } catch (e) {
      thinking.appendText(`格式补写出错: ${u.error(e).message}`);
      thinking.updateTitle(`${label}格式补写出错`);
      thinking.complete();
      return null;
    }
  }

  /**
   * 兜底保存：格式补写也失败时，直接把模型正文（剥掉尾部确认话术和空段）
   * 存入工作区，避免内容彻底丢失。宁可存"可能带杂质的完整内容"也不要空白。
   */
  async function fallbackSave(
    subMsg: ReturnType<ResTool["newMessage"]>,
    label: string,
    field: "storySkeleton" | "adaptationStrategy",
    fullResponse: string,
  ): Promise<boolean> {
    let content = fullResponse.trim();
    // 去掉尾部可能的确认话术（skill 要求的固定格式）与收尾分隔线
    content = content
      .replace(/(故事骨架|改编策略)已保存，请在右侧工作台查看。\s*$/, "")
      .replace(/\n[-—]{2,}\s*$/, "")
      .replace(/\n{2,}$/, "")
      .trim();
    if (content.length < 50) return false;

    const thinking = subMsg.thinking(`正在以兜底方式保存${label}...`);
    try {
      await mergeScriptPlanData(resTool.data.projectId, { [field]: content });
      thinking.appendText(
        `⚠️ ${label}未按XML格式输出且补写失败，已将正文直接存入工作区（长度 ${content.length}）。内容开头可能包含少量说明文字，建议在工作台检查并微调。`,
      );
      thinking.updateTitle(`${label}已兜底保存（建议检查）`);
      thinking.complete();
      return true;
    } catch (e) {
      thinking.appendText(`兜底保存失败: ${u.error(e).message}`);
      thinking.updateTitle(`${label}兜底保存失败`);
      thinking.error();
      return false;
    }
  }

  async function runAgent({
    key,
    prompt,
    system,
    name,
    memoryKey,
    tools: extraTools,
    messages,
    workTag,
  }: {
    key: `${string}:${string}`;
    prompt: string;
    system: string;
    name: string;
    memoryKey: string;
    tools?: Record<string, any>;
    messages?: { role: "user" | "assistant" | "system"; content: string }[];
    /** 本子Agent需要写入工作区的XML标签及落库字段（script 表示剧本 scriptItem，落 o_script 表） */
    workTag?: { tag: string; field: "storySkeleton" | "adaptationStrategy" | "script"; label: string };
  }) {
    parentCtx.msg.complete();
    const subMsg = resTool.newMessage("assistant", name);

    const { fullStream } = await u.Ai.Text(key, parentCtx.thinkConfig.think, parentCtx.thinkConfig.thinlLevel).stream({
      system,
      messages: messages ?? [{ role: "user", content: prompt }],
      abortSignal,
      tools: { ...extraTools, ...useTools({ resTool, msg: subMsg }) },
    });

    const fullResponse = await consumeFullStream(fullStream, subMsg);

    // ── 服务端落库：XML正常 → 合并保存；缺失 → 补写重试；仍失败 → 兜底存正文 ──
    // 所有子Agent都跑通用解析落库（含 scriptItem → o_script 表）；
    // workTag 仅决定"单值字段"（骨架/策略）缺失时是否触发格式补写与兜底。
    if (fullResponse.trim() && !abortSignal?.aborted) {
      const patch = await persistFromResponse(subMsg, fullResponse).catch(() => null);
      if (workTag) {
        const tagSaved = (patch as any)?.[workTag.field];
        if (!tagSaved) {
          const repaired = await repairMissingTags(subMsg, key, workTag.label, workTag.tag, prompt, fullResponse);
          if (repaired) {
            if (workTag.field === "script") {
              // 剧本补写产物：一个或多个 scriptItem，走通用落库（写 o_script 表）
              await persistScriptPlanDataFromResponse(resTool.data.projectId, repaired).catch((e) =>
                console.error("[scriptAgent] 补写剧本落库失败:", u.error(e).message),
              );
            } else {
              await mergeScriptPlanData(resTool.data.projectId, { [workTag.field]: repaired } as any).catch((e) =>
                console.error("[scriptAgent] 补写内容落库失败:", u.error(e).message),
              );
            }
          }
          // 剧本不做正文兜底：多集内容无 name 边界，错误拆分比不保存更糟；
          // 补写失败时在 thinking 中明确警示
          else if (workTag.field === "script") {
            const warn = subMsg.thinking("剧本格式补写失败");
            warn.appendText(
              `⚠️ 本次剧本内容未包含 <scriptItem name="..."> 标签且格式补写失败，内容未写入剧本库。完整内容已在对话流中，请让Agent重新输出（或复制保存）。`,
            );
            warn.updateTitle("剧本未保存（格式异常）");
            warn.complete();
          } else {
            await fallbackSave(subMsg, workTag.label, workTag.field, fullResponse).catch(() => null);
          }
        }
      }
    }

    if (fullResponse.trim()) {
      await memory.add(memoryKey, removeAllXmlTags(fullResponse), {
        name,
        createTime: new Date(subMsg.datetime).getTime(),
      });
    }

    parentCtx.msg = resTool.newMessage("assistant", "视频策划");
    return fullResponse;
  }

  const promptInput = z
    .object({
      prompt: z.string().describe("交给子Agent的任务简约描述，100字以内"),
    })
    .toJSONSchema();

  const run_sub_agent_storySkeleton = tool({
    description: "运行执行subAgent来完成故事骨架相关任务",
    inputSchema: jsonSchema<{ prompt: string }>(promptInput),
    execute: async ({ prompt }) => {
      const skill = path.join(u.getPath("skills"), "script_execution_skeleton.md");
      const systemPrompt = await fs.promises.readFile(skill, "utf-8");

      const formatPrompt = "\n你必须使用如下XML格式写入工作区：\n<storySkeleton>故事骨架内容</storySkeleton>";

      return runAgent({
        key: "scriptAgent:storySkeletonAgent",
        prompt,
        system: systemPrompt + formatPrompt,
        name: "编剧",
        memoryKey: "assistant:execution:storySkeleton",
        messages: [{ role: "user", content: prompt + formatPrompt }],
        workTag: { tag: "storySkeleton", field: "storySkeleton", label: "故事骨架" },
      });
    },
  });

  const run_sub_agent_adaptationStrategy = tool({
    description: "运行执行subAgent来完成改编策略相关任务",
    inputSchema: jsonSchema<{ prompt: string }>(promptInput),
    execute: async ({ prompt }) => {
      const skill = path.join(u.getPath("skills"), "script_execution_adaptation.md");
      const systemPrompt = await fs.promises.readFile(skill, "utf-8");

      const formatPrompt = "\n你必须使用如下XML格式写入工作区：\n<adaptationStrategy>改编策略内容</adaptationStrategy>";

      return runAgent({
        key: "scriptAgent:adaptationStrategyAgent",
        prompt,
        system: systemPrompt + formatPrompt,
        name: "编剧",
        memoryKey: "assistant:execution:adaptationStrategy",
        messages: [{ role: "user", content: prompt + formatPrompt }],
        workTag: { tag: "adaptationStrategy", field: "adaptationStrategy", label: "改编策略" },
      });
    },
  });

  const run_sub_agent_script = tool({
    description: "运行执行subAgent来完成剧本相关任务",
    inputSchema: jsonSchema<{ prompt: string }>(promptInput),
    execute: async ({ prompt }) => {
      const skill = path.join(u.getPath("skills"), "script_execution_script.md");
      const systemPrompt = await fs.promises.readFile(skill, "utf-8");

      const scriptList = await u.db("o_script").where("projectId", resTool.data.projectId).select("id", "name");
      const scriptPrompt = ["## 可用剧本(ID:名称)", scriptList.map((s: any) => `${s.id}:${(s.name || "").replace(/[,:]/g, "")}`).join(","), ""].join(
        "\n",
      );

      const novelData = await u.db("o_novel").where("projectId", resTool.data.projectId).select("chapterIndex");

      const formatPrompt = `\n你必须使用如下XML格式写入工作区：\nXML不得添加任何额外标签<scriptItem name="剧本名称">剧本内容</scriptItem><scriptItem name="剧本名称">剧本内容</scriptItem><scriptItem name="剧本名称">剧本内容</scriptItem>`;

      return runAgent({
        key: "scriptAgent:scriptAgent",
        prompt,
        system: systemPrompt + formatPrompt,
        messages: [
          { role: "assistant", content: scriptPrompt + `章节数量：${novelData.length}章` },
          { role: "user", content: prompt + formatPrompt },
        ],
        name: "编剧",
        memoryKey: "assistant:execution:script",
        workTag: { tag: "scriptItem", field: "script", label: "剧本" },
      });
    },
  });

  const run_supervision_agent = tool({
    description: "运行监督层subAgent执行独立任务，完成后返回结果",
    inputSchema: jsonSchema<{ prompt: string }>(promptInput),
    execute: async ({ prompt }) => {
      const skill = path.join(u.getPath("skills"), "script_agent_supervision.md");
      const systemPrompt = await fs.promises.readFile(skill, "utf-8");

      return runAgent({
        key: "scriptAgent:supervisionAgent",
        prompt,
        system: systemPrompt,
        name: "编辑",
        memoryKey: "assistant:supervision",
      });
    },
  });

  return {
    run_sub_agent_storySkeleton,
    run_sub_agent_adaptationStrategy,
    run_sub_agent_script,
    run_supervision_agent,
  };
}

async function consumeFullStream(
  fullStream: AsyncIterable<any>,
  initialMsg: ReturnType<ResTool["newMessage"]>,
  syncMsg?: () => ReturnType<ResTool["newMessage"]>,
): Promise<string> {
  let msg = initialMsg;
  let text = msg.text();
  let thinking: ReturnType<typeof msg.thinking> | null = null;
  let thinkTime = 0;
  let fullResponse = "";

  try {
    for await (const chunk of fullStream) {
      if (syncMsg) {
        const newMsg = syncMsg();
        if (newMsg !== msg) {
          msg = newMsg;
          text = msg.text();
        }
      }
      if (chunk.type === "reasoning-start") {
        thinkTime = Date.now();
        thinking = msg.thinking("思考中...");
      } else if (chunk.type === "reasoning-delta") {
        thinking?.append(chunk.text);
      } else if (chunk.type === "reasoning-end") {
        thinkTime = Date.now() - thinkTime;
        thinking?.updateTitle(`思考完毕（${(thinkTime / 1000).toFixed(1)} 秒）`);
        thinking?.complete();
        thinking = null;
      } else if (chunk.type === "text-delta") {
        text.append(chunk.text);
        fullResponse += chunk.text;
      } else if (chunk.type === "error") {
        throw chunk.error;
      }
    }
    text.complete();
    msg.complete();
  } catch (err: any) {
    thinking?.complete();
    const errMsg = err?.message ?? String(err);
    text.append(errMsg);
    text.error();
    msg.error();
    throw err;
  }

  return fullResponse;
}

function removeAllXmlTags(text: string): string {
  text = text.replace(/<([a-zA-Z][\w-]*)(\s+[^>]*)?>([\s\S]*?)<\/\1>/g, "");
  text = text.replace(/<([a-zA-Z][\w-]*)(\s+[^>]*)?\/>/g, "");
  text = text.replace(/<\/?[a-zA-Z][\w-]*(\s+[^>]*)?>/g, "");
  return text.trim();
}

import express from "express";
import { success } from "@/lib/responseFormat";
import u from "@/utils";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    agentType: z.enum(["scriptAgent"]),
    data: z.object({
      storySkeleton: z.string(),
      adaptationStrategy: z.string(),
    }),
  }),
  async (req, res) => {
    const { projectId, agentType, data } = req.body;
    await u
      .db("o_agentWorkData")
      .where({ projectId: projectId, key: agentType })
      .update({
        data: JSON.stringify(data),
      });

    const rawScript = data?.script;
    if (Array.isArray(rawScript) && rawScript.length > 0) {
      // 对 payload 中可能存在的重名 script 做去重（保留最新一项）
      const scriptMap = new Map<string, any>();
      for (const s of rawScript) {
        if (s && s.name) {
          scriptMap.set(s.name, s);
        }
      }
      const uniqueScripts = Array.from(scriptMap.values());

      for (const s of uniqueScripts) {
        const rows = await u.db("o_script").where({ projectId, name: s.name }).select("id").orderBy("id", "asc");
        if (rows.length > 0) {
          const mainId = rows[0].id;
          await u.db("o_script").where({ id: mainId }).update({
            content: s.content,
          });

          // 如果存在历史重复多余的同名记录，清理多余记录并迁移关联资产
          if (rows.length > 1) {
            const extraIds = rows.slice(1).map((r) => r.id);
            const mainAssets = await u.db("o_scriptAssets").where("scriptId", mainId).select("assetId");
            const existingAssetIds = new Set(mainAssets.map((a: any) => a.assetId));

            const dupAssets = await u.db("o_scriptAssets").whereIn("scriptId", extraIds).select("assetId");
            for (const da of dupAssets) {
              if (!existingAssetIds.has(da.assetId)) {
                await u.db("o_scriptAssets").insert({ scriptId: mainId, assetId: da.assetId });
                existingAssetIds.add(da.assetId);
              }
            }
            await u.db("o_scriptAssets").whereIn("scriptId", extraIds).delete();
            await u.db("o_script").whereIn("id", extraIds).delete();
          }
        } else {
          await u.db("o_script").insert({
            projectId,
            name: s.name,
            content: s.content,
            createTime: Date.now(),
          });
        }
      }
    }

    res.status(200).send(success());
  },
);

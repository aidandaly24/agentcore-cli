import { z } from "zod";
import { HarnessSpecSchema } from "./harness";

/** Scaffold references name future YAML-relative files; only literal prompts enter the domain schema. */
export const HarnessAuthoringSchema = z
  .object({ systemPrompt: z.string().optional() })
  .passthrough()
  .transform(({ systemPrompt, ...rest }, ctx) => {
    const reference = systemPrompt?.startsWith("file://") ? systemPrompt : undefined;
    if (reference === "file://") {
      ctx.addIssue({
        code: "custom",
        path: ["systemPrompt"],
        message: "systemPrompt: file:// requires a path",
      });
      return z.NEVER;
    }
    const parsed = HarnessSpecSchema.safeParse({
      ...rest,
      systemPrompt: reference === undefined ? systemPrompt : undefined,
    });
    if (!parsed.success) {
      for (const issue of parsed.error.issues) ctx.addIssue({ ...issue });
      return z.NEVER;
    }
    return reference === undefined ? parsed.data : { ...parsed.data, systemPrompt: reference };
  });

import { z } from 'zod'

export const ReasoningEffortOptionSchema = z
  .object({
    reasoningEffort: z.string().min(1),
    description: z.string().optional(),
  })
  .strict()

/** Normalized Codex model descriptor surfaced to the renderer. */
export const ModelOptionSchema = z
  .object({
    id: z.string().min(1),
    displayName: z.string().min(1),
    supportedReasoningEfforts: z.array(ReasoningEffortOptionSchema),
    inputModalities: z.array(z.string().min(1)),
    isDefault: z.boolean(),
    hidden: z.boolean(),
  })
  .strict()

export const ModelOptionsSchema = z.array(ModelOptionSchema)

export const ConnectionTestResultSchema = z
  .object({
    success: z.boolean(),
    error: z.string().optional(),
  })
  .strict()

export type ReasoningEffortOption = z.infer<typeof ReasoningEffortOptionSchema>
export type ModelOption = z.infer<typeof ModelOptionSchema>
export type ConnectionTestResult = z.infer<typeof ConnectionTestResultSchema>

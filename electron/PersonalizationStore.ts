import { z } from "zod"
import { readJsonFile, statePath, writeJsonFile } from "./jsonStorage"

export const personalizationSchema = z.object({
  mode: z.enum(["question", "coding"]).default("question"),
  verbosity: z.enum(["concise", "verbose"]).default("concise"),
  customInstructionsEnabled: z.boolean().default(false),
  customInstructions: z.string().default(""),
})

export type PersonalizationConfig = z.infer<typeof personalizationSchema>

const PERSONALIZATION_PATH = statePath("personalization.json")

export function getPersonalizationConfig(): PersonalizationConfig {
  const parsed = readJsonFile<unknown>(PERSONALIZATION_PATH)
  return personalizationSchema.catch(personalizationSchema.parse({})).parse(parsed ?? {})
}

export function updatePersonalizationConfig(
  patch: Partial<PersonalizationConfig>
): PersonalizationConfig {
  const next = personalizationSchema.parse({ ...getPersonalizationConfig(), ...patch })
  writeJsonFile(PERSONALIZATION_PATH, next)
  return next
}

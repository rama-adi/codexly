import { z } from 'zod'

import {
  ContractVersionSchema,
  ExtensionsSchema,
  IdentifierSchema,
  IsoDateTimeSchema,
} from './common'

export const WindowRoleSchema = z.enum(['main', 'toolbar'])

export const WindowBoundsSchema = z
  .object({
    x: z.number().int(),
    y: z.number().int(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })
  .strict()

export const WindowStateSchema = z
  .object({
    version: ContractVersionSchema,
    role: WindowRoleSchema,
    displayId: IdentifierSchema,
    bounds: WindowBoundsSchema,
    visible: z.boolean(),
    focused: z.boolean(),
    minimized: z.boolean(),
    maximized: z.boolean(),
    fullScreen: z.boolean(),
    alwaysOnTop: z.boolean(),
    updatedAt: IsoDateTimeSchema,
    extensions: ExtensionsSchema.optional(),
  })
  .strict()

export const WindowStatesSchema = z
  .array(WindowStateSchema)
  .max(2)
  .superRefine((windows, context) => {
    const roles = new Set<string>()
    windows.forEach((window, index) => {
      if (roles.has(window.role)) {
        context.addIssue({
          code: 'custom',
          message: `Duplicate window role: ${window.role}`,
          path: [index, 'role'],
        })
      }
      roles.add(window.role)
    })
  })

export type WindowRole = z.infer<typeof WindowRoleSchema>
export type WindowBounds = z.infer<typeof WindowBoundsSchema>
export type WindowState = z.infer<typeof WindowStateSchema>

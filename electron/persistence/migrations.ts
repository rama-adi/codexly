import { z } from 'zod'

export type VersionedRecord = Readonly<Record<string, unknown>> & {
  version: number
}

export type Migration = Readonly<{
  from: number
  to: number
  migrate: (record: VersionedRecord) => VersionedRecord
}>

const VersionedRecordSchema = z.object({ version: z.number().int().nonnegative() }).passthrough()

/**
 * Applies an unambiguous sequence of one-version migrations.
 *
 * Migration functions must be pure: the same input must always produce the same
 * output. This runner rejects duplicate, skipped, backward, and version-mismatched
 * transitions so a stored record can only follow one deterministic path.
 */
export function migrateRecord(
  input: unknown,
  currentVersion: number,
  migrations: readonly Migration[],
): VersionedRecord {
  if (!Number.isInteger(currentVersion) || currentVersion < 0) {
    throw new Error('The current record version must be a non-negative integer.')
  }

  const bySourceVersion = new Map<number, Migration>()
  for (const migration of migrations) {
    if (!Number.isInteger(migration.from) || migration.from < 0 || migration.to !== migration.from + 1) {
      throw new Error('Migrations must advance exactly one version at a time.')
    }
    if (bySourceVersion.has(migration.from)) {
      throw new Error(`Duplicate migration for version ${migration.from}.`)
    }
    bySourceVersion.set(migration.from, migration)
  }

  let record = VersionedRecordSchema.parse(input) as VersionedRecord
  if (record.version > currentVersion) {
    throw new Error(`Record version ${record.version} is newer than supported version ${currentVersion}.`)
  }

  while (record.version < currentVersion) {
    const migration = bySourceVersion.get(record.version)
    if (!migration) {
      throw new Error(`Missing migration from version ${record.version}.`)
    }

    const migrated = VersionedRecordSchema.parse(migration.migrate(record)) as VersionedRecord
    if (migrated.version !== migration.to) {
      throw new Error(`Migration from version ${migration.from} must return version ${migration.to}.`)
    }
    record = migrated
  }

  return record
}

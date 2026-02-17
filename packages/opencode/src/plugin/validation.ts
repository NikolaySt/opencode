/**
 * Plugin Config Validation
 *
 * Lightweight validation for plugin configuration values.
 * Performs basic type and required-field checks without a
 * full JSON Schema validator — plugins validate their own
 * config thoroughly inside register().
 */

export type ValidationResult = { ok: true; value?: Record<string, unknown> } | { ok: false; errors: string[] }

/**
 * Validate a value against a JSON Schema object.
 * Performs basic type/property checking without a full Ajv dependency.
 * This is intentionally lightweight - plugins are expected to
 * validate their own config thoroughly inside register().
 */
export function validatePluginConfig(params: { schema?: Record<string, unknown>; value?: unknown }): ValidationResult {
  if (!params.schema) return { ok: true, value: params.value as Record<string, unknown> | undefined }

  const schema = params.schema
  const value = params.value ?? {}

  // Basic type check
  const type = schema.type
  if (type === "object" && (typeof value !== "object" || value === null || Array.isArray(value))) {
    return { ok: false, errors: ["expected an object"] }
  }

  // Required fields check
  const required = schema.required
  if (Array.isArray(required) && typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>
    const missing = required.filter(
      (key: unknown) => typeof key === "string" && (!(key in record) || record[key] === undefined),
    )
    if (missing.length > 0) {
      return { ok: false, errors: missing.map((k: string) => `missing required field: ${k}`) }
    }
  }

  return { ok: true, value: value as Record<string, unknown> }
}

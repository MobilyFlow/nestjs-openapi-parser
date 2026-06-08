import type { OpenApiDocument } from './types/openapi';

export interface ValidationResult {
  valid: boolean;
  /** Flattened, human-readable validation messages (empty when `valid`). */
  errors: string[];
}

// `@seriousme/openapi-schema-validator` is ESM-only. Under `module: commonjs`,
// `tsc` would downlevel a plain `import()` to `require()`, which throws on an
// ESM-only package (Node < 22). Routing the import through `Function` keeps a
// *native* dynamic import so it loads on every supported Node version.
const importEsm = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<unknown>;

interface ValidatorResult {
  valid: boolean;
  errors?: Array<{ instancePath?: string; message?: string }> | string;
}

interface ValidatorModule {
  Validator: new () => {
    validate(spec: Record<string, unknown>): Promise<ValidatorResult>;
  };
}

/**
 * Validate a generated document against the OpenAPI 3.x JSON Schema using
 * `@seriousme/openapi-schema-validator`. Returns validity plus flattened error
 * messages. The validator dependency is imported lazily, so callers that never
 * validate don't load it.
 */
export async function validateDocument(document: OpenApiDocument): Promise<ValidationResult> {
  const { Validator } = (await importEsm('@seriousme/openapi-schema-validator')) as ValidatorModule;
  const result = await new Validator().validate(document as unknown as Record<string, unknown>);
  return result.valid
    ? { valid: true, errors: [] }
    : { valid: false, errors: formatErrors(result) };
}

function formatErrors(result: ValidatorResult): string[] {
  const { errors } = result;
  if (!errors) return ['Document failed OpenAPI schema validation.'];
  if (typeof errors === 'string') return [errors];
  return errors.map((e) => `${e.instancePath || '(root)'}: ${e.message ?? 'invalid'}`);
}

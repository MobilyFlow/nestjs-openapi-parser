import { ClassDeclaration, Node, PropertyDeclaration, SyntaxKind, Type } from 'ts-morph';
import type { OpenApiSchema } from '../types/openapi';
import { AstIndex } from './ast-index';
import { filterScopedComments, getScopes, getTags, isVisible } from './tags';

export interface SchemaBuilderOptions {
  activeScopes?: Set<string>;
  /** Scope vocabulary used to recognize `<scope>…</scope>` description fragments. */
  knownScopes?: Set<string>;
}

export interface SchemaMembers {
  properties: Record<string, OpenApiSchema>;
  required: string[];
}

/**
 * Converts TypeScript classes (entities & DTOs) into OpenAPI `components.schemas`.
 * Handles:
 *  - required derived from `@IsOptional()` / `?` (configurable)
 *  - `@Exclude()` properties omitted (configurable)
 *  - union object types -> `oneOf`, string-literal unions -> enum
 *  - `PartialType / PickType / OmitType / IntersectionType` heritage
 */
export class SchemaBuilder {
  private readonly schemas: Record<string, OpenApiSchema> = {};
  private readonly pending = new Set<string>();
  private readonly done = new Set<string>();
  private readonly activeScopes: Set<string>;
  private readonly knownScopes: Set<string> | undefined;

  constructor(
    private readonly index: AstIndex,
    options: SchemaBuilderOptions = {},
  ) {
    this.activeScopes = options.activeScopes ?? new Set();
    this.knownScopes = options.knownScopes;
  }

  /** Register a reference to a class schema and return the `$ref` fragment. */
  registerRef(name: string): OpenApiSchema {
    if (!this.index.hasClass(name)) return { type: 'object' };
    if (!this.done.has(name)) this.pending.add(name);
    return { $ref: `#/components/schemas/${name}` };
  }

  /** Process the queue until no schema remains to build. */
  build(): void {
    while (this.pending.size) {
      const name = this.pending.values().next().value as string;
      this.pending.delete(name);
      if (this.done.has(name)) continue;
      this.done.add(name);

      const clazz = this.index.getClass(name);
      if (!clazz) continue;

      const classScopes = getScopes(getTags(clazz));
      if (!isVisible(classScopes, this.activeScopes)) {
        throw new Error(
          `Scope conflict: class "${name}" is reached by the spec but has @Scope ${formatScopes(classScopes)} ` +
            `which doesn't match the active scopes ${formatScopes(this.activeScopes)}. ` +
            `Add a matching scope to --scope/config.scopes, or hide whatever referenced it.`,
        );
      }

      const members = this.buildMembers(clazz);
      const schema: OpenApiSchema = { type: 'object', properties: members.properties };
      if (members.required.length) schema.required = members.required;
      const rawDesc = clazz.getJsDocs()[0]?.getCommentText();
      const desc = rawDesc
        ? filterScopedComments(rawDesc, this.activeScopes, {
            itemPath: name,
            knownScopes: this.knownScopes,
          })
        : undefined;
      if (desc) schema.description = desc;
      this.schemas[name] = schema;
    }
  }

  getSchemas(): Record<string, OpenApiSchema> {
    return this.schemas;
  }

  /** Public entry to map an arbitrary type to an OpenAPI schema fragment. */
  typeToSchema(type: Type): OpenApiSchema {
    return this.schemaForType(type);
  }

  /** Flatten a class's properties (own + inherited / mapped-type heritage). */
  buildMembers(clazz: ClassDeclaration): SchemaMembers {
    const base = clazz.getBaseClass();
    let inherited: SchemaMembers = { properties: {}, required: [] };
    if (base) {
      inherited = this.buildMembers(base);
    } else {
      const ext = clazz.getExtends();
      if (ext) inherited = this.resolveHeritage(ext.getExpression());
    }
    return this.mergeMembers(inherited, this.buildOwnMembers(clazz));
  }

  private buildOwnMembers(clazz: ClassDeclaration): SchemaMembers {
    const properties: Record<string, OpenApiSchema> = {};
    const required: string[] = [];
    const excludeDecorator = this.index.excludeDecorator;

    for (const prop of clazz.getInstanceProperties()) {
      if (!Node.isPropertyDeclaration(prop)) continue;
      if (prop.getDecorator(excludeDecorator)) continue;
      if (!isVisible(getScopes(getTags(prop)), this.activeScopes)) continue;

      const name = prop.getName();
      const schema = this.schemaForType(prop.getType());
      this.applyValidatorConstraints(schema, prop);
      const rawDesc = prop.getJsDocs()[0]?.getCommentText();
      const desc = rawDesc
        ? filterScopedComments(rawDesc, this.activeScopes, {
            itemPath: `${clazz.getName() ?? '<anon>'}.${name}`,
            knownScopes: this.knownScopes,
          })
        : undefined;

      properties[name] = desc ? withDescription(schema, desc) : schema;
      if (!this.index.isOptionalProperty(prop)) required.push(name);
    }

    return { properties, required };
  }

  /** Resolve `PartialType() / PickType() / OmitType() / IntersectionType()` heritage. */
  private resolveHeritage(expr: Node): SchemaMembers {
    if (Node.isIdentifier(expr)) {
      const cls = this.index.getClass(expr.getText());
      return cls ? this.buildMembers(cls) : { properties: {}, required: [] };
    }

    if (Node.isCallExpression(expr)) {
      const fnName = expr.getExpression().getText();
      const args = expr.getArguments();

      if (fnName === 'IntersectionType') {
        let merged: SchemaMembers = { properties: {}, required: [] };
        for (const arg of args) merged = this.mergeMembers(merged, this.resolveHeritage(arg));
        return merged;
      }

      const inner = args.length ? this.resolveHeritage(args[0]) : { properties: {}, required: [] };
      if (fnName === 'PartialType') return { properties: inner.properties, required: [] };
      if (fnName === 'PickType') return this.pick(inner, this.parseStringArray(args[1]));
      if (fnName === 'OmitType') return this.omit(inner, this.parseStringArray(args[1]));
      return inner;
    }

    return { properties: {}, required: [] };
  }

  private schemaForType(type: Type): OpenApiSchema {
    if (type.isString()) return { type: 'string' };
    if (type.isNumber()) return { type: 'number' };
    if (type.isBoolean()) return { type: 'boolean' };

    const symbolName = AstIndex.symbolName(type);
    if (symbolName === 'Date') return { type: 'string', format: 'date-time' };

    if (type.isArray()) {
      const element = type.getArrayElementType();
      return { type: 'array', items: element ? this.schemaForType(element) : {} };
    }

    if (symbolName && this.index.hasEnum(symbolName)) {
      return this.enumSchema(symbolName);
    }

    if (type.isUnion()) {
      const members = type.getUnionTypes().filter((t) => !t.isUndefined() && !t.isNull());
      if (members.length === 1) return this.schemaForType(members[0]);
      if (members.length && members.every((t) => t.isStringLiteral())) {
        return { type: 'string', enum: members.map((t) => t.getLiteralValue() as string) };
      }
      const objectMembers = members.filter((t) => {
        const n = AstIndex.symbolName(t);
        return n && this.index.hasClass(n);
      });
      if (members.length > 0 && objectMembers.length === members.length) {
        return { oneOf: members.map((t) => this.registerRef(AstIndex.symbolName(t)!)) };
      }
      return { type: 'object' };
    }

    if (symbolName && this.index.hasClass(symbolName)) {
      return this.registerRef(symbolName);
    }

    return { type: 'object' };
  }

  /**
   * Build the schema for a named TS enum, deriving `type` from the member
   * values rather than assuming strings:
   *  - all strings        -> `string`
   *  - all integers       -> `integer`
   *  - all numbers (some non-integer) -> `number`
   *  - mixed string/number -> `type` omitted (no single OpenAPI type fits)
   */
  private enumSchema(name: string): OpenApiSchema {
    const values = this.index.getEnumValues(name) ?? [];
    if (values.length === 0) return { type: 'string', enum: values };

    if (values.every((v) => typeof v === 'number')) {
      const type = values.every((v) => Number.isInteger(v)) ? 'integer' : 'number';
      return { type, enum: values };
    }
    if (values.every((v) => typeof v === 'string')) {
      return { type: 'string', enum: values };
    }
    return { enum: values };
  }

  /**
   * Merge class-validator constraints from a property's decorators into its
   * schema. Unknown decorators are ignored. A `$ref` is left untouched (its
   * siblings are ignored by OpenAPI 3.0, so constraints don't belong on it).
   *
   *  - `@Min/@Max`                  -> `minimum` / `maximum`
   *  - `@MinLength/@MaxLength`      -> `minLength` / `maxLength`
   *  - `@Length(min, max)`         -> `minLength` + `maxLength`
   *  - `@ArrayMinSize/@ArrayMaxSize` -> `minItems` / `maxItems`
   *  - `@IsEmail/@IsUrl/@IsUUID/@IsDateString` -> `format`
   *  - `@Matches(/re/)`            -> `pattern`
   *  - `@IsInt`                    -> narrows `number` to `integer`
   *  - `@IsPositive/@IsNegative`   -> exclusive `minimum` / `maximum` of 0
   */
  private applyValidatorConstraints(schema: OpenApiSchema, prop: PropertyDeclaration): void {
    if ('$ref' in schema) return;

    for (const decorator of prop.getDecorators()) {
      const args = decorator.getArguments();
      const setNum = (key: string, value: number | undefined): void => {
        if (value !== undefined) schema[key] = value;
      };

      switch (decorator.getName()) {
        case 'Min':
          setNum('minimum', literalNumber(args[0]));
          break;
        case 'Max':
          setNum('maximum', literalNumber(args[0]));
          break;
        case 'MinLength':
          setNum('minLength', literalNumber(args[0]));
          break;
        case 'MaxLength':
          setNum('maxLength', literalNumber(args[0]));
          break;
        case 'Length':
          setNum('minLength', literalNumber(args[0]));
          setNum('maxLength', literalNumber(args[1]));
          break;
        case 'ArrayMinSize':
          setNum('minItems', literalNumber(args[0]));
          break;
        case 'ArrayMaxSize':
          setNum('maxItems', literalNumber(args[0]));
          break;
        case 'IsEmail':
          schema.format = 'email';
          break;
        case 'IsUrl':
          schema.format = 'uri';
          break;
        case 'IsUUID':
          schema.format = 'uuid';
          break;
        case 'IsDateString':
          schema.format = 'date-time';
          break;
        case 'IsInt':
          if (schema.type === 'number') schema.type = 'integer';
          break;
        case 'IsPositive':
          schema.minimum = 0;
          schema.exclusiveMinimum = true;
          break;
        case 'IsNegative':
          schema.maximum = 0;
          schema.exclusiveMaximum = true;
          break;
        case 'Matches': {
          const pattern = regexLiteralPattern(args[0]);
          if (pattern !== undefined) schema.pattern = pattern;
          break;
        }
      }
    }
  }

  private mergeMembers(a: SchemaMembers, b: SchemaMembers): SchemaMembers {
    const properties = { ...a.properties, ...b.properties };
    const required = [...new Set([...a.required, ...b.required])].filter((k) => k in properties);
    return { properties, required };
  }

  private pick(members: SchemaMembers, keys: string[]): SchemaMembers {
    const properties: Record<string, OpenApiSchema> = {};
    for (const key of keys)
      if (key in members.properties) properties[key] = members.properties[key];
    return { properties, required: members.required.filter((k) => keys.includes(k)) };
  }

  private omit(members: SchemaMembers, keys: string[]): SchemaMembers {
    const properties: Record<string, OpenApiSchema> = {};
    for (const key of Object.keys(members.properties)) {
      if (!keys.includes(key)) properties[key] = members.properties[key];
    }
    return { properties, required: members.required.filter((k) => !keys.includes(k)) };
  }

  private parseStringArray(arg?: Node): string[] {
    if (!arg) return [];
    let node: Node = arg;
    if (Node.isAsExpression(node)) node = node.getExpression();
    if (Node.isArrayLiteralExpression(node)) {
      return node
        .getElements()
        .map((el) =>
          Node.isStringLiteral(el) ? el.getLiteralValue() : el.getText().replace(/['"]/g, ''),
        );
    }
    return [];
  }
}

function formatScopes(scopes: Set<string>): string {
  return scopes.size === 0 ? '{}' : `{${[...scopes].join(', ')}}`;
}

/** A numeric decorator argument, supporting a leading unary `-`/`+` (e.g. `@Min(-1)`). */
function literalNumber(arg: Node | undefined): number | undefined {
  if (!arg) return undefined;
  if (Node.isNumericLiteral(arg)) return arg.getLiteralValue();
  if (Node.isPrefixUnaryExpression(arg)) {
    const operand = arg.getOperand();
    if (Node.isNumericLiteral(operand)) {
      const value = operand.getLiteralValue();
      return arg.getOperatorToken() === SyntaxKind.MinusToken ? -value : value;
    }
  }
  return undefined;
}

/** The pattern of a `@Matches(...)` argument — a regex literal `/re/flags` or a string. */
function regexLiteralPattern(arg: Node | undefined): string | undefined {
  if (!arg) return undefined;
  if (Node.isStringLiteral(arg)) return arg.getLiteralValue();
  const match = /^\/(.*)\/[dgimsuy]*$/s.exec(arg.getText());
  return match ? match[1] : undefined;
}

/**
 * Attach a `description` to a property schema. A `$ref` is a Reference Object
 * whose sibling keys are ignored in OpenAPI 3.0, so a bare `$ref` is wrapped in
 * `allOf` (a normal Schema Object) so the description is actually honored. Any
 * other schema takes the description directly as a sibling.
 */
function withDescription(schema: OpenApiSchema, description: string): OpenApiSchema {
  if ('$ref' in schema) {
    return { allOf: [schema], description };
  }
  schema.description = description;
  return schema;
}

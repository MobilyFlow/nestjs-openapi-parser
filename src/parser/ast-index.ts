import fs from 'node:fs';
import path from 'node:path';
import {
  ClassDeclaration,
  ClassInstancePropertyTypes,
  EnumDeclaration,
  Node,
  Project,
  Type,
} from 'ts-morph';
import { DEFAULT_CONVENTIONS, DEFAULT_PROJECT } from '../config/defaults';
import type { ConventionsConfig, NestParserHooks, ProjectConfig } from '../config/types';
import { getScopes, getTags } from './tags';

export interface AstIndexOptions {
  projectRoot: string;
  project?: ProjectConfig;
  conventions?: ConventionsConfig;
  hooks?: Pick<NestParserHooks, 'isDto'>;
}

/**
 * Builds and indexes the TypeScript AST of the user's source tree with ts-morph
 * so the OpenAPI generator can resolve classes (entities/DTOs), enums and
 * controllers purely from source code.
 */
export class AstIndex {
  readonly project: Project;
  private readonly classesMap = new Map<string, ClassDeclaration>();
  private readonly enumsMap = new Map<string, EnumDeclaration>();
  private readonly conventions: Required<ConventionsConfig>;
  private readonly isDtoHook: NestParserHooks['isDto'];

  constructor(options: AstIndexOptions) {
    const projectCfg = { ...DEFAULT_PROJECT, ...options.project };
    this.conventions = { ...DEFAULT_CONVENTIONS, ...options.conventions };
    this.isDtoHook = options.hooks?.isDto;

    const tsConfigFilePath = path.isAbsolute(projectCfg.tsConfigFilePath)
      ? projectCfg.tsConfigFilePath
      : path.resolve(options.projectRoot, projectCfg.tsConfigFilePath);

    this.project = new Project({ tsConfigFilePath });

    const rootDir = path.isAbsolute(projectCfg.rootDir)
      ? projectCfg.rootDir
      : path.resolve(options.projectRoot, projectCfg.rootDir);

    this.generateMaps(rootDir, projectCfg.excludeSuffixes);
  }

  private generateMaps(folder: string, excludeSuffixes: string[]): void {
    if (!fs.existsSync(folder)) return;
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        this.generateMaps(full, excludeSuffixes);
        continue;
      }
      if (!entry.name.endsWith('.ts')) continue;
      if (excludeSuffixes.some((suffix) => entry.name.endsWith(suffix))) continue;

      const sourceFile = this.project.getSourceFile(full);
      if (!sourceFile) continue;
      for (const clazz of sourceFile.getClasses()) {
        const name = clazz.getName();
        if (name) this.classesMap.set(name, clazz);
      }
      for (const e of sourceFile.getEnums()) {
        this.enumsMap.set(e.getName(), e);
      }
    }
  }

  getClass(name: string): ClassDeclaration | undefined {
    return this.classesMap.get(name);
  }

  hasClass(name: string): boolean {
    return this.classesMap.has(name);
  }

  getEnum(name: string): EnumDeclaration | undefined {
    return this.enumsMap.get(name);
  }

  hasEnum(name: string): boolean {
    return this.enumsMap.has(name);
  }

  /** All classes carrying the configured entity decorator. */
  getEntities(): ClassDeclaration[] {
    const decoratorName = this.conventions.entityDecorator;
    return [...this.classesMap.values()].filter((c) => !!c.getDecorator(decoratorName));
  }

  /** All DTO classes — default: file ends in `.dto.ts` or class name matches `/(DTO|Dto)$/`. */
  getDtos(): ClassDeclaration[] {
    const isDto = this.isDtoHook ?? defaultIsDto;
    return [...this.classesMap.values()].filter((c) => isDto(c));
  }

  /** All classes decorated with `@Controller(...)`. */
  getControllers(): ClassDeclaration[] {
    return [...this.classesMap.values()].filter((c) => !!c.getDecorator('Controller'));
  }

  /**
   * Every distinct `@Scope` value declared anywhere in the indexed source
   * (classes, methods, properties). This is the scope *vocabulary* — used to
   * tell genuine `<scope>…</scope>` description fragments apart from ordinary
   * angle-bracket prose like `Array<string>` or `<id>`.
   */
  getDeclaredScopes(): Set<string> {
    const scopes = new Set<string>();
    for (const clazz of this.classesMap.values()) {
      for (const s of getScopes(getTags(clazz))) scopes.add(s);
      for (const method of clazz.getInstanceMethods()) {
        for (const s of getScopes(getTags(method))) scopes.add(s);
      }
      for (const prop of clazz.getInstanceProperties()) {
        for (const s of getScopes(getTags(prop))) scopes.add(s);
      }
    }
    return scopes;
  }

  /** Walk a class + its real base classes, returning every instance property. */
  getAllProperties(clazz: ClassDeclaration): ClassInstancePropertyTypes[] {
    let properties: ClassInstancePropertyTypes[] = [];
    let it: ClassDeclaration | undefined = clazz;
    while (it) {
      properties = [...it.getInstanceProperties(), ...properties];
      it = it.getBaseClass();
    }
    return properties;
  }

  /** Resolve the named enum's string values, or undefined if unknown. */
  getEnumValues(name: string): (string | number)[] | undefined {
    const e = this.enumsMap.get(name);
    if (!e) return undefined;
    return e.getMembers().map((m) => m.getValue() as string | number);
  }

  /** Symbol name of a type (e.g. `Date`, `App`, `ProductType`), if any. */
  static symbolName(type: Type): string | undefined {
    return type.getSymbol()?.getName() ?? type.getAliasSymbol()?.getName();
  }

  isOptionalProperty(prop: ClassInstancePropertyTypes): boolean {
    if (!Node.isPropertyDeclaration(prop)) return false;
    return prop.hasQuestionToken() || !!prop.getDecorator(this.conventions.optionalDecorator);
  }

  get excludeDecorator(): string {
    return this.conventions.excludeDecorator;
  }
}

function defaultIsDto(clazz: ClassDeclaration): boolean {
  const fileName = clazz.getSourceFile().getBaseName();
  const name = clazz.getName() ?? '';
  return fileName.endsWith('.dto.ts') || /(DTO|Dto)$/.test(name);
}

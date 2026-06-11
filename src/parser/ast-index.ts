import fs from 'node:fs';
import path from 'node:path';
import {
  ClassDeclaration,
  ClassInstancePropertyTypes,
  EnumDeclaration,
  InterfaceDeclaration,
  Node,
  Project,
  Type,
  TypeAliasDeclaration,
} from 'ts-morph';
import { DEFAULT_CONVENTIONS, DEFAULT_PROJECT } from '../config/defaults';
import type { ConventionsConfig, ProjectConfig } from '../config/types';
import { getScopes, getTags } from './tags';

export interface AstIndexOptions {
  projectRoot: string;
  project?: ProjectConfig;
  conventions?: ConventionsConfig;
}

/**
 * Builds and indexes the TypeScript AST of the user's source tree with ts-morph
 * so the OpenAPI generator can resolve classes (entities/DTOs), interfaces, type
 * aliases, enums and controllers purely from source code.
 */
export class AstIndex {
  readonly project: Project;
  private readonly classesMap = new Map<string, ClassDeclaration>();
  private readonly interfacesMap = new Map<string, InterfaceDeclaration>();
  private readonly typeAliasesMap = new Map<string, TypeAliasDeclaration>();
  private readonly enumsMap = new Map<string, EnumDeclaration>();
  private readonly conventions: Required<ConventionsConfig>;

  constructor(options: AstIndexOptions) {
    const projectCfg = { ...DEFAULT_PROJECT, ...options.project };
    this.conventions = { ...DEFAULT_CONVENTIONS, ...options.conventions };

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
    // Sort entries by name so the traversal order — and therefore the order of
    // paths, schemas and tags in the output — is identical across filesystems
    // and platforms. `fs.readdirSync` order is not guaranteed (arbitrary on
    // ext4/xfs), and `localeCompare` would reintroduce locale-dependent
    // ordering, so compare raw strings by UTF-16 code unit.
    const entries = fs
      .readdirSync(folder, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
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
      for (const iface of sourceFile.getInterfaces()) {
        this.interfacesMap.set(iface.getName(), iface);
      }
      for (const alias of sourceFile.getTypeAliases()) {
        this.typeAliasesMap.set(alias.getName(), alias);
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

  getInterface(name: string): InterfaceDeclaration | undefined {
    return this.interfacesMap.get(name);
  }

  hasInterface(name: string): boolean {
    return this.interfacesMap.has(name);
  }

  getTypeAlias(name: string): TypeAliasDeclaration | undefined {
    return this.typeAliasesMap.get(name);
  }

  hasTypeAlias(name: string): boolean {
    return this.typeAliasesMap.has(name);
  }

  /** True when the name resolves to any schema model — class, interface or type alias. */
  hasModel(name: string): boolean {
    return this.hasClass(name) || this.hasInterface(name) || this.hasTypeAlias(name);
  }

  /**
   * The declaration node backing a named model (class, interface or type alias),
   * or undefined if unknown. A class wins over an interface, an interface over a
   * type alias, mirroring the resolution order used elsewhere. Used for shared
   * JSDoc/`@Scope` handling across the three kinds.
   */
  getModel(
    name: string,
  ): ClassDeclaration | InterfaceDeclaration | TypeAliasDeclaration | undefined {
    return this.getClass(name) ?? this.getInterface(name) ?? this.getTypeAlias(name);
  }

  hasEnum(name: string): boolean {
    return this.enumsMap.has(name);
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
    for (const iface of this.interfacesMap.values()) {
      for (const s of getScopes(getTags(iface))) scopes.add(s);
      for (const prop of iface.getProperties()) {
        for (const s of getScopes(getTags(prop))) scopes.add(s);
      }
    }
    for (const alias of this.typeAliasesMap.values()) {
      for (const s of getScopes(getTags(alias))) scopes.add(s);
    }
    return scopes;
  }

  /** Resolve the named enum's member values (string or numeric), or undefined if unknown. */
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

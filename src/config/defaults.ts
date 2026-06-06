import type { ConventionsConfig, ProjectConfig } from './types';

export const DEFAULT_PROJECT: Required<Omit<ProjectConfig, 'excludeSuffixes'>> & {
  excludeSuffixes: string[];
} = {
  tsConfigFilePath: 'tsconfig.json',
  rootDir: 'src',
  globalPrefix: '',
  excludeSuffixes: ['.spec.ts', '.test.ts', '.d.ts'],
};

export const DEFAULT_CONVENTIONS: Required<ConventionsConfig> = {
  entityDecorator: 'Entity',
  excludeDecorator: 'Exclude',
  optionalDecorator: 'IsOptional',
};

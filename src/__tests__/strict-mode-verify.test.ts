export {};

import * as fs from 'fs';
import * as path from 'path';

describe('TypeScript Strict Mode', () => {
  const tsconfigPath = path.join(__dirname, '..', '..', 'tsconfig.json');
  let tsconfig: { compilerOptions: Record<string, unknown> };

  beforeAll(() => {
    const content = fs.readFileSync(tsconfigPath, 'utf-8');
    tsconfig = JSON.parse(content);
  });

  it('strict mode value is consistent', () => {
    // strict is currently false in the project's tsconfig
    expect(tsconfig.compilerOptions.strict).toBe(false);
  });

  it('noImplicitAny matches current config', () => {
    // Currently explicitly set to false
    expect(tsconfig.compilerOptions.noImplicitAny).toBe(false);
  });

  it('strictNullChecks is not explicitly overridden', () => {
    // Not set in current tsconfig (undefined)
    expect(tsconfig.compilerOptions.strictNullChecks).toBeUndefined();
  });

  it('noImplicitReturns matches current config', () => {
    // Currently set to false
    expect(tsconfig.compilerOptions.noImplicitReturns).toBe(false);
  });

  it('noFallthroughCasesInSwitch is enabled', () => {
    expect(tsconfig.compilerOptions.noFallthroughCasesInSwitch).toBe(true);
  });

  it('target is ES2022', () => {
    expect(tsconfig.compilerOptions.target).toBe('ES2022');
  });

  it('noImplicitAny is explicitly configured', () => {
    // noImplicitAny is explicitly set in the current config
    expect(tsconfig.compilerOptions.noImplicitAny).toBeDefined();
  });
});

import * as fs from 'fs';
import * as path from 'path';

describe('Fix #26 — package.json db:push:prod aliases removed + CI guards present', () => {
  const repoRoot = path.resolve(__dirname, '../..');
  it('package.json has no db:push:prod:* scripts', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    const dangerous = Object.keys(pkg.scripts).filter(k => k === 'db:push:prod' || k.startsWith('db:push:prod:'));
    expect(dangerous).toEqual([]);
  });
  it('only db:migrate:prod:ecs-task is allowed as a db:migrate:prod:* alias', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    const matches = Object.keys(pkg.scripts).filter(k => k.startsWith('db:migrate:prod:'));
    expect(matches).toEqual(['db:migrate:prod:ecs-task']);
  });
  it('db:migrate:prod:ecs-task command is prisma migrate deploy', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    expect(pkg.scripts['db:migrate:prod:ecs-task']).toBe('prisma migrate deploy');
  });
  it('env-lint workflow contains lint-no-prod-db-npm-scripts step', () => {
    const yml = fs.readFileSync(path.join(repoRoot, '.github/workflows/env-lint.yml'), 'utf8');
    expect(yml).toMatch(/lint-no-prod-db-npm-scripts/);
    expect(yml).toMatch(/lint-env-example-no-prod-superuser/);
  });
  it('CI lint uses correct jq regex blocking db:push:prod:* and non-ecs-task db:migrate:prod:*', () => {
    const yml = fs.readFileSync(path.join(repoRoot, '.github/workflows/env-lint.yml'), 'utf8');
    expect(yml).toMatch(/\^db:push:prod\(\$\|:\)/);
    expect(yml).toMatch(/\^db:migrate:prod\(\$\|:\(\?!ecs-task\$\)\)/);
  });
});

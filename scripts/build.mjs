#!/usr/bin/env node
// Bundles every Lambda function with esbuild into dist/<function>/index.mjs.
// One small, tree-shaken ES module per function => faster cold starts and small packages.
// The SAM template points each function's CodeUri to its dist/<function> folder.

import { build } from 'esbuild';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const functionsDir = join(root, 'src', 'functions');
const distDir = join(root, 'dist');

const functions = readdirSync(functionsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(functionsDir, entry.name, 'index.mjs')))
  .map((entry) => entry.name)
  .sort();

rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

const started = Date.now();
const results = await Promise.all(
  functions.map(async (name) => {
    const outdir = join(distDir, name);
    const result = await build({
      entryPoints: [join(functionsDir, name, 'index.mjs')],
      outfile: join(outdir, 'index.mjs'),
      bundle: true,
      platform: 'node',
      target: 'node22',
      format: 'esm',
      minify: true,
      sourcemap: true,
      sourcesContent: false,
      legalComments: 'none',
      metafile: true,
      mainFields: ['module', 'main'],
      // Some bundled CommonJS dependencies call require() on Node built-ins.
      banner: {
        js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
      },
      logLevel: 'warning',
    });
    writeFileSync(join(outdir, 'package.json'), `${JSON.stringify({ name: `blogify-${name}`, type: 'module' }, null, 2)}\n`);
    const bytes = Object.values(result.metafile.outputs).reduce((sum, output) => sum + output.bytes, 0);
    return { name, bytes };
  }),
);

// The documentation function serves the OpenAPI specification (converted to JSON).
const openapiYaml = join(root, 'docs', 'openapi.yaml');
if (existsSync(openapiYaml) && functions.includes('docs')) {
  const spec = parseYaml(readFileSync(openapiYaml, 'utf8'));
  writeFileSync(join(distDir, 'docs', 'openapi.json'), JSON.stringify(spec));
}

for (const { name, bytes } of results) {
  console.log(`  ${name.padEnd(18)} ${(bytes / 1024).toFixed(1).padStart(8)} KiB`);
}
console.log(`Built ${results.length} functions into dist/ in ${Date.now() - started} ms`);

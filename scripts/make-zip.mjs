#!/usr/bin/env node
// Creates blogify-source.zip (source code + docs, without node_modules / build outputs)
// from the committed content of the repository, ready to be uploaded on Moodle.

import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';

const output = process.argv[2] ?? 'blogify-source.zip';
execFileSync('git', ['archive', '--format=zip', '--prefix=blogify/', '-o', output, 'HEAD'], { stdio: 'inherit' });
console.log(`${output} created (${(statSync(output).size / 1024).toFixed(0)} KiB) from the last commit.`);

// Small helpers shared by the operational scripts (argument parsing, stack outputs).

import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';

/** Parses "--key value" and "--flag" arguments. */
export function parseArgs(argv = process.argv.slice(2)) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const [key, inlineValue] = arg.slice(2).split('=');
    if (inlineValue !== undefined) args[key] = inlineValue;
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) args[key] = argv[++i];
    else args[key] = true;
  }
  return args;
}

/** Reads the CloudFormation outputs of the deployed stack as a { key: value } object. */
export async function stackOutputs(stackName, region) {
  const client = new CloudFormationClient(region ? { region } : {});
  const { Stacks } = await client.send(new DescribeStacksCommand({ StackName: stackName }));
  if (!Stacks?.length) throw new Error(`Stack ${stackName} not found`);
  return Object.fromEntries((Stacks[0].Outputs ?? []).map((o) => [o.OutputKey, o.OutputValue]));
}

export const color = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

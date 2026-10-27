#!/usr/bin/env node
// Creates (or promotes) a Blogify administrator directly in Cognito, with a permanent password.
// Requires AWS credentials allowed to administer the user pool (the deployer's credentials).
//
// Usage:
//   node scripts/bootstrap-admin.mjs --email admin@example.com --password 'Str0ngPassw0rd' [--name "Admin"]
//        [--stack blogify-dev] [--region eu-west-3] [--user-pool-id eu-west-3_xxx] [--role admin]

import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminGetUserCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import { color, parseArgs, stackOutputs } from './lib/cli.mjs';

const args = parseArgs();
const email = args.email;
const password = args.password;
const role = args.role ?? 'admin';
const name = args.name ?? 'Administrator';

if (!email || !password) {
  console.error('Usage: node scripts/bootstrap-admin.mjs --email <email> --password <password> [--name <name>] [--stack <stack>] [--region <region>] [--user-pool-id <id>] [--role admin|editor|guest-author]');
  process.exit(1);
}

const region = args.region;
const userPoolId = args['user-pool-id'] ?? (await stackOutputs(args.stack ?? 'blogify-dev', region)).UserPoolId;
const cognito = new CognitoIdentityProviderClient(region ? { region } : {});

let username;
try {
  const user = await cognito.send(new AdminGetUserCommand({ UserPoolId: userPoolId, Username: email }));
  username = user.Username;
  console.log(color.yellow(`User ${email} already exists (${username}) - updating password and role.`));
} catch (err) {
  if (err.name !== 'UserNotFoundException') throw err;
  const created = await cognito.send(
    new AdminCreateUserCommand({
      UserPoolId: userPoolId,
      Username: email,
      MessageAction: 'SUPPRESS',
      UserAttributes: [
        { Name: 'email', Value: email },
        { Name: 'email_verified', Value: 'true' },
        { Name: 'name', Value: name },
      ],
    }),
  );
  username = created.User.Username;
  console.log(color.green(`Created user ${email} (${username}).`));
}

await cognito.send(
  new AdminSetUserPasswordCommand({ UserPoolId: userPoolId, Username: username, Password: password, Permanent: true }),
);
await cognito.send(new AdminAddUserToGroupCommand({ UserPoolId: userPoolId, Username: username, GroupName: role }));
console.log(color.green(`User ${email} is now in group "${role}" with a permanent password.`));
console.log(`Log in with: POST /auth/login {"email":"${email}","password":"..."}`);

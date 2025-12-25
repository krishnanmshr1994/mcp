import jsforce from 'jsforce';
import { McpProvider } from './provider.js';

async function getSalesforceConnection(): Promise<jsforce.Connection> {
  const loginUrl = process.env.SALESFORCE_LOGIN_URL || 'https://login.salesforce.com';
  const username = process.env.SALESFORCE_USERNAME;
  const password = process.env.SALESFORCE_PASSWORD;
  const token = process.env.SALESFORCE_SECURITY_TOKEN;

  if (!username || !password || !token) {
    throw new Error('Missing Salesforce credentials in environment variables');
  }

  const conn = new jsforce.Connection({ loginUrl });
  console.log(`🔑 Logging into Salesforce org at ${loginUrl} as ${username}...`);
  await conn.login(username, password + token);
  console.log(`✅ Salesforce login successful`);
  return conn;
}

async function main() {
  const conn = await getSalesforceConnection();

  const provider = new McpProvider({
    tools: [
      {
        name: 'query',
        description: 'Execute SOQL query',
        invoke: async (args) => {
          const result = await conn.query(args.soql);
          return result;
        }
      },
      {
        name: 'describe',
        description: 'Get object metadata',
        invoke: async (args) => {
          return await conn.describe(args.objectName);
        }
      }
      // Add create/update/delete here similarly
    ]
  });

  await provider.start(); // or whatever starts JSON-RPC loop
}

main().catch(err => {
  console.error('❌ Runtime error:', err);
  process.exit(1);
});
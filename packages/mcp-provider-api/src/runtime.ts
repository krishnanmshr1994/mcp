import jsforce from 'jsforce';
import { McpProvider } from './provider.js';
import { serve } from '@modelcontextprotocol/sdk';

async function getSalesforceConnection() {
  const loginUrl = process.env.SALESFORCE_LOGIN_URL || 'https://login.salesforce.com';
  const username = process.env.SALESFORCE_USERNAME;
  const password = process.env.SALESFORCE_PASSWORD;
  const token = process.env.SALESFORCE_SECURITY_TOKEN;
  
  if (!username || !password || !token) {
    throw new Error('Missing Salesforce credentials');
  }

  const conn = new jsforce.Connection({ loginUrl });
  console.log(`🔑 Logging into Salesforce at ${loginUrl} as ${username}...`);
  await conn.login(username, password + token);
  console.log('✅ Salesforce login successful');
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
          if (!args.soql) throw new Error('SOQL is required');
          return await conn.query(args.soql);
        }
      },
      {
        name: 'describe',
        description: 'Describe object',
        invoke: async (args) => {
          if (!args.objectName) throw new Error('objectName is required');
          return await conn.describe(args.objectName);
        }
      }
      // add more if needed
    ]
  });

  // Start the JSON-RPC loop: listens on stdin, writes to stdout
  await serve(provider);
}

main().catch((err) => {
  console.error('❌ MCP runtime failed:', err);
  process.exit(1);
});
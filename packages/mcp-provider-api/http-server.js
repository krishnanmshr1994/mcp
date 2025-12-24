import express from 'express';
import { spawn } from 'child_process';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'salesforce-mcp-provider' });
});

// MCP RPC endpoint
app.post('/mcp', async (req, res) => {
  try {
    const mcpProcess = spawn('node', ['dist/index.js'], {
      env: {
        ...process.env,
        SALESFORCE_LOGIN_URL: process.env.SALESFORCE_LOGIN_URL,
        SALESFORCE_USERNAME: process.env.SALESFORCE_USERNAME,
        SALESFORCE_PASSWORD: process.env.SALESFORCE_PASSWORD,
        SALESFORCE_SECURITY_TOKEN: process.env.SALESFORCE_SECURITY_TOKEN
      }
    });

    let output = '';
    let errorOutput = '';

    mcpProcess.stdin.write(JSON.stringify(req.body) + '\n');
    mcpProcess.stdin.end();

    mcpProcess.stdout.on('data', (data) => {
      output += data.toString();
    });

    mcpProcess.stderr.on('data', (data) => {
      errorOutput += data.toString();
      console.error('MCP stderr:', data.toString());
    });

    mcpProcess.on('close', (code) => {
      if (code !== 0) {
        console.error('MCP process error:', errorOutput);
        return res.status(500).json({ 
          error: 'MCP process failed',
          details: errorOutput,
          code 
        });
      }

      try {
        const lines = output.trim().split('\n').filter(l => l.trim());
        const responses = lines.map(line => JSON.parse(line));
        res.json(responses[responses.length - 1] || responses);
      } catch (e) {
        console.error('Parse error:', e, 'Output:', output);
        res.status(500).json({ 
          error: 'Failed to parse MCP response',
          raw: output 
        });
      }
    });

  } catch (error) {
    console.error('Server error:', error);
    res.status(500).json({ 
      error: error.message,
      stack: error.stack 
    });
  }
});

// List available tools
app.get('/tools', (req, res) => {
  res.json({
    tools: [
      { name: 'query', description: 'Execute SOQL query' },
      { name: 'create', description: 'Create Salesforce record' },
      { name: 'update', description: 'Update Salesforce record' },
      { name: 'delete', description: 'Delete Salesforce record' }
    ]
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Salesforce MCP Provider running on port ${PORT}`);
});
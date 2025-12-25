import express from 'express';
import { spawn } from 'child_process';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 8080;

// NVIDIA LLM Configuration
const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY || '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';
const NVIDIA_API_BASE = 'https://integrate.api.nvidia.com/v1';
const NVIDIA_MODEL = process.env.NVIDIA_MODEL || 'meta/llama-3.3-70b-instruct';

// Cache for schema information
let schemaCache = null;
let schemaCacheTime = null;
const SCHEMA_CACHE_TTL = 3600000; // 1 hour

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'salesforce-mcp-provider',
    llmEnabled: !!NVIDIA_API_KEY,
    model: NVIDIA_MODEL,
    schemaCached: !!schemaCache
  });
});

// ============================================
// SCHEMA DISCOVERY
// ============================================

// Get Salesforce org schema (objects and fields)
app.get('/schema', async (req, res) => {
  try {
    const schema = await getOrgSchema();
    res.json(schema);
  } catch (error) {
    console.error('Schema error:', error);
    res.status(500).json({ 
      error: 'Failed to fetch schema',
      details: error.message 
    });
  }
});

// Get schema for specific object
app.get('/schema/:objectName', async (req, res) => {
  try {
    const { objectName } = req.params;
    const objectSchema = await getObjectSchema(objectName);
    res.json(objectSchema);
  } catch (error) {
    console.error('Object schema error:', error);
    res.status(500).json({ 
      error: 'Failed to fetch object schema',
      details: error.message 
    });
  }
});

// ============================================
// MCP ENDPOINTS
// ============================================

// Execute MCP commands
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
      { name: 'delete', description: 'Delete Salesforce record' },
      { name: 'describe', description: 'Get object metadata' }
    ]
  });
});

// ============================================
// LLM ENDPOINTS
// ============================================

// Chat with LLM (with optional Salesforce context)
app.post('/chat', async (req, res) => {
  try {
    if (!NVIDIA_API_KEY) {
      return res.status(503).json({ 
        error: 'LLM not configured. Please set NVIDIA_API_KEY environment variable.' 
      });
    }

    const { message, conversationHistory = [], includeContext = false, includeSchema = false } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    let systemPrompt = `You are a helpful Salesforce assistant. You can help users understand their Salesforce data, generate SOQL queries, and provide insights.`;

    // Include schema information if requested
    if (includeSchema) {
      try {
        const schema = await getOrgSchema();
        systemPrompt += `\n\nAvailable Salesforce Objects in this org:\n${formatSchemaForPrompt(schema)}`;
      } catch (err) {
        console.error('Failed to fetch schema:', err);
      }
    }

    // Optionally fetch Salesforce context
    let salesforceContext = '';
    if (includeContext) {
      try {
        const contextData = await fetchSalesforceContext(message);
        if (contextData) {
          salesforceContext = `\n\nCurrent Salesforce Context:\n${JSON.stringify(contextData, null, 2)}`;
          systemPrompt += salesforceContext;
        }
      } catch (err) {
        console.error('Failed to fetch context:', err);
      }
    }

    const messages = [
      { role: 'system', content: systemPrompt },
      ...conversationHistory.map(msg => ({
        role: msg.role,
        content: msg.content
      })),
      { role: 'user', content: message }
    ];

    const response = await fetch(`${NVIDIA_API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${NVIDIA_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: NVIDIA_MODEL,
        messages: messages,
        temperature: 0.7,
        max_tokens: 1024,
        top_p: 1.0
      })
    });

    if (!response.ok) {
      const errorData = await response.text();
      throw new Error(`NVIDIA API error: ${response.status} - ${errorData}`);
    }

    const data = await response.json();
    const assistantMessage = data.choices[0].message.content;

    res.json({
      response: assistantMessage,
      model: NVIDIA_MODEL,
      contextIncluded: includeContext && !!salesforceContext,
      schemaIncluded: includeSchema
    });

  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({ 
      error: 'Failed to process chat',
      details: error.message 
    });
  }
});

// Generate SOQL query from natural language (with dynamic schema)
app.post('/generate-soql', async (req, res) => {
  try {
    if (!NVIDIA_API_KEY) {
      return res.status(503).json({ 
        error: 'LLM not configured. Please set NVIDIA_API_KEY environment variable.' 
      });
    }

    const { question, objectHint } = req.body;

    if (!question) {
      return res.status(400).json({ error: 'Question is required' });
    }

    // Get org schema dynamically
    const schema = await getOrgSchema();
    const schemaDescription = formatSchemaForPrompt(schema);

    // If object hint provided, get detailed schema for that object
    let detailedObjectInfo = '';
    if (objectHint) {
      try {
        const objectSchema = await getObjectSchema(objectHint);
        detailedObjectInfo = `\n\nDetailed schema for ${objectHint}:\n${JSON.stringify(objectSchema, null, 2)}`;
      } catch (err) {
        console.error('Failed to get object schema:', err);
      }
    }

    const prompt = `You are a Salesforce SOQL expert. Convert the following natural language question into a valid SOQL query.

${schemaDescription}${detailedObjectInfo}

IMPORTANT RULES:
1. If there are custom objects with similar names to standard objects, ASK the user to clarify which one they mean
2. Custom objects end with __c (e.g., Custom_Account__c)
3. Custom fields end with __c (e.g., Custom_Field__c)
4. Always use the exact API names from the schema above
5. If you're unsure which object or field to use, ask the user for clarification

Question: ${question}

If you need clarification about which object or field to use, respond with:
CLARIFICATION_NEEDED: [your question to the user]

Otherwise, respond ONLY with the SOQL query. No explanations, no markdown, just the query.`;

    const response = await fetch(`${NVIDIA_API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${NVIDIA_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: NVIDIA_MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 512
      })
    });

    const data = await response.json();
    let result = data.choices[0].message.content.trim();
    
    // Check if clarification is needed
    if (result.startsWith('CLARIFICATION_NEEDED:')) {
      const clarificationQuestion = result.replace('CLARIFICATION_NEEDED:', '').trim();
      return res.json({
        needsClarification: true,
        question: clarificationQuestion,
        originalQuestion: question
      });
    }

    // Clean up any markdown or extra text
    result = result.replace(/```sql\n?/g, '').replace(/```\n?/g, '').trim();

    res.json({
      soql: result,
      originalQuestion: question,
      needsClarification: false
    });

  } catch (error) {
    console.error('SOQL generation error:', error);
    res.status(500).json({ 
      error: 'Failed to generate SOQL',
      details: error.message 
    });
  }
});

// Smart query: Natural language → SOQL → Execute → Explain results
app.post('/smart-query', async (req, res) => {
  try {
    if (!NVIDIA_API_KEY) {
      return res.status(503).json({ 
        error: 'LLM not configured. Please set NVIDIA_API_KEY environment variable.' 
      });
    }

    const { question, objectHint } = req.body;

    if (!question) {
      return res.status(400).json({ error: 'Question is required' });
    }

    // Step 1: Generate SOQL
    const soqlResponse = await fetch(`http://localhost:${PORT}/generate-soql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, objectHint })
    });
    const soqlResult = await soqlResponse.json();

    // Check if clarification is needed
    if (soqlResult.needsClarification) {
      return res.json({
        needsClarification: true,
        question: soqlResult.question,
        originalQuestion: question
      });
    }

    const { soql } = soqlResult;

    // Step 2: Execute SOQL via MCP
    let mcpResponse;
    try {
      mcpResponse = await executeMCPQuery(soql);
    } catch (err) {
      return res.status(500).json({
        error: 'SOQL execution failed',
        soql: soql,
        details: err.message,
        suggestion: 'The generated query may be invalid. Try providing more context or using objectHint parameter.'
      });
    }

    // Step 3: Let LLM explain the results
    const explanationPrompt = `The user asked: "${question}"

We executed this SOQL query:
${soql}

Results:
${JSON.stringify(mcpResponse, null, 2)}

Please provide a clear, concise explanation of these results in natural language. Focus on answering the user's original question.`;

    const llmResponse = await fetch(`${NVIDIA_API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${NVIDIA_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: NVIDIA_MODEL,
        messages: [{ role: 'user', content: explanationPrompt }],
        temperature: 0.7,
        max_tokens: 512
      })
    });

    const llmData = await llmResponse.json();
    const explanation = llmData.choices[0].message.content;

    res.json({
      question,
      soql,
      data: mcpResponse,
      explanation,
      recordCount: mcpResponse.records?.length || 0,
      needsClarification: false
    });

  } catch (error) {
    console.error('Smart query error:', error);
    res.status(500).json({ 
      error: 'Failed to process smart query',
      details: error.message 
    });
  }
});

// ============================================
// HELPER FUNCTIONS
// ============================================

async function executeMCPQuery(soql) {
  return new Promise((resolve, reject) => {
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

    const request = {
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: {
        name: 'query',
        arguments: { soql }
      }
    };

    mcpProcess.stdin.write(JSON.stringify(request) + '\n');
    mcpProcess.stdin.end();

    mcpProcess.stdout.on('data', (data) => {
      output += data.toString();
    });

    mcpProcess.on('close', (code) => {
      if (code !== 0) {
        reject(new Error('MCP process failed'));
      }
      try {
        const lines = output.trim().split('\n').filter(l => l.trim());
        const responses = lines.map(line => JSON.parse(line));
        const result = responses[responses.length - 1];
        resolve(result.result || result);
      } catch (e) {
        reject(e);
      }
    });
  });
}

async function getOrgSchema() {
  // Check cache
  if (schemaCache && schemaCacheTime && (Date.now() - schemaCacheTime < SCHEMA_CACHE_TTL)) {
    return schemaCache;
  }

  // Query for all objects using Global Describe
  const describeQuery = `SELECT QualifiedApiName, Label, IsCustom FROM EntityDefinition WHERE IsCustomizable = true ORDER BY IsCustom DESC, QualifiedApiName`;
  
  try {
    const result = await executeMCPQuery(describeQuery);
    
    // Group by standard and custom
    const objects = {
      standard: [],
      custom: []
    };

    if (result.records) {
      result.records.forEach(obj => {
        const objInfo = {
          apiName: obj.QualifiedApiName,
          label: obj.Label,
          isCustom: obj.IsCustom
        };
        
        if (obj.IsCustom) {
          objects.custom.push(objInfo);
        } else {
          objects.standard.push(objInfo);
        }
      });
    }

    schemaCache = objects;
    schemaCacheTime = Date.now();
    
    return objects;
  } catch (err) {
    console.error('Failed to get org schema:', err);
    // Return minimal schema as fallback
    return {
      standard: [
        { apiName: 'Account', label: 'Account', isCustom: false },
        { apiName: 'Contact', label: 'Contact', isCustom: false },
        { apiName: 'Opportunity', label: 'Opportunity', isCustom: false },
        { apiName: 'Lead', label: 'Lead', isCustom: false },
        { apiName: 'Case', label: 'Case', isCustom: false }
      ],
      custom: []
    };
  }
}

async function getObjectSchema(objectName) {
  // Get fields for specific object
  const fieldsQuery = `SELECT QualifiedApiName, Label, DataType FROM FieldDefinition WHERE EntityDefinition.QualifiedApiName = '${objectName}' ORDER BY QualifiedApiName`;
  
  try {
    const result = await executeMCPQuery(fieldsQuery);
    return {
      objectName,
      fields: result.records || []
    };
  } catch (err) {
    throw new Error(`Failed to get schema for ${objectName}: ${err.message}`);
  }
}

function formatSchemaForPrompt(schema) {
  let formatted = 'Available Salesforce Objects:\n\n';
  
  // Standard objects
  if (schema.standard && schema.standard.length > 0) {
    formatted += 'STANDARD OBJECTS:\n';
    schema.standard.forEach(obj => {
      formatted += `- ${obj.apiName} (${obj.label})\n`;
    });
  }
  
  // Custom objects
  if (schema.custom && schema.custom.length > 0) {
    formatted += '\nCUSTOM OBJECTS:\n';
    schema.custom.forEach(obj => {
      formatted += `- ${obj.apiName} (${obj.label})\n`;
    });
  }
  
  return formatted;
}

async function fetchSalesforceContext(message) {
  // Determine what context to fetch based on the message
  const messageLower = message.toLowerCase();
  let soql = 'SELECT Id, Name FROM Account LIMIT 5';

  if (messageLower.includes('opportunity') || messageLower.includes('deal')) {
    soql = 'SELECT Id, Name, Amount, StageName FROM Opportunity LIMIT 5';
  } else if (messageLower.includes('contact')) {
    soql = 'SELECT Id, Name, Email FROM Contact LIMIT 5';
  } else if (messageLower.includes('case')) {
    soql = 'SELECT Id, CaseNumber, Subject, Status FROM Case LIMIT 5';
  }

  try {
    return await executeMCPQuery(soql);
  } catch (err) {
    console.error('Context fetch error:', err);
    return null;
  }
}

// ============================================
// START SERVER
// ============================================

app.listen(PORT, () => {
  console.log(`🚀 Salesforce MCP Provider running on port ${PORT}`);
  console.log(`📊 Available endpoints:`);
  console.log(`   GET  /health        - Health check`);
  console.log(`   GET  /tools         - List available tools`);
  console.log(`   GET  /schema        - Get org schema`);
  console.log(`   GET  /schema/:obj   - Get object schema`);
  console.log(`   POST /mcp           - Execute MCP commands`);
  console.log(`   POST /chat          - Chat with LLM`);
  console.log(`   POST /generate-soql - Generate SOQL from natural language`);
  console.log(`   POST /smart-query   - Natural language query with explanation`);
  console.log(`🤖 LLM: ${NVIDIA_API_KEY ? `Enabled (${NVIDIA_MODEL})` : 'Disabled'}`);
});
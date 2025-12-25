import express from 'express';
import { spawn } from 'child_process';
import cors from 'cors';
import fs from 'fs/promises';
import path from 'path';

const app = express();
const PORT = process.env.PORT || 8080;

// NVIDIA LLM Configuration
const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY || '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';
const NVIDIA_API_BASE = 'https://integrate.api.nvidia.com/v1';
const NVIDIA_MODEL = process.env.NVIDIA_MODEL || 'meta/llama-3.3-70b-instruct';

// OPTIMIZED CACHING CONFIGURATION
const SCHEMA_CACHE_TTL = parseInt(process.env.SCHEMA_CACHE_TTL) || 3600000; // 1 hour default
const OBJECT_CACHE_TTL = parseInt(process.env.OBJECT_CACHE_TTL) || 7200000; // 2 hours for object details
const CACHE_FILE_PATH = '/tmp/schema-cache.json'; // Persistent cache file
const ENABLE_PERSISTENT_CACHE = process.env.ENABLE_PERSISTENT_CACHE !== 'false'; // Default true

// In-memory cache
let schemaCache = null;
let schemaCacheTime = null;
const objectFieldsCache = new Map(); // Cache for individual object fields
let isRefreshing = false; // Flag to prevent concurrent refreshes

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ============================================
// CACHE MANAGEMENT
// ============================================

// Load cache from disk on startup
async function loadCacheFromDisk() {
  if (!ENABLE_PERSISTENT_CACHE) return;
  
  try {
    const cacheData = await fs.readFile(CACHE_FILE_PATH, 'utf-8');
    const parsed = JSON.parse(cacheData);
    
    // Check if cache is still valid
    if (parsed.timestamp && (Date.now() - parsed.timestamp < SCHEMA_CACHE_TTL)) {
      schemaCache = parsed.schema;
      schemaCacheTime = parsed.timestamp;
      console.log('✅ Loaded schema cache from disk (still valid)');
    } else {
      console.log('⚠️  Cache on disk expired, will refresh');
    }
  } catch (err) {
    console.log('ℹ️  No valid cache file found, will fetch fresh');
  }
}

// Save cache to disk
async function saveCacheToDisk() {
  if (!ENABLE_PERSISTENT_CACHE || !schemaCache) return;
  
  try {
    const cacheData = {
      schema: schemaCache,
      timestamp: schemaCacheTime
    };
    await fs.writeFile(CACHE_FILE_PATH, JSON.stringify(cacheData, null, 2));
    console.log('💾 Saved schema cache to disk');
  } catch (err) {
    console.error('Failed to save cache to disk:', err.message);
  }
}

// Background refresh (non-blocking)
async function refreshSchemaInBackground() {
  if (isRefreshing) return;
  
  isRefreshing = true;
  console.log('🔄 Background schema refresh started...');
  
  try {
    const describeQuery = `SELECT QualifiedApiName, Label, IsCustom FROM EntityDefinition WHERE IsCustomizable = true ORDER BY IsCustom DESC, QualifiedApiName`;
    const result = await executeMCPQuery(describeQuery);
    
    const objects = { standard: [], custom: [] };
    
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
    await saveCacheToDisk();
    
    console.log(`✅ Background refresh complete: ${objects.standard.length} standard, ${objects.custom.length} custom objects`);
  } catch (err) {
    console.error('❌ Background refresh failed:', err.message);
  } finally {
    isRefreshing = false;
  }
}

// Schedule periodic background refresh
setInterval(() => {
  if (schemaCache && (Date.now() - schemaCacheTime >= SCHEMA_CACHE_TTL)) {
    refreshSchemaInBackground();
  }
}, 60000); // Check every minute

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'salesforce-mcp-provider',
    llmEnabled: !!NVIDIA_API_KEY,
    model: NVIDIA_MODEL,
    cache: {
      schemaLoaded: !!schemaCache,
      schemaCacheAge: schemaCache ? Math.floor((Date.now() - schemaCacheTime) / 1000) : null,
      schemaCacheTTL: Math.floor(SCHEMA_CACHE_TTL / 1000),
      objectsCached: objectFieldsCache.size,
      persistentCacheEnabled: ENABLE_PERSISTENT_CACHE
    }
  });
});

// ============================================
// CACHE CONTROL ENDPOINTS
// ============================================

// Manual cache refresh
app.post('/cache/refresh', async (req, res) => {
  try {
    schemaCache = null;
    schemaCacheTime = null;
    objectFieldsCache.clear();
    
    await refreshSchemaInBackground();
    
    res.json({ 
      message: 'Cache refresh initiated',
      note: 'Schema is being refreshed in the background'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Clear cache
app.post('/cache/clear', async (req, res) => {
  schemaCache = null;
  schemaCacheTime = null;
  objectFieldsCache.clear();
  
  try {
    if (ENABLE_PERSISTENT_CACHE) {
      await fs.unlink(CACHE_FILE_PATH);
    }
  } catch (err) {
    // File might not exist, that's ok
  }
  
  res.json({ message: 'Cache cleared successfully' });
});

// Get cache stats
app.get('/cache/stats', (req, res) => {
  res.json({
    schema: {
      cached: !!schemaCache,
      age: schemaCache ? Math.floor((Date.now() - schemaCacheTime) / 1000) : null,
      ttl: Math.floor(SCHEMA_CACHE_TTL / 1000),
      expiresIn: schemaCache ? Math.floor((SCHEMA_CACHE_TTL - (Date.now() - schemaCacheTime)) / 1000) : null,
      objectCount: schemaCache ? (schemaCache.standard.length + schemaCache.custom.length) : 0
    },
    objectFields: {
      cached: objectFieldsCache.size,
      objects: Array.from(objectFieldsCache.keys())
    },
    config: {
      schemaCacheTTL: SCHEMA_CACHE_TTL,
      objectCacheTTL: OBJECT_CACHE_TTL,
      persistentCacheEnabled: ENABLE_PERSISTENT_CACHE
    }
  });
});

// ============================================
// SCHEMA DISCOVERY
// ============================================

// Get Salesforce org schema (objects)
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

// Get schema for specific object (with caching)
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

// Generate SOQL query from natural language (with optimized caching)
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

    // Get org schema (from cache if available)
    const schema = await getOrgSchema();
    const schemaDescription = formatSchemaForPrompt(schema);

    // If object hint provided, get detailed schema (from cache if available)
    let detailedObjectInfo = '';
    if (objectHint) {
      try {
        const objectSchema = await getObjectSchema(objectHint);
        detailedObjectInfo = `\n\nDetailed schema for ${objectHint}:\nFields: ${objectSchema.fields.map(f => `${f.apiName} (${f.dataType})`).join(', ')}`;
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
      needsClarification: false,
      cacheHit: !!schemaCache && !!schemaCacheTime
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

    // Step 1: Generate SOQL (uses cached schema)
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
      needsClarification: false,
      cacheHit: soqlResult.cacheHit
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
// HELPER FUNCTIONS (OPTIMIZED)
// ============================================

async function executeMCPQuery(soql) {
  return new Promise((resolve, reject) => {
    // Path must point to where your MCP logic is built
   const mcpPath = path.resolve(process.cwd(), '../mcp/lib/index.js');
    
    const mcpProcess = spawn('node', [mcpPath], {
      env: { 
        ...process.env,
        // Force mapping to ensure the sub-process sees them
        SALESFORCE_USERNAME: process.env.SALESFORCE_USERNAME,
        SALESFORCE_PASSWORD: process.env.SALESFORCE_PASSWORD,
        SALESFORCE_SECURITY_TOKEN: process.env.SALESFORCE_SECURITY_TOKEN,
        SALESFORCE_LOGIN_URL: process.env.SALESFORCE_LOGIN_URL || 'https://login.salesforce.com'
      }
    });

    let output = '';
    let errorOutput = '';

    const request = {
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: { name: 'query', arguments: { soql } }
    };

    mcpProcess.stdin.write(JSON.stringify(request) + '\n');
    mcpProcess.stdin.end();

    mcpProcess.stdout.on('data', (data) => output += data.toString());
    mcpProcess.stderr.on('data', (data) => errorOutput += data.toString());

    mcpProcess.on('close', (code) => {
      if (code !== 0) {
        console.error(`❌ MCP Auth/Query Error (Code ${code}): ${errorOutput}`);
        return reject(new Error(errorOutput));
      }
      try {
        const lines = output.trim().split('\n').filter(l => l.trim());
        const lastLine = JSON.parse(lines[lines.length - 1]);
        
        // Handle both .result and .result.content structures
        const data = lastLine.result?.content?.[0]?.text 
                     ? JSON.parse(lastLine.result.content[0].text) 
                     : (lastLine.result || lastLine);
                     
        resolve(data);
      } catch (e) {
        reject(new Error(`Parse Error: ${e.message}. Raw: ${output}`));
      }
    });
  });
}

async function getOrgSchema() {
  // Check in-memory cache first
  if (schemaCache && schemaCacheTime && (Date.now() - schemaCacheTime < SCHEMA_CACHE_TTL)) {
    return schemaCache;
  }

  // If cache expired but we have old data, return it while refreshing in background
  if (schemaCache && !isRefreshing) {
    refreshSchemaInBackground(); // Non-blocking refresh
    return schemaCache; // Return stale data immediately
  }

  // No cache at all, fetch synchronously
  const describeQuery = `SELECT QualifiedApiName, Label, IsCustom FROM EntityDefinition WHERE IsCustomizable = true ORDER BY IsCustom DESC, QualifiedApiName`;
  
  try {
    const result = await executeMCPQuery(describeQuery);
    
    const objects = { standard: [], custom: [] };

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
    await saveCacheToDisk();
    
    return objects;
  } catch (err) {
    console.error('Failed to get org schema:', err);
    // Return minimal schema as fallback
    return {
      standard: [
        { apiName: 'Account', label: 'Account', isCustom: false },
        { apiName: 'Contact', label: 'Contact', isCustom: false },
        { apiName: 'Opportunity', label: 'Opportunity', isCustom: false }
      ],
      custom: []
    };
  }
}

async function getObjectSchema(objectName) {
  // Check cache first
  const cacheKey = objectName;
  const cached = objectFieldsCache.get(cacheKey);
  
  if (cached && (Date.now() - cached.timestamp < OBJECT_CACHE_TTL)) {
    return cached.data;
  }

  // Fetch from Salesforce
  const fieldsQuery = `SELECT QualifiedApiName, Label, DataType FROM FieldDefinition WHERE EntityDefinition.QualifiedApiName = '${objectName}' ORDER BY QualifiedApiName`;
  
  try {
    const result = await executeMCPQuery(fieldsQuery);
    const objectSchema = {
      objectName,
      fields: result.records || []
    };
    
    // Cache it
    objectFieldsCache.set(cacheKey, {
      data: objectSchema,
      timestamp: Date.now()
    });
    
    return objectSchema;
  } catch (err) {
    throw new Error(`Failed to get schema for ${objectName}: ${err.message}`);
  }
}

function formatSchemaForPrompt(schema) {
  let formatted = 'Available Salesforce Objects:\n\n';
  
  if (schema.standard && schema.standard.length > 0) {
    formatted += 'STANDARD OBJECTS:\n';
    schema.standard.forEach(obj => {
      formatted += `- ${obj.apiName} (${obj.label})\n`;
    });
  }
  
  if (schema.custom && schema.custom.length > 0) {
    formatted += '\nCUSTOM OBJECTS:\n';
    schema.custom.forEach(obj => {
      formatted += `- ${obj.apiName} (${obj.label})\n`;
    });
  }
  
  return formatted;
}

async function fetchSalesforceContext(message) {
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
// STARTUP & SERVER
// ============================================

// Load cache on startup
await loadCacheFromDisk();

// Initial schema fetch if not cached
if (!schemaCache) {
  console.log('📥 No cache found, fetching schema...');
  refreshSchemaInBackground();
}

app.listen(PORT, () => {
  console.log(`🚀 Salesforce MCP Provider running on port ${PORT}`);
  console.log(`📊 Available endpoints:`);
  console.log(`   GET  /health         - Health check with cache stats`);
  console.log(`   GET  /cache/stats    - Detailed cache statistics`);
  console.log(`   POST /cache/refresh  - Manual cache refresh`);
  console.log(`   POST /cache/clear    - Clear all caches`);
  console.log(`   GET  /schema         - Get org schema (cached)`);
  console.log(`   GET  /schema/:obj    - Get object schema (cached)`);
  console.log(`   POST /chat           - Chat with LLM`);
  console.log(`   POST /generate-soql  - Generate SOQL`);
  console.log(`   POST /smart-query    - Smart query with explanation`);
  console.log(`🤖 LLM: ${NVIDIA_API_KEY ? `Enabled (${NVIDIA_MODEL})` : 'Disabled'}`);
  console.log(`💾 Cache: Schema TTL=${SCHEMA_CACHE_TTL/1000}s, Object TTL=${OBJECT_CACHE_TTL/1000}s`);
  console.log(`📁 Persistent Cache: ${ENABLE_PERSISTENT_CACHE ? 'Enabled' : 'Disabled'}`);
});
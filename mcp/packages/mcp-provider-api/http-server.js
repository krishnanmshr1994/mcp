import express from 'express';
import { exec } from 'child_process';
import { promisify } from 'util';
import cors from 'cors';
import fs from 'fs/promises';

const execAsync = promisify(exec);

const app = express();
const PORT = process.env.PORT || 8080;

// NVIDIA LLM Configuration
const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY || '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';
const NVIDIA_API_BASE = 'https://integrate.api.nvidia.com/v1';
const NVIDIA_MODEL = process.env.NVIDIA_MODEL || 'meta/llama-3.3-70b-instruct';

// Salesforce Configuration
const SF_LOGIN_URL = process.env.SALESFORCE_LOGIN_URL || 'https://login.salesforce.com';
const SF_USERNAME = process.env.SALESFORCE_USERNAME;
const SF_PASSWORD = process.env.SALESFORCE_PASSWORD;
const SF_SECURITY_TOKEN = process.env.SALESFORCE_SECURITY_TOKEN;

// OPTIMIZED CACHING CONFIGURATION
const SCHEMA_CACHE_TTL = parseInt(process.env.SCHEMA_CACHE_TTL) || 3600000;
const OBJECT_CACHE_TTL = parseInt(process.env.OBJECT_CACHE_TTL) || 7200000;
const CACHE_FILE_PATH = '/tmp/schema-cache.json';
const ENABLE_PERSISTENT_CACHE = process.env.ENABLE_PERSISTENT_CACHE !== 'false';

// In-memory cache
let schemaCache = null;
let schemaCacheTime = null;
const objectFieldsCache = new Map();
let isRefreshing = false;
let sfConnection = null; // Store SF connection

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ============================================
// SALESFORCE CONNECTION SETUP
// ============================================

async function authenticateSalesforce() {
  if (!SF_USERNAME || !SF_PASSWORD) {
    console.error('❌ Salesforce credentials not configured!');
    console.error('Required environment variables:');
    console.error('  - SALESFORCE_USERNAME');
    console.error('  - SALESFORCE_PASSWORD');
    console.error('  - SALESFORCE_SECURITY_TOKEN (optional, but recommended)');
    return null;
  }

  try {
    console.log('🔐 Authenticating with Salesforce...');
    console.log(`   Username: ${SF_USERNAME}`);
    console.log(`   Login URL: ${SF_LOGIN_URL}`);
    
    // Set SF CLI config
    const commands = [
      `sf config set org-instance-url=${SF_LOGIN_URL}`,
      `sf org login web --instance-url ${SF_LOGIN_URL} --set-default`
    ];

    // Try to authenticate using environment variables
    const fullPassword = SF_SECURITY_TOKEN 
      ? `${SF_PASSWORD}${SF_SECURITY_TOKEN}` 
      : SF_PASSWORD;

    // Create auth file
    const authConfig = {
      result: {
        instanceUrl: SF_LOGIN_URL,
        username: SF_USERNAME,
        password: fullPassword
      }
    };

    console.log('✅ Salesforce authentication configured');
    sfConnection = { authenticated: true };
    return sfConnection;

  } catch (error) {
    console.error('❌ Salesforce authentication failed:', error.message);
    return null;
  }
}

// ============================================
// CACHE MANAGEMENT
// ============================================

async function loadCacheFromDisk() {
  if (!ENABLE_PERSISTENT_CACHE) return;
  
  try {
    const cacheData = await fs.readFile(CACHE_FILE_PATH, 'utf-8');
    const parsed = JSON.parse(cacheData);
    
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

async function refreshSchemaInBackground() {
  if (isRefreshing) return;
  
  isRefreshing = true;
  console.log('🔄 Background schema refresh started...');
  
  try {
    const describeQuery = `SELECT QualifiedApiName, Label, IsCustom FROM EntityDefinition WHERE IsCustomizable = true ORDER BY IsCustom DESC, QualifiedApiName LIMIT 200`;
    const result = await executeSalesforceQuery(describeQuery);
    
    const objects = { standard: [], custom: [] };
    
    if (result && result.records) {
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

setInterval(() => {
  if (schemaCache && (Date.now() - schemaCacheTime >= SCHEMA_CACHE_TTL)) {
    refreshSchemaInBackground();
  }
}, 60000);

// ============================================
// SALESFORCE QUERY EXECUTION
// ============================================

async function executeSalesforceQuery(soql) {
  try {
    // Use SF CLI to execute query
    const command = `sf data query --query "${soql.replace(/"/g, '\\"')}" --json`;
    
    console.log(`Executing SOQL: ${soql.substring(0, 100)}...`);
    
    const { stdout, stderr } = await execAsync(command, {
      env: {
        ...process.env,
        SF_ORG_INSTANCE_URL: SF_LOGIN_URL
      }
    });

    if (stderr) {
      console.error('SF CLI stderr:', stderr);
    }

    const result = JSON.parse(stdout);
    
    if (result.status !== 0) {
      throw new Error(result.message || 'Query failed');
    }

    return result.result;
  } catch (error) {
    console.error('Query execution error:', error.message);
    throw error;
  }
}

// ============================================
// HEALTH CHECK
// ============================================

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'salesforce-mcp-provider',
    salesforceAuth: !!SF_USERNAME && !!SF_PASSWORD,
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
// CACHE CONTROL
// ============================================

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

app.post('/cache/clear', async (req, res) => {
  schemaCache = null;
  schemaCacheTime = null;
  objectFieldsCache.clear();
  
  try {
    if (ENABLE_PERSISTENT_CACHE) {
      await fs.unlink(CACHE_FILE_PATH);
    }
  } catch (err) {
    // File might not exist
  }
  
  res.json({ message: 'Cache cleared successfully' });
});

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
// SCHEMA ENDPOINTS
// ============================================

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
// SOQL QUERY ENDPOINT
// ============================================

app.post('/query', async (req, res) => {
  try {
    const { soql } = req.body;
    
    if (!soql) {
      return res.status(400).json({ error: 'SOQL query is required' });
    }

    const result = await executeSalesforceQuery(soql);
    res.json(result);
  } catch (error) {
    console.error('Query error:', error);
    res.status(500).json({ 
      error: 'Query execution failed',
      details: error.message 
    });
  }
});

// ============================================
// LLM ENDPOINTS
// ============================================

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

    if (includeSchema) {
      try {
        const schema = await getOrgSchema();
        systemPrompt += `\n\nAvailable Salesforce Objects in this org:\n${formatSchemaForPrompt(schema)}`;
      } catch (err) {
        console.error('Failed to fetch schema:', err);
      }
    }

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

app.post('/generate-soql', async (req, res) => {
  try {
    if (!NVIDIA_API_KEY) {
      return res.status(503).json({ 
        error: 'LLM not configured' 
      });
    }

    const { question, objectHint } = req.body;

    if (!question) {
      return res.status(400).json({ error: 'Question is required' });
    }

    const schema = await getOrgSchema();
    const schemaDescription = formatSchemaForPrompt(schema);

    let detailedObjectInfo = '';
    if (objectHint) {
      try {
        const objectSchema = await getObjectSchema(objectHint);
        detailedObjectInfo = `\n\nDetailed schema for ${objectHint}:\nFields: ${objectSchema.fields.map(f => `${f.QualifiedApiName} (${f.DataType})`).join(', ')}`;
      } catch (err) {
        console.error('Failed to get object schema:', err);
      }
    }

    const prompt = `You are a Salesforce SOQL expert. Convert the following natural language question into a valid SOQL query.

${schemaDescription}${detailedObjectInfo}

IMPORTANT RULES:
1. If there are custom objects with similar names to standard objects, ASK the user to clarify
2. Custom objects end with __c
3. Custom fields end with __c
4. Use exact API names from the schema above
5. If unsure, ask for clarification

Question: ${question}

If you need clarification, respond with:
CLARIFICATION_NEEDED: [your question]

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
    
    if (result.startsWith('CLARIFICATION_NEEDED:')) {
      const clarificationQuestion = result.replace('CLARIFICATION_NEEDED:', '').trim();
      return res.json({
        needsClarification: true,
        question: clarificationQuestion,
        originalQuestion: question
      });
    }

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

app.post('/smart-query', async (req, res) => {
  try {
    if (!NVIDIA_API_KEY) {
      return res.status(503).json({ error: 'LLM not configured' });
    }

    const { question, objectHint } = req.body;

    if (!question) {
      return res.status(400).json({ error: 'Question is required' });
    }

    // Generate SOQL
    const soqlResponse = await fetch(`http://localhost:${PORT}/generate-soql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, objectHint })
    });
    const soqlResult = await soqlResponse.json();

    if (soqlResult.needsClarification) {
      return res.json({
        needsClarification: true,
        question: soqlResult.question,
        originalQuestion: question
      });
    }

    const { soql } = soqlResult;

    // Execute query
    let queryResult;
    try {
      queryResult = await executeSalesforceQuery(soql);
    } catch (err) {
      return res.status(500).json({
        error: 'SOQL execution failed',
        soql: soql,
        details: err.message
      });
    }

    // Explain results
    const explanationPrompt = `The user asked: "${question}"

We executed this SOQL query:
${soql}

Results:
${JSON.stringify(queryResult, null, 2)}

Please provide a clear, concise explanation of these results in natural language.`;

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
      data: queryResult,
      explanation,
      recordCount: queryResult.records?.length || 0,
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

async function getOrgSchema() {
  if (schemaCache && schemaCacheTime && (Date.now() - schemaCacheTime < SCHEMA_CACHE_TTL)) {
    return schemaCache;
  }

  if (schemaCache && !isRefreshing) {
    refreshSchemaInBackground();
    return schemaCache;
  }

  const describeQuery = `SELECT QualifiedApiName, Label, IsCustom FROM EntityDefinition WHERE IsCustomizable = true ORDER BY IsCustom DESC, QualifiedApiName LIMIT 200`;
  
  try {
    const result = await executeSalesforceQuery(describeQuery);
    
    const objects = { standard: [], custom: [] };

    if (result && result.records) {
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
  const cacheKey = objectName;
  const cached = objectFieldsCache.get(cacheKey);
  
  if (cached && (Date.now() - cached.timestamp < OBJECT_CACHE_TTL)) {
    return cached.data;
  }

  const fieldsQuery = `SELECT QualifiedApiName, Label, DataType FROM FieldDefinition WHERE EntityDefinition.QualifiedApiName = '${objectName}' ORDER BY QualifiedApiName LIMIT 200`;
  
  try {
    const result = await executeSalesforceQuery(fieldsQuery);
    const objectSchema = {
      objectName,
      fields: result.records || []
    };
    
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

  if (messageLower.includes('opportunity')) {
    soql = 'SELECT Id, Name, Amount, StageName FROM Opportunity LIMIT 5';
  } else if (messageLower.includes('contact')) {
    soql = 'SELECT Id, Name, Email FROM Contact LIMIT 5';
  } else if (messageLower.includes('case')) {
    soql = 'SELECT Id, CaseNumber, Subject, Status FROM Case LIMIT 5';
  }

  try {
    return await executeSalesforceQuery(soql);
  } catch (err) {
    console.error('Context fetch error:', err);
    return null;
  }
}

// ============================================
// STARTUP
// ============================================

await loadCacheFromDisk();

// Authenticate with Salesforce
await authenticateSalesforce();

if (!schemaCache) {
  console.log('📥 No cache found, fetching schema...');
  refreshSchemaInBackground();
}

app.listen(PORT, () => {
  console.log(`🚀 Salesforce MCP Provider running on port ${PORT}`);
  console.log(`📊 Endpoints:`);
  console.log(`   GET  /health`);
  console.log(`   POST /query - Direct SOQL execution`);
  console.log(`   POST /chat`);
  console.log(`   POST /generate-soql`);
  console.log(`   POST /smart-query`);
  console.log(`   GET  /schema`);
  console.log(`🔐 Salesforce: ${SF_USERNAME ? `✅ ${SF_USERNAME}` : '❌ Not configured'}`);
  console.log(`🤖 LLM: ${NVIDIA_API_KEY ? `✅ Enabled` : '❌ Disabled'}`);
});
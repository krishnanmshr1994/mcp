import express from 'express';
import cors from 'cors';
import jsforce from 'jsforce';
import fs from 'fs/promises';

const app = express();
const PORT = process.env.PORT || 8080;

// NVIDIA LLM Configuration
const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY;
const NVIDIA_API_BASE = 'https://integrate.api.nvidia.com/v1';
const NVIDIA_MODEL = process.env.NVIDIA_MODEL || 'meta/llama-3.3-70b-instruct';

// Salesforce Configuration
const SF_LOGIN_URL = process.env.SALESFORCE_LOGIN_URL || 'https://login.salesforce.com';
const SF_USERNAME = process.env.SALESFORCE_USERNAME;
const SF_PASSWORD = process.env.SALESFORCE_PASSWORD;
const SF_SECURITY_TOKEN = process.env.SALESFORCE_SECURITY_TOKEN || '';

// Cache Configuration
const SCHEMA_CACHE_TTL = parseInt(process.env.SCHEMA_CACHE_TTL) || 3600000; // 1 hour
const OBJECT_CACHE_TTL = parseInt(process.env.OBJECT_CACHE_TTL) || 7200000; // 2 hours
const CACHE_FILE_PATH = '/tmp/schema-cache.json';
const ENABLE_PERSISTENT_CACHE = process.env.ENABLE_PERSISTENT_CACHE !== 'false';

// Cache storage
let schemaCache = null;
let schemaCacheTime = null;
const objectFieldsCache = new Map();
let isRefreshing = false;

// Salesforce connection
let conn = null;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ============================================
// SALESFORCE CONNECTION
// ============================================

async function getSalesforceConnection() {
  console.log(`in getSalesforceConnection`);
  // Return existing valid connection if possible
  if (conn && conn.accessToken) {
    try {
      // Quick test query to confirm connection is still alive
      await conn.query('SELECT Id FROM User LIMIT 1');
      return conn;
    } catch (err) {
      console.log('⚠️  Existing connection expired or invalid, reconnecting...');
      conn = null; // Force reconnection
    }
  }

  // === PRIORITY 1: Use pre-authenticated access token (recommended) ===
  const accessToken = process.env.SALESFORCE_ACCESS_TOKEN?.trim();
  const instanceUrl = process.env.SALESFORCE_INSTANCE_URL?.trim().replace(/\/$/, ''); // Remove trailing slash

  if (accessToken && instanceUrl) {
    console.log('🔐 Attempting Salesforce connection using pre-authenticated access token');
    console.log(`   Instance URL: ${instanceUrl}`);

    conn = new jsforce.Connection({
      instanceUrl: instanceUrl,
      accessToken: accessToken
    });

    // No need to call login() — initialize is enough with token
    try {
      // Test the connection with a lightweight query
      await conn.query('SELECT Id FROM User LIMIT 1');
      console.log('✅ Salesforce token-based connection established successfully');
      return conn;
    } catch (error) {
      console.error('❌ Token-based authentication failed:', error.message);
      console.error('   Possible causes: expired token, wrong instance URL, or insufficient permissions');
      conn = null;
      // Do NOT fall back to username/password automatically — token should be valid
      throw new Error(`Token authentication failed: ${error.message}`);
    }
  }

  // === FALLBACK: Original username/password method (legacy) ===
  if (!SF_USERNAME || !SF_PASSWORD) {
    throw new Error('Salesforce credentials not configured. Please set SALESFORCE_USERNAME and SALESFORCE_PASSWORD (or use token auth).');
  }

  console.log('🔐 Falling back to username/password authentication...');
  console.log(`   Username: ${SF_USERNAME}`);
  console.log(`   Login URL: ${SF_LOGIN_URL}`);

  conn = new jsforce.Connection({
    loginUrl: SF_LOGIN_URL
  });

  try {
    const fullPassword = SF_PASSWORD + (SF_SECURITY_TOKEN || '');
    await conn.login(SF_USERNAME, fullPassword);
    
    console.log('✅ Salesforce username/password connection established');
    console.log(`   Org ID: ${conn.userInfo.organizationId}`);
    console.log(`   User ID: ${conn.userInfo.id}`);
    
    return conn;
  } catch (error) {
    console.error('❌ Salesforce login failed:', error.message);
    conn = null;
    throw new Error(`Salesforce authentication failed: ${error.message}`);
  }
}

// ============================================
// SALESFORCE OPERATIONS
// ============================================

async function executeQuery(soql) {
  const connection = await getSalesforceConnection();
  console.log(`📊 Executing: ${soql.substring(0, 100)}...`);
  
  try {
    const result = await connection.query(soql);
    console.log(`✅ Query returned ${result.totalSize} records`);
    return result;
  } catch (error) {
    console.error('❌ Query failed:', error.message);
    throw error;
  }
}

async function createRecord(objectType, data) {
  const connection = await getSalesforceConnection();
  console.log(`➕ Creating ${objectType} record`);
  
  try {
    const result = await connection.sobject(objectType).create(data);
    console.log(`✅ Created record: ${result.id}`);
    return result;
  } catch (error) {
    console.error('❌ Create failed:', error.message);
    throw error;
  }
}

async function updateRecord(objectType, id, data) {
  const connection = await getSalesforceConnection();
  console.log(`✏️  Updating ${objectType} record: ${id}`);
  
  try {
    const result = await connection.sobject(objectType).update({ Id: id, ...data });
    console.log(`✅ Updated record: ${id}`);
    return result;
  } catch (error) {
    console.error('❌ Update failed:', error.message);
    throw error;
  }
}

async function deleteRecord(objectType, id) {
  const connection = await getSalesforceConnection();
  console.log(`🗑️  Deleting ${objectType} record: ${id}`);
  
  try {
    const result = await connection.sobject(objectType).destroy(id);
    console.log(`✅ Deleted record: ${id}`);
    return result;
  } catch (error) {
    console.error('❌ Delete failed:', error.message);
    throw error;
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
      console.log('✅ Loaded schema cache from disk');
    } else {
      console.log('⚠️  Cached schema expired');
    }
  } catch (err) {
    console.log('ℹ️  No cache file found');
  }
}

async function saveCacheToDisk() {
  if (!ENABLE_PERSISTENT_CACHE || !schemaCache) return;
  
  try {
    await fs.writeFile(CACHE_FILE_PATH, JSON.stringify({
      schema: schemaCache,
      timestamp: schemaCacheTime
    }, null, 2));
    console.log('💾 Schema cache saved to disk');
  } catch (err) {
    console.error('⚠️  Failed to save cache:', err.message);
  }
}

async function refreshSchemaInBackground() {
  if (isRefreshing) return;
  
  isRefreshing = true;
  console.log('🔄 Refreshing schema cache...');
  
  try {
    const query = 'SELECT QualifiedApiName, Label, IsCustom FROM EntityDefinition WHERE IsCustomizable = true ORDER BY IsCustom DESC, QualifiedApiName LIMIT 200';
    const result = await executeQuery(query);
    
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
    
    console.log(`✅ Schema refreshed: ${objects.standard.length} standard, ${objects.custom.length} custom objects`);
  } catch (err) {
    console.error('❌ Schema refresh failed:', err.message);
  } finally {
    isRefreshing = false;
  }
}

// Auto-refresh every minute if expired
setInterval(() => {
  if (schemaCache && (Date.now() - schemaCacheTime >= SCHEMA_CACHE_TTL)) {
    refreshSchemaInBackground();
  }
}, 60000);

// ============================================
// API ENDPOINTS
// ============================================

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    service: 'salesforce-mcp-provider',
    timestamp: new Date().toISOString(),
    salesforce: {
      configured: !!(SF_USERNAME && SF_PASSWORD),
      connected: !!(conn && conn.accessToken),
      username: SF_USERNAME || 'Not configured'
    },
    llm: {
      configured: !!NVIDIA_API_KEY,
      model: NVIDIA_MODEL
    },
    cache: {
      loaded: !!schemaCache,
      ageSeconds: schemaCache ? Math.floor((Date.now() - schemaCacheTime) / 1000) : null,
      ttlSeconds: Math.floor(SCHEMA_CACHE_TTL / 1000),
      objectCount: schemaCache ? (schemaCache.standard.length + schemaCache.custom.length) : 0,
      objectsCached: objectFieldsCache.size
    }
  });
});

// Cache control
app.post('/cache/refresh', async (req, res) => {
  try {
    schemaCache = null;
    schemaCacheTime = null;
    objectFieldsCache.clear();
    await refreshSchemaInBackground();
    res.json({ message: 'Cache refresh initiated' });
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
      await fs.unlink(CACHE_FILE_PATH).catch(() => {});
    }
  } catch (err) {
    // Ignore errors
  }
  
  res.json({ message: 'Cache cleared' });
});

app.get('/cache/stats', (req, res) => {
  res.json({
    schema: {
      cached: !!schemaCache,
      ageSeconds: schemaCache ? Math.floor((Date.now() - schemaCacheTime) / 1000) : null,
      ttlSeconds: Math.floor(SCHEMA_CACHE_TTL / 1000),
      expiresInSeconds: schemaCache ? Math.floor((SCHEMA_CACHE_TTL - (Date.now() - schemaCacheTime)) / 1000) : null,
      objectCount: schemaCache ? (schemaCache.standard.length + schemaCache.custom.length) : 0
    },
    objectFields: {
      cached: objectFieldsCache.size,
      objects: Array.from(objectFieldsCache.keys())
    }
  });
});

// Schema endpoints
app.get('/schema', async (req, res) => {
  try {
    const schema = await getOrgSchema();
    res.json(schema);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/schema/:objectName', async (req, res) => {
  try {
    const schema = await getObjectSchema(req.params.objectName);
    res.json(schema);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Salesforce operations
app.post('/query', async (req, res) => {
  try {
    const { soql } = req.body;
    if (!soql) {
      return res.status(400).json({ error: 'SOQL query is required' });
    }
    const result = await executeQuery(soql);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/create', async (req, res) => {
  try {
    const { objectType, data } = req.body;
    if (!objectType || !data) {
      return res.status(400).json({ error: 'objectType and data are required' });
    }
    const result = await createRecord(objectType, data);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/update', async (req, res) => {
  try {
    const { objectType, id, data } = req.body;
    if (!objectType || !id || !data) {
      return res.status(400).json({ error: 'objectType, id, and data are required' });
    }
    const result = await updateRecord(objectType, id, data);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/delete', async (req, res) => {
  try {
    const { objectType, id } = req.body;
    if (!objectType || !id) {
      return res.status(400).json({ error: 'objectType and id are required' });
    }
    const result = await deleteRecord(objectType, id);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// LLM endpoints
app.post('/generate-soql', async (req, res) => {
  try {
    if (!NVIDIA_API_KEY) {
      return res.status(503).json({ error: 'LLM not configured. Set NVIDIA_API_KEY environment variable.' });
    }

    const { question, objectHint } = req.body;
    if (!question) {
      return res.status(400).json({ error: 'question is required' });
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

    const prompt = `You are a Salesforce SOQL expert. Convert this question into valid SOQL.

${schemaDescription}${detailedObjectInfo}

RULES:
1. If custom objects exist with similar names to standard objects, ask for clarification
2. Custom objects/fields end with __c
3. Use exact API names from schema
4. If unsure, ask for clarification

Question: ${question}

If clarification needed, respond: CLARIFICATION_NEEDED: [your question]
Otherwise, respond ONLY with the SOQL query (no markdown, no explanations).`;

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

    if (!response.ok) {
      throw new Error(`NVIDIA API error: ${response.status}`);
    }

    const data = await response.json();
    let result = data.choices[0].message.content.trim();
    
    if (result.startsWith('CLARIFICATION_NEEDED:')) {
      return res.json({
        needsClarification: true,
        question: result.replace('CLARIFICATION_NEEDED:', '').trim(),
        originalQuestion: question
      });
    }

    result = result.replace(/```sql\n?/g, '').replace(/```\n?/g, '').trim();
    res.json({
      soql: result,
      originalQuestion: question,
      needsClarification: false
    });

  } catch (error) {
    console.error('SOQL generation error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/smart-query', async (req, res) => {
  try {
    if (!NVIDIA_API_KEY) {
      return res.status(503).json({ error: 'LLM not configured' });
    }

    const { question, objectHint } = req.body;
    if (!question) {
      return res.status(400).json({ error: 'question is required' });
    }

    // Step 1: Generate SOQL
    const soqlRes = await fetch(`http://localhost:${PORT}/generate-soql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, objectHint })
    });
    const soqlData = await soqlRes.json();

    if (soqlData.needsClarification) {
      return res.json(soqlData);
    }

    // Step 2: Execute query
    const queryResult = await executeQuery(soqlData.soql);
    console.log(`Env Vars Check:
                USERNAME: ${process.env.SALESFORCE_USERNAME ? 'Set' : 'Unset'}
                PASSWORD: ${process.env.SALESFORCE_PASSWORD ? 'Set' : 'Unset'}
                TOKEN: ${process.env.SALESFORCE_SECURITY_TOKEN ? 'Set' : 'Unset'}
                LOGIN_URL: ${process.env.SALESFORCE_LOGIN_URL || 'Default (production)'}`);
    // Step 3: Get explanation
    const llmResponse = await fetch(`${NVIDIA_API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${NVIDIA_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: NVIDIA_MODEL,
        messages: [{
          role: 'user',
          content: `User asked: "${question}"\n\nSOQL: ${soqlData.soql}\n\nResults (${queryResult.totalSize} records):\n${JSON.stringify(queryResult.records.slice(0, 5), null, 2)}\n\nProvide a clear explanation answering the user's question.`
        }],
        temperature: 0.7,
        max_tokens: 512
      })
    });

    const llmData = await llmResponse.json();

    res.json({
      question,
      soql: soqlData.soql,
      data: queryResult,
      explanation: llmData.choices[0].message.content,
      recordCount: queryResult.totalSize
    });

  } catch (error) {
    console.error('Smart query error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/chat', async (req, res) => {
  try {
    if (!NVIDIA_API_KEY) {
      return res.status(503).json({ error: 'LLM not configured' });
    }

    const { message, conversationHistory = [], includeSchema = false } = req.body;
    if (!message) {
      return res.status(400).json({ error: 'message is required' });
    }

    let systemPrompt = 'You are a helpful Salesforce assistant. You can help with SOQL queries, data analysis, and Salesforce questions.';

    if (includeSchema) {
      const schema = await getOrgSchema();
      systemPrompt += `\n\nAvailable objects:\n${formatSchemaForPrompt(schema)}`;
    }

    const messages = [
      { role: 'system', content: systemPrompt },
      ...conversationHistory,
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
        messages,
        temperature: 0.7,
        max_tokens: 1024
      })
    });

    const data = await response.json();
    res.json({
      response: data.choices[0].message.content,
      model: NVIDIA_MODEL
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// HELPER FUNCTIONS
// ============================================

async function getOrgSchema() {
  // Return cached if valid
  if (schemaCache && schemaCacheTime && (Date.now() - schemaCacheTime < SCHEMA_CACHE_TTL)) {
    return schemaCache;
  }

  // Return stale cache while refreshing
  if (schemaCache && !isRefreshing) {
    refreshSchemaInBackground();
    return schemaCache;
  }

  // Fetch fresh
  const query = 'SELECT QualifiedApiName, Label, IsCustom FROM EntityDefinition WHERE IsCustomizable = true ORDER BY IsCustom DESC, QualifiedApiName LIMIT 200';
  const result = await executeQuery(query);
  
  const objects = { standard: [], custom: [] };
  if (result.records) {
    result.records.forEach(obj => {
      const info = { apiName: obj.QualifiedApiName, label: obj.Label, isCustom: obj.IsCustom };
      if (obj.IsCustom) objects.custom.push(info);
      else objects.standard.push(info);
    });
  }

  schemaCache = objects;
  schemaCacheTime = Date.now();
  await saveCacheToDisk();
  return objects;
}

async function getObjectSchema(objectName) {
  const cached = objectFieldsCache.get(objectName);
  if (cached && (Date.now() - cached.timestamp < OBJECT_CACHE_TTL)) {
    return cached.data;
  }

  const query = `SELECT QualifiedApiName, Label, DataType FROM FieldDefinition WHERE EntityDefinition.QualifiedApiName = '${objectName}' ORDER BY QualifiedApiName LIMIT 200`;
  const result = await executeQuery(query);
  
  const schema = { objectName, fields: result.records || [] };
  objectFieldsCache.set(objectName, { data: schema, timestamp: Date.now() });
  return schema;
}

function formatSchemaForPrompt(schema) {
  let text = 'STANDARD OBJECTS:\n';
  schema.standard?.forEach(o => text += `- ${o.apiName} (${o.label})\n`);
  if (schema.custom?.length) {
    text += '\nCUSTOM OBJECTS:\n';
    schema.custom.forEach(o => text += `- ${o.apiName} (${o.label})\n`);
  }
  return text;
}

// ============================================
// STARTUP
// ============================================

console.log('🚀 Starting Salesforce MCP Provider...');

// Load cache
await loadCacheFromDisk();

// Test Salesforce connection
await getSalesforceConnection();
  
// Fetch schema if not cached
if (!schemaCache) {
  console.log('📥 Fetching schema...');
  await refreshSchemaInBackground();
}

app.listen(PORT, () => {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`${'='.repeat(60)}`);
  console.log(`\n📊 Endpoints:`);
  console.log(`   GET  /health - Health check`);
  console.log(`   GET  /schema - Get org schema`);
  console.log(`   POST /query - Execute SOQL`);
  console.log(`   POST /generate-soql - Natural language → SOQL`);
  console.log(`   POST /smart-query - Question → Answer`);
  console.log(`   POST /chat - Chat with AI`);
  console.log(`\n🔐 Salesforce: ${SF_USERNAME || 'NOT CONFIGURED'}`);
  console.log(`🤖 LLM: ${NVIDIA_API_KEY ? 'ENABLED' : 'NOT CONFIGURED'}`);
  console.log(`💾 Cache: ${schemaCache ? `${schemaCache.standard.length + schemaCache.custom.length} objects` : 'Empty'}`);
  console.log(`\n${'='.repeat(60)}\n`);
});
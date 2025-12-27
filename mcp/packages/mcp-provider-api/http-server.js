import express from 'express';
import cors from 'cors';
import jsforce from 'jsforce';

const app = express();
const PORT = process.env.PORT || 8080;

// Configuration
const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY;
const NVIDIA_MODEL = process.env.NVIDIA_MODEL || 'meta/llama-3.3-70b-instruct';
const NVIDIA_API_BASE = 'https://integrate.api.nvidia.com/v1';

const SF_LOGIN_URL = process.env.SALESFORCE_LOGIN_URL || 'https://login.salesforce.com';
const SF_USERNAME = process.env.SALESFORCE_USERNAME;
const SF_PASSWORD = process.env.SALESFORCE_PASSWORD;
const SF_SECURITY_TOKEN = process.env.SALESFORCE_SECURITY_TOKEN || '';
const SF_ACCESS_TOKEN = process.env.SALESFORCE_ACCESS_TOKEN;
const SF_INSTANCE_URL = process.env.SALESFORCE_INSTANCE_URL;

// Cache
let schemaCache = null;
let schemaCacheTime = null;
const SCHEMA_CACHE_TTL = 3600000;
const objectFieldsCache = new Map();

// Connection
let conn = null;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ============================================
// CONNECTION WITH DETAILED LOGGING
// ============================================

async function getConnection() {
  console.log('🔍 [getConnection] CALLED');
  
  // Check existing connection
  if (conn && conn.accessToken) {
    console.log('🔍 [getConnection] Testing existing connection...');
    try {
      await conn.query('SELECT Id FROM User LIMIT 1');
      console.log('✅ [getConnection] Existing connection valid');
      return conn;
    } catch (err) {
      console.log('⚠️  [getConnection] Existing connection invalid:', err.message);
      conn = null;
    }
  }

  // Method 1: Access Token
  if (SF_ACCESS_TOKEN && SF_INSTANCE_URL) {
    console.log('🔍 [getConnection] Attempting token-based auth');
    console.log(`   Instance: ${SF_INSTANCE_URL}`);
    
    conn = new jsforce.Connection({
      instanceUrl: SF_INSTANCE_URL.replace(/\/$/, ''),
      accessToken: SF_ACCESS_TOKEN
    });

    try {
      await conn.query('SELECT Id FROM User LIMIT 1');
      console.log('✅ [getConnection] Token auth successful');
      return conn;
    } catch (error) {
      console.error('❌ [getConnection] Token auth failed:', error.message);
      conn = null;
      throw error;
    }
  }

  // Method 2: Username/Password
  if (!SF_USERNAME || !SF_PASSWORD) {
    throw new Error('No Salesforce credentials configured');
  }

  console.log('🔍 [getConnection] Attempting username/password auth');
  console.log(`   URL: ${SF_LOGIN_URL}`);
  console.log(`   Username: ${SF_USERNAME}`);
  
  conn = new jsforce.Connection({ loginUrl: SF_LOGIN_URL });

  try {
    const password = SF_PASSWORD + SF_SECURITY_TOKEN;
    await conn.login(SF_USERNAME, password);
    console.log('✅ [getConnection] Username/password auth successful');
    console.log(`   Org ID: ${conn.userInfo.organizationId}`);
    return conn;
  } catch (error) {
    console.error('❌ [getConnection] Username/password auth failed:', error.message);
    conn = null;
    throw error;
  }
}

// ============================================
// SALESFORCE OPERATIONS WITH LOGGING
// ============================================

async function query(soql) {
  console.log(`🔍 [query] CALLED with: ${soql.substring(0, 80)}...`);
  
  const connection = await getConnection();
  console.log('🔍 [query] Got connection, executing...');
  
  try {
    const result = await connection.query(soql);
    console.log(`✅ [query] Success: ${result.totalSize} records`);
    return result;
  } catch (error) {
    console.error(`❌ [query] Failed: ${error.message}`);
    throw error;
  }
}

async function create(objectType, data) {
  console.log(`🔍 [create] CALLED for ${objectType}`);
  const connection = await getConnection();
  return await connection.sobject(objectType).create(data);
}

async function update(objectType, id, data) {
  console.log(`🔍 [update] CALLED for ${objectType}:${id}`);
  const connection = await getConnection();
  return await connection.sobject(objectType).update({ Id: id, ...data });
}

async function deleteRecord(objectType, id) {
  console.log(`🔍 [deleteRecord] CALLED for ${objectType}:${id}`);
  const connection = await getConnection();
  return await connection.sobject(objectType).destroy(id);
}

// ============================================
// SCHEMA FUNCTIONS WITH LOGGING
// ============================================

async function getOrgSchema() {
  console.log('🔍 [getOrgSchema] CALLED');
  
  // Check cache
  if (schemaCache && schemaCacheTime && (Date.now() - schemaCacheTime < SCHEMA_CACHE_TTL)) {
    const age = Math.floor((Date.now() - schemaCacheTime) / 1000);
    console.log(`✅ [getOrgSchema] Returning cached schema (age: ${age}s)`);
    return schemaCache;
  }

  console.log('🔍 [getOrgSchema] Cache miss or expired, fetching fresh...');
  
  const soql = 'SELECT QualifiedApiName, Label, IsCustom FROM EntityDefinition WHERE IsCustomizable = true ORDER BY IsCustom DESC LIMIT 200';
  console.log('🔍 [getOrgSchema] About to call query()...');
  
  const result = await query(soql);
  console.log('🔍 [getOrgSchema] Query returned, processing...');
  
  const objects = { standard: [], custom: [] };
  
  if (result && result.records) {
    result.records.forEach(obj => {
      const info = {
        apiName: obj.QualifiedApiName,
        label: obj.Label,
        isCustom: obj.IsCustom
      };
      if (obj.IsCustom) objects.custom.push(info);
      else objects.standard.push(info);
    });
  }

  schemaCache = objects;
  schemaCacheTime = Date.now();
  
  console.log(`✅ [getOrgSchema] Schema cached: ${objects.standard.length} standard, ${objects.custom.length} custom`);
  return objects;
}

async function getObjectSchema(objectName) {
  console.log(`🔍 [getObjectSchema] CALLED for ${objectName}`);
  
  const cached = objectFieldsCache.get(objectName);
  if (cached && (Date.now() - cached.timestamp < SCHEMA_CACHE_TTL)) {
    console.log(`✅ [getObjectSchema] Returning cached fields for ${objectName}`);
    return cached.data;
  }

  console.log(`🔍 [getObjectSchema] Fetching fields for ${objectName}...`);
  
  const soql = `SELECT QualifiedApiName, Label, DataType FROM FieldDefinition WHERE EntityDefinition.QualifiedApiName = '${objectName}' ORDER BY QualifiedApiName LIMIT 200`;
  const result = await query(soql);
  
  const schema = { objectName, fields: result.records || [] };
  objectFieldsCache.set(objectName, { data: schema, timestamp: Date.now() });
  
  console.log(`✅ [getObjectSchema] Cached ${schema.fields.length} fields for ${objectName}`);
  return schema;
}

function formatSchema(schema) {
  let text = 'STANDARD OBJECTS:\n';
  schema.standard?.forEach(o => text += `- ${o.apiName}\n`);
  if (schema.custom?.length) {
    text += '\nCUSTOM OBJECTS:\n';
    schema.custom.forEach(o => text += `- ${o.apiName}\n`);
  }
  return text;
}

// ============================================
// API ENDPOINTS
// ============================================

app.get('/health', async (req, res) => {
  console.log('🔍 [/health] Endpoint called');
  
  let sfStatus = 'unknown';
  try {
    if (conn && conn.accessToken) {
      await conn.identity();
      sfStatus = 'connected';
    } else {
      sfStatus = 'not connected';
    }
  } catch (err) {
    sfStatus = 'connection error';
  }
  
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    salesforce: {
      status: sfStatus,
      username: SF_USERNAME || 'Not configured',
      hasToken: !!SF_ACCESS_TOKEN,
      hasPassword: !!SF_PASSWORD
    },
    llm: {
      configured: !!NVIDIA_API_KEY,
      model: NVIDIA_MODEL
    },
    cache: {
      loaded: !!schemaCache,
      ageSeconds: schemaCache ? Math.floor((Date.now() - schemaCacheTime) / 1000) : null,
      objectCount: schemaCache ? (schemaCache.standard.length + schemaCache.custom.length) : 0
    }
  });
});

app.get('/schema', async (req, res) => {
  console.log('🔍 [GET /schema] Endpoint called');
  try {
    const schema = await getOrgSchema();
    console.log('✅ [GET /schema] Returning schema');
    res.json(schema);
  } catch (error) {
    console.error('❌ [GET /schema] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/schema/:objectName', async (req, res) => {
  console.log(`🔍 [GET /schema/:object] Endpoint called for ${req.params.objectName}`);
  try {
    const schema = await getObjectSchema(req.params.objectName);
    res.json(schema);
  } catch (error) {
    console.error(`❌ [GET /schema/:object] Error:`, error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/query', async (req, res) => {
  console.log('🔍 [POST /query] Endpoint called');
  try {
    const { soql } = req.body;
    if (!soql) {
      return res.status(400).json({ error: 'soql required' });
    }
    const result = await query(soql);
    res.json(result);
  } catch (error) {
    console.error('❌ [POST /query] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/generate-soql', async (req, res) => {
  console.log('🔍 [POST /generate-soql] Endpoint called');
  try {
    if (!NVIDIA_API_KEY) {
      return res.status(503).json({ error: 'LLM not configured' });
    }

    const { question, objectHint } = req.body;
    if (!question) {
      return res.status(400).json({ error: 'question required' });
    }

    console.log(`🔍 [generate-soql] Question: ${question}`);
    
    const schema = await getOrgSchema();
    const schemaText = formatSchema(schema);

    let objectInfo = '';
    if (objectHint) {
      const objSchema = await getObjectSchema(objectHint);
      objectInfo = `\n\nFields: ${objSchema.fields.map(f => f.QualifiedApiName).join(', ')}`;
    }

    const prompt = `Convert to SOQL:\n\n${schemaText}${objectInfo}\n\nQuestion: ${question}\n\nRespond with SOQL only.`;

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
    let soql = data.choices[0].message.content.trim();
    soql = soql.replace(/```sql\n?/g, '').replace(/```\n?/g, '').trim();
    
    console.log(`✅ [generate-soql] Generated: ${soql}`);
    res.json({ soql });

  } catch (error) {
    console.error('❌ [POST /generate-soql] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/smart-query', async (req, res) => {
  console.log('🔍 [POST /smart-query] Endpoint called');
  try {
    const { question } = req.body;

    // Generate SOQL
    console.log('🔍 [smart-query] Generating SOQL...');
    const soqlRes = await fetch(`http://localhost:${PORT}/generate-soql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question })
    });
    const soqlData = await soqlRes.json();

    // Execute
    console.log('🔍 [smart-query] Executing query...');
    const queryResult = await query(soqlData.soql);

    // Explain
    console.log('🔍 [smart-query] Getting explanation...');
    const llmRes = await fetch(`${NVIDIA_API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${NVIDIA_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: NVIDIA_MODEL,
        messages: [{
          role: 'user',
          content: `Question: "${question}"\nResults: ${JSON.stringify(queryResult.records.slice(0, 3))}\n\nExplain:`
        }],
        temperature: 0.7,
        max_tokens: 512
      })
    });

    const llmData = await llmRes.json();

    res.json({
      question,
      soql: soqlData.soql,
      data: queryResult,
      explanation: llmData.choices[0].message.content,
      recordCount: queryResult.totalSize
    });

  } catch (error) {
    console.error('❌ [POST /smart-query] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// STARTUP WITH DETAILED LOGGING
// ============================================

console.log('\n' + '='.repeat(60));
console.log('🚀 STARTING SALESFORCE MCP PROVIDER');
console.log('='.repeat(60));

console.log('\n📋 Environment Check:');
console.log(`   SF_USERNAME: ${SF_USERNAME ? '✅ Set' : '❌ Not set'}`);
console.log(`   SF_PASSWORD: ${SF_PASSWORD ? '✅ Set' : '❌ Not set'}`);
console.log(`   SF_SECURITY_TOKEN: ${SF_SECURITY_TOKEN ? '✅ Set' : '❌ Not set'}`);
console.log(`   SF_ACCESS_TOKEN: ${SF_ACCESS_TOKEN ? '✅ Set' : '❌ Not set'}`);
console.log(`   SF_INSTANCE_URL: ${SF_INSTANCE_URL ? '✅ Set' : '❌ Not set'}`);
console.log(`   NVIDIA_API_KEY: ${NVIDIA_API_KEY ? '✅ Set' : '❌ Not set'}`);

console.log('\n🔐 Testing Salesforce Connection...');
try {
  await getConnection();
  console.log('✅ Salesforce connection successful!\n');
  
  console.log('📥 Fetching initial schema...');
  await getOrgSchema();
  console.log('✅ Schema loaded!\n');
  
} catch (error) {
  console.error('❌ STARTUP FAILED:', error.message);
  console.error('\nServer will NOT start. Fix credentials and redeploy.\n');
  process.exit(1);
}

app.listen(PORT, () => {
  console.log('='.repeat(60));
  console.log(`✅ SERVER RUNNING ON PORT ${PORT}`);
  console.log('='.repeat(60));
  console.log('\n📊 Available Endpoints:');
  console.log(`   GET  /health`);
  console.log(`   GET  /schema`);
  console.log(`   POST /query`);
  console.log(`   POST /generate-soql`);
  console.log(`   POST /smart-query`);
  console.log('\n' + '='.repeat(60) + '\n');
});
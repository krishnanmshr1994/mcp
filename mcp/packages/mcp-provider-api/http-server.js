import express from 'express';
import cors from 'cors';
import jsforce from 'jsforce';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const app = express();
const PORT = process.env.PORT || 8080;

// Configuration
const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY;
const NVIDIA_API_BASE = 'https://integrate.api.nvidia.com/v1';
const NVIDIA_MODEL = process.env.NVIDIA_MODEL || 'meta/llama-3.3-70b-instruct';

const SF_LOGIN_URL = process.env.SALESFORCE_LOGIN_URL || 'https://login.salesforce.com';
const SF_USERNAME = process.env.SALESFORCE_USERNAME;
const SF_PASSWORD = process.env.SALESFORCE_PASSWORD;
const SF_SECURITY_TOKEN = process.env.SALESFORCE_SECURITY_TOKEN || '';

// Cache
let schemaCache = null;
let schemaCacheTime = null;
const SCHEMA_CACHE_TTL = 3600000; // 1 hour
const objectFieldsCache = new Map();
let isRefreshing = false;

// Salesforce connection
let sfConnection = null;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ============================================
// MCP runtime child process (diagnostics + restart)
// ============================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mcpChild = null;
let mcpRestartAttempts = 0;
const MCP_MAX_RESTARTS = 3;

function startMcpProcess() {
  try {
    const runtimePath = path.join(__dirname, 'dist', 'runtime.js');
    console.log('🔧 Starting MCP runtime:', runtimePath);

    mcpChild = spawn(process.execPath, [runtimePath], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    mcpChild.stdout?.on('data', (chunk) => {
      process.stdout.write(`[MCP stdout] ${chunk.toString()}`);
    });

    mcpChild.stderr?.on('data', (chunk) => {
      process.stderr.write(`[MCP stderr] ${chunk.toString()}`);
    });

    mcpChild.on('error', (err) => {
      console.error('❌ MCP child process error:', err && err.message ? err.message : err);
    });

    mcpChild.on('exit', (code, signal) => {
      console.error(`❌ MCP child exited. code=${code} signal=${signal}`);
      mcpChild = null;
      mcpRestartAttempts++;
      if (mcpRestartAttempts <= MCP_MAX_RESTARTS) {
        console.log(`🔁 Restarting MCP runtime (attempt ${mcpRestartAttempts}/${MCP_MAX_RESTARTS})`);
        setTimeout(startMcpProcess, 2000 * mcpRestartAttempts);
      } else {
        console.error('⛔ MCP runtime failed to start after multiple attempts');
      }
    });

  } catch (err) {
    console.error('❌ Failed to start MCP runtime:', err && err.message ? err.message : err);
  }
}

// ============================================
// SALESFORCE CONNECTION
// ============================================

async function getConnection() {
  // Return existing if valid
  if (sfConnection && sfConnection.accessToken) {
    try {
      // Quick test
      await sfConnection.identity();
      return sfConnection;
    } catch (err) {
      console.log('⚠️  Connection expired, reconnecting...');
      sfConnection = null;
    }
  }

  // Validate credentials
  if (!SF_USERNAME || !SF_PASSWORD) {
    throw new Error('❌ Salesforce credentials missing! Set SALESFORCE_USERNAME and SALESFORCE_PASSWORD');
  }

  console.log('🔐 Authenticating with Salesforce...');
  console.log(`   URL: ${SF_LOGIN_URL}`);
  console.log(`   Username: ${SF_USERNAME}`);

  try {
    sfConnection = new jsforce.Connection({ loginUrl: SF_LOGIN_URL });
    
    const password = SF_PASSWORD + SF_SECURITY_TOKEN;
    const userInfo = await sfConnection.login(SF_USERNAME, password);
    
    console.log('✅ Salesforce authentication successful!');
    console.log(`   Org ID: ${userInfo.organizationId}`);
    console.log(`   User ID: ${userInfo.id}`);
    
    return sfConnection;
  } catch (error) {
    console.error('❌ Salesforce login failed:', error.message);
    sfConnection = null;
    throw new Error(`Login failed: ${error.message}`);
  }
}

// ============================================
// SALESFORCE OPERATIONS
// ============================================

async function query(soql) {
  const conn = await getConnection();
  console.log(`📊 Query: ${soql.substring(0, 80)}...`);
  
  try {
    const result = await conn.query(soql);
    console.log(`✅ Returned ${result.totalSize} records`);
    return result;
  } catch (error) {
    console.error(`❌ Query failed: ${error.message}`);
    throw error;
  }
}

async function create(objectType, data) {
  const conn = await getConnection();
  return await conn.sobject(objectType).create(data);
}

async function update(objectType, id, data) {
  const conn = await getConnection();
  return await conn.sobject(objectType).update({ Id: id, ...data });
}

async function deleteRecord(objectType, id) {
  const conn = await getConnection();
  return await conn.sobject(objectType).destroy(id);
}

// ============================================
// SCHEMA FUNCTIONS
// ============================================

async function fetchSchema() {
  console.log('🔄 Fetching org schema...');
  
  try {
    const soql = 'SELECT QualifiedApiName, Label, IsCustom FROM EntityDefinition WHERE IsCustomizable = true ORDER BY IsCustom DESC, QualifiedApiName LIMIT 200';
    const result = await query(soql);
    
    const objects = { standard: [], custom: [] };
    
    if (result && result.records) {
      result.records.forEach(obj => {
        const info = {
          apiName: obj.QualifiedApiName,
          label: obj.Label,
          isCustom: obj.IsCustom
        };
        
        if (obj.IsCustom) {
          objects.custom.push(info);
        } else {
          objects.standard.push(info);
        }
      });
    }
    
    schemaCache = objects;
    schemaCacheTime = Date.now();
    
    console.log(`✅ Schema loaded: ${objects.standard.length} standard, ${objects.custom.length} custom objects`);
    return objects;
    
  } catch (error) {
    console.error('❌ Schema fetch failed:', error.message);
    throw error;
  }
}

async function getOrgSchema() {
  // Return cache if valid
  if (schemaCache && schemaCacheTime && (Date.now() - schemaCacheTime < SCHEMA_CACHE_TTL)) {
    return schemaCache;
  }

  // Fetch fresh
  return await fetchSchema();
}

async function getObjectSchema(objectName) {
  const cached = objectFieldsCache.get(objectName);
  if (cached && (Date.now() - cached.timestamp < SCHEMA_CACHE_TTL)) {
    return cached.data;
  }

  const soql = `SELECT QualifiedApiName, Label, DataType FROM FieldDefinition WHERE EntityDefinition.QualifiedApiName = '${objectName}' ORDER BY QualifiedApiName LIMIT 200`;
  const result = await query(soql);
  
  const schema = {
    objectName,
    fields: result.records || []
  };
  
  objectFieldsCache.set(objectName, {
    data: schema,
    timestamp: Date.now()
  });
  
  return schema;
}

function formatSchema(schema) {
  let text = 'STANDARD OBJECTS:\n';
  schema.standard?.forEach(o => text += `- ${o.apiName} (${o.label})\n`);
  
  if (schema.custom?.length) {
    text += '\nCUSTOM OBJECTS:\n';
    schema.custom.forEach(o => text += `- ${o.apiName} (${o.label})\n`);
  }
  
  return text;
}

// ============================================
// API ENDPOINTS
// ============================================

app.get('/health', async (req, res) => {
  let sfStatus = 'Not connected';
  
  try {
    if (sfConnection && sfConnection.accessToken) {
      await sfConnection.identity();
      sfStatus = 'Connected';
    }
  } catch (err) {
    sfStatus = 'Connection lost';
  }
  
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    salesforce: {
      configured: !!(SF_USERNAME && SF_PASSWORD),
      status: sfStatus,
      username: SF_USERNAME || 'Not configured'
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

app.post('/query', async (req, res) => {
  try {
    const { soql } = req.body;
    if (!soql) {
      return res.status(400).json({ error: 'soql is required' });
    }
    const result = await query(soql);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/create', async (req, res) => {
  try {
    const { objectType, data } = req.body;
    const result = await create(objectType, data);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/update', async (req, res) => {
  try {
    const { objectType, id, data } = req.body;
    const result = await update(objectType, id, data);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/delete', async (req, res) => {
  try {
    const { objectType, id } = req.body;
    const result = await deleteRecord(objectType, id);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/generate-soql', async (req, res) => {
  try {
    if (!NVIDIA_API_KEY) {
      return res.status(503).json({ error: 'LLM not configured' });
    }

    const { question, objectHint } = req.body;
    if (!question) {
      return res.status(400).json({ error: 'question is required' });
    }

    const schema = await getOrgSchema();
    const schemaText = formatSchema(schema);

    let objectInfo = '';
    if (objectHint) {
      try {
        const objSchema = await getObjectSchema(objectHint);
        objectInfo = `\n\nFields for ${objectHint}:\n${objSchema.fields.map(f => `${f.QualifiedApiName} (${f.DataType})`).join(', ')}`;
      } catch (err) {
        console.error('Object schema error:', err);
      }
    }

    const prompt = `You are a Salesforce SOQL expert. Convert this question to SOQL.

${schemaText}${objectInfo}

Question: ${question}

If you need clarification, respond: CLARIFICATION_NEEDED: [question]
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
        question: result.replace('CLARIFICATION_NEEDED:', '').trim()
      });
    }

    result = result.replace(/```sql\n?/g, '').replace(/```\n?/g, '').trim();
    res.json({ soql: result, needsClarification: false });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/smart-query', async (req, res) => {
  try {
    const { question, objectHint } = req.body;

    // Generate SOQL
    const soqlRes = await fetch(`http://localhost:${PORT}/generate-soql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, objectHint })
    });
    const soqlData = await soqlRes.json();

    if (soqlData.needsClarification) {
      return res.json(soqlData);
    }

    // Execute
    const queryResult = await query(soqlData.soql);

    // Explain
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
          content: `Question: "${question}"\nSOQL: ${soqlData.soql}\nResults: ${JSON.stringify(queryResult.records.slice(0, 5))}\n\nExplain the results clearly.`
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
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// STARTUP
// ============================================

console.log('🚀 Starting Salesforce MCP Provider...\n');

// Test connection and load schema
try {
  await getConnection();
  await fetchSchema();
  console.log('\n✅ Server initialized successfully!');
} catch (error) {
  console.error('\n❌ Initialization failed:', error.message);
  console.error('   Server will start but operations will fail until fixed.\n');
}

// Start MCP runtime child to provide the MCP protocol (diagnostics enabled)
startMcpProcess();

app.listen(PORT, () => {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`🌐 Server running at http://localhost:${PORT}`);
  console.log(`${'='.repeat(60)}`);
  console.log(`\n📊 Endpoints:`);
  console.log(`   GET  /health`);
  console.log(`   GET  /schema`);
  console.log(`   POST /query`);
  console.log(`   POST /generate-soql`);
  console.log(`   POST /smart-query`);
  console.log(`\n🔐 Salesforce: ${SF_USERNAME || 'NOT CONFIGURED'}`);
  console.log(`🤖 NVIDIA LLM: ${NVIDIA_API_KEY ? 'ENABLED' : 'NOT CONFIGURED'}`);
  console.log(`💾 Schema: ${schemaCache ? `${schemaCache.standard.length + schemaCache.custom.length} objects cached` : 'Not loaded'}`);
  console.log(`${'='.repeat(60)}\n`);
});
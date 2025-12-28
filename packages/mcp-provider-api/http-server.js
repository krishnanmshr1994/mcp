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
const SCHEMA_CACHE_TTL = 3600000; // 1 hour
const objectFieldsCache = new Map();

// Salesforce connection
let sfConnection = null;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ============================================
// SALESFORCE CONNECTION
// ============================================

async function getConnection() {
  console.log('🔍 Getting Salesforce connection...');
  
  // Test existing connection
  if (sfConnection && sfConnection.accessToken) {
    try {
      await sfConnection.query('SELECT Id FROM User LIMIT 1');
      console.log('✅ Using existing connection');
      return sfConnection;
    } catch (err) {
      console.log('⚠️  Connection expired, reconnecting...');
      sfConnection = null;
    }
  }

  // Method 1: Access Token (if provided)
  if (SF_ACCESS_TOKEN && SF_INSTANCE_URL) {
    console.log('🔐 Authenticating with access token...');
    console.log(`   Instance: ${SF_INSTANCE_URL}`);
    
    sfConnection = new jsforce.Connection({
      instanceUrl: SF_INSTANCE_URL.replace(/\/$/, ''),
      accessToken: SF_ACCESS_TOKEN
    });

    try {
      await sfConnection.query('SELECT Id FROM User LIMIT 1');
      console.log('✅ Token authentication successful');
      return sfConnection;
    } catch (error) {
      console.error('❌ Token authentication failed:', error.message);
      sfConnection = null;
      throw new Error(`Token auth failed: ${error.message}`);
    }
  }

  // Method 2: Username/Password
  if (!SF_USERNAME || !SF_PASSWORD) {
    throw new Error('Salesforce credentials not configured. Set SALESFORCE_USERNAME and SALESFORCE_PASSWORD or SALESFORCE_ACCESS_TOKEN and SALESFORCE_INSTANCE_URL');
  }

  console.log('🔐 Authenticating with username/password...');
  console.log(`   URL: ${SF_LOGIN_URL}`);
  console.log(`   Username: ${SF_USERNAME}`);
  
  sfConnection = new jsforce.Connection({ loginUrl: SF_LOGIN_URL });

  try {
    const password = SF_PASSWORD + SF_SECURITY_TOKEN;
    const userInfo = await sfConnection.login(SF_USERNAME, password);
    console.log('✅ Username/password authentication successful');
    console.log(`   Org ID: ${userInfo.organizationId}`);
    console.log(`   User ID: ${userInfo.id}`);
    return sfConnection;
  } catch (error) {
    console.error('❌ Username/password authentication failed:', error.message);
    sfConnection = null;
    throw new Error(`Login failed: ${error.message}`);
  }
}

// ============================================
// SALESFORCE OPERATIONS
// ============================================

async function query(soql) {
  console.log(`📊 Executing query: ${soql.substring(0, 80)}...`);
  const conn = await getConnection();
  
  try {
    const result = await conn.query(soql);
    console.log(`✅ Query returned ${result.totalSize} records`);
    return result;
  } catch (error) {
    console.error(`❌ Query failed: ${error.message}`);
    throw error;
  }
}

async function createRecord(objectType, data) {
  console.log(`➕ Creating ${objectType} record`);
  const conn = await getConnection();
  
  try {
    const result = await conn.sobject(objectType).create(data);
    console.log(`✅ Created: ${result.id}`);
    return result;
  } catch (error) {
    console.error(`❌ Create failed: ${error.message}`);
    throw error;
  }
}

async function updateRecord(objectType, id, data) {
  console.log(`✏️  Updating ${objectType}: ${id}`);
  const conn = await getConnection();
  
  try {
    const result = await conn.sobject(objectType).update({ Id: id, ...data });
    console.log(`✅ Updated: ${id}`);
    return result;
  } catch (error) {
    console.error(`❌ Update failed: ${error.message}`);
    throw error;
  }
}

async function deleteRecord(objectType, id) {
  console.log(`🗑️  Deleting ${objectType}: ${id}`);
  const conn = await getConnection();
  
  try {
    const result = await conn.sobject(objectType).destroy(id);
    console.log(`✅ Deleted: ${id}`);
    return result;
  } catch (error) {
    console.error(`❌ Delete failed: ${error.message}`);
    throw error;
  }
}

// ============================================
// SCHEMA FUNCTIONS
// ============================================

async function getOrgSchema() {
  console.log('🔍 Getting org schema...');
  
  // Check cache
  if (schemaCache && schemaCacheTime && (Date.now() - schemaCacheTime < SCHEMA_CACHE_TTL)) {
    const age = Math.floor((Date.now() - schemaCacheTime) / 1000);
    console.log(`✅ Returning cached schema (age: ${age}s)`);
    return schemaCache;
  }

  console.log('📥 Fetching fresh schema from Salesforce...');
  
  const soql = 'SELECT QualifiedApiName, Label FROM EntityDefinition WHERE IsCustomizable = true ORDER BY QualifiedApiName LIMIT 50000';
  const result = await query(soql);
  
  const objects = { standard: [], custom: [] };
  
  if (result && result.records) {
    result.records.forEach(obj => {
      const isCustom = obj.QualifiedApiName.endsWith('__c');
      const info = {
        apiName: obj.QualifiedApiName,
        label: obj.Label,
        isCustom: isCustom
      };
      if (isCustom) objects.custom.push(info);
      else objects.standard.push(info);
    });
  }

  schemaCache = objects;
  schemaCacheTime = Date.now();
  
  console.log(`✅ Schema cached: ${objects.standard.length} standard, ${objects.custom.length} custom objects`);
  return objects;
}

async function getObjectSchema(objectName) {
  console.log(`🔍 Getting schema for ${objectName}...`);
  
  const cached = objectFieldsCache.get(objectName);
  if (cached && (Date.now() - cached.timestamp < SCHEMA_CACHE_TTL)) {
    console.log(`✅ Returning cached fields for ${objectName}`);
    return cached.data;
  }

  console.log(`📥 Fetching fields for ${objectName}...`);
  
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
  
  console.log(`✅ Cached ${schema.fields.length} fields for ${objectName}`);
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
  console.log('🔍 Health check called');
  
  let sfStatus = 'not connected';
  try {
    if (sfConnection && sfConnection.accessToken) {
      await sfConnection.identity();
      sfStatus = 'connected';
    }
  } catch (err) {
    sfStatus = 'connection error';
  }
  
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    salesforce: {
      status: sfStatus,
      configured: !!(SF_USERNAME && SF_PASSWORD) || !!(SF_ACCESS_TOKEN && SF_INSTANCE_URL),
      username: SF_USERNAME || 'Token-based',
      hasAccessToken: !!SF_ACCESS_TOKEN
    },
    llm: {
      configured: !!NVIDIA_API_KEY,
      model: NVIDIA_MODEL
    },
    cache: {
      loaded: !!schemaCache,
      ageSeconds: schemaCache ? Math.floor((Date.now() - schemaCacheTime) / 1000) : null,
      objectCount: schemaCache ? (schemaCache.standard.length + schemaCache.custom.length) : 0,
      objectFieldsCached: objectFieldsCache.size
    }
  });
});

app.get('/schema', async (req, res) => {
  console.log('🔍 GET /schema called');
  try {
    const schema = await getOrgSchema();
    res.json(schema);
  } catch (error) {
    console.error('❌ GET /schema error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/schema/:objectName', async (req, res) => {
  console.log(`🔍 GET /schema/${req.params.objectName} called`);
  try {
    const schema = await getObjectSchema(req.params.objectName);
    res.json(schema);
  } catch (error) {
    console.error(`❌ GET /schema/:object error:`, error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/query', async (req, res) => {
  console.log('🔍 POST /query called');
  try {
    const { soql } = req.body;
    if (!soql) {
      return res.status(400).json({ error: 'soql is required' });
    }
    const result = await query(soql);
    res.json(result);
  } catch (error) {
    console.error('❌ POST /query error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/create', async (req, res) => {
  console.log('🔍 POST /create called');
  try {
    const { objectType, data } = req.body;
    if (!objectType || !data) {
      return res.status(400).json({ error: 'objectType and data are required' });
    }
    const result = await createRecord(objectType, data);
    res.json(result);
  } catch (error) {
    console.error('❌ POST /create error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/update', async (req, res) => {
  console.log('🔍 POST /update called');
  try {
    const { objectType, id, data } = req.body;
    if (!objectType || !id || !data) {
      return res.status(400).json({ error: 'objectType, id, and data are required' });
    }
    const result = await updateRecord(objectType, id, data);
    res.json(result);
  } catch (error) {
    console.error('❌ POST /update error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/delete', async (req, res) => {
  console.log('🔍 POST /delete called');
  try {
    const { objectType, id } = req.body;
    if (!objectType || !id) {
      return res.status(400).json({ error: 'objectType and id are required' });
    }
    const result = await deleteRecord(objectType, id);
    res.json(result);
  } catch (error) {
    console.error('❌ POST /delete error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/describe-object', async (req, res) => {
  console.log('🔍 POST /describe-object called');
  try {
    const { objectName } = req.body;
    if (!objectName) {
      return res.status(400).json({ error: 'objectName is required' });
    }

    console.log(`📋 Describing object: ${objectName}`);
    
    // Get all fields
    const objSchema = await getObjectSchema(objectName);
    
    // Generate SOQL with ALL fields
    const fieldNames = objSchema.fields.map(f => f.QualifiedApiName);
    const soql = `SELECT ${fieldNames.join(', ')} FROM ${objectName} LIMIT 10`;
    
    // Execute query to get sample data
    let sampleData = null;
    try {
      sampleData = await query(soql);
    } catch (err) {
      console.log('⚠️  Could not fetch sample data:', err.message);
    }
    
    res.json({
      objectName,
      fieldCount: objSchema.fields.length,
      fields: objSchema.fields,
      generatedSOQL: soql,
      sampleData: sampleData ? {
        totalSize: sampleData.totalSize,
        records: sampleData.records
      } : null
    });

  } catch (error) {
    console.error('❌ POST /describe-object error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/generate-soql', async (req, res) => {
  console.log('🔍 POST /generate-soql called');
  try {
    if (!NVIDIA_API_KEY) {
      return res.status(503).json({ error: 'LLM not configured. Set NVIDIA_API_KEY' });
    }

    const { question, objectHint } = req.body;
    if (!question) {
      return res.status(400).json({ error: 'question is required' });
    }

    // Detect if user is asking about fields of an object
    const fieldQueryMatch = question.toLowerCase().match(/fields?.*(?:of|for|in)\s+(\w+)/);
    let detectedObject = objectHint;
    
    if (fieldQueryMatch) {
      detectedObject = fieldQueryMatch[1].replace(/barcode[_\s]config/i, 'Barcode_Config__c');
    }

    // Auto-detect custom object names from question
    const customObjMatch = question.match(/(\w+__c)/i);
    if (customObjMatch) {
      detectedObject = customObjMatch[1];
    }

    const schema = await getOrgSchema();
    const schemaText = formatSchema(schema);

    let objectFieldsList = '';
    let isFieldsQuery = false;
    
    // If asking about fields, fetch them first
    if (detectedObject || fieldQueryMatch) {
      try {
        const targetObject = detectedObject || fieldQueryMatch[1];
        console.log(`🔍 Detected request for fields of: ${targetObject}`);
        
        // Find the correct object name from schema
        const allObjects = [...schema.standard, ...schema.custom];
        const matchedObject = allObjects.find(obj => 
          obj.apiName.toLowerCase().includes(targetObject.toLowerCase()) ||
          obj.label.toLowerCase().includes(targetObject.toLowerCase())
        );

        if (matchedObject) {
          console.log(`✅ Found object: ${matchedObject.apiName}`);
          const objSchema = await getObjectSchema(matchedObject.apiName);
          objectFieldsList = `\n\nAvailable fields for ${matchedObject.apiName}:\n${objSchema.fields.map(f => `- ${f.QualifiedApiName} (${f.DataType}) - ${f.Label}`).join('\n')}`;
          isFieldsQuery = true;
          detectedObject = matchedObject.apiName;
        }
      } catch (err) {
        console.error('Failed to get object fields:', err);
      }
    }

    const prompt = `You are a Salesforce SOQL expert. Generate valid SOQL queries following these STRICT RULES:

CRITICAL SOQL RULES:
1. NEVER use "SELECT *" - SOQL does NOT support this syntax
2. ALWAYS explicitly list field names: SELECT Id, Name, Field1__c FROM Object
3. Custom objects end with __c (e.g., Barcode_Config__c)
4. Custom fields end with __c (e.g., Custom_Field__c)
5. Use EXACT API names from the schema provided

${schemaText}${objectFieldsList}

Question: ${question}

${isFieldsQuery ? `
This is a request to see ALL fields of an object.
Generate a SELECT query that includes ALL the fields listed above.
Example format: SELECT Id, Field1__c, Field2__c, Field3__c FROM ${detectedObject}
` : ''}

If you need clarification about which object to use, respond: CLARIFICATION_NEEDED: [your question]

Otherwise, respond ONLY with the valid SOQL query (no markdown, no explanations, no SELECT *).`;

    const response = await fetch(`${NVIDIA_API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${NVIDIA_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: NVIDIA_MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        max_tokens: 1024
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

    // Clean up the response
    result = result.replace(/```sql\n?/g, '').replace(/```\n?/g, '').trim();
    
    // Validate - reject if contains SELECT *
    if (result.includes('SELECT *')) {
      console.error('⚠️  LLM generated invalid SELECT * query, regenerating...');
      result = result.replace(/SELECT \*/gi, `SELECT Id, Name`);
    }

    console.log(`✅ Generated SOQL: ${result}`);
    
    res.json({
      soql: result,
      originalQuestion: question,
      needsClarification: false,
      detectedObject: detectedObject || null
    });

  } catch (error) {
    console.error('❌ POST /generate-soql error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/smart-query', async (req, res) => {
    console.log('🔍 POST /smart-query (Agentic) called');
    try {
        if (!NVIDIA_API_KEY) {
            return res.status(503).json({ error: 'LLM not configured' });
        }

        const { question } = req.body;
        if (!question) {
            return res.status(400).json({ error: 'question is required' });
        }

        // 1. Get current Object list for context
        const schema = await getOrgSchema();
        const objectList = [...schema.standard, ...schema.custom].map(o => `${o.apiName} (${o.label})`).join(', ');

        // 2. Step 1: Orchestration - Decide the path
        const orchestratorRes = await fetch(`${NVIDIA_API_BASE}/chat/completions`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${NVIDIA_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: NVIDIA_MODEL,
                messages: [{
                    role: 'system',
                    content: `You are a Salesforce Orchestrator. Available Objects: ${objectList}.
                    Based on the question, respond with ONE of these formats:
                    - 'FETCH: [ObjectAPIName]' if you need fields to query records or explain structure.
                    - 'CLARIFY: [Obj1], [Obj2]' if the entity (e.g., Tesla) exists in multiple objects.
                    - 'ANSWER: [Response]' for general knowledge, troubleshooting advice (access/permissions), or simple help.`
                }, { role: 'user', content: question }],
                temperature: 0.1
            })
        });

        const orchData = await orchestratorRes.json();
        const decision = orchData.choices[0].message.content.trim();
        console.log(`🤖 Orchestrator Decision: ${decision}`);

        // --- BRANCH A: Direct Answer (General/Troubleshooting) ---
        if (decision.startsWith('ANSWER:')) {
            return res.json({
                question,
                explanation: decision.replace('ANSWER:', '').trim(),
                type: 'general'
            });
        }

        // --- BRANCH B: Ambiguity Handling ---
        if (decision.startsWith('CLARIFY:')) {
            const options = decision.replace('CLARIFY:', '').split(',').map(s => s.trim());
            return res.json({
                question,
                needsClarification: true,
                options,
                type: 'clarification'
            });
        }

        // --- BRANCH C: Deep Data Thinking (Fetch + Query) ---
        if (decision.startsWith('CLARIFY:')) {
          const potentialObjects = decision.replace('CLARIFY:', '').split(',').map(s => s.trim());
          const confirmedObjects = [];

          // "Deep Thinking" step: Check if the record actually exists in these objects
          for (const obj of potentialObjects) {
              const checkResult = await query(`SELECT Id FROM ${obj} WHERE Name LIKE '%Tesla%' OR Name = 'Tesla' LIMIT 1`);
              if (checkResult.totalSize > 0) {
                  confirmedObjects.push(obj);
              }
          }

          // If it only exists in ONE place, auto-pivot to Branch C (FETCH)
          if (confirmedObjects.length === 1) {
              console.log(`🎯 Auto-resolved: Record only exists in ${confirmedObjects[0]}`);
              return await handleFetchBranch(confirmedObjects[0], req, res); 
          }

          // If it exists in zero places, give a friendly "Not Found" answer
          if (confirmedObjects.length === 0) {
              return res.json({ explanation: "I couldn't find any Account or Contact named 'Tesla'." });
          }

          // Only clarify if it REALLY exists in both places
          return res.json({
              question,
              needsClarification: true,
              options: confirmedObjects,
              type: 'clarification'
          });
        }

        // Fallback if the LLM format is weird
        throw new Error("Unexpected orchestrator response format");

    } catch (error) {
        console.error('❌ POST /smart-query error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/chat', async (req, res) => {
  console.log('🔍 POST /chat called');
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
      systemPrompt += `\n\nAvailable objects:\n${formatSchema(schema)}`;
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
    console.error('❌ POST /chat error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// STARTUP
// ============================================

console.log('\n' + '='.repeat(60));
console.log('🚀 STARTING SALESFORCE MCP PROVIDER');
console.log('='.repeat(60));

console.log('\n📋 Configuration:');
console.log(`   SF_USERNAME: ${SF_USERNAME ? '✅ Set' : '❌ Not set'}`);
console.log(`   SF_PASSWORD: ${SF_PASSWORD ? '✅ Set' : '❌ Not set'}`);
console.log(`   SF_SECURITY_TOKEN: ${SF_SECURITY_TOKEN ? '✅ Set' : '❌ Not set'}`);
console.log(`   SF_ACCESS_TOKEN: ${SF_ACCESS_TOKEN ? '✅ Set' : '❌ Not set'}`);
console.log(`   SF_INSTANCE_URL: ${SF_INSTANCE_URL ? '✅ Set' : '❌ Not set'}`);
console.log(`   NVIDIA_API_KEY: ${NVIDIA_API_KEY ? '✅ Set' : '❌ Not set'}`);

console.log('\n🔐 Testing Salesforce connection...');
try {
  await getConnection();
  console.log('✅ Salesforce connection successful!\n');
  
  console.log('📥 Fetching initial schema...');
  await getOrgSchema();
  console.log('✅ Schema loaded!\n');
  
} catch (error) {
  console.error('\n❌ STARTUP FAILED:', error.message);
  console.error('Fix credentials and redeploy.\n');
  process.exit(1);
}

app.listen(PORT, () => {
  console.log('='.repeat(60));
  console.log(`✅ SERVER RUNNING ON PORT ${PORT}`);
  console.log('='.repeat(60));
  console.log('\n📊 Endpoints:');
  console.log(`   GET  /health`);
  console.log(`   GET  /schema`);
  console.log(`   GET  /schema/:objectName`);
  console.log(`   POST /query`);
  console.log(`   POST /create`);
  console.log(`   POST /update`);
  console.log(`   POST /delete`);
  console.log(`   POST /generate-soql`);
  console.log(`   POST /smart-query`);
  console.log(`   POST /chat`);
  console.log('\n' + '='.repeat(60) + '\n');
});
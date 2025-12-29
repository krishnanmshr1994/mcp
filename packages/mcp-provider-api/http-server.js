import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import { z } from "zod";
import jsforce from 'jsforce';

// 1. Initialize MCP Server with McpServer (simpler API)
const server = new McpServer({
    name: "salesforce-mcp-detective",
    version: "1.0.0"
});

// 2. Salesforce Connection Helper
async function getSFConnection() {
    if (process.env.SALESFORCE_ACCESS_TOKEN && process.env.SALESFORCE_INSTANCE_URL) {
        return new jsforce.Connection({
            instanceUrl: process.env.SALESFORCE_INSTANCE_URL,
            accessToken: process.env.SALESFORCE_ACCESS_TOKEN
        });
    }
    const conn = new jsforce.Connection({
        loginUrl: process.env.SALESFORCE_LOGIN_URL || 'https://login.salesforce.com'
    });
    await conn.login(
        process.env.SALESFORCE_USERNAME, 
        process.env.SALESFORCE_PASSWORD + (process.env.SALESFORCE_SECURITY_TOKEN || '')
    );
    return conn;
}

// ============================================
// TOOLS (Using simplified API)
// ============================================

server.tool(
    "search_salesforce", 
    { searchTerm: z.string().describe("The term to search for") },
    async ({ searchTerm }) => {
        const conn = await getSFConnection();
        const results = await conn.search(
            `FIND {${searchTerm}} IN NAME FIELDS RETURNING Account(Id, Name), Contact(Id, Name), Lead(Id, Name)`
        );
        return { 
            content: [{ 
                type: "text", 
                text: JSON.stringify(results, null, 2) 
            }] 
        };
    }
);

server.tool(
    "investigate_org_logic",
    { toolingSoql: z.string().describe("The Tooling API SOQL query to execute") },
    async ({ toolingSoql }) => {
        const conn = await getSFConnection();
        const res = await conn.tooling.query(toolingSoql);
        return { 
            content: [{ 
                type: "text", 
                text: JSON.stringify(res.records || res, null, 2) 
            }] 
        };
    }
);

server.tool(
    "query_data",
    { soql: z.string().describe("The SOQL query to execute") },
    async ({ soql }) => {
        const conn = await getSFConnection();
        const res = await conn.query(soql);
        return { 
            content: [{ 
                type: "text", 
                text: JSON.stringify(res.records, null, 2) 
            }] 
        };
    }
);

server.tool(
    "general_chat",
    { prompt: z.string().describe("The prompt to send to the AI") },
    async ({ prompt }) => {
        const response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.NVIDIA_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: process.env.NVIDIA_MODEL || 'meta/llama-3.3-70b-instruct',
                messages: [{ role: 'user', content: prompt }]
            })
        });
        const data = await response.json();
        return { 
            content: [{ 
                type: "text", 
                text: data.choices[0].message.content 
            }] 
        };
    }
);

// ============================================
// EXPRESS SERVER WITH SSE
// ============================================

const app = express();
app.use(express.json({ limit: '5mb' }));

// Enable CORS
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

const transports = new Map();

app.get("/sse", async (req, res) => {
    console.log("New SSE connection");
    const transport = new SSEServerTransport("/messages", res);
    transports.set(transport.sessionId, transport);
    
    res.on("close", () => {
        console.log(`SSE connection closed: ${transport.sessionId}`);
        transports.delete(transport.sessionId);
    });
    
    await server.connect(transport);
});

app.post("/messages", async (req, res) => {
    const sessionId = req.query.sessionId;
    const transport = transports.get(sessionId);
    
    if (transport) {
        await transport.handlePostMessage(req, res);
    } else {
        res.status(400).json({ error: "Session not found" });
    }
});

app.get("/health", (req, res) => {
    res.json({ status: "ok", uptime: process.uptime() });
});

const PORT = process.env.PORT || 8080;

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Salesforce MCP Detective LIVE on port ${PORT}`);
    console.log(`   Health: http://localhost:${PORT}/health`);
    console.log(`   SSE:    http://localhost:${PORT}/sse`);
});
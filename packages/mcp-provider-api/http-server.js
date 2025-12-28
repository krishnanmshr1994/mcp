import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSETransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import { z } from "zod";
import jsforce from 'jsforce';
import fetch from 'node-fetch';

// 1. Initialize MCP Server
const server = new McpServer({
    name: "salesforce-mcp-detective",
    version: "1.0.0"
});

// 2. Salesforce Connection Helper (Token-First Strategy)
async function getSFConnection() {
    if (process.env.SF_ACCESS_TOKEN && process.env.SF_INSTANCE_URL) {
        return new jsforce.Connection({
            instanceUrl: process.env.SF_INSTANCE_URL,
            accessToken: process.env.SF_ACCESS_TOKEN
        });
    }
    
    // Fallback to Username/Password if token isn't provided
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
// TOOL 1: SMART SEARCH (Fixes the "Tesla" Issue)
// ============================================
server.tool("search_salesforce",
    { searchTerm: z.string().describe("The name or keyword to find (e.g. 'Tesla')") },
    async ({ searchTerm }) => {
        const conn = await getSFConnection();
        // SOSL: Scans multiple objects. AI sees empty results vs real results immediately.
        const results = await conn.search(
            `FIND {${searchTerm}} IN NAME FIELDS RETURNING Account(Id, Name), Contact(Id, Name), Lead(Id, Name)`
        );
        return { content: [{ type: "text", text: JSON.stringify(results) }] };
    }
);

// ============================================
// TOOL 2: UNIVERSAL METADATA (Investigation)
// ============================================
server.tool("investigate_org_logic",
    { 
        toolingSoql: z.string().describe("Tooling API SOQL (e.g. check ValidationRule or SharingRule)") 
    },
    async ({ toolingSoql }) => {
        const conn = await getSFConnection();
        // Accesses the 'Architect' layer of Salesforce
        const res = await conn.tooling.query(toolingSoql);
        return { content: [{ type: "text", text: JSON.stringify(res.records) }] };
    }
);

// ============================================
// TOOL 3: DATA OPERATIONS (SOQL & Schema)
// ============================================
server.tool("query_data",
    { soql: z.string().describe("A valid SOQL query for records") },
    async ({ soql }) => {
        const conn = await getSFConnection();
        const res = await conn.query(soql);
        return { content: [{ type: "text", text: JSON.stringify(res.records) }] };
    }
);

server.tool("describe_object",
    { objectApiName: z.string().describe("API name (e.g. 'Account')") },
    async ({ objectApiName }) => {
        const conn = await getSFConnection();
        const metadata = await conn.sobject(objectApiName).describe();
        const fields = metadata.fields.map(f => ({ name: f.name, label: f.label, type: f.type }));
        return { content: [{ type: "text", text: JSON.stringify(fields) }] };
    }
);

// ============================================
// TOOL 4: GENERAL CHAT (Non-Salesforce)
// ============================================
server.tool("general_chat",
    { prompt: z.string().describe("General non-Salesforce question") },
    async ({ prompt }) => {
        const response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.NVIDIA_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: process.env.NVIDIA_MODEL || 'meta/llama-3.3-70b-instruct',
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.7
            })
        });
        const data = await response.json();
        return { content: [{ type: "text", text: data.choices[0].message.content }] };
    }
);

// ============================================
// RENDER HOSTING (SSE)
// ============================================
const app = express();
let sseTransport = null;

app.get("/sse", async (req, res) => {
    console.log("Establish SSE Connection");
    sseTransport = new SSETransport("/messages", res);
    await server.connect(sseTransport);
});

app.post("/messages", express.json(), async (req, res) => {
    if (sseTransport) {
        await sseTransport.handlePostMessage(req, res);
    }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 MCP Detective running on port ${PORT}`));
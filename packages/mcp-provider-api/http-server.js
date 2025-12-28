import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSETransport } from "@modelcontextprotocol/server-sse";
import express from "express";
import { z } from "zod";
import jsforce from 'jsforce';

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
// TOOLS
// ============================================

// Tool 1: Smart Search (Fixes record "ghosting")
server.tool("search_salesforce", { searchTerm: z.string() }, async ({ searchTerm }) => {
    const conn = await getSFConnection();
    const results = await conn.search(`FIND {${searchTerm}} IN NAME FIELDS RETURNING Account(Id, Name), Contact(Id, Name), Lead(Id, Name)`);
    return { content: [{ type: "text", text: JSON.stringify(results) }] };
});

// Tool 2: Metadata/Logic Investigation (Tooling API)
server.tool("investigate_org_logic", { toolingSoql: z.string() }, async ({ toolingSoql }) => {
    const conn = await getSFConnection();
    const res = await conn.tooling.query(toolingSoql);
    return { content: [{ type: "text", text: JSON.stringify(res.records || res) }] };
});

// Tool 3: Standard Data Query (SOQL)
server.tool("query_data", { soql: z.string() }, async ({ soql }) => {
    const conn = await getSFConnection();
    const res = await conn.query(soql);
    return { content: [{ type: "text", text: JSON.stringify(res.records) }] };
});

// Tool 4: General Chat (Non-Salesforce via NVIDIA)
server.tool("general_chat", { prompt: z.string() }, async ({ prompt }) => {
    const response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.NVIDIA_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
            model: process.env.NVIDIA_MODEL || 'meta/llama-3.3-70b-instruct', 
            messages: [{ role: 'user', content: prompt }] 
        })
    });
    const data = await response.json();
    return { content: [{ type: "text", text: data.choices[0].message.content }] };
});

// ============================================
// HOSTING (Express + SSE)
// ============================================
const app = express();

// Protects against large payloads from Salesforce queries
app.use(express.json({ limit: '5mb' }));

let sseTransport = null;

app.get("/sse", async (req, res) => {
    console.log("New SSE Connection Initiated");
    sseTransport = new SSETransport("/messages", res);
    await server.connect(sseTransport);
});

app.post("/messages", async (req, res) => {
    if (sseTransport) {
        await sseTransport.handlePostMessage(req, res);
    } else {
        res.status(400).send("No active SSE session found. Hit /sse first.");
    }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`🚀 Salesforce MCP Detective running on port ${PORT}`);
});
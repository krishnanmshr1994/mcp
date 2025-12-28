import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import { z } from "zod";
import jsforce from 'jsforce';

// 1. Initialize MCP Server
const server = new McpServer({
    name: "salesforce-mcp-detective",
    version: "1.0.0"
});

// 2. Salesforce Connection Helper (Using your Exact Env Vars)
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
// TOOLS
// ============================================

server.tool("search_salesforce", { searchTerm: z.string() }, async ({ searchTerm }) => {
    const conn = await getSFConnection();
    const results = await conn.search(`FIND {${searchTerm}} IN NAME FIELDS RETURNING Account(Id, Name), Contact(Id, Name), Lead(Id, Name)`);
    return { content: [{ type: "text", text: JSON.stringify(results) }] };
});

server.tool("investigate_org_logic", { toolingSoql: z.string() }, async ({ toolingSoql }) => {
    const conn = await getSFConnection();
    const res = await conn.tooling.query(toolingSoql);
    return { content: [{ type: "text", text: JSON.stringify(res.records || res) }] };
});

server.tool("query_data", { soql: z.string() }, async ({ soql }) => {
    const conn = await getSFConnection();
    const res = await conn.query(soql);
    return { content: [{ type: "text", text: JSON.stringify(res.records) }] };
});

server.tool("general_chat", { prompt: z.string() }, async ({ prompt }) => {
    const response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.NVIDIA_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: process.env.NVIDIA_MODEL || 'meta/llama-3.3-70b-instruct', messages: [{ role: 'user', content: prompt }] })
    });
    const data = await response.json();
    return { content: [{ type: "text", text: data.choices[0].message.content }] };
});

// ============================================
// HOSTING (Express + SSE)
// ============================================
const app = express();
app.use(express.json({ limit: '5mb' }));

const transports = new Map();

app.get("/sse", async (req, res) => {
    const transport = new SSEServerTransport("/messages", res);
    transports.set(transport.sessionId, transport);
    res.on("close", () => {
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
        res.status(400).send("Session not found.");
    }
});

const PORT = process.env.PORT || 8080;
// CRITICAL FIX: Bind to 0.0.0.0
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Salesforce MCP Detective LIVE on port ${PORT}`);
});
/**
 * MCP server factory (SDK v2). FR-MCP-02A-01 registers no application tools:
 * the `tools` capability is declared so that `tools/list` answers with an
 * empty list instead of "method not found".
 */

import { McpServer } from "@modelcontextprotocol/server"

export const SERVER_NAME = "fluent-reader-mcp"
export const SERVER_VERSION = "0.1.0"

export function createServer(): McpServer {
    return new McpServer(
        { name: SERVER_NAME, version: SERVER_VERSION },
        { capabilities: { tools: {} } },
    )
}

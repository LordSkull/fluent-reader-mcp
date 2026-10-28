/**
 * Diagnostics on stderr. stdout is reserved for MCP JSON-RPC.
 *
 * Callers pass only a fixed event name and scalar fields that carry no
 * personal data: codes, reasons, flags, versions. Never paths, URLs, titles,
 * article content, settings values or raw error messages.
 */

export type LogEvent =
    | "startup_failed"
    | "profile_ok"
    | "database_ok"
    | "settings_ok"
    | "settings_unavailable"
    | "settings_suspicious"
    | "database_replaced"
    | "serving"
    | "transport_error"
    | "tool_error"
    | "shutdown"
    | "fatal"

export type LogFields = Readonly<Record<string, string | number | boolean>>

export function logEvent(event: LogEvent, fields: LogFields = {}): void {
    try {
        process.stderr.write(`fluent-reader-mcp ${JSON.stringify({ event, ...fields })}\n`)
    } catch {
        // stderr unavailable: nothing else may be written anywhere.
    }
}

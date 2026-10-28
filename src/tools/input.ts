/**
 * Tool input validation under this server's control.
 *
 * The SDK validates `inputSchema` before calling a handler and, on failure,
 * returns its own isError text without a stable code. To answer every invalid
 * input with the sanitized INVALID_ARGUMENT error, tools register
 * `advertised(schema)`: a Standard Schema that publishes exactly the JSON
 * Schema of the Zod schema in tools/list (zod >= 4.2 implements
 * `~standard.jsonSchema`) but accepts any value. The handler then validates
 * with the Zod schema itself through `parseArgs`.
 */

import type { StandardSchemaWithJSON } from "@modelcontextprotocol/server"
import type { z } from "zod"
import { FrMcpError } from "../errors.js"

export function advertised(schema: z.ZodType): StandardSchemaWithJSON<unknown, unknown> {
    const standard = schema["~standard"]
    return {
        "~standard": {
            version: 1,
            vendor: "fluent-reader-mcp",
            validate: (value: unknown) => ({ value }),
            jsonSchema: standard.jsonSchema,
        },
    }
}

/**
 * Parses tool arguments; any failure is INVALID_ARGUMENT, without echoing the input.
 *
 * Only omitted arguments (`undefined`) default to `{}`: `null` is not an
 * object and is rejected like any other non-object. Over JSON-RPC, SDK 2.4.0
 * itself rejects a non-object `params.arguments` (null, array, string) with
 * error -32602 before any handler runs, and turns omitted arguments into `{}`;
 * this check covers every other caller of the handlers.
 */
export function parseArgs<S extends z.ZodType>(schema: S, args: unknown): z.output<S> {
    const parsed = schema.safeParse(args === undefined ? {} : args)
    if (!parsed.success) throw new FrMcpError("INVALID_ARGUMENT", "invalid-argument")
    return parsed.data
}

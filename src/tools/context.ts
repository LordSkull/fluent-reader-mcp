/**
 * Process-wide services shared by the tools. Created once in main.ts, so that
 * cursors and sourceRefs survive across MCP requests (but not restarts).
 */

import type { DatabaseAccess } from "../db/connection.js"
import { GroupIndex } from "../domain/groups.js"
import { logEvent } from "../log.js"
import { CursorRegistry } from "../scan/cursors.js"
import { SourceIdentity } from "../scan/identity.js"
import { readSettings } from "../settings/read-settings.js"

export interface ToolContext {
    readonly database: Pick<DatabaseAccess, "withReadConnection">
    readonly configPath: string
    readonly profileDir: string
    readonly cursors: CursorRegistry
    readonly identity: SourceIdentity
    readonly now: () => number
}

export interface ToolContextOptions {
    readonly database: Pick<DatabaseAccess, "withReadConnection">
    readonly configPath: string
    readonly profileDir: string
    readonly cursors?: CursorRegistry
    readonly now?: () => number
}

export function createToolContext(options: ToolContextOptions): ToolContext {
    const now = options.now ?? Date.now
    return {
        database: options.database,
        configPath: options.configPath,
        profileDir: options.profileDir,
        cursors: options.cursors ?? new CursorRegistry({ now }),
        identity: new SourceIdentity(),
        now,
    }
}

/**
 * Groups and rules from config.json, read per call (it is replaced by the app
 * at any time). A settings failure makes them unavailable; it is not fatal.
 * Groups with a negative gid are logged by count only (no gid, no sids).
 */
export async function loadGroups(context: ToolContext): Promise<GroupIndex> {
    let groups: GroupIndex
    try {
        groups = GroupIndex.fromSnapshot(await readSettings(context.configPath, context.profileDir))
    } catch (error) {
        return GroupIndex.unavailable(error)
    }
    if (groups.negativeGroupIds > 0) logEvent("settings_suspicious", { reason: "negative-gid", groups: groups.negativeGroupIds })
    return groups
}

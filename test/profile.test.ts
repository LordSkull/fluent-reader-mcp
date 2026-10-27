import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { after, before, describe, test } from "node:test"
import { PROFILE_ENV_VAR, resolveProfile, selectProfileInput } from "../src/config/profile.js"
import { FrMcpError } from "../src/errors.js"
import {
    canCreateFileSymlinks,
    CONFIG_NAME,
    createProfile,
    createTempRoot,
    DB_NAME,
    removeTempRoot,
    snapshotDir,
} from "./helpers/fixtures.js"

const isWindows = process.platform === "win32"

function expectProfileError(fn: () => unknown, reason: string): FrMcpError {
    let caught: unknown
    try {
        fn()
    } catch (error) {
        caught = error
    }
    assert.ok(caught instanceof FrMcpError, "expected a FrMcpError")
    assert.equal(caught.code, "PROFILE_UNAVAILABLE")
    assert.equal(caught.reason, reason)
    return caught
}

describe("selectProfileInput", () => {
    const dir = isWindows ? "C:\\profiles\\fr" : "/profiles/fr"

    test("accepts --profile-dir <path> and --profile-dir=<path>", () => {
        assert.equal(selectProfileInput(["--profile-dir", dir], {}), dir)
        assert.equal(selectProfileInput([`--profile-dir=${dir}`], {}), dir)
    })

    test("accepts the environment variable", () => {
        assert.equal(selectProfileInput([], { [PROFILE_ENV_VAR]: dir }), dir)
    })

    test("accepts identical argument and environment values", () => {
        assert.equal(selectProfileInput(["--profile-dir", dir], { [PROFILE_ENV_VAR]: dir }), dir)
    })

    test("rejects a missing configuration (no default, no autodiscovery)", () => {
        expectProfileError(() => selectProfileInput([], {}), "not-configured")
        expectProfileError(() => selectProfileInput([], { [PROFILE_ENV_VAR]: "" }), "not-configured")
    })

    test("rejects argument and environment with different values", () => {
        expectProfileError(
            () => selectProfileInput(["--profile-dir", dir], { [PROFILE_ENV_VAR]: `${dir}2` }),
            "ambiguous",
        )
    })

    test("rejects a repeated flag", () => {
        expectProfileError(() => selectProfileInput(["--profile-dir", dir, "--profile-dir", dir], {}), "ambiguous")
    })

    test("rejects unknown arguments, --db/--config overrides and missing values", () => {
        expectProfileError(() => selectProfileInput(["--db", dir], {}), "invalid-argument")
        expectProfileError(() => selectProfileInput(["--config", dir], {}), "invalid-argument")
        expectProfileError(() => selectProfileInput(["--profile-dir"], {}), "invalid-argument")
        expectProfileError(() => selectProfileInput(["--profile-dir", "--other"], {}), "invalid-argument")
        expectProfileError(() => selectProfileInput(["--profile-dir="], {}), "invalid-argument")
        expectProfileError(() => selectProfileInput([dir], {}), "invalid-argument")
    })
})

describe("resolveProfile", () => {
    let root: string
    before(() => {
        root = createTempRoot()
    })
    after(() => removeTempRoot(root))

    test("accepts a valid synthetic profile and returns canonical paths", () => {
        const profile = createProfile(path.join(root, "valid"))
        const resolved = resolveProfile(profile.dir)
        assert.equal(resolved.directory, fs.realpathSync.native(profile.dir))
        assert.equal(resolved.databasePath, path.join(resolved.directory, DB_NAME))
        assert.equal(resolved.configPath, path.join(resolved.directory, CONFIG_NAME))
        assert.equal(resolved.hardLinkWarning, false)
    })

    test("rejects relative paths", () => {
        expectProfileError(() => resolveProfile("relative\\profile"), "not-absolute")
        expectProfileError(() => resolveProfile("./profile"), "not-absolute")
        if (isWindows) {
            expectProfileError(() => resolveProfile("\\rooted-without-drive"), "not-absolute")
            expectProfileError(() => resolveProfile("C:drive-relative"), "not-absolute")
        }
    })

    test("rejects network and device paths without touching them", { skip: !isWindows }, () => {
        expectProfileError(() => resolveProfile("\\\\server.invalid\\share\\profile"), "network-path")
        expectProfileError(() => resolveProfile("//server.invalid/share/profile"), "network-path")
        expectProfileError(() => resolveProfile("\\\\?\\UNC\\server.invalid\\share"), "network-path")
        expectProfileError(() => resolveProfile("\\\\.\\PhysicalDrive0"), "not-local")
    })

    test("accepts the \\\\?\\X:\\ long form of a local path", { skip: !isWindows }, () => {
        const profile = createProfile(path.join(root, "long-form"))
        const resolved = resolveProfile(`\\\\?\\${profile.dir}`)
        assert.equal(resolved.directory, fs.realpathSync.native(profile.dir))
    })

    test("rejects a missing directory and creates nothing", () => {
        const initial = snapshotDir(root)
        const missing = path.join(root, "does-not-exist")
        expectProfileError(() => resolveProfile(missing), "not-found")
        assert.equal(fs.existsSync(missing), false)
        assert.deepEqual(snapshotDir(root), initial)
    })

    test("rejects a path that is a file", () => {
        const file = path.join(root, "plain-file")
        fs.writeFileSync(file, "x")
        expectProfileError(() => resolveProfile(file), "not-directory")
    })

    test("rejects a missing database and creates nothing", () => {
        const profile = createProfile(path.join(root, "no-db"), { db: false })
        const initial = snapshotDir(profile.dir)
        expectProfileError(() => resolveProfile(profile.dir), "db-missing")
        assert.deepEqual(snapshotDir(profile.dir), initial)
        assert.equal(fs.existsSync(profile.dbPath), false)
    })

    test("rejects a missing config.json and creates nothing", () => {
        const profile = createProfile(path.join(root, "no-config"), { settings: false })
        const initial = snapshotDir(profile.dir)
        expectProfileError(() => resolveProfile(profile.dir), "config-missing")
        assert.deepEqual(snapshotDir(profile.dir), initial)
        assert.equal(fs.existsSync(profile.configPath), false)
    })

    test("rejects profile entries that are directories", () => {
        const profile = createProfile(path.join(root, "db-is-dir"), { db: false })
        fs.mkdirSync(profile.dbPath)
        expectProfileError(() => resolveProfile(profile.dir), "not-regular-file")
    })

    test("accepts a directory with spaces", () => {
        const profile = createProfile(path.join(root, "Prova Profilo FR"))
        assert.equal(resolveProfile(profile.dir).directory, fs.realpathSync.native(profile.dir))
    })

    test("accepts a directory with Unicode, accents and emoji", () => {
        const profile = createProfile(path.join(root, "profilo àèìòù 中文 Ελληνικά 😀"))
        const resolved = resolveProfile(profile.dir)
        assert.equal(resolved.directory, fs.realpathSync.native(profile.dir))
        assert.ok(fs.existsSync(resolved.databasePath))
        assert.equal(resolveProfile(profile.dir).directory, resolved.directory, "realpath is stable")
    })

    test("accepts a directory reached through a junction and flags canonicalPathDiffers", () => {
        const profile = createProfile(path.join(root, "junction-target"))
        const junction = path.join(root, "junction-link")
        fs.symlinkSync(profile.dir, junction, "junction")
        const resolved = resolveProfile(junction)
        assert.equal(resolved.directory, fs.realpathSync.native(profile.dir))
        assert.equal(resolved.canonicalPathDiffers, true)
    })

    test("accepts a profile whose ancestor is a junction", () => {
        const realParent = path.join(root, "ancestor-real")
        const profile = createProfile(path.join(realParent, "inner"))
        const junction = path.join(root, "ancestor-link")
        fs.symlinkSync(realParent, junction, "junction")
        const resolved = resolveProfile(path.join(junction, "inner"))
        assert.equal(resolved.directory, fs.realpathSync.native(profile.dir))
        assert.equal(resolved.canonicalPathDiffers, true)
    })

    test("rejects database and config.json that are file symlinks", (t) => {
        if (!canCreateFileSymlinks(root)) {
            t.skip("file symlinks cannot be created by this account (Developer Mode/admin required)")
            return
        }
        const real = createProfile(path.join(root, "symlink-real"))
        const dbLinked = createProfile(path.join(root, "db-linked"), { db: false })
        fs.symlinkSync(real.dbPath, dbLinked.dbPath, "file")
        expectProfileError(() => resolveProfile(dbLinked.dir), "linked-file")

        const cfgLinked = createProfile(path.join(root, "cfg-linked"), { settings: false })
        fs.symlinkSync(path.join(real.dir, CONFIG_NAME), cfgLinked.configPath, "file")
        expectProfileError(() => resolveProfile(cfgLinked.dir), "linked-file")

        // Link to a file of the same directory is rejected too.
        const sameDir = createProfile(path.join(root, "same-dir-link"), { db: false })
        fs.copyFileSync(real.dbPath, path.join(sameDir.dir, "other.db"))
        fs.symlinkSync(path.join(sameDir.dir, "other.db"), sameDir.dbPath, "file")
        expectProfileError(() => resolveProfile(sameDir.dir), "linked-file")
    })

    test("accepts a directory symlink", (t) => {
        const profile = createProfile(path.join(root, "dir-symlink-target"))
        const link = path.join(root, "dir-symlink")
        try {
            fs.symlinkSync(profile.dir, link, "dir")
        } catch {
            t.skip("directory symlinks cannot be created by this account (Developer Mode/admin required)")
            return
        }
        const resolved = resolveProfile(link)
        assert.equal(resolved.directory, fs.realpathSync.native(profile.dir))
        assert.equal(resolved.canonicalPathDiffers, true)
    })

    test("flags hard-linked profile files as a warning only", () => {
        const profile = createProfile(path.join(root, "hardlink"))
        fs.linkSync(profile.configPath, path.join(root, "hardlink-extra.json"))
        assert.equal(resolveProfile(profile.dir).hardLinkWarning, true)
    })

    test("errors carry no path", () => {
        const marker = path.join(root, "PATHMARK-secret-dir")
        const error = expectProfileError(() => resolveProfile(marker), "not-found")
        const serialized = [error.message, error.hint, JSON.stringify(error), String(error)].join("\n")
        assert.ok(!serialized.includes("PATHMARK"))
        assert.ok(!serialized.includes(root))
        assert.equal(error.cause, undefined)
    })
})

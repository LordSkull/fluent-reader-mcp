# Provenance: cross-source duplicates contract, version 1

Byte-exact copies, taken with `git show`, of the public contract published by
the Fluent Reader application repository. They let the MCP tests run after a
clean clone of this repository alone: nothing here, at build, test or run
time, reads the Fluent Reader repository.

| | |
|---|---|
| Contract | `fluent-reader/cross-source-duplicates` |
| Version | 1 |
| Source repository | `LordSkull/fluent-reader` |
| Source commit | `7a23a931fbcc974d15bf73fb52a93ee4ae889f08` (`7a23a93`, merge of `42bab88`) |
| `CONTRACT.md` | `contracts/cross-source-duplicates/README.md`, git blob `2122b447673209cac49a8b2a0e87c5391b742a32`, SHA-256 `9999af95795d74184c721ac7acbf8bbfcac72331ba3c5e0c1264c96bd75bc35d` |
| `conformance.json` | `contracts/cross-source-duplicates/conformance.json`, git blob `f6327ac8ec1427b57bbc65ca20bdf392f70c095d`, SHA-256 `59e553e615a26608f1698dac666486498da0c0013a88d4afb5f34faebbbba855` |

The SHA-256 values are those of the committed bytes (LF line endings);
`.gitattributes` marks these files `-text` so that no checkout converts them.
`test/duplicates-contract.test.ts` verifies both hashes before using the data.

The data is synthetic (no personal data). These files are never edited here:
a change of the rules is a new contract version, made in both repositories
(contract section 9), and would be copied into a new `v2` directory.

The MCP implementation is `src/domain/duplicates.ts` (identity, sections 3 to
7, unchanged) and `src/scan/duplicate-memory.ts` (grouping in the MCP's
"stored" order, as allowed by section 8, "Other orders").

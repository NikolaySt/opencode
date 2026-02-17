import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import path from "path"
import fs from "fs"
import os from "os"
import { discover, type PluginCandidate } from "../../src/plugin/discovery"

describe("plugin.discovery", () => {
  let tmpDir: string

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-discovery-"))
  })

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  test("returns empty when no plugins exist", () => {
    const result = discover({
      workspaceDir: tmpDir,
      configDirectories: [path.join(tmpDir, "nonexistent")],
    })
    expect(result.candidates).toEqual([])
    expect(result.diagnostics).toEqual([])
  })

  test("discovers single .ts file in extensions dir", () => {
    const extDir = path.join(tmpDir, ".opencode-test-ext1", "extensions")
    fs.mkdirSync(extDir, { recursive: true })
    fs.writeFileSync(path.join(extDir, "my-plugin.ts"), "export default {}")

    const result = discover({
      workspaceDir: tmpDir,
      configDirectories: [path.join(tmpDir, ".opencode-test-ext1")],
    })
    expect(result.candidates.length).toBe(1)
    expect(result.candidates[0].idHint).toBe("my-plugin")
    expect(result.candidates[0].origin).toBe("workspace")
  })

  test("discovers directory plugin with index.ts", () => {
    const pluginsDir = path.join(tmpDir, ".opencode-test-ext2", "plugins")
    const pluginDir = path.join(pluginsDir, "dir-plugin")
    fs.mkdirSync(pluginDir, { recursive: true })
    fs.writeFileSync(path.join(pluginDir, "index.ts"), "export function register() {}")

    const result = discover({
      workspaceDir: tmpDir,
      configDirectories: [path.join(tmpDir, ".opencode-test-ext2")],
    })
    expect(result.candidates.length).toBe(1)
    expect(result.candidates[0].idHint).toBe("dir-plugin")
  })

  test("discovers package plugin with opencode.extensions", () => {
    const pluginsDir = path.join(tmpDir, ".opencode-test-ext3", "extensions")
    const pkgDir = path.join(pluginsDir, "pkg-plugin")
    fs.mkdirSync(pkgDir, { recursive: true })
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({ name: "my-pkg-plugin", version: "1.0.0", opencode: { extensions: ["./entry.ts"] } }),
    )
    fs.writeFileSync(path.join(pkgDir, "entry.ts"), "export function register() {}")

    const result = discover({
      workspaceDir: tmpDir,
      configDirectories: [path.join(tmpDir, ".opencode-test-ext3")],
    })
    expect(result.candidates.length).toBe(1)
    expect(result.candidates[0].packageName).toBe("my-pkg-plugin")
    expect(result.candidates[0].packageVersion).toBe("1.0.0")
  })

  test("extra paths from config are discovered as 'config' origin", () => {
    const extra = path.join(tmpDir, "extra-plugin.ts")
    fs.writeFileSync(extra, "export default {}")

    const result = discover({
      workspaceDir: tmpDir,
      extraPaths: [extra],
    })
    expect(result.candidates.length).toBe(1)
    expect(result.candidates[0].origin).toBe("config")
  })

  test("produces diagnostic for missing extra path", () => {
    const result = discover({
      workspaceDir: tmpDir,
      extraPaths: [path.join(tmpDir, "does-not-exist.ts")],
    })
    expect(result.candidates).toEqual([])
    expect(result.diagnostics.length).toBe(1)
    expect(result.diagnostics[0].level).toBe("error")
    expect(result.diagnostics[0].message).toContain("not found")
  })

  test("deduplicates candidates by resolved path", () => {
    const file = path.join(tmpDir, "dedup-plugin.ts")
    fs.writeFileSync(file, "export default {}")

    const result = discover({
      workspaceDir: tmpDir,
      extraPaths: [file, file],
    })
    expect(result.candidates.length).toBe(1)
  })

  test("ignores .d.ts files", () => {
    const extDir = path.join(tmpDir, ".opencode-test-ext4", "extensions")
    fs.mkdirSync(extDir, { recursive: true })
    fs.writeFileSync(path.join(extDir, "types.d.ts"), "export type Foo = {}")

    const result = discover({
      workspaceDir: tmpDir,
      configDirectories: [path.join(tmpDir, ".opencode-test-ext4")],
    })
    expect(result.candidates).toEqual([])
  })

  test("scans both extensions and plugins subdirectories", () => {
    const base = path.join(tmpDir, ".opencode-test-ext5")
    const extDir = path.join(base, "extensions")
    const plugDir = path.join(base, "plugins")
    fs.mkdirSync(extDir, { recursive: true })
    fs.mkdirSync(plugDir, { recursive: true })
    fs.writeFileSync(path.join(extDir, "ext-a.ts"), "export default {}")
    fs.writeFileSync(path.join(plugDir, "plug-b.ts"), "export default {}")

    const result = discover({
      workspaceDir: tmpDir,
      configDirectories: [base],
    })
    expect(result.candidates.length).toBe(2)
    const ids = result.candidates.map((c) => c.idHint).sort()
    expect(ids).toEqual(["ext-a", "plug-b"])
  })
})

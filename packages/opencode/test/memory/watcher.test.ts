import { describe, expect, test, afterEach } from "bun:test"
import path from "path"
import fs from "fs"
import os from "os"
import { create } from "../../src/memory/watcher"

function makeTmpDir(): string {
  const dir = path.join(os.tmpdir(), `opencode-watcher-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

describe("memory.watcher state logic", () => {
  let dir: string
  let watcher: ReturnType<typeof create>

  afterEach(() => {
    watcher?.stop()
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  })

  test("isDirty is false initially", () => {
    watcher = create()
    expect(watcher.isDirty()).toBe(false)
  })

  test("clearDirty resets dirty flag after file change", async () => {
    dir = makeTmpDir()
    const filepath = path.join(dir, "MEMORY.md")
    fs.writeFileSync(filepath, "# Knowledge v1")
    watcher = create()
    watcher.start(dir, 50)

    // Trigger actual file change to make dirty
    fs.writeFileSync(filepath, "# Knowledge v2")
    await Bun.sleep(300)
    expect(watcher.isDirty()).toBe(true)

    // Now verify clearDirty actually resets it
    watcher.clearDirty()
    expect(watcher.isDirty()).toBe(false)
  })

  test("stop clears dirty flag and watchers", () => {
    dir = makeTmpDir()
    watcher = create()
    watcher.start(dir, 100)
    watcher.stop()
    expect(watcher.isDirty()).toBe(false)
  })

  test("stop clears dirty flag even when dirty", async () => {
    dir = makeTmpDir()
    const filepath = path.join(dir, "MEMORY.md")
    fs.writeFileSync(filepath, "# Knowledge v1")
    watcher = create()
    watcher.start(dir, 50)

    // Make dirty
    fs.writeFileSync(filepath, "# Knowledge v2")
    await Bun.sleep(300)
    expect(watcher.isDirty()).toBe(true)

    // Stop should reset dirty
    watcher.stop()
    expect(watcher.isDirty()).toBe(false)
  })

  test("stop is safe to call multiple times", () => {
    watcher = create()
    watcher.stop()
    watcher.stop()
    expect(watcher.isDirty()).toBe(false)
  })

  test("start does not throw or set dirty when MEMORY.md exists", () => {
    dir = makeTmpDir()
    fs.writeFileSync(path.join(dir, "MEMORY.md"), "# Knowledge")
    watcher = create()
    watcher.start(dir, 100)
    expect(watcher.isDirty()).toBe(false)
  })

  test("start detects change in MEMORY.md", async () => {
    dir = makeTmpDir()
    const filepath = path.join(dir, "MEMORY.md")
    fs.writeFileSync(filepath, "# Knowledge v1")
    watcher = create()
    watcher.start(dir, 50)
    expect(watcher.isDirty()).toBe(false)

    fs.writeFileSync(filepath, "# Knowledge v2")
    await Bun.sleep(300)
    expect(watcher.isDirty()).toBe(true)
  })

  test("start does not throw or set dirty when memory/ directory exists", () => {
    dir = makeTmpDir()
    fs.mkdirSync(path.join(dir, "memory"), { recursive: true })
    fs.writeFileSync(path.join(dir, "memory", "notes.md"), "# Notes")
    watcher = create()
    watcher.start(dir, 100)
    expect(watcher.isDirty()).toBe(false)
  })

  test("start detects change in memory/ directory", async () => {
    dir = makeTmpDir()
    fs.mkdirSync(path.join(dir, "memory"), { recursive: true })
    fs.writeFileSync(path.join(dir, "memory", "notes.md"), "# Notes v1")
    watcher = create()
    watcher.start(dir, 50)
    expect(watcher.isDirty()).toBe(false)

    fs.writeFileSync(path.join(dir, "memory", "notes.md"), "# Notes v2")
    await Bun.sleep(300)
    expect(watcher.isDirty()).toBe(true)
  })

  test("start does not throw or set dirty for extra paths", () => {
    dir = makeTmpDir()
    const extra = path.join(dir, "extra.md")
    fs.writeFileSync(extra, "# Extra")
    watcher = create()
    watcher.start(dir, 100, [extra])
    expect(watcher.isDirty()).toBe(false)
  })

  test("start detects change in extra paths", async () => {
    dir = makeTmpDir()
    const extra = path.join(dir, "extra.md")
    fs.writeFileSync(extra, "# Extra v1")
    watcher = create()
    watcher.start(dir, 50, [extra])
    expect(watcher.isDirty()).toBe(false)

    fs.writeFileSync(extra, "# Extra v2")
    await Bun.sleep(300)
    expect(watcher.isDirty()).toBe(true)
  })

  test("start skips nonexistent targets without error", () => {
    dir = makeTmpDir()
    // No MEMORY.md, no memory/ — should not throw
    watcher = create()
    watcher.start(dir, 100)
    expect(watcher.isDirty()).toBe(false)
  })

  test("restart clears previous watchers", () => {
    dir = makeTmpDir()
    fs.writeFileSync(path.join(dir, "MEMORY.md"), "# Knowledge")
    watcher = create()
    watcher.start(dir, 100)
    // Start again — should not throw or double-watch
    watcher.start(dir, 100)
    expect(watcher.isDirty()).toBe(false)
  })

  // Removed: "file change sets dirty flag after debounce" — duplicate of "start detects change in MEMORY.md"
  // Removed: "clearDirty resets after file change" — duplicate of "clearDirty resets dirty flag after file change"
})

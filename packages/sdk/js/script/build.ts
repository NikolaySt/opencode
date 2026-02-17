#!/usr/bin/env bun

import { $ } from "bun"
import fs from "fs/promises"
import path from "path"

import { createClient } from "@hey-api/openapi-ts"

const dir = path.resolve(import.meta.dirname, "..")
process.chdir(dir)

const openapi = path.join(dir, "openapi.json")
const dist = path.join(dir, "dist")
const opencode = path.resolve(dir, "../../opencode")

// remove stale dist before running generate to avoid import errors
await fs.rm(dist, { recursive: true, force: true })

await $`bun dev generate > ${openapi}`.cwd(opencode)

await createClient({
  input: "./openapi.json",
  output: {
    path: "./src/v2/gen",
    tsConfigPath: path.join(dir, "tsconfig.json"),
    clean: true,
  },
  plugins: [
    {
      name: "@hey-api/typescript",
      exportFromIndex: false,
    },
    {
      name: "@hey-api/sdk",
      instance: "OpencodeClient",
      exportFromIndex: false,
      auth: false,
      paramsStructure: "flat",
    },
    {
      name: "@hey-api/client-fetch",
      exportFromIndex: false,
      baseUrl: "http://localhost:4096",
    },
  ],
})

await $`bun prettier --write src/gen`
await $`bun prettier --write src/v2`
await $`bun tsc`
await fs.rm(openapi, { force: true })

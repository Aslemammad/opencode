import { getSandbox, proxyToSandbox, type Sandbox } from "@cloudflare/sandbox"

export { Sandbox } from "@cloudflare/sandbox"

type Env = {
  Sandbox: DurableObjectNamespace<Sandbox>
  ASSETS: Fetcher
}

const PORT = 8080
const BIN = "/root/.bun/bin/opencode"
const DEFAULT_ORG = "tinylibs"
const DEFAULT_REPO = "tinybench"
const SANDBOX_ID = `desktop-${DEFAULT_ORG}-${DEFAULT_REPO}`
const serviceCache = new Map<string, Promise<void>>()

async function ensureRepo(sandbox: Sandbox, org: string, repo: string, ref?: string): Promise<string> {
  const path = `/workspace/repos/${org}/${repo}`
  const exists = await sandbox.exec(`test -d ${path}`)

  if (!exists.success) {
    await sandbox.mkdir(`/workspace/repos/${org}`, { recursive: true })
    await sandbox.exec(`git clone https://github.com/${org}/${repo}.git ${path}`)
  }

  return path
}

async function waitForReady(sandbox: Sandbox): Promise<void> {
  const attempts = Array.from({ length: 30 })

  for (const _ of attempts) {
    const ping = await sandbox.exec(`curl --silent --max-time 5 http://127.0.0.1:${PORT}`)

    if (ping.success) return

    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

async function ensureService(sandbox: Sandbox, repoPath: string) {
  const cacheKey = SANDBOX_ID
  const cached = serviceCache.get(cacheKey)
  if (cached) return cached

  const start = async () => {
    const binCheck = await sandbox.exec(`test -x ${BIN}`)
    if (!binCheck.success) {
      throw new Error("opencode binary missing")
    }

    try {
      const processes = await sandbox.listProcesses()
      const running = processes.find((p) => p.command.includes(`${BIN} serve`))
      if (running) {
        const probe = await sandbox.exec(`curl --silent --max-time 2 http://127.0.0.1:${PORT}`)
        if (probe.success) {
          return
        }
      }
    } catch {}

    const proc = await sandbox.startProcess(`${BIN} serve --hostname 0.0.0.0 --port ${PORT}`, { cwd: repoPath })

    await waitForReady(sandbox)

    const secondProbe = await sandbox.exec(`curl --silent --max-time 10 http://127.0.0.1:${PORT}`)
    if (!secondProbe.success) {
      const logs = await proc.getLogs().catch(() => ({ stdout: "", stderr: "" }))
      if (logs.stdout || logs.stderr) {
      }
    }

    return
  }

  const promise = start().catch((error) => {
    serviceCache.delete(cacheKey)
    throw error
  })
  serviceCache.set(cacheKey, promise)
  return promise
}

const sandboxId = (org: string, repo: string) => `desktop-${org}-${repo}`

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const proxied = await proxyToSandbox(request, env)
    if (proxied) return proxied

    const url = new URL(request.url)
    const parts = url.pathname.split("/").filter(Boolean)
    const isDefaultPath = parts[0] === DEFAULT_ORG && parts[1] === DEFAULT_REPO
    const assetRequest = isDefaultPath
      ? new Request(new URL(`/${DEFAULT_ORG}/${DEFAULT_REPO}/${parts.slice(2).join("/")}`, url).toString(), request)
      : request
    if (url.pathname.startsWith("/container")) {
      const sandbox = getSandbox(env.Sandbox, SANDBOX_ID, {
        keepAlive: true,
        sleepAfter: "30m",
        normalizeId: true,
      })
      const repoPath = await ensureRepo(sandbox, DEFAULT_ORG, DEFAULT_REPO)
      await ensureService(sandbox, repoPath)

      const path = `/${url.pathname.slice("/container".length) || ""}`.replace(/\/+/, "/")
      const target =
        path.startsWith("/global/event") && !url.search
          ? `http://127.0.0.1:${PORT}${path}?directory=${encodeURIComponent(repoPath)}`
          : `http://127.0.0.1:${PORT}${path}${url.search || `?directory=${encodeURIComponent(repoPath)}`}`

      try {
        const headers = new Headers(request.headers)
        headers.set("x-opencode-directory", repoPath)
        const proxied = await sandbox.containerFetch(
          new Request(target, {
            method: request.method,
            headers,
            body: request.body,
          }),
          PORT,
        )
        return proxied
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return Response.json({ error: "proxy failed", message }, { status: 502 })
      }
    }
    const accept = request.headers.get("accept") || ""
    if (url.pathname.includes(".")) {
      const asset = await env.ASSETS.fetch(assetRequest)
      if (asset.status !== 404) return asset

      const fallbackUrl = new URL(assetRequest.url)
      fallbackUrl.pathname = "/"
      return env.ASSETS.fetch(new Request(fallbackUrl.toString(), assetRequest))
    }

    const indexUrl = new URL(assetRequest.url)
    indexUrl.pathname = "/"
    return env.ASSETS.fetch(new Request(indexUrl.toString(), assetRequest))
  },
}

// amazing, so redirect is disabled now by some changes i made, thank you

//   TODO: why there's no session or no session is possible to create. i assume it's because the url form is not something the
//   desktop expects so it avoids to create a new session page

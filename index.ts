import { Plugin } from "@opencode/plugin"

// Self-heal for Responses-style reasoning continuation failures:
//
// - `reasoning encrypted_content was not issued to this caller`
// - `invalid_encrypted_content` / `could not be verified`
// - `Referenced reasoning item 'rs_..:rs_..' was not found or has expired`
//
// Seen on Gateway Console free models (e.g. muse-spark-1.3-contributor-free,
// 2-3 message sessions) and on Responses API with `store: false` after a few
// tool turns. Same family of fixes as upstream PR #28678 (don't replay `rs_*`
// ids when stateless) and PR #29000 (summary splitting, encrypted replay,
// `item_reference` when stored).
//
// Strategy:
// 1. `context`/`compaction`/`generate`: force stateless full replay
//    (drop `previous_response_id`, force `store: false`), drop
//    `include: reasoning.encrypted_content`, always strip server-issued ids
//    from metadata, keep at most 1 newest encrypted blob.
// 2. `retry`: on matching errors, flag the session so the next request goes
//    out with NO reasoning at all (fresh reasoning), then allow 1 retry.

const FLAG_PREFIX = "rs-guard/strip/"

function isContinuationError(message: string): boolean {
  const m = (message ?? "").toLowerCase()
  return (
    m.includes("encrypted_content") ||
    m.includes("invalid_encrypted_content") ||
    m.includes("was not issued to this caller") ||
    m.includes("could not be verified") ||
    m.includes("was not found or has expired") ||
    m.includes("referenced reasoning") ||
    m.includes("reasoning item") ||
    m.includes("previous_response") ||
    m.includes("previous response") ||
    m.includes("item_reference")
  )
}

// Server-issued continuation ids live in metadata keys only — never touch the
// local `id` of a part, so tool-call/tool-result pairing stays intact.
const SERVER_ID_KEYS = new Set([
  "itemid",
  "item_id",
  "previous_response_id",
  "previousresponseid",
  "response_id",
  "responseid",
])

function isServerItemId(value: unknown): boolean {
  return typeof value === "string" && /^[A-Za-z]+_[A-Za-z0-9][A-Za-z0-9:_-]*$/.test(value)
}

// Remove ONLY server ids (leave encrypted blobs alone) — used on the normal
// path so lowering can't build an expired `item_reference`.
function stripServerIdsOnly(obj: any): boolean {
  if (!obj || typeof obj !== "object") return false
  let stripped = false
  const containers: any[] = [obj?.metadata, obj?.providerMetadata, obj?.providerOptions]
  for (const c of [obj?.providerMetadata, obj?.providerOptions]) {
    if (c && typeof c === "object") {
      for (const v of Object.values(c)) containers.push(v)
    }
  }
  for (const c of containers) {
    if (!c || typeof c !== "object") continue
    for (const k of Object.keys(c)) {
      if (SERVER_ID_KEYS.has(k.toLowerCase()) && isServerItemId((c as any)[k])) {
        delete (c as any)[k]
        stripped = true
      }
    }
  }
  return stripped
}

// Remove encrypted blobs AND server ids from one part/message object.
function stripEncryptedKeys(obj: any): boolean {
  if (!obj || typeof obj !== "object") return false
  let stripped = false
  const containers: any[] = [obj, obj?.metadata, obj?.providerMetadata, obj?.providerOptions]
  // Native continuation metadata is sometimes nested one level deeper.
  for (const c of [obj?.providerMetadata, obj?.providerOptions]) {
    if (c && typeof c === "object") {
      for (const v of Object.values(c)) containers.push(v)
    }
  }
  for (const c of containers) {
    if (!c || typeof c !== "object") continue
    for (const k of Object.keys(c)) {
      const lk = k.toLowerCase()
      if (lk.includes("encrypt")) {
        delete (c as any)[k]
        stripped = true
      }
      if (c !== obj && SERVER_ID_KEYS.has(lk) && isServerItemId((c as any)[k])) {
        delete (c as any)[k]
        stripped = true
      }
      if (c !== obj && lk === "itemid" && typeof (c as any)[k] === "string" && (c as any)[k].startsWith("rs_")) {
        delete (c as any)[k]
        stripped = true
      }
    }
  }
  // Native Responses shape: { type: "reasoning", encrypted_content: "..." } on the part itself.
  for (const k of Object.keys(obj)) {
    if (k.toLowerCase().includes("encrypt")) {
      delete obj[k]
      stripped = true
    }
  }
  return stripped
}

function hasEncrypted(obj: any): boolean {
  if (!obj || typeof obj !== "object") return false
  const seen = new Set<any>()
  const stack: any[] = [obj]
  while (stack.length) {
    const cur = stack.pop()
    if (!cur || typeof cur !== "object" || seen.has(cur)) continue
    seen.add(cur)
    for (const [k, v] of Object.entries(cur)) {
      if (k.toLowerCase().includes("encrypt") && typeof v === "string" && v.length > 0) return true
      if (v && typeof v === "object") stack.push(v)
    }
  }
  return false
}

function getParts(msg: any): any[] | undefined {
  if (!msg || typeof msg !== "object") return undefined
  if (Array.isArray((msg as any).parts)) return (msg as any).parts
  if (Array.isArray((msg as any).content)) return (msg as any).content
  if (msg.info && typeof msg.info === "object" && Array.isArray((msg as any).parts)) return (msg as any).parts
  // A bare part rather than a message.
  if (typeof (msg as any).type === "string") return [msg]
  return undefined
}

function stripInclude(options: any) {
  if (!options || typeof options !== "object") return
  if (Array.isArray((options as any).include)) {
    ;(options as any).include = (options as any).include.filter(
      (v: any) => typeof v !== "string" || !v.toLowerCase().includes("encrypt"),
    )
    if ((options as any).include.length === 0) delete (options as any).include
  }
  // Provider-scoped: options.openai.include / options.azure.include / etc.
  for (const v of Object.values(options)) {
    if (v && typeof v === "object") stripInclude(v)
  }
}

export default Plugin.define({
  id: "rs-guard",
  async setup(ctx) {
    const stripAllReasoning = (messages: any[]) => {
      for (const msg of messages) {
        const parts = getParts(msg)
        if (!parts || (parts.length === 1 && parts[0] === msg)) {
          stripEncryptedKeys(msg)
          continue
        }
        const kept = parts.filter((p: any) => p?.type !== "reasoning")
        for (const p of kept) stripEncryptedKeys(p)
        // Drop message-level server ids so they can't become item_reference.
        if (msg && typeof msg === "object") {
          for (const k of Object.keys(msg)) {
            if (SERVER_ID_KEYS.has(k.toLowerCase()) && isServerItemId((msg as any)[k])) {
              delete (msg as any)[k]
            }
          }
          if (msg.providerMetadata && typeof msg.providerMetadata === "object") {
            for (const ns of Object.values(msg.providerMetadata as any)) {
              if (!ns || typeof ns !== "object") continue
              for (const k of Object.keys(ns as any)) {
                if (SERVER_ID_KEYS.has(k.toLowerCase()) && isServerItemId((ns as any)[k])) {
                  delete (ns as any)[k]
                }
              }
            }
          }
        }
        if (Array.isArray((msg as any).parts)) (msg as any).parts = kept
        else if (Array.isArray((msg as any).content)) (msg as any).content = kept
      }
    }

    const handleContext = async (event: any) => {
      try {
        stripInclude(event?.options)
        // Force stateless full replay: no previous_response_id, no store.
        // Prevents the upstream from resolving item_reference to expired ids.
        const dropContinuation = (o: any, depth = 0) => {
          if (!o || typeof o !== "object" || depth > 4) return
          for (const k of Object.keys(o)) {
            const lk = k.toLowerCase()
            if (
              lk === "previous_response_id" ||
              lk === "previousresponseid" ||
              lk === "conversation" ||
              lk === "response_id" ||
              lk === "responseid"
            ) {
              delete (o as any)[k]
              continue
            }
            if (lk === "store") {
              ;(o as any)[k] = false
              continue
            }
            const v = (o as any)[k]
            if (v && typeof v === "object") dropContinuation(v, depth + 1)
          }
        }
        dropContinuation(event?.options)
        const messages: any[] = Array.isArray(event?.messages) ? event.messages : []
        if (!messages.length) return

        // Self-heal mode: the next request after a continuation error goes
        // out with no reasoning at all.
        const flagKey = `${FLAG_PREFIX}${event?.sessionID ?? "unknown"}`
        let stripAll = false
        try {
          stripAll = (await ctx.storage.get(flagKey)) === true
          if (stripAll) await ctx.storage.remove(flagKey)
        } catch {
          stripAll = false
        }
        if (stripAll) {
          stripAllReasoning(messages)
          return
        }

        // Normal path: keep at most 1 newest encrypted blob, but ALWAYS
        // strip server ids from every part so lowering can't item_reference.
        for (const msg of messages) {
          const parts = getParts(msg)
          if (!parts || (parts.length === 1 && parts[0] === msg)) {
            stripServerIdsOnly(msg)
            continue
          }
          for (const p of parts) stripServerIdsOnly(p)
        }
        const hits: Array<{ part: any }> = []
        for (const msg of messages) {
          const parts = getParts(msg)
          if (!parts) continue
          if (parts.length === 1 && parts[0] === msg) {
            if (hasEncrypted(msg)) hits.push({ part: msg })
            continue
          }
          for (const p of parts) {
            if (hasEncrypted(p)) hits.push({ part: p })
          }
        }
        if (hits.length <= 1) return
        for (let i = 0; i < hits.length - 1; i++) stripEncryptedKeys(hits[i].part)
      } catch (e) {
        console.error("[rs-guard] context hook failed:", e)
      }
    }

    await ctx.session.hook("context", handleContext as any)
    await ctx.session.hook("compaction", handleContext as any)
    await ctx.session.hook("generate", handleContext as any)

    await ctx.session.hook("retry", (async (event: any) => {
      try {
        if (!isContinuationError(String(event?.error?.message ?? ""))) return
        if (event?.attempt >= 3) {
          event.decision = { retry: false }
          return
        }
        const sessionID = (event as any)?.sessionID
        if (sessionID) {
          try {
            await ctx.storage.set(`${FLAG_PREFIX}${sessionID}`, true)
          } catch {}
        }
        event.decision = { retry: true, delay: 0 }
      } catch (e) {
        console.error("[rs-guard] retry hook failed:", e)
      }
    }) as any)
  },
})

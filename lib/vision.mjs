// Image description bridge for the free lane.
//
// The free NodeCode model is text-only, so NodeCode's own `(look ...)` helper
// cannot attach an image.  The plugin can still "see" through a vision model
// exposed by magpie: the model calls `look` through (magpie-tool ...), this
// module sends the image to the local magpie gateway, and the returned
// description is fed back as an ordinary tool result.

import { createHash } from "node:crypto"
import { readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { extname, isAbsolute, join, resolve } from "node:path"

export const DEFAULT_VISION_MODELS = [
  "group/auto-deepseek-flash",
  "auto/gpt-6.1-sol",
  "auto/gemini-3.8-flash",
]
export const DEFAULT_VISION_MODEL = DEFAULT_VISION_MODELS[0]
export const DEFAULT_VISION_BASE_URL = "http://127.0.0.1:3425/v1"
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
export const MAX_VISION_RESULT_CHARS = 12_000
export const DEFAULT_MAX_BRIDGED_IMAGES = 4
export const LOOK_CACHE_DEFAULT_SIZE = 32
export const LOOK_CACHE_MAX_SIZE = 512
export const VISION_ATTEMPTS_PER_MODEL = 2

const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"])
const IMAGE_PART_TYPES = new Set(["image_url", "input_image", "image"])
export const DEFAULT_IMAGE_PROMPT =
  "Describe this image for a software agent. Transcribe every visible piece of text exactly, " +
  "then describe the layout, UI elements, colors, and details that matter for the task. " +
  "Do not invent content that is not visible."

const MIME_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
}

function trim(value) {
  return typeof value === "string" ? value.trim() : ""
}

// Descriptions of the same image (same path/size/mtime, same question) are
// reused: agents tend to look at one screenshot from several turns.
const LOOK_CACHE = new Map()

/** How many descriptions to remember; 0 disables the cache. */
export function lookCacheSize(env = process.env) {
  const flag = trim(env.NODECODE_VISION_CACHE).toLowerCase()
  if (flag === "0" || flag === "false" || flag === "off" || flag === "no") return 0
  const size = Number(env.NODECODE_VISION_CACHE_SIZE)
  if (Number.isFinite(size) && size >= 0) return Math.min(Math.floor(size), LOOK_CACHE_MAX_SIZE)
  return LOOK_CACHE_DEFAULT_SIZE
}

export function clearLookCache() {
  LOOK_CACHE.clear()
}

function cacheKey(image, question) {
  let identity = ""
  if (image.path) identity = `file:${image.path}:${image.size ?? 0}:${image.mtimeMs ?? 0}`
  else if (image.url) identity = `url:${image.url}`
  else if (image.dataUrl) identity = `data:${createHash("sha1").update(image.dataUrl).digest("hex")}`
  if (!identity) return ""
  return `${identity}|${question}`
}

function cacheGet(key) {
  if (!key || !LOOK_CACHE.has(key)) return undefined
  const value = LOOK_CACHE.get(key)
  LOOK_CACHE.delete(key)
  LOOK_CACHE.set(key, value)
  return value
}

function cacheSet(key, value, limit) {
  if (!key || limit <= 0) return
  LOOK_CACHE.delete(key)
  LOOK_CACHE.set(key, value)
  while (LOOK_CACHE.size > limit) LOOK_CACHE.delete(LOOK_CACHE.keys().next().value)
}

function withoutTrailingSlash(value) {
  return String(value).replace(/\/+$/, "")
}

/**
 * Resolve the local gateway and model used for image description.
 *
 * `MAGPIE_ADDR` is the address the host is already listening on, so a plugin
 * running inside magpie can reuse it without another configuration knob.
 */
export function visionConfig(env = process.env) {
  let baseUrl = trim(env.NODECODE_VISION_BASE_URL) || trim(env.MAGPIE_GATEWAY_URL)
  if (!baseUrl && trim(env.MAGPIE_ADDR)) {
    const address = trim(env.MAGPIE_ADDR).replace(/^https?:\/\//, "")
    baseUrl = `http://${address}`
  }
  baseUrl = withoutTrailingSlash(baseUrl || DEFAULT_VISION_BASE_URL)
  if (!/\/v1$/.test(baseUrl)) baseUrl += "/v1"
  const timeout = Number(env.NODECODE_VISION_TIMEOUT_MS)
  const configured = trim(env.NODECODE_VISION_MODEL)
  const models = configured ? [configured] : [...DEFAULT_VISION_MODELS]
  return {
    baseUrl,
    model: models[0],
    models,
    apiKey: trim(env.NODECODE_VISION_API_KEY) || trim(env.MAGPIE_GATEWAY_KEY),
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 30_000,
  }
}

/** Expand a user path and resolve it against the agent workspace. */
export function resolveImagePath(value, cwd = process.cwd()) {
  const raw = trim(value)
  if (!raw) throw new Error("look needs a non-empty image path")
  if (raw === "~") return homedir()
  const expanded = raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw
  return isAbsolute(expanded) ? expanded : resolve(cwd || process.cwd(), expanded)
}

/** Detect the image type from magic bytes, falling back to the extension. */
export function imageMime(buffer, path = "") {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return ""
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return "image/png"
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg"
  }
  if (buffer.length >= 6) {
    const head = buffer.toString("ascii", 0, 6)
    if (head === "GIF87a" || head === "GIF89a") return "image/gif"
  }
  if (
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp"
  }
  return MIME_BY_EXT[extname(path).toLowerCase()] || ""
}

/** Read one local image and enforce the same 5 MiB limit as NodeCode's look. */
export function readImage(value, { cwd = process.cwd(), maxBytes = MAX_IMAGE_BYTES } = {}) {
  const path = resolveImagePath(value, cwd)
  let stat
  try {
    stat = statSync(path)
  } catch {
    throw new Error(`cannot read image ${path}: file does not exist`)
  }
  if (!stat.isFile()) throw new Error(`cannot read image ${path}: not a regular file`)
  if (stat.size > maxBytes) {
    throw new Error(`cannot read image ${path}: ${stat.size} bytes exceeds ${maxBytes} byte limit`)
  }
  const buffer = readFileSync(path)
  const mime = imageMime(buffer, path)
  if (!mime) {
    throw new Error(`cannot read image ${path}: expected PNG, JPEG, GIF or WebP`)
  }
  return {
    path,
    mime,
    bytes: buffer.length,
    base64: buffer.toString("base64"),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  }
}

/** Extract path/prompt from either a JSON object or a plain path string. */
export function parseLookArguments(value) {
  let args = value
  if (typeof value === "string") {
    const text = value.trim()
    if (!text) return null
    try {
      args = JSON.parse(text)
    } catch {
      return { path: text }
    }
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) return null
  const path = args.path ?? args.file ?? args.image ?? args.image_path ?? args.imagePath
  if (typeof path !== "string" || !path.trim()) return null
  const prompt = args.prompt ?? args.question ?? args.instruction ?? args.text
  return {
    path: path.trim(),
    ...(typeof prompt === "string" && prompt.trim() ? { prompt: prompt.trim() } : {}),
  }
}

/** Parse a `data:image/*;base64,...` URL and estimate the decoded size. */
export function parseDataUrl(value) {
  const text = trim(value)
  if (!/^data:/i.test(text)) return null
  const comma = text.indexOf(",")
  if (comma < 0) throw new Error("image data URL has no comma")
  const header = text.slice(5, comma)
  const payload = text.slice(comma + 1)
  const base64 = /;base64/i.test(header)
  if (!base64) throw new Error("image data URL must be base64 encoded")
  const mime = header.split(";")[0].toLowerCase()
  const compact = payload.replace(/\s+/g, "")
  const padding = compact.endsWith("==") ? 2 : compact.endsWith("=") ? 1 : 0
  const bytes = Math.floor((compact.length * 3) / 4) - padding
  return { mime, base64: compact, bytes, dataUrl: text }
}

/**
 * Normalize one image reference from any client shape into a URL the vision
 * model can consume: an http(s) URL, a data URL, or a local file path.
 */
export function imageSource(value, { cwd = process.cwd(), maxBytes = MAX_IMAGE_BYTES } = {}) {
  let raw = value
  if (raw && typeof raw === "object") {
    raw = raw.url ?? raw.image_url ?? raw.dataUrl ?? raw.data ?? raw.path ?? raw.file ?? raw.image
  }
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error("image part has no usable url or path")
  }
  const text = raw.trim()
  if (/^data:/i.test(text)) {
    const parsed = parseDataUrl(text)
    if (!IMAGE_MIME_TYPES.has(parsed.mime)) {
      throw new Error(`unsupported image type ${parsed.mime || "unknown"}`)
    }
    if (parsed.bytes > maxBytes) {
      throw new Error(`image is ${parsed.bytes} bytes, exceeds ${maxBytes} byte limit`)
    }
    return { dataUrl: parsed.dataUrl, mime: parsed.mime, bytes: parsed.bytes }
  }
  if (/^https?:\/\//i.test(text)) {
    return { url: text, mime: "", bytes: 0 }
  }
  if (text.startsWith("file://")) {
    let path = text
    try {
      path = decodeURIComponent(new URL(text).pathname)
    } catch {
      path = text.slice("file://".length)
    }
    const image = readImage(path, { cwd, maxBytes })
    return {
      dataUrl: `data:${image.mime};base64,${image.base64}`,
      mime: image.mime,
      bytes: image.bytes,
      path: image.path,
      size: image.size,
      mtimeMs: image.mtimeMs,
    }
  }
  const image = readImage(text, { cwd, maxBytes })
  return {
    dataUrl: `data:${image.mime};base64,${image.base64}`,
    mime: image.mime,
    bytes: image.bytes,
    path: image.path,
    size: image.size,
    mtimeMs: image.mtimeMs,
  }
}

function imagePartSource(part) {
  if (!part || typeof part !== "object") return null
  const direct = part.image_url ?? part.image ?? part.url ?? part.data ?? part.path ?? part.file
  if (typeof direct === "string" && direct.trim()) return direct
  if (direct && typeof direct === "object") {
    const nested = direct.url ?? direct.dataUrl ?? direct.data ?? direct.path
    if (typeof nested === "string" && nested.trim()) return nested
  }
  const source = part.source
  if (source && typeof source === "object") {
    if (source.data && source.type === "base64") {
      const mime = typeof source.media_type === "string" ? source.media_type : "image/png"
      return `data:${mime};base64,${source.data}`
    }
    const nested = source.url ?? source.dataUrl ?? source.data ?? source.path
    if (typeof nested === "string" && nested.trim()) return nested
  }
  return null
}

/**
 * Replace image parts in a chat transcript with vision-model descriptions.
 *
 * The free NodeCode model is text-only, so native image parts would otherwise
 * be dropped or rejected.  Failures degrade into an `[image unavailable: ...]`
 * text part so the request still reaches the model.
 */
export async function bridgeImages(messages, options = {}) {
  const {
    cwd = process.cwd(),
    describe = describeImage,
    prompt,
    config,
    maxImages = DEFAULT_MAX_BRIDGED_IMAGES,
    maxBytes = MAX_IMAGE_BYTES,
  } = options
  if (!Array.isArray(messages)) return { messages, images: 0, failures: 0 }
  const out = []
  let images = 0
  let failures = 0
  for (const message of messages) {
    const content = message?.content
    if (!Array.isArray(content)) {
      out.push(message)
      continue
    }
    const parts = []
    for (const part of content) {
      const isImage = part && typeof part === "object" && IMAGE_PART_TYPES.has(part.type)
      if (!isImage) {
        parts.push(part)
        continue
      }
      const label = images + 1
      if (images >= maxImages) {
        parts.push({ type: "text", text: `[image ${label} skipped: at most ${maxImages} images]` })
        continue
      }
      images += 1
      try {
        const source = imagePartSource(part)
        const description = await describe({
          url: source,
          path: source,
          dataUrl: source,
          prompt,
          cwd,
          config,
          maxBytes,
        })
        parts.push({ type: "text", text: `[image ${images}: ${description}]` })
      } catch (error) {
        failures += 1
        parts.push({ type: "text", text: `[image ${images} unavailable: ${error.message}]` })
      }
    }
    out.push({ ...message, content: parts })
  }
  return { messages: out, images, failures }
}

function contentOf(message) {
  const content = message?.content
  if (typeof content === "string") return content.trim()
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : part?.text ?? ""))
      .filter(Boolean)
      .join("\n")
      .trim()
  }
  return ""
}

/**
 * Ask a vision model to describe one local image.
 *
 * The OpenAI image_url shape works with magpie's gateway, which routes the
 * request to a provider that supports image input.  By default several vision
 * models are tried in order because individual gateway routes can disappear.
 */
export async function describeImage({
  path,
  url,
  dataUrl,
  data,
  mime,
  prompt,
  cwd = process.cwd(),
  config = visionConfig(),
  fetchImpl = globalThis.fetch,
  maxBytes = MAX_IMAGE_BYTES,
} = {}) {
  const reference =
    url ?? dataUrl ?? data ?? path ?? (mime ? `data:${mime};base64,` : undefined)
  const image = imageSource(reference, { cwd, maxBytes })
  const imageUrl = image.url ?? image.dataUrl
  const question = trim(prompt) || DEFAULT_IMAGE_PROMPT
  const models =
    Array.isArray(config.models) && config.models.length > 0
      ? config.models
      : [config.model || DEFAULT_VISION_MODEL]
  const headers = { "content-type": "application/json" }
  if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`
  const failures = []
  const limit = Number.isFinite(config.cacheSize) ? config.cacheSize : lookCacheSize()
  const key = limit > 0 ? cacheKey(image, question) : ""
  const cached = cacheGet(key)
  if (cached !== undefined) return cached

  for (const model of models) {
    const body = {
      model,
      stream: false,
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: question },
            {
              type: "image_url",
              image_url: { url: imageUrl },
            },
          ],
        },
      ],
    }
    let timedOut = false
    let lastError = null
    for (let attempt = 0; attempt < VISION_ATTEMPTS_PER_MODEL; attempt += 1) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), config.timeoutMs)
      try {
        const response = await fetchImpl(`${config.baseUrl}/chat/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        })
        const raw = await response.text()
        if (!response.ok) {
          const error = new Error(`HTTP ${response.status}: ${raw.slice(0, 300)}`)
          error.status = response.status
          throw error
        }
        let data
        try {
          data = JSON.parse(raw)
        } catch {
          throw new Error("returned invalid JSON")
        }
        const text = contentOf(data?.choices?.[0]?.message)
        if (!text) throw new Error("returned no description")
        const answer =
          text.length > MAX_VISION_RESULT_CHARS
            ? `${text.slice(0, MAX_VISION_RESULT_CHARS)}\n[truncated by nodecode-magpie]`
            : text
        cacheSet(key, answer, limit)
        return answer
      } catch (error) {
        if (controller.signal.aborted) {
          timedOut = true
          failures.push(`${model}: timed out after ${config.timeoutMs}ms`)
          break
        }
        // A gateway route that is briefly restarting answers 429/5xx or drops
        // the connection: one extra try beats failing the whole look.
        if (attempt + 1 < VISION_ATTEMPTS_PER_MODEL && isTransientVisionError(error)) {
          lastError = null
          await new Promise((r) => setTimeout(r, 150))
          continue
        }
        lastError = error
        break
      } finally {
        clearTimeout(timer)
      }
    }
    if (timedOut) break
    if (lastError) failures.push(`${model}: ${lastError.message}`)
  }

  throw new Error(`vision model failed (${failures.join("; ")})`)
}

function isTransientVisionError(error) {
  const status = error?.status
  if (status === undefined) return true
  return status === 429 || status >= 500
}

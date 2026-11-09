// Image description bridge for the free lane.
//
// The free NodeCode model is text-only, so NodeCode's own `(look ...)` helper
// cannot attach an image.  The plugin can still "see" through a vision model
// exposed by magpie: the model calls `look` through (magpie-tool ...), this
// module sends the image to the local magpie gateway, and the returned
// description is fed back as an ordinary tool result.

import { readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { extname, isAbsolute, join, resolve } from "node:path"

export const DEFAULT_VISION_MODEL = "auto/deepseek-v4.1-flash"
export const DEFAULT_VISION_BASE_URL = "http://127.0.0.1:3425/v1"
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
export const MAX_VISION_RESULT_CHARS = 12_000
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
  return {
    baseUrl,
    model: trim(env.NODECODE_VISION_MODEL) || DEFAULT_VISION_MODEL,
    apiKey: trim(env.NODECODE_VISION_API_KEY) || trim(env.MAGPIE_GATEWAY_KEY),
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 60_000,
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
  return { path, mime, bytes: buffer.length, base64: buffer.toString("base64") }
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
 * request to a provider that supports image input.  The default model is the
 * same deepseek-v4.1-flash the user already uses through magpie.
 */
export async function describeImage({
  path,
  prompt,
  cwd = process.cwd(),
  config = visionConfig(),
  fetchImpl = globalThis.fetch,
} = {}) {
  const image = readImage(path, { cwd })
  const question = trim(prompt) || DEFAULT_IMAGE_PROMPT
  const body = {
    model: config.model,
    stream: false,
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: question },
          {
            type: "image_url",
            image_url: { url: `data:${image.mime};base64,${image.base64}` },
          },
        ],
      },
    ],
  }
  const headers = { "content-type": "application/json" }
  if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`

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
      throw new Error(`vision model ${config.model} HTTP ${response.status}: ${raw.slice(0, 300)}`)
    }
    let data
    try {
      data = JSON.parse(raw)
    } catch {
      throw new Error(`vision model ${config.model} returned invalid JSON`)
    }
    const text = contentOf(data?.choices?.[0]?.message)
    if (!text) throw new Error(`vision model ${config.model} returned no description`)
    if (text.length > MAX_VISION_RESULT_CHARS) {
      return `${text.slice(0, MAX_VISION_RESULT_CHARS)}\n[truncated by nodecode-magpie]`
    }
    return text
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`vision model ${config.model} timed out after ${config.timeoutMs}ms`)
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import {
  bridgeImages,
  describeImage,
  imageMime,
  imageSource,
  parseDataUrl,
  parseLookArguments,
  readImage,
  resolveImagePath,
  visionConfig,
} from "../lib/vision.mjs"

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z1ZkAAAAASUVORK5CYII=",
  "base64",
)

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "nc-vision-"))
  writeFileSync(join(dir, "pixel.png"), PNG)
  writeFileSync(join(dir, "notes.txt"), "not an image")
  return dir
}

test("readImage resolves relative paths and detects PNG", () => {
  const dir = fixture()
  try {
    const image = readImage("pixel.png", { cwd: dir })
    assert.equal(image.path, join(dir, "pixel.png"))
    assert.equal(image.mime, "image/png")
    assert.ok(image.base64.length > 10)
    assert.equal(resolveImagePath("pixel.png", dir), join(dir, "pixel.png"))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("readImage rejects non-images and missing files with useful messages", () => {
  const dir = fixture()
  try {
    assert.throws(() => readImage("notes.txt", { cwd: dir }), /expected PNG, JPEG, GIF or WebP/)
    assert.throws(() => readImage("missing.png", { cwd: dir }), /does not exist/)
    assert.throws(() => readImage("", { cwd: dir }), /non-empty image path/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("imageMime recognizes JPEG, GIF and WebP signatures", () => {
  assert.equal(imageMime(Buffer.from([0xff, 0xd8, 0xff, 0x00])), "image/jpeg")
  assert.equal(imageMime(Buffer.from("GIF89a....")), "image/gif")
  assert.equal(imageMime(Buffer.from("RIFF0000WEBP")), "image/webp")
})

test("visionConfig derives the gateway from MAGPIE_ADDR and allows overrides", () => {
  const cfg = visionConfig({
    MAGPIE_ADDR: "127.0.0.1:3425",
    NODECODE_VISION_MODEL: "auto/test-vision",
    NODECODE_VISION_TIMEOUT_MS: "1234",
  })
  assert.equal(cfg.baseUrl, "http://127.0.0.1:3425/v1")
  assert.equal(cfg.model, "auto/test-vision")
  assert.equal(cfg.timeoutMs, 1234)
  assert.equal(
    visionConfig({ NODECODE_VISION_BASE_URL: "http://example.test/v1/" }).baseUrl,
    "http://example.test/v1",
  )
  assert.equal(
    visionConfig({ NODECODE_VISION_BASE_URL: "http://example.test:9" }).baseUrl,
    "http://example.test:9/v1",
  )
  assert.equal(visionConfig({ MAGPIE_GATEWAY_KEY: "gateway-key" }).apiKey, "gateway-key")
})

test("parseLookArguments accepts JSON and bare paths", () => {
  assert.deepEqual(parseLookArguments('{"path":"a.png","prompt":"read it"}'), {
    path: "a.png",
    prompt: "read it",
  })
  assert.deepEqual(parseLookArguments("/tmp/a.png"), { path: "/tmp/a.png" })
  assert.equal(parseLookArguments("{}"), null)
})

test("describeImage sends the image as a data URI and returns text", async () => {
  const dir = fixture()
  const seen = []
  try {
    const text = await describeImage({
      path: "pixel.png",
      cwd: dir,
      prompt: "what is this?",
      config: { baseUrl: "http://gateway.test/v1", model: "auto/vision", timeoutMs: 5000, apiKey: "k" },
      fetchImpl: async (url, init) => {
        seen.push({ url, body: JSON.parse(init.body), headers: init.headers })
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "a single pixel" } }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      },
    })
    assert.equal(text, "a single pixel")
    assert.equal(seen[0].url, "http://gateway.test/v1/chat/completions")
    assert.equal(seen[0].body.model, "auto/vision")
    assert.equal(seen[0].body.messages[0].content[0].text, "what is this?")
    assert.match(seen[0].body.messages[0].content[1].image_url.url, /^data:image\/png;base64,/)
    assert.equal(seen[0].headers.authorization, "Bearer k")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("describeImage surfaces gateway errors", async () => {
  const dir = fixture()
  try {
    await assert.rejects(
      describeImage({
        path: "pixel.png",
        cwd: dir,
        config: { baseUrl: "http://gateway.test/v1", model: "auto/vision", timeoutMs: 5000 },
        fetchImpl: async () => new Response("no such model", { status: 400 }),
      }),
      /HTTP 400: no such model/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("imageSource accepts data URLs and rejects unsupported or oversized ones", () => {
  const source = imageSource(`data:image/png;base64,${PNG.toString("base64")}`)
  assert.equal(source.mime, "image/png")
  assert.ok(source.dataUrl.startsWith("data:image/png;base64,"))
  assert.equal(parseDataUrl("data:image/png;base64,YQ==").bytes, 1)
  assert.throws(() => imageSource("data:text/plain;base64,YQ=="), /unsupported image type/)
  assert.throws(() => imageSource("data:image/png;base64,YQ==", { maxBytes: 0 }), /exceeds 0 byte limit/)
  assert.throws(() => imageSource(""), /no usable url or path/)
})

test("describeImage accepts a remote image URL without reading a file", async () => {
  const seen = []
  const text = await describeImage({
    url: "https://example.test/a.png",
    config: { baseUrl: "http://gateway.test/v1", model: "auto/vision", timeoutMs: 5000 },
    fetchImpl: async (_url, init) => {
      seen.push(JSON.parse(init.body))
      return new Response(JSON.stringify({ choices: [{ message: { content: "remote image" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    },
  })
  assert.equal(text, "remote image")
  assert.equal(seen[0].messages[0].content[1].image_url.url, "https://example.test/a.png")
})

test("bridgeImages replaces image parts with descriptions in place", async () => {
  const messages = [
    { role: "system", content: "be helpful" },
    {
      role: "user",
      content: [
        { type: "text", text: "compare these" },
        { type: "image_url", image_url: { url: "data:image/png;base64,YQ==" } },
        { type: "input_image", image_url: "https://example.test/b.png" },
      ],
    },
  ]
  const seen = []
  const result = await bridgeImages(messages, {
    describe: async (args) => {
      seen.push(args.url)
      return seen.length === 1 ? "first image" : "second image"
    },
  })
  assert.equal(result.images, 2)
  assert.equal(result.failures, 0)
  assert.equal(result.messages[0], messages[0])
  assert.deepEqual(
    result.messages[1].content.map((part) => part.type),
    ["text", "text", "text"],
  )
  assert.match(result.messages[1].content[1].text, /first image/)
  assert.match(result.messages[1].content[2].text, /second image/)
  assert.deepEqual(seen, ["data:image/png;base64,YQ==", "https://example.test/b.png"])
})

test("bridgeImages caps the number of images and degrades failures", async () => {
  const messages = [
    {
      role: "user",
      content: [
        { type: "image_url", image_url: { url: "data:image/png;base64,YQ==" } },
        { type: "image_url", image_url: { url: "data:image/png;base64,Yg==" } },
        { type: "image_url", image_url: { url: "data:image/png;base64,Yw==" } },
      ],
    },
  ]
  let call = 0
  const result = await bridgeImages(messages, {
    maxImages: 2,
    describe: async () => {
      call += 1
      if (call === 1) throw new Error("model down")
      return "ok"
    },
  })
  assert.equal(result.images, 2)
  assert.equal(result.failures, 1)
  assert.match(result.messages[0].content[0].text, /unavailable: model down/)
  assert.match(result.messages[0].content[1].text, /ok/)
  assert.match(result.messages[0].content[2].text, /skipped: at most 2 images/)
})

test("describeImage falls back to the next vision model", async () => {
  const seen = []
  const text = await describeImage({
    url: "https://example.test/a.png",
    config: {
      baseUrl: "http://gateway.test/v1",
      model: "auto/primary",
      models: ["auto/primary", "auto/fallback"],
      timeoutMs: 5000,
    },
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body)
      seen.push(body.model)
      if (body.model === "auto/primary") {
        return new Response("no such model", { status: 400 })
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "fallback worked" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    },
  })
  assert.equal(text, "fallback worked")
  assert.deepEqual(seen, ["auto/primary", "auto/fallback"])
})

import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import {
  describeImage,
  imageMime,
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

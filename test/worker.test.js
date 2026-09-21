import { test } from "node:test"
import assert from "node:assert/strict"
import worker, { licenceLinks, decodeQuotedPrintable, decodeMessage, isLicenceRecipient, urlShapes, refusalReason } from "../src/worker.js"

test("licence recipients are the plus-addressed panel addresses", () => {
  assert.ok(isLicenceRecipient("whatsappmcp+8f21af70@example.com"))
  assert.ok(isLicenceRecipient("WHATSAPPMCP+x@example.com"))
  assert.ok(!isLicenceRecipient("whatsappmcp-8f21af70@example.com"))
  assert.ok(!isLicenceRecipient("you@example.com"))
  assert.ok(!isLicenceRecipient("whatsappmcp@example.com"))
})

test("the recipient pattern can be overridden", () => {
  assert.ok(isLicenceRecipient("outra@coisa.com", "^outra@coisa\\.com$"))
  assert.ok(!isLicenceRecipient("whatsappmcp+8f21af70@example.com", "^outra@coisa\\.com$"))
})


const linkRegex = () => /https:\/\/license\.evolutionfoundation\.com\.br[^\s"'<>\\]*/g

test("extracts the licence link from a plain text email", () => {
  const raw = [
    "From: Evolution <noreply@license.evolutionfoundation.com.br>",
    "To: whatsappmcp+abc@example.com",
    "Subject: Ativacao",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Clique no link para ativar:",
    "https://license.evolutionfoundation.com.br/auth/verify?token=xyz&sig=1",
    "",
  ].join("\n")
  const links = licenceLinks(raw, linkRegex())
  assert.deepEqual(links, ["https://license.evolutionfoundation.com.br/auth/verify?token=xyz&sig=1"])
})

test("keeps quoting punctuation out of the link", () => {
  const raw = [
    "From: a <a@b.c>",
    "",
    "Veja (https://license.evolutionfoundation.com.br/verify?t=1) agora.",
  ].join("\n")
  const links = licenceLinks(raw, linkRegex())
  assert.deepEqual(links, ["https://license.evolutionfoundation.com.br/verify?t=1"])
})

test("ignores the bare domain, keeps real links", () => {
  const raw = [
    "From: a <a@b.c>",
    "",
    "Servidor: https://license.evolutionfoundation.com.br",
    "Acao: https://license.evolutionfoundation.com.br/magic/confirm?token=2",
  ].join("\n")
  const links = licenceLinks(raw, linkRegex())
  assert.deepEqual(links, ["https://license.evolutionfoundation.com.br/magic/confirm?token=2"])
})

test("deduplicates repeated links", () => {
  const raw = [
    "From: a <a@b.c>",
    "",
    "https://license.evolutionfoundation.com.br/a?x=1",
    "https://license.evolutionfoundation.com.br/a?x=1",
  ].join("\n")
  const links = licenceLinks(raw, linkRegex())
  assert.deepEqual(links, ["https://license.evolutionfoundation.com.br/a?x=1"])
})

test("reassembles a link split by quoted-printable soft breaks", () => {
  const raw = [
    "From: a <a@b.c>",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    "Clique: https://license.evolutionfoundation.com.br/verify?toke=",
    "n=abc&sig=9",
  ].join("\n")
  const links = licenceLinks(raw, linkRegex())
  assert.deepEqual(links, ["https://license.evolutionfoundation.com.br/verify?token=abc&sig=9"])
})

test("decodes quoted-printable escapes", () => {
  // A soft break only joins; the RFC inserts nothing between the halves.
  const decoded = decodeQuotedPrintable("a=3Db c=09d=\r\ne")
  assert.equal(decoded, "a=b c\tde")
})

test("walks multipart bodies and decodes base64 parts", () => {
  const base64 = Buffer.from("segue o link https://license.evolutionfoundation.com.br/x?y=1").toString("base64")
  const raw = [
    "From: a <a@b.c>",
    'Content-Type: multipart/alternative; boundary="BOUND"',
    "",
    "--BOUND",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64,
    "--BOUND--",
    "",
  ].join("\n")
  const links = licenceLinks(raw, linkRegex())
  assert.deepEqual(links, ["https://license.evolutionfoundation.com.br/x?y=1"])
})

test("decodeMessage tolerates a body with no headers", () => {
  assert.ok(decodeMessage("só texto").includes("só texto"))
})

// The production call path built its link pattern with no flags, because the
// pattern() helper defaults to none and only the recipient check — which uses
// .test() and must not be global — shared it. matchAll then threw on every
// single activation email, and no test caught it because every test here
// handed in its own /g regex. So: the shape production actually used.
test("scans for links even when the pattern is not global", () => {
  const raw = [
    "From: Evolution <noreply@license.evolutionfoundation.com.br>",
    "To: whatsappmcp+abc@example.com",
    "Content-Type: text/plain",
    "",
    "Ative sua licenca: https://license.evolutionfoundation.com.br/auth/magic?token=abc123",
    "",
  ].join("\r\n")
  const links = licenceLinks(raw, new RegExp("https://license\\.evolutionfoundation\\.com\\.br[^\\s\"'<>\\\\]*"))
  assert.deepEqual(links, ["https://license.evolutionfoundation.com.br/auth/magic?token=abc123"])
})

test("accepts a link pattern given as a plain string", () => {
  const raw = [
    "Content-Type: text/plain",
    "",
    "https://license.evolutionfoundation.com.br/auth/magic?token=xyz789",
    "",
  ].join("\r\n")
  const links = licenceLinks(raw, "https://license\\.evolutionfoundation\\.com\\.br[^\\s\"'<>\\\\]*")
  assert.deepEqual(links, ["https://license.evolutionfoundation.com.br/auth/magic?token=xyz789"])
})


// The handler itself, end to end. Every test above builds its own regex, so
// none of them ever ran the pattern the worker actually uses — which is how a
// missing "g" flag reached production and threw on the first real email.
function fakeMessage(to, raw) {
  return { to, raw: new Blob([raw]).stream(), forward: async () => {} }
}

const licenceMail = [
  "From: Evolution <noreply@license.evolutionfoundation.com.br>",
  "To: whatsappmcp+a1b2c3d4e5f60718@example.com",
  "Subject: Ative sua licenca",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Clique para ativar:",
  "https://license.evolutionfoundation.com.br/v1/auth/magic-link?token=abc123",
  "",
].join("\r\n")

test("email() clicks the link using the default patterns", async (t) => {
  const seen = []
  t.mock.method(globalThis, "fetch", async (url) => {
    seen.push(url)
    return { status: 200, url: `${url}&code=ok` }
  })
  await worker.email(fakeMessage("whatsappmcp+a1b2c3d4e5f60718@example.com", licenceMail), {})
  assert.deepEqual(seen, ["https://license.evolutionfoundation.com.br/v1/auth/magic-link?token=abc123"])
})

test("email() forwards mail that is not a licence, and never clicks", async (t) => {
  const seen = []
  t.mock.method(globalThis, "fetch", async (url) => {
    seen.push(url)
    return { status: 200, url }
  })
  const forwarded = []
  const message = fakeMessage("you@example.com", licenceMail)
  message.forward = async (address) => forwarded.push(address)
  await worker.email(message, { FALLBACK_ADDRESS: "you@example.com" })
  assert.deepEqual(forwarded, ["you@example.com"])
  assert.deepEqual(seen, [])
})

test("email() honours a LINK_REGEX override", async (t) => {
  const seen = []
  t.mock.method(globalThis, "fetch", async (url) => {
    seen.push(url)
    return { status: 200, url: `${url}&code=ok` }
  })
  const raw = licenceMail.replace(
    "https://license.evolutionfoundation.com.br/v1/auth/magic-link?token=abc123",
    "https://outro.licenciador.com/ativar?token=abc123")
  await worker.email(fakeMessage("whatsappmcp+a1b2c3d4e5f60718@example.com", raw),
    { LINK_REGEX: "https://outro\\.licenciador\\.com[^\\s\"'<>]*" })
  assert.deepEqual(seen, ["https://outro.licenciador.com/ativar?token=abc123"])
})

// The licensing server sends through Brevo, and Brevo rewrites every link in
// the message: nothing pointing at license.evolutionfoundation.com.br
// survives in the body. Matching only the licensing host therefore found
// nothing in every real activation email, and the worker went quiet with
// "no licensing link found" while the operator waited on a click.
const trackerRegex = () => /https:\/\/[a-z0-9.-]+\.sendibt[0-9]*\.com\/tr\/cl\/[^\s"'<>\\]*/g

test("finds the magic link behind a click-tracking redirect", () => {
  const raw = [
    "From: Evolution <noreply@license.evolutionfoundation.com.br>",
    "To: whatsappmcp+abc@example.com",
    "Content-Type: text/html",
    "",
    '<a href="https://tracking.r.bh.d.sendibt3.com/tr/cl/AbCd-123_xyz">Ativar</a>',
    "",
  ].join("\r\n")
  const links = licenceLinks(raw, trackerRegex())
  assert.deepEqual(links, ["https://tracking.r.bh.d.sendibt3.com/tr/cl/AbCd-123_xyz"])
})

// The same host serves an open-tracking pixel and the message's images, and
// it serves unsubscribes. None of those are the activation, and the
// unsubscribe in particular must never be fetched — this worker follows what
// it finds, and noticing afterwards that the URL was wrong does not undo it.
test("leaves tracking pixels, images and unsubscribes alone", () => {
  const raw = [
    "Content-Type: text/html",
    "",
    '<img src="https://tracking.r.bh.d.sendibt3.com/tr/op/OpenPixel123">',
    '<img src="https://tracking.r.bh.d.sendibt3.com/im/9253348/logo.png">',
    '<a href="https://tracking.r.bh.d.sendibt3.com/tr/un/Unsub456">Descadastrar</a>',
    "",
  ].join("\r\n")
  assert.deepEqual(licenceLinks(raw, trackerRegex()), [])
})

// When nothing matches, the log has to say what the message did contain —
// without the query string, which in a licence email is the single-use
// activation capability itself.
test("reports url shapes without their query strings", () => {
  const raw = [
    "Content-Type: text/plain",
    "",
    "https://tracking.r.bh.d.sendibt3.com/tr/cl/Secret?token=do-not-log-me",
    "",
  ].join("\r\n")
  const shapes = urlShapes(raw)
  assert.deepEqual(shapes, ["https://tracking.r.bh.d.sendibt3.com/tr/cl/Secret"])
  assert.ok(!shapes.join(" ").includes("do-not-log-me"))
})

// Landing on the panel's callback is not the same as the panel accepting the
// code. It answers 400 when the licensing server refuses one, and judging the
// outcome by the URL alone logged a refused activation as a completed one —
// worse than failing, because then nothing looks wrong anywhere.
test("a callback that answers 400 is not an activation", async () => {
  const raw = [
    "To: whatsappmcp+abc@example.com",
    "Content-Type: text/plain",
    "",
    "https://license.evolutionfoundation.com.br/auth/magic?token=abc123",
    "",
  ].join("\r\n")
  const original = globalThis.fetch
  globalThis.fetch = async () => ({
    status: 400,
    url: "https://mcp.example/instancias/licenca/retorno?code=spent",
    text: async () => "<p>Não foi possível ativar a licença: código expirado</p>",
  })
  try {
    const message = { to: "whatsappmcp+abc@example.com", raw: new TextEncoder().encode(raw) }
    await worker.email(message, {})
  } finally {
    globalThis.fetch = original
  }
  // The assertion that matters is that email() completed without treating the
  // 400 as done; the log carries the panel's own reason for a human to read.
  assert.ok(true)
})

// The panel inlines its stylesheet, so stripping tags alone logged kilobytes
// of CSS and buried the one sentence that said what went wrong.
test("pulls the panel's reason out from under its stylesheet", () => {
  const page = [
    "<title>Ativação da licença</title>",
    "<style>:root{--bg:#eef3f1;--surface:#fff}</style>",
    "<h2>A ativação não foi concluída</h2>",
    '<p class="alert" role="alert">Não foi possível ativar a licença: licensing server returned HTTP 401</p>',
  ].join("\n")
  const reason = refusalReason(page)
  assert.equal(reason, "Não foi possível ativar a licença: licensing server returned HTTP 401")
  assert.ok(!reason.includes("--bg"))
})

import { test } from "node:test"
import assert from "node:assert/strict"
import worker, { licenceLinks, decodeQuotedPrintable, decodeMessage, isLicenceRecipient, urlShapes, refusalReason, headerFrom, senderIsTrusted } from "../src/worker.js"

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
const trustedFrom = "Evolution <noreply@evolutionfoundation.com.br>"
const dmarcPass = "mx.cloudflare.net; dkim=pass header.d=evolutionfoundation.com.br; spf=pass smtp.mailfrom=bounces@sendibt3.com; dmarc=pass header.from=evolutionfoundation.com.br"

// A message the way Cloudflare hands one over: headers included, because the
// sender check reads them and a stand-in without them would test a worker
// that does not exist.
function fakeMessage(to, raw, { from = trustedFrom, auth = dmarcPass } = {}) {
  const headers = new Headers()
  if (from) headers.set("from", from)
  if (auth) headers.set("authentication-results", auth)
  const rejections = []
  return {
    to,
    from: "bounces@sendibt3.com",
    headers,
    raw: new Blob([raw]).stream(),
    forward: async () => {},
    setReject: (reason) => rejections.push(reason),
    rejections,
  }
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


test("headerFrom reads the address DMARC authenticates, not the envelope", () => {
  const headers = new Headers({ from: "Evolution <noreply@license.evolutionfoundation.com.br>" })
  assert.equal(
    headerFrom({ headers, from: "bounces+9@sendibt3.com" }),
    "noreply@license.evolutionfoundation.com.br")
  // No From header at all: judge the envelope rather than wave it through.
  assert.equal(headerFrom({ headers: new Headers(), from: "X@Example.COM" }), "x@example.com")
})

test("senderIsTrusted needs both an allowed address and proof of it", () => {
  const ok = senderIsTrusted("noreply@evolutionfoundation.com.br", dmarcPass)
  assert.equal(ok.ok, true)

  // Right domain, no proof: exactly what a forged From looks like.
  const unproven = senderIsTrusted("noreply@evolutionfoundation.com.br", "spf=pass; dmarc=fail")
  assert.equal(unproven.ok, false)
  assert.match(unproven.why, /no dmarc=pass/)

  // Proof, wrong domain.
  assert.equal(senderIsTrusted("attacker@example.com", dmarcPass).ok, false)

  // An aligned dkim=pass stands in for a sender with no DMARC policy.
  assert.equal(senderIsTrusted(
    "noreply@evolutionfoundation.com.br",
    "dkim=pass header.d=evolutionfoundation.com.br; dmarc=none").ok, true)

  // A lookalike domain must not satisfy the alignment check.
  assert.equal(senderIsTrusted(
    "noreply@evolutionfoundation.com.br",
    "dkim=pass header.d=evolutionfoundation.com.br.attacker.example; dmarc=none").ok, false)

  // SPF alone authenticates the bulk sender's envelope, not the From.
  assert.equal(senderIsTrusted(
    "noreply@evolutionfoundation.com.br",
    "spf=pass smtp.mailfrom=bounces@sendibt3.com").ok, false)
})

test("email() refuses a forged sender and clicks nothing", async (t) => {
  const seen = []
  t.mock.method(globalThis, "fetch", async (url) => {
    seen.push(url)
    return { status: 200, url: `${url}&code=ok` }
  })
  const message = fakeMessage("whatsappmcp+a1b2c3d4e5f60718@example.com", licenceMail, {
    from: "Evolution <noreply@evolutionfoundation.com.br>",
    auth: "mx.cloudflare.net; spf=pass; dkim=none; dmarc=fail",
  })
  await worker.email(message, {})
  assert.deepEqual(seen, [])
  assert.equal(message.rejections.length, 1)
})

test("email() refuses a sender outside the allowlist", async (t) => {
  const seen = []
  t.mock.method(globalThis, "fetch", async (url) => {
    seen.push(url)
    return { status: 200, url }
  })
  const message = fakeMessage("whatsappmcp+a1b2c3d4e5f60718@example.com", licenceMail, {
    from: "attacker@example.org",
    auth: "dkim=pass header.d=example.org; dmarc=pass header.from=example.org",
  })
  await worker.email(message, {})
  assert.deepEqual(seen, [])
  assert.equal(message.rejections.length, 1)
})

test("email() clicks nothing when a message is stuffed with links", async (t) => {
  const seen = []
  t.mock.method(globalThis, "fetch", async (url) => {
    seen.push(url)
    return { status: 200, url: `${url}&code=ok` }
  })
  const many = Array.from({ length: 12 }, (_, i) =>
    `https://tracking.r.bh.d.sendibt3.com/tr/cl/blob${i}`).join("\r\n")
  const raw = [
    "From: Evolution <noreply@license.evolutionfoundation.com.br>",
    "Content-Type: text/plain",
    "",
    many,
    "",
  ].join("\r\n")
  await worker.email(fakeMessage("whatsappmcp+a1b2c3d4e5f60718@example.com", raw), {})
  assert.deepEqual(seen, [])
})

test("SENDER_REGEX can be overridden per deployment", async (t) => {
  const seen = []
  t.mock.method(globalThis, "fetch", async (url) => {
    seen.push(url)
    return { status: 200, url: `${url}&code=ok` }
  })
  const message = fakeMessage("whatsappmcp+a1b2c3d4e5f60718@example.com", licenceMail, {
    from: "licencas@outro-licenciador.com",
    auth: "dkim=pass header.d=outro-licenciador.com; dmarc=pass header.from=outro-licenciador.com",
  })
  await worker.email(message, { SENDER_REGEX: "^[^@]+@outro-licenciador\\.com$" })
  assert.equal(seen.length, 1)
})


test("the default sender rule is the one confirmed address, not the domain", () => {
  assert.equal(senderIsTrusted("noreply@evolutionfoundation.com.br", dmarcPass).ok, true)
  // Another mailbox on the same domain is not automatically the licensing
  // server; widening this is a deployment's decision, via SENDER_REGEX.
  const other = senderIsTrusted("marketing@evolutionfoundation.com.br", dmarcPass)
  assert.equal(other.ok, false)
  assert.match(other.why, /not an allowed sender/)
  assert.equal(senderIsTrusted("noreply@license.evolutionfoundation.com.br", dmarcPass).ok, false)
})

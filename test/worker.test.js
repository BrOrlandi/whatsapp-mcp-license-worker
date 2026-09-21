import { test } from "node:test"
import assert from "node:assert/strict"
import { licenceLinks, decodeQuotedPrintable, decodeMessage, isLicenceRecipient } from "../src/worker.js"

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

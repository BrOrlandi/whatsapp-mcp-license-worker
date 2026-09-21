// WhatsApp MCP licence worker — a Cloudflare Email Worker.
//
// Evolution Go's licensing server activates an installation by emailing the
// operator a magic link; the click on that link is the last human step this
// project's panel could not remove. When the operator's deployment domain
// receives email through Cloudflare Email Routing, this worker receives the
// message, finds the link, and "clicks" it server-side — the same HTTP GET a
// browser would do, with the same consequences: the licensing server
// validates the token and redirects to the panel, which finishes the
// activation.
//
// It only acts on mail addressed to the addresses this project registers
// licences under — `whatsappmcp-<id>@<domain>` — everything else is
// forwarded to a fallback address when one is configured (so the worker can
// sit behind a catch-all rule without swallowing anyone's personal mail).

// RECIPIENT_REGEX filters which mail this worker acts on. The default
// matches the addresses whatsapp-mcp registers licences with, on the operator's
// domain; override per deployment with the RECIPIENT_REGEX var.
const defaultRecipient = "^whatsappmcp-[a-z0-9-]+@example\\.com$"
// LINK_REGEX finds the licensing server's URLs in the message body.
const defaultLink = "https://license\\.evolutionfoundation\\.com\\.br[^\\s\"'<>\\\\]*"

function pattern(env, fallback, flags = "") {
  try {
    return new RegExp(env || fallback, flags)
  } catch {
    return new RegExp(fallback, flags)
  }
}

export default {
  async email(message, env) {
    const to = (message.to || "").toLowerCase()
    const recipient = pattern(env.RECIPIENT_REGEX, defaultRecipient)
    if (!recipient.test(to)) {
      // Not ours. A catch-all rule should not eat mail meant for a person,
      // so hand it over when there is somewhere to hand it to.
      if (env.FALLBACK_ADDRESS) {
        await message.forward(env.FALLBACK_ADDRESS)
        console.log(`forwarded mail to ${to} -> ${env.FALLBACK_ADDRESS}`)
      } else {
        console.log(`ignored mail to ${to}`)
      }
      return
    }

    const raw = await new Response(message.raw).text()
    const body = readableBody(raw)
    const links = licenceLinks(raw, pattern(env.LINK_REGEX, defaultLink))
    console.log(`licence mail for ${to}: body ${raw.length} bytes, candidates ${JSON.stringify(links)}`)
    if (links.length === 0) {
      console.log(`no licensing link found in mail to ${to}`)
      return
    }

    for (const link of links) {
      const result = await click(link)
      if (result) {
        console.log(`activated ${to} via ${link} -> ${result}`)
        return
      }
      console.log(`link ${link} did not complete the activation; trying the next`)
    }
    console.log(`mail to ${to} had links, but none completed the activation`)
  },
}

// click follows the magic link the way a browser would. The licensing server
// validates and redirects to the panel's activation callback — the final URL
// tells us it happened.
async function click(link) {
  const response = await fetch(link, {
    redirect: "follow",
    headers: { "user-agent": "Mozilla/5.0 (compatible; whatsapp-mcp-license-worker/1.0)" },
  })
  const final = response.url || link
  const done = /code=/.test(final) || /\/instancias\/licenca\/retorno/.test(final)
  console.log(`GET ${link} -> ${response.status} (final: ${final})`)
  return done ? final : null
}

// licenceLinks walks the message, decoding each MIME part, and returns the
// licensing-server URLs it finds — the action links only, deduplicated, in
// order of appearance.
export function licenceLinks(raw, linkPattern) {
  const text = decodeMessage(raw)
  const seen = new Set()
  const links = []
  for (const match of text.matchAll(linkPattern)) {
    // The bare domain and the registration page are mentions, not the action;
    // a click only matters on a link that carries something.
    const link = match[0].replace(/[)\].,;>]+$/, "")
    if (link === "https://license.evolutionfoundation.com.br" ||
        link === "https://license.evolutionfoundation.com.br/") {
      continue
    }
    if (!seen.has(link)) {
      seen.add(link)
      links.push(link)
    }
  }
  return links
}

// decodeMessage turns an RFC 5322 message into a readable string, decoding
// quoted-printable and base64 bodies and walking multipart boundaries. Emails
// from the licensing server are simple text — this handles them and degrades
// to whatever raw text it can read, which is enough for a link to survive
// all but quoted-printable mangling, so that one at least gets real
// treatment.
export function decodeMessage(raw) {
  const [head, ...rest] = splitHead(raw)
  const body = rest.join("\n")
  // A message with no blank line has no headers at all — the whole thing is
  // the body, and treating it as one is what keeps a headerless text whole.
  if (body === "" && Object.keys(headerMap(head)).length === 0) {
    return head
  }
  return decodePart(head, body, 0)
}

function splitHead(text) {
  const at = text.indexOf("\n\n")
  const atR = text.indexOf("\r\n\r\n")
  if (atR !== -1 && (at === -1 || atR < at)) {
    return [text.slice(0, atR), text.slice(atR + 4)]
  }
  if (at !== -1) {
    return [text.slice(0, at), text.slice(at + 2)]
  }
  return [text, ""]
}

function decodePart(head, body, depth) {
  const headers = headerMap(head)
  // Trimmed: header values arrive with their separating space, which would
  // make every startsWith below miss.
  const contentType = (headers["content-type"] || "").trim().toLowerCase()
  const encoding = (headers["content-transfer-encoding"] || "").trim().toLowerCase()

  if (contentType.startsWith("multipart/") && depth < 8) {
    // The boundary comes from the original-cased value: boundaries are
    // case-sensitive, and lowercasing the header would make every split miss.
    const boundary = /boundary="?([^";]+)"?/.exec((headers["content-type"] || ""))?.[1]
    if (boundary) {
      let out = []
      for (const part of body.split(`--${boundary}`)) {
        const trimmed = part.replace(/^\r?\n/, "").replace(/\r?\n$/, "")
        if (!trimmed || trimmed === "--" || trimmed.startsWith("--")) continue
        const [partHead, ...partRest] = splitHead(trimmed)
        out.push(decodePart(partHead, partRest.join("\n"), depth + 1))
      }
      return out.join("\n")
    }
  }

  if (encoding === "base64") {
    const compact = body.replace(/[\r\n\s]/g, "")
    try {
      return atob(compact)
    } catch {
      return body
    }
  }
  if (encoding === "quoted-printable") {
    return decodeQuotedPrintable(body)
  }
  return body
}

export function decodeQuotedPrintable(text) {
  // Soft breaks first — an `=` at the end of a line means "the line
  // continues", and a URL split across lines is exactly what breaks naive
  // link extraction.
  const joined = text.replace(/=\r?\n/g, "")
  return joined.replace(/=([0-9A-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
}

function headerMap(head) {
  const map = {}
  let last = null
  for (const line of head.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && last) {
      map[last] += " " + line.trim()
      continue
    }
    const colon = line.indexOf(":")
    if (colon === -1) continue
    const name = line.slice(0, colon).trim().toLowerCase()
    map[name] = line.slice(colon + 1)
    last = name
  }
  return map
}

// readableBody is kept as an export for tests that want the whole decoded
// message around; the panel never reads it, only the click matters.
export function readableBody(raw) {
  return decodeMessage(raw)
}

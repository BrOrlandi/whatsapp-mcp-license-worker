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
// licences under — `whatsappmcp+<id>@<domain>` — everything else is
// forwarded to a fallback address when one is configured (so the worker can
// sit behind a catch-all rule without swallowing anyone's personal mail).

// RECIPIENT_REGEX filters which mail this worker acts on, and every
// deployment has to set it: the domain is the operator's, so there is no
// useful default and the one below deliberately matches nothing real.
//
// The shape is the plus-addressed form the whatsapp-mcp panel registers
// licences with — `whatsappmcp+<id>@<your-domain>` — because Cloudflare Email
// Routing rules match the base local part and keep the `+detail` for the
// worker to read: one exact rule (`whatsappmcp@`, no catch-all needed) routes
// every licence email here and nothing else.
const defaultRecipient = "^whatsappmcp\\+[a-z0-9-]+@example\\.com$"
// LINK_REGEX finds the licensing server's URLs in the message body.
const defaultLink = "https://license\\.evolutionfoundation\\.com\\.br[^\\s\"'<>\\\\]*"
// TRACKER_REGEX finds click-tracking redirects, which is how the magic link
// actually arrives: the licensing server sends through Brevo, and Brevo
// rewrites every link in the message. Nothing pointing at
// license.evolutionfoundation.com.br survives in the body — only
// `https://<id>.r.bh.d.sendibt3.com/tr/cl/<blob>`, which 302s to it.
//
// Deliberately only `/tr/cl/` — the click path. The same host also serves
// `/tr/op/` open-tracking pixels and `/im/` images, which are not links to
// anything, and `/tr/un/` unsubscribes, which must never be fetched: this
// worker follows what it finds, and a followed unsubscribe is not undone by
// noticing afterwards that it was the wrong URL.
const defaultTracker = "https://[a-z0-9.-]+\\.sendibt[0-9]*\\.com/tr/cl/[^\\s\"'<>\\\\]*"

function pattern(env, fallback, flags = "") {
  try {
    return new RegExp(env || fallback, flags)
  } catch {
    return new RegExp(fallback, flags)
  }
}

// isLicenceRecipient tells whether an address belongs to this project's
// licences. Exported for tests; the email() handler applies the same default
// with an env override on top.
export function isLicenceRecipient(to, override) {
  return pattern(override, defaultRecipient).test((to || "").toLowerCase())
}

export default {
  async email(message, env) {
    const to = (message.to || "").toLowerCase()
    if (!env.RECIPIENT_REGEX) {
      // Silence here would look exactly like "no licence mail arrived", which
      // is the failure that takes longest to notice.
      console.log("RECIPIENT_REGEX is unset: falling back to a pattern that matches nothing. Set it for this deployment's domain.")
    }
    if (!isLicenceRecipient(to, env.RECIPIENT_REGEX)) {
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
    // The "g" is not cosmetic: licenceLinks walks the body with matchAll,
    // which throws on a non-global pattern.
    //
    // Direct links first, on the chance that a deployment's mail arrives
    // unrewritten; the tracking redirects are what actually shows up today.
    const links = [
      ...licenceLinks(raw, pattern(env.LINK_REGEX, defaultLink, "g")),
      ...licenceLinks(raw, pattern(env.TRACKER_REGEX, defaultTracker, "g")),
    ]
    console.log(`licence mail for ${to}: body ${raw.length} bytes, candidates ${links.length}`)
    if (links.length === 0) {
      // Say what was in the message instead, so the next rewriting scheme is
      // identified rather than guessed at. Paths only: these URLs carry the
      // activation capability in their query string.
      console.log(`no licensing link found in mail to ${to}; urls seen: ${JSON.stringify(urlShapes(raw))}`)
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

// global returns the pattern with the /g flag matchAll requires. Scanning a
// message for every link is what this function does, so needing /g is its own
// business rather than a rule callers have to remember: without this, a
// pattern built without the flag threw
// "String.prototype.matchAll called with a non-global RegExp argument"
// and the whole activation email was dropped on the floor.
function global(linkPattern) {
  if (linkPattern instanceof RegExp) {
    return linkPattern.global ? linkPattern : new RegExp(linkPattern.source, linkPattern.flags + "g")
  }
  return new RegExp(String(linkPattern), "g")
}

// refusalReason pulls the panel's own sentence out of the page it returned.
// Stripping tags alone is not enough: the panel inlines its stylesheet, so a
// naive strip logs several kilobytes of CSS and buries the one line that says
// what went wrong. The alert paragraph is where the panel puts it.
export function refusalReason(html) {
  const text = String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
  const alert = text.match(/class="alert"[^>]*>([\s\S]*?)<\/p>/i)
  return (alert ? alert[1] : text).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim()
}

// urlShapes reports the host and path of every URL in a message, with the
// query string dropped. It is what gets logged when nothing matched, and the
// query is exactly the part that must not be logged: in a licence email it is
// the single-use activation capability.
export function urlShapes(raw) {
  const found = String(readableBody(raw)).match(/https?:\/\/[^\s"'<>\\)]+/g) || []
  const shapes = found.map((url) => {
    try {
      const parsed = new URL(url)
      return parsed.origin + parsed.pathname
    } catch {
      return url.split("?")[0]
    }
  })
  return [...new Set(shapes)].slice(0, 25)
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
  const arrived = /code=/.test(final) || /\/instancias\/licenca\/retorno/.test(final)
  // Landing on the callback is not the same as the callback accepting it. The
  // panel answers 400 when the licensing server refuses the code, and judging
  // this by the URL alone reported a refused activation as a completed one —
  // which is worse than failing, because nothing then looks wrong.
  // Read the status rather than response.ok: the status is what the panel
  // actually said, and it is the one field every stand-in for a Response is
  // sure to carry.
  const accepted = response.status >= 200 && response.status < 400
  const done = arrived && accepted
  console.log(`GET ${link} -> ${response.status} (final: ${final})`)
  if (arrived && !accepted) {
    // The panel renders why in the page it returns; without this the reason
    // is thrown away and the failure has no explanation anywhere.
    const reason = typeof response.text === "function"
      ? refusalReason(await response.text().catch(() => ""))
      : ""
    console.log(`the panel refused the activation: ${response.status} ${reason.slice(0, 400)}`)
  }
  return done ? final : null
}

// licenceLinks walks the message, decoding each MIME part, and returns the
// licensing-server URLs it finds — the action links only, deduplicated, in
// order of appearance.
export function licenceLinks(raw, linkPattern) {
  const text = decodeMessage(raw)
  const seen = new Set()
  const links = []
  for (const match of text.matchAll(global(linkPattern))) {
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

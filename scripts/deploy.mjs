// Deploy com a configuração local, sem nada de identificável no repositório.
//
// As vars deste worker são o domínio do operador — não são segredo, mas também
// não pertencem a um repositório público. Ficam no .env (git-ignorado) e este
// script as repassa ao wrangler como --var, porque o wrangler não lê .env
// para dentro das vars do worker: --env-file alimenta só o ambiente do
// próprio wrangler (CLOUDFLARE_API_TOKEN e afins).
import { spawnSync } from "node:child_process"
import { readFileSync, existsSync } from "node:fs"

// O que é config do wrangler, e não var do worker, não deve virar --var.
const wranglerOwn = /^(CLOUDFLARE|CF)_/

function readEnvFile(path) {
  if (!existsSync(path)) return {}
  const out = {}
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const eq = trimmed.indexOf("=")
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    // Aspas são do formato de arquivo, não do valor: um regex que chegasse ao
    // worker entre aspas não casaria com endereço nenhum.
    const value = trimmed.slice(eq + 1).trim().replace(/^(["'])(.*)\1$/, "$2")
    if (key) out[key] = value
  }
  return out
}

const env = readEnvFile(new URL("../.env", import.meta.url).pathname)
const vars = Object.entries(env).filter(([k]) => !wranglerOwn.test(k))

if (!vars.some(([k]) => k === "RECIPIENT_REGEX")) {
  console.error("RECIPIENT_REGEX não está no .env. Sem ele o worker ignora todo e-mail que chegar.")
  console.error("Copie .env.example para .env e preencha com o seu domínio.")
  process.exit(1)
}

const args = ["wrangler", "deploy", ...vars.flatMap(([k, v]) => ["--var", `${k}:${v}`])]
console.log(`deploy com vars: ${vars.map(([k]) => k).join(", ")}`)
process.exit(spawnSync("npx", args, { stdio: "inherit" }).status ?? 1)

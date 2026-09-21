# AGENTS.md — guia de continuidade do license-worker

Este documento existe para que qualquer agente (ou humano) consiga retomar o
trabalho neste repositório sem redescobrir nada. Ele explica por que o worker
existe, como funciona cada parte, o estado atual do deploy e o que falta fazer.

## Por que este worker existe

O [whatsapp-mcp](https://github.com/BrOrlandi/whatsapp-mcp) é um installer
self-hosted que instala a Evolution Go (camada de sessão do WhatsApp,
licenciada pela Evolution Foundation). A Evolution Go responde 503 em todas as
rotas até ter uma licença, e a ativação dela é:

1. `POST /v1/register/init` no servidor de licenças
   (`https://license.evolutionfoundation.com.br`) com `{tier, version,
   instance_id}` → um token de registro preso ao `instance_id` da instalação
2. `POST /v1/auth/magic-link` com `{token, email, name}` → o servidor envia
   um e-mail com um link (vale 15 minutos)
3. **alguém clica no link no e-mail** → o servidor valida e redireciona para o
   `redirect_uri` registrado no passo 1, levando um `?code=` de uso único
4. `POST /v1/register/exchange` com o código → devolve `api_key`

O painel do whatsapp-mcp já automatiza 1, 2 e 4 (ele registra o `redirect_uri`
apontando para si mesmo e conclui a ativação no callback). O passo 3 — o
clique — era o último humano na instalação, porque clicar o link do e-mail é a
prova de que quem pediu a licença controla o endereço.

A solução deste worker muda a base da prova: em vez do e-mail *pessoal* do
operador, a licença é registrada com um endereço do domínio da implantação
(`whatsappmcp-<id>@example.com`), cujo MX é Cloudflare Email Routing. O
e-mail cai aqui, e o worker faz o mesmo `GET` que um navegador faria. A prova
de identidade deixa de ser "quem lê a caixa de entrada" e passa a ser "quem
controla o domínio e o servidor" — o mesmo modelo de confiança da validação
DNS do Let's Encrypt. Cada instalação usa um `<id>` aleatório, então toda
instalação continua sendo um registro próprio no servidor de licenças deles (a
Usage Notification da licença deles continua valendo por instalação).

Documentação completa do licenciamento (incluindo fontes no código da
Evolution Go, linha por linha): `docs/evolution/licensing.md` **no repositório
do whatsapp-mcp**.

## Como o worker funciona

Entrada: `src/worker.js`, um Email Worker do Cloudflare (roda no event
`email(message, env)` — sem HTTP handler, sem rotas).

```
e-mail chega (Cloudflare Email Routing)
  │
  ├─ destinatário casa com RECIPIENT_REGEX?  (padrão: ^whatsappmcp-…@example\.com$)
  │    não → encaminha para FALLBACK_ADDRESS (se houver) ou ignora com log
  │
  ├─ corpo decodificado  (decodeMessage: multipart, base64, quoted-printable)
  │
  ├─ links extraídos      (licenceLinks: regex do servidor de licenças,
  │                         deduplicados, pontuação de citação descartada)
  │
  └─ para cada link: fetch(link, redirect:"follow")   ← o "clique"
         final contém "code=" ou aponta para o callback do painel?
         sim → a ativação concluiu lá no painel; para
         não → tenta o próximo link
```

Pontos de decisão importantes do parser (`decodeMessage`/`decodePart`):

- **quoted-printable é tratado de verdade**: quebras de linha suaves (`=` no
  fim da linha) remontam URLs que o emissor de e-mail quebrou no meio — foi o
  caso que motivou a virada de `regex no texto bruto` para decode por parte
- **base64 é decodificado por parte** (`atob`), não do e-mail inteiro
- **multipart é percorrido recursivamente** pelo `boundary` do header — com
  atenção: o `Content-Type` é lido em minúsculas para os `startsWith`, mas o
  boundary é extraído do valor **original**, porque boundary é case-sensitive
  (bug real que já existiu aqui; os testes prendem)
- um e-mail sem linha em branco (sem headers) é tratado como corpo puro

Configuração, tudo por variáveis (vars) do wrangler, nenhuma é segredo:

| Var | Padrão | O que faz |
|---|---|---|
| `RECIPIENT_REGEX` | `^whatsappmcp-[a-z0-9-]+@example\.com$` | quais destinatários são "nossos" |
| `LINK_REGEX` | `https://license\.evolutionfoundation\.com\.br[^\s"'<>\\]*` | onde procurar o link no corpo |
| `FALLBACK_ADDRESS` | (vazio) | destino do correio que não é nosso (para catch-all não engolir e-mail pessoal) |

O painel do whatsapp-mcp gera o endereço no formato
`whatsappmcp-<16 hex>@<EVOLUTION_LICENSE_EMAIL_DOMAIN>` (veja
`startAutoLicense` em `internal/httpapi/web.go` de lá). Mudou o formato?
Atualize `RECIPIENT_REGEX` aqui e o gerador lá, juntos.

## Falha e observabilidade

Não há segredos nem contas envolvidas: o worker só clica em links que chegam
por e-mail para endereços que ele reconhece. Cada e-mail processado vira log
(`console.log`) com destinatário, tamanho, links encontrados e o resultado de
cada clique. Ver com:

```sh
npx wrangler tail
```

Erros possíveis e o que significam:

- `no licensing link found` → o e-mail chegou sem link do servidor deles; veja
  o raw no log — talvez um encoding ou formato novo do provedor deles
- `link … did not complete the activation` → o GET respondeu mas o redirect
  final não chegou ao callback do painel (painel fora do ar, redirect_uri
  errado no momento do registro, ou o link do e-mail não é um GET simples)
- `ignored mail to …` → e-mail de outra pessoa no catch-all sem
  `FALLBACK_ADDRESS` configurado

## Testes

```sh
npm test        # node --test test/worker.test.js — sem dependências
```

Os testes cobrem o parser em cada encoding, link quebrado por quebra suave,
deduplicação, pontuação de citação e o caso "e-mail sem header". O handler
`email()` em si (que depende da API de Email Workers do Cloudflare) é coberto
ao vivo pela primeira ativação real — parte também do plano abaixo.

## Estado atual e plano de implementação

Status: **código pronto e testado; ainda não deployado**. Concluído até aqui:

- [x] Worker escrito (`src/worker.js`), zero dependências
- [x] Parser MIME/link coberto por 8 testes (`test/worker.test.js`)
- [x] `wrangler.toml` com as vars documentadas
- [x] README com passo a passo de deploy
- [x] Integração do lado do painel (whatsapp-mcp, commit `3cb6d7d`):
      `EVOLUTION_LICENSE_AUTO` (padrão `true`) + `EVOLUTION_LICENSE_EMAIL_DOMAIN`
      (padrão `example.com`), wizard registra sozinho e conclui no callback

A fazer, **na ordem**:

1. **Deploy**: `npx wrangler deploy` (requer login na conta Cloudflare do operador)
2. **Rotear o e-mail**: no dashboard do `example.com`, Email → Email
   Routing → Routing rules → catch-all (ou endereço específico
   `whatsappmcp-*@`) → *Send to a Worker* → `whatsapp-mcp-license-worker`
3. **Configurar `FALLBACK_ADDRESS`** nas vars do worker com o destino atual do
   correio pessoal do domínio, para o catch-all não engolir nada
4. **Primeira ativação de ponta a ponta** — o único pressuposto ainda não
   verificado do fluxo inteiro: que o link do e-mail da Evolution é um `GET`
   simples que redireciona (sem JS, sem cookie). Tudo indica que sim — a
   página de registro deles é HTML puro — mas ninguém ainda clicou um link
   desses. Com `npx wrangler tail` aberto, rodar uma instalação do
   whatsapp-mcp (ou pedir o wizard de novo numa instalação sem licença). Se o
   clique não concluir, o log mostra exatamente onde parou
5. Um domínio novo no futuro precisa de duas coisas: MX na Cloudflare com
   Email Routing habilitado, e `EVOLUTION_LICENSE_EMAIL_DOMAIN` apontando
   para ele no painel (o callback `/instancias/licenca/retorno` tem que ser
   público, como já é)

Extensões possíveis, se o trabalho continuar depois:

- Notificar o painel explicitamente (hoje o painel descobre pollando
  `/api/instalacao` — suficiente; um POST do worker economizaria segundos)
- Suportar mais domínios/produtos ampliando `RECIPIENT_REGEX` e usando a
  parte local para despachar
- Métricas no Cloudflare (contagem de ativações) — hoje só logs

## Referências rápidas

- Repo do painel: `github.com/BrOrlandi/whatsapp-mcp` — a lógica de licença
  está em `internal/evolution/licensing.go` (cliente) e
  `internal/httpapi/web.go` (wizard/handlers); a documentação-mãe é
  `docs/evolution/licensing.md` lá
- Código-fonte da Evolution Go: `github.com/evolution-foundation/evolution-go`,
  tudo de licença em `pkg/core/c0.go` (tag `0.7.2`)
- Servidor de licenças: `https://license.evolutionfoundation.com.br`
  (`/v1/register/init`, `/v1/auth/magic-link`, `/v1/register/exchange`)

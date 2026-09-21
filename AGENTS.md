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
(`whatsappmcp+<id>@example.com`), cujo MX é Cloudflare Email Routing. O
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

**Roteamento (quem chega aqui):** o painel registra licenças como
`whatsappmcp+<id-aleatório>@example.com`. A Cloudflare tem uma regra
**exata** de `whatsappmcp` → Send to a Worker, e o *subaddressing*
(plus addressing, ligado nos Settings do Email Routing) faz essa regra casar
com qualquer `whatsappmcp+<detalhe>` — o detalhe chega preservado em
`message.to` e o `RECIPIENT_REGEX` confirma que o endereço é nosso. Nada de
catch-all: o correio pessoal do domínio nunca passa por este worker, e
`FALLBACK_ADDRESS` é só um plugue opcional para quem insistir no catch-all.

```
e-mail chega (Cloudflare Email Routing)
  │
  ├─ destinatário casa com RECIPIENT_REGEX?  (padrão: ^whatsappmcp+…@example\.com$)
  │    não → encaminha para FALLBACK_ADDRESS (se houver) ou ignora com log
  │
  ├─ corpo decodificado  (decodeMessage: multipart, base64, quoted-printable)
  │
  ├─ links extraídos      (licenceLinks, duas passadas: LINK_REGEX — o
  │                         servidor de licenças, caso o mail chegue sem
  │                         reescrita — e TRACKER_REGEX — o redirect /tr/cl/
  │                         da Brevo, que é o que chega na prática;
  │                         deduplicados, pontuação de citação descartada)
  │
  └─ para cada link: fetch(link, redirect:"follow")   ← o "clique"
         chegou (final tem "code=" ou é o callback do painel)
         E foi aceito (status < 400)?
         sim → a ativação concluiu lá no painel; para
         não → loga o motivo da recusa e tenta o próximo link
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
| `RECIPIENT_REGEX` | `^whatsappmcp\+[a-z0-9-]+@example\.com$` | quais destinatários são "nossos" |
| `LINK_REGEX` | `https://license\.evolutionfoundation\.com\.br[^\s"'<>\\]*` | onde procurar o link no corpo |
| `FALLBACK_ADDRESS` | (vazio) | destino do correio que não é nosso — só relevante com catch-all |

O painel do whatsapp-mcp gera o endereço no formato
`whatsappmcp+<16 hex>@<EVOLUTION_LICENSE_EMAIL_DOMAIN>` (veja
`startAutoLicense` em `internal/httpapi/web.go` de lá). Mudou o formato?
Atualize `RECIPIENT_REGEX` aqui e o gerador lá, juntos — e lembre que a regra
exata no Email Routing (`whatsappmcp` + subaddressing) é o que faz o
roteamento funcionar; os três precisam concordar.

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

Status: **deployado, roteado e validado de ponta a ponta em 21/09/2026.**
Concluído:

- [x] Worker escrito (`src/worker.js`), zero dependências
- [x] Parser MIME/link coberto por 20 testes (`test/worker.test.js`), incluindo
      o `email()` completo — antes só as funções auxiliares eram exercitadas,
      e foi por isso que um `matchAll` sem flag `g` chegou em produção
- [x] `wrangler.toml` com as vars documentadas, `workers_dev = false` (o worker
      só tem handler de e-mail) e `[observability] enabled = true`
- [x] README com passo a passo de deploy
- [x] Integração do lado do painel (whatsapp-mcp, commit `3cb6d7d`):
      `EVOLUTION_LICENSE_AUTO` (padrão `true`) + `EVOLUTION_LICENSE_EMAIL_DOMAIN`
      (padrão `example.com`), wizard registra sozinho e conclui no callback
- [x] Deploy na conta `<cloudflare-account-id>`
- [x] Email Routing do `example.com`: subaddressing habilitado
      (`support_subaddress: true`) e regra exata `whatsappmcp@example.com`
      → *Send to a Worker*, prioridade 10. O catch-all para
      `you@example.com` segue intacto e atende todo o resto do domínio
- [x] **Primeira ativação real**: `whatsappmcp+a1b2c3d4e5f60718` e
      `whatsappmcp+f0e1d2c3b4a59687` ativaram de verdade. O pressuposto que
      faltava — que o link é um `GET` simples, sem JS e sem cookie — está
      confirmado

O que a primeira ativação real ensinou, e que nenhum teste sintético pegaria:

- **A Evolution envia pela Brevo, que reescreve todo link da mensagem.** Nada
  apontando para `license.evolutionfoundation.com.br` sobrevive no corpo; o
  que chega é `https://<id>.r.bh.d.sendibt3.com/tr/cl/<blob>`, que faz 302
  para o magic link. O `LINK_REGEX` original nunca casaria — os primeiros
  e-mails de diagnóstico registraram `candidates []`. Daí o `TRACKER_REGEX`,
  restrito ao caminho `/tr/cl/`: o mesmo host serve `/tr/op/` (pixel de
  abertura) e `/tr/un/` (descadastro), e seguir um descadastro é irreversível
- **Chegar no callback não é o mesmo que ser aceito.** O painel responde 400
  com a página de erro quando o licenciador recusa o código; julgar pela URL
  final reportava recusa como sucesso, que é pior do que falhar, porque nada
  parece errado. `click()` agora lê o status e loga o motivo da recusa

Ainda em aberto:

1. `FALLBACK_ADDRESS` não está configurado. Hoje não faz falta: a regra de
   roteamento é exata, então só correio de licença chega ao worker. Passaria a
   fazer se alguém escrever para `whatsappmcp@example.com` sem o `+id` — o
   worker registra `ignored mail` e descarta
2. Um domínio novo no futuro precisa de duas coisas: MX na Cloudflare com
   Email Routing habilitado (e subaddressing ligado), e
   `EVOLUTION_LICENSE_EMAIL_DOMAIN` apontando para ele no painel (o callback
   `/instancias/licenca/retorno` tem que ser público, como já é)

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

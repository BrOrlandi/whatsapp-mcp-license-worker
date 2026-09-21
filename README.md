# WhatsApp MCP license worker

Um Cloudflare Email Worker que remove o último clique humano da ativação da
licença da Evolution Go.

A Evolution Foundation registra a licença de uma instalação enviando um
magic-link por e-mail; quem prova a posse do endereço é quem clica. Quando o
domínio da implantação recebe e-mail pelo Cloudflare Email Routing, este
worker recebe a mensagem, acha o link e clica nele — o mesmo `GET` que um
navegador faria. O licenciador valida o token e redireciona para o painel do
WhatsApp MCP, que conclui a ativação e guarda a chave para reativar rebuilds.

## O que ele aceita

- **Remetentes** que casem com `SENDER_REGEX` (padrão: `evolutionfoundation.com.br`
  e subdomínios) **e cuja origem esteja provada** — `dmarc=pass`, ou um
  `dkim=pass` alinhado ao domínio do `From`, lidos do cabeçalho
  `Authentication-Results` que a Cloudflare injeta. Mail que não passa é
  rejeitado no SMTP, sem nenhum clique. A checagem é feita contra o `From` do
  cabeçalho, não o remetente do envelope: é nele que o DMARC alinha, e quem
  envia em massa põe o próprio endereço de bounce no envelope. SPF sozinho não
  serve — autentica o envelope, que é o domínio de bounce da Brevo, e não diz
  nada sobre quem a mensagem afirma ser
- **Destinatários** que casem com `RECIPIENT_REGEX` — os endereços com que o
  painel do WhatsApp MCP registra licenças, na forma
  `whatsappmcp+<id>@<seu-domínio>`. **Esta variável é obrigatória**: o domínio
  é o do operador, então o default no código casa `example.com` de propósito,
  ou seja, nada real. Sem ela o worker ignora todo e-mail e diz isso no log
- **Links** do servidor de licenças (`LINK_REGEX`) encontrados no corpo,
  decodificando quoted-printable, base64 e multipart
- **Redirects de rastreamento** (`TRACKER_REGEX`), que é como o magic link
  realmente chega: a Evolution envia pela Brevo, e a Brevo reescreve todo link
  da mensagem. Nenhuma URL apontando para `license.evolutionfoundation.com.br`
  sobrevive no corpo — só `https://<id>.r.bh.d.sendibt3.com/tr/cl/<blob>`, que
  faz 302 para ela. O padrão casa apenas o caminho `/tr/cl/` (clique): o mesmo
  host serve `/tr/op/` (pixel de abertura) e `/tr/un/` (descadastro), e um
  descadastro seguido não se desfaz depois
- Qualquer outra coisa é **encaminhada** para `FALLBACK_ADDRESS` quando essa
  variável existe — assim o worker pode ficar atrás de uma regra catch-all sem
  engolir o correio pessoal do domínio

## Deploy

1. Autentique o Wrangler:

   ```sh
   npx wrangler login
   ```

2. Configure o seu domínio. Nada que identifique a sua instalação vive no
   repositório — tudo vem do `.env`, que é git-ignorado:

   ```sh
   cp .env.example .env
   $EDITOR .env          # preencha RECIPIENT_REGEX com o seu domínio
   ```

3. Publique o worker:

   ```sh
   npm run deploy
   ```

   O script lê o `.env` e repassa cada variável ao wrangler como `--var`
   (o wrangler não lê `.env` para dentro das vars do worker por conta
   própria — `--env-file` alimenta só o ambiente dele). Ele recusa o deploy
   se `RECIPIENT_REGEX` estiver faltando, porque um worker sem essa var
   descarta silenciosamente todo e-mail que chega.

4. No dashboard da Cloudflare do seu domínio, em
   **Email → Email Routing**:
   - em **Settings**, habilite **Subaddressing** (plus addressing) — é o que
     faz a regra de `whatsappmcp` casar com todos os `whatsappmcp+<detalhe>`
   - em **Routing rules**, crie uma regra com o endereço **`whatsappmcp`**,
     ação **Send to a Worker** → `whatsapp-mcp-license-worker`

   Não é preciso (e não é recomendado) colocar o worker no catch-all: com a
   regra exata, só o correio de licença chega aqui e o resto do domínio
   continua exatamente como está. `FALLBACK_ADDRESS` só faz sentido se você
   resolver mesmo assim usar catch-all.

   O MX e o SPF do domínio já estão no Cloudflare — nada mais para mexer no
   DNS.

5. Para conferir depois de uma ativação: **Workers →
   whatsapp-mcp-license-worker → Logs**, ou `wrangler tail`. O
   `wrangler.toml` já traz `[observability] enabled = true`; sem isso o
   Cloudflare não retém nada e uma exceção vira só um contador de erro.

### Por que a verificação de remetente existe

Este código é público, então o formato do endereço é público: qualquer pessoa
pode escrever para ele. E o redirect que o worker segue resolve para o destino
que quem montou aquela campanha escolheu. Sem checar remetente, o worker é um
buscador de URLs que qualquer um aponta para onde quiser. O limite de
`maxLinks` e o corte do corpo em `maxScanBytes` fecham a mesma porta pelo lado
do volume: uma mensagem com dezenas de links não é uma licença, é alguém
usando o worker para disparar requisições.

### Testar sem passar pelo painel

Encaminhar o e-mail do seu Gmail **não funciona mais**, e é assim que deve
ser: o `From` passa a ser você, e a verificação rejeita. Para um teste de
ponta a ponta, peça uma ativação real pelo painel. Para iterar no parser sem
e-mail nenhum, use `npx wrangler dev`, que expõe `/cdn-cgi/handler/email`
localmente e aceita um `.eml` cru via POST.

Se precisar mesmo encaminhar, aponte `SENDER_REGEX` para o seu próprio
domínio durante o teste. O texto abaixo vale para esse caso: encaminhe para
`whatsappmcp+<qualquer-coisa>@example.com` (o sufixo depois do `+` precisa
casar `[a-z0-9-]+`) com o `wrangler tail` aberto. **O worker clica de verdade
no link**: encaminhe um e-mail já usado se não quiser consumir um token — o
log ainda mostra o `GET`, o status e a URL final, que é o pipeline inteiro
menos o efeito no licenciador.

## Testes

```sh
node --test
```

Sem dependências: só a biblioteca padrão do Node (o worker em si roda no
runtime do Cloudflare, que fornece `fetch` e a API de Email Workers).

## Como isso se liga ao WhatsApp MCP

O painel do [whatsapp-mcp](https://github.com/BrOrlandi/whatsapp-mcp)
registra a licença com um endereço `whatsappmcp+<id-aleatório>@example.com`
quando a variável `EVOLUTION_LICENSE_AUTO` está habilitada (padrão). O e-mail
cai neste worker, o worker clica, e o painel conclui. Com a variável em
`false`, o painel usa o ciclo manual: o operador informa o próprio e-mail e
clica no link ele mesmo.

# MBC-14.2 — Cloudflare Tunnel de produção

Classificação: **INFRAESTRUTURA DE PRODUÇÃO PREPARADA**

**PREPARADA, AGUARDANDO CONFIGURAÇÃO REAL DO CLOUDFLARE.**

**TUNNEL DE PRODUÇÃO AINDA NÃO ATIVADO POR AUSÊNCIA DE DOMÍNIO/CREDENCIAIS/CONFIGURAÇÃO REAL.**

Decisão: **NO-GO**

Mercado Pago: **NÃO HOMOLOGADO**

## Arquitetura

```
INTERNET → CLOUDFLARE (HTTPS) → HOSTNAME PERMANENTE
  → TUNNEL NOMEADO → http://127.0.0.1:3010
  → Gateway OAuth Mercado Pago → Motor Bancário → SQLite local
```

ERP permanece em `127.0.0.1:3001` e **não** entra no Tunnel.

## Por que Quick Tunnel não é produção

`trycloudflare.com` gera URL aleatória, sem hostname permanente, sem controle operacional. Proibido nesta sprint.

## Isolamento

O ingress oficial aponta **somente** para `http://127.0.0.1:3010`.

Proibido: `localhost:3001`, `127.0.0.1:3001`, `/`, `/api/vendas`, `/api/financeiro`, `/api/bancario` completo, `/storage`, SQLite, frontend.

Última regra de ingress: `http_status:404`.

O gateway continua em **127.0.0.1:3010** (não `0.0.0.0`).

## Hostname

Variável: `CLOUDFLARE_TUNNEL_HOSTNAME`

Sem valor padrão. Ausência = **NÃO CONFIGURADO**.

Não gravar domínio ilustrativo no código.

Quando houver hostname real, a Redirect URI conceitual será:

`https://<HOSTNAME_REAL>/api/bancario/mercado-pago/oauth/callback`

`MERCADO_PAGO_OAUTH_REDIRECT_URI` **não** é preenchida automaticamente nesta sprint.

## Variáveis

| Variável | Segredo? |
|---|---|
| `CLOUDFLARE_TUNNEL_ID` | identificador — não inventar |
| `CLOUDFLARE_TUNNEL_HOSTNAME` | não inventar |
| `CLOUDFLARE_CREDENTIALS_FILE` | caminho da credencial — arquivo fora do Git |

Token de serviço Cloudflare, se existir, **não** vai para código, frontend, SQLite, API ou console.

## Instalação cloudflared (Windows) — não executar automaticamente

Pré-requisito operacional. Nesta máquina: **não instalado**.

1. Obter o instalador oficial da Cloudflare (conta/documentação da empresa).
2. Instalar `cloudflared` sem atualização automática pelo CDS.
3. Autenticar na conta oficial (`cloudflared tunnel login`) no equipamento autorizado.
4. Criar Tunnel **nomeado** (não Quick Tunnel).
5. Associar DNS do hostname permanente ao Tunnel.
6. Gerar/usar arquivo de credencial local (fora do repositório).
7. Só então preencher as variáveis de ambiente.

Não baixar nem instalar pelo Motor Bancário.

## Modelo de configuração (somente com IDs reais)

```
tunnel: <TUNNEL_ID_REAL>
credentials-file: <CAMINHO_CREDENCIAL_REAL>
ingress:
  - hostname: <HOSTNAME_REAL>
    service: http://127.0.0.1:3010
  - service: http_status:404
```

Função `montarYamlTunnel()` devolve `null` se faltar qualquer item. Não gera YAML operacional no repositório.

## Serviço Windows

Em produção, três processos separados:

- CDS ERP (3001, local)
- Gateway OAuth (`npm run start:mercado-pago-oauth`)
- `cloudflared` como serviço Windows apontando ao YAML real

**Não** instalar o serviço nesta sprint sem credenciais reais.

O Tunnel **não** entra no boot do `server.js`.

Script de recusa segura: `npm run start:cloudflare-tunnel` (sai com erro se não configurado; não inicia Quick Tunnel).

## HTTPS

TLS termina na Cloudflare. O Express do gateway permanece HTTP local. Sem certificado manual nesta sprint.

## Health

`GET http://127.0.0.1:3010/health` → `{ status, servico }`

Sem versão interna, credencial, banco ou token.

Teste externo `https://<HOSTNAME>/health` **somente** com domínio/Tunnel reais. Não realizado.

## Rollback

Parar/desinstalar `cloudflared`. ERP, SQLite, MBC, vendas, financeiro e PDV permanecem. Apenas a exposição externa do callback some.

## Critérios de ativação (GO)

Domínio real, hostname real, Tunnel nomeado, credenciais válidas, cloudflared instalado, 3010 no ar, HTTPS, callback no 3010, 3001 não exposto, SQLite não exposto, testes de segurança.

Qualquer falta: **NO-GO**.

## Troubleshooting

- 404 em tudo: ingress catch-all ativo ou hostname errado.
- ERP visível: configuração inválida — corrigir para só 3010.
- URL `trycloudflare.com`: não é produção.
- Gateway inacessível: confirmar `127.0.0.1:3010` e `npm run start:mercado-pago-oauth`.

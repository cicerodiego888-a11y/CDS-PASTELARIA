# MBC-14.1 — Callback OAuth Mercado Pago + gateway local

Classificação: **PREPARAÇÃO DE CALLBACK CONCLUÍDA.**

Mercado Pago **não** está homologado. Sem chamada à API, sem token, sem cadastro de Redirect URL no painel.

## Portas

| Serviço | Endereço |
|---|---|
| ERP | `http://localhost:3001` (inalterado, JWT) |
| Gateway callback | `http://127.0.0.1:3010` somente |

Host do gateway: **127.0.0.1** (não `0.0.0.0`).

Porta do gateway: `MERCADO_PAGO_OAUTH_CALLBACK_PORT` (padrão **3010**).

## Rotas do gateway

- `GET /health` → `{ "status": "ok", "servico": "callback-oauth-mercado-pago" }`
- `GET /api/bancario/mercado-pago/oauth/callback` → `state`, `code`, `error`, `error_description`
- Qualquer outra rota → **404**

Não serve frontend, ERP, PDV, vendas, financeiro, bancário genérico nem arquivos estáticos.

`/api/bancario` no ERP **continua** atrás de `verificarToken`. Este gateway **não** usa JWT.

## Segurança

Autoridade: state MBC-06 (aleatório, TTL, uso único, vínculo empresa/conta/config/consentimento).

`req.query.empresa_id` e `req.body.empresa_id` **não** são autoridade.

State inválido / ausente / expirado / consumido → HTTP 400, texto: **Autorização inválida.** (sem detalhe interno).

Sucesso: **Autorização recebida. Você pode retornar ao CDS.**

Falha: **Não foi possível concluir a autorização.**

Resposta **não** inclui `code`, token, `state`, verifier ou secret.

## PKCE

Preparação S256. Verifier só no servidor / `ISecretStore`. Não vai ao frontend nem à URL de autorização. Não é logado.

## Redirect URI

`MERCADO_PAGO_OAUTH_REDIRECT_URI` — sem padrão. Ausente ou `http://` / `localhost` → `NAO_CONFIGURADO`.

URL local do gateway **não** é a Redirect URL do Mercado Pago. O túnel HTTPS apontará para:

`https://<hostname-publico>/api/bancario/mercado-pago/oauth/callback`

→ destino local `http://127.0.0.1:3010/...`

Hostname do túnel **não** fica no código.

## SecretStore

Mesmo `ISecretStore`. Gateway não guarda token. `OF_MOCK_REF` só para MOCK / MOCK_OPEN_FINANCE.

## Execução

```
npm run start:mercado-pago-oauth
```

O ERP (`npm start` / porta 3001) **não** inicia este gateway automaticamente.

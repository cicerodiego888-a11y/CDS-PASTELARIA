# IMPLEMENTAÇÃO MBC-15

SPRINT: MBC-15

STATUS: **CONCLUÍDA COM RESSALVAS**

Classificação: **OAUTH IMPLEMENTADO — HOMOLOGAÇÃO REAL PENDENTE**

Não declarar Mercado Pago integrado para saldo/extrato.  
Não declarar OAuth ponta a ponta homologado em produção sem o teste real controlado do usuário.  
Não declarar banco conectado.

## Objetivo

Fechar o fluxo OAuth real Authorization Code + PKCE S256 do Mercado Pago, reutilizando a infraestrutura MBC-01…14.4.1.

## Arquitetura utilizada

```
EMPRESA → CONTA_BANCARIA → CONFIG_INTEGRACAO_BANCARIA
  → Client ID (aplicacao_ref) + Client Secret (mbc.config.{id})
  → Consentimento/state (MBC-06)
  → PKCE S256 (SecretStore)
  → Authorization URL oficial Mercado Pago
  → Callback gateway 3010
  → POST https://api.mercadopago.com/oauth/token
  → Tokens em mbc.oauth.mercadopago.{configId}
  → Status AUTORIZADO
```

## Arquivos alterados / criados

| Arquivo | Papel |
|---------|--------|
| `backend/motores/bancario/providers/mercadopago/MercadoPagoOAuthClient.js` | URL + troca de token (contrato oficial) |
| `backend/motores/bancario/services/MercadoPagoOAuthService.js` | iniciar / status / desconectar |
| `backend/motores/bancario/providers/openfinance-real/OpenFinanceRealBankProvider.js` | caminho OAuth MP sem liberar sync |
| `backend/motores/bancario/services/ConsentimentoOpenFinanceService.js` | passa config/PKCE no fluxo |
| `backend/motores/bancario/MotorBancarioService.js` | API de domínio OAuth |
| `backend/rotas/bancario.js` | endpoints protegidos |
| `backend/mercado-pago/oauth-callback-server.js` | mensagens sucesso/negado |
| `frontend/erp/pages/contas-bancarias.html` | aba Autorização |
| `frontend/erp/js/contas-bancarias.js` | Autorizar / status / desconectar |
| `backend/motores/bancario/version.js` | SPRINT = MBC-15 |
| `tests/bancario/motor-bancario-15.test.js` | suite MBC-15 |
| `docs/bancario/MBC-15-RELATORIO.md` | este relatório |

Ajustes de regressão em asserts históricos de “sem oauth” (MBC-01/03/04/05) e sprint flexível (14.x).

## Endpoints

- `POST /api/bancario/configuracoes/:id/oauth/autorizar` → `{ ok, authorization_url }`
- `GET /api/bancario/configuracoes/:id/oauth/status` → status seguro
- `POST /api/bancario/configuracoes/:id/oauth/desconectar` → remove tokens locais

Callback (sem JWT): `GET /api/bancario/mercado-pago/oauth/callback` no gateway 3010.

## Fluxo OAuth

1. Validar JWT, empresa, conta, config ativa, provider, Client ID/Secret, Redirect URI HTTPS  
2. Criar/reutilizar consentimento + state (TTL 10 min, uso único)  
3. Gerar PKCE S256; verifier só no SecretStore  
4. Abrir `https://auth.mercadopago.com/authorization` com `platform_id=mp`  
5. Callback valida state → troca code (sem retry automático)  
6. Persiste access/refresh + metadados no SecretStore  
7. Consentimento AUTORIZADO; UI “Autorização concluída”

## PKCE / State / SecretStore

- PKCE: módulo existente `backend/mercado-pago/pkce.js`  
- Redirect: `MERCADO_PAGO_OAUTH_REDIRECT_URI` via `redirectUri.js`  
- Tokens: `mbc.oauth.mercadopago.{configId}` (JSON; nunca SQLite plaintext)  
- Credenciais app: `mbc.config.{configId}` (inalterado MBC-14.4)  
- `expires_at` = now + `expires_in` − **60 s** de margem

## Erros mapeados

`invalid_client`, `invalid_grant`, `invalid_scope`, `unauthorized_client`, `429` → mensagens amigáveis; logs sanitizados.

## Testes

| Suite | Resultado |
|-------|-----------|
| MBC-15 | **pass** |
| MBC-01 … MBC-14.4.1 | **pass** (regressão completa) |
| Financeiro 05.38.D / 05.41, Caixa 05.38.C, Vendas 05.40, Compras 05.64 | **pass** |

## Homologação real

**Pendente.** Requer no ambiente do usuário:

1. `MERCADO_PAGO_OAUTH_REDIRECT_URI` HTTPS (Cloudflare → 3010)  
2. Gateway `npm run start:mercado-pago-oauth`  
3. Credenciais reais já configuradas no CDS  
4. Fluxo Autorizar → Mercado Pago → callback → AUTORIZADO  

Nenhum secret/token/code foi registrado neste relatório.

## Limitações

- Sem saldo/extrato/sincronização reais  
- Sem refresh automático  
- Desconectar = somente local (sem revogação remota afirmada)  
- Uma autorização operacional por conta/provider (modelo MBC-06)

## Próximo passo

MBC-15.x — homologação real controlada + refresh token + operação bancária quando houver contrato.

## Status final

**CONCLUÍDA COM RESSALVAS** — OAuth implementado e coberto por testes automatizados; homologação real ponta a ponta ainda pendente do ambiente do usuário.

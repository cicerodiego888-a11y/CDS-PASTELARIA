# MBC-15.1 — Bootstrap Gateway OAuth Mercado Pago

## STATUS

**INFRAESTRUTURA OAUTH CORRIGIDA** (testes automatizados)

Homologação E2E real Mercado Pago: **pendente** neste ambiente (requer Cloudflare + Redirect URI + conta MP).

## CAUSA RAIZ

ERP e Gateway 3010 são processos Node independentes.

1. O Gateway **não** executava bootstrap de `DB_DIR` / `MBC_SECRET_STORE_KEY`.
2. Fallback da chave em `garantirMbcSecretStoreKey` apontava para pasta diferente (`CDS Sistemas`) do banco oficial (`MercantilFiscal/dados`).
3. Callback engolia erros como “Autorização inválida.” sem código MBC no log interno.

## ERP DB_DIR

Origem oficial:

- Electron: `process.env.DB_DIR` ou `ProgramData/MercantilFiscal/dados`
- `backend/database.js`: mesmo fallback → `mercadao.db`

## Gateway DB_DIR

Agora usa `bootstrapAmbienteOperacionalMbc()` → **mesmo** `DB_DIR` / `mercadao.db`.

## SecretStore

- Mesma rotina: `garantirMbcSecretStoreKey`
- Mesma tabela: `mbc_secret_store`
- Mesma chave de ambiente / arquivo `mbc-secret-store.key` em `DB_DIR`

## Redirect URI

- Somente `MERCADO_PAGO_OAUTH_REDIRECT_URI` (HTTPS, sem localhost)
- Sem hardcode / sem valor padrão inventado
- Gateway recusa iniciar se ausente

## PKCE

Inalterado (MBC-15): S256; verifier só no SecretStore; apagado após sucesso.

## Callback

- Continua sem JWT
- Usuário: “Não foi possível concluir a autorização.” em falhas internas
- Log interno sanitizado com `codigo_erro`, `status_http`, `consentimento_id` (sem secrets)

## Correções

1. `bootstrapAmbienteOperacionalMbc` compartilhado
2. Gateway chama bootstrap antes de escutar
3. Fallback de chave alinhado a `MercantilFiscal`
4. `/health` com indicadores não sensíveis (`db_configurado`, `cofre_disponivel`, `redirect_uri_configurado`)
5. Observabilidade de erro do callback

## Arquivos alterados

| Arquivo | Mudança |
|---------|---------|
| `backend/motores/bancario/secrets/bootstrapAmbienteOperacionalMbc.js` | Novo bootstrap |
| `backend/motores/bancario/secrets/garantirMbcSecretStoreKey.js` | Fallback = MercantilFiscal |
| `backend/mercado-pago/oauth-callback-server.js` | Bootstrap + health + logs |
| `backend/server.js` / `electron.js` | Usam bootstrap compartilhado |
| `tests/bancario/motor-bancario-15-1.test.js` | Novos testes |
| `tests/bancario/motor-bancario-15.test.js` | Passa `env` ao gateway |
| `docs/bancario/MBC-15.1-RELATORIO.md` | Este relatório |

## Testes / Regressões

| Suite | Resultado |
|-------|-----------|
| MBC-15.1 | **10/10 pass** |
| MBC-14.1 / 14.4.2 / 15 | **pass** |
| MBC-01 … MBC-08 | **258/258 pass** |
| MBC-09 | **85/85 pass** |
| MBC-10 … MBC-13 | **218/218 pass** |

Homologação E2E real: **não executada** nesta sessão.

## Homologação real

Pendente. Passos: ERP + Gateway 3010 + Cloudflare + Redirect URI env + autorizar no CDS.

## Pendências

- Definir `MERCADO_PAGO_OAUTH_REDIRECT_URI` no ambiente do Gateway/ERP
- Executar fluxo real e registrar evidências sem segredos

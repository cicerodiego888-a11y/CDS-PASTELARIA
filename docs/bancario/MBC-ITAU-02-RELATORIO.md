# MBC-ITAU-02 — RELATÓRIO

STATUS: **CONCLUÍDO — E2E REAL BLOQUEADO POR CREDENCIAIS/PORTAL**

## 1. Objetivo

Implementar a camada de domínio/adapter para:

- consultar **saldo real** Itaú;
- consultar **extrato/movimentações**;
- normalizar para o MBC;
- persistir com **idempotência**;
- sincronizar com **checkpoint** existente;
- separar **saldo real** × **saldo conceitual MBC**;

sem fingir conexão real com o portal Itaú.

---

## 2. Estado anterior

- MBC-ITAU-01 / 01.1: provider ITAU registrado, OAuth Client Credentials, mTLS, SecretStore, teste de conexão.
- `consultarSaldo` / `listarTransacoes` retornavam 501.
- Sync genérico exigia consentimento Open Finance (bloqueava Itaú).
- UI de sync só liberava com OAuth Mercado Pago.

---

## 3. Auditoria (resumo)

| Item | Decisão |
|------|---------|
| Contrato `IBankProvider` | Já tinha `consultarSaldo` / `listarTransacoes`; sync no serviço MBC |
| Persistência | Reutilizar `transacao_bancaria` + `TransacaoBancariaService.registrar` |
| Checkpoint | Reutilizar `sincronizacao_bancaria` + loop genérico MBC-07/16.3 |
| Mercado Pago | Continua via Settlement Report; **não** alterado no fluxo dedicado |
| Endpoints saldo/extrato | **Não inventados** — configuráveis via env |

---

## 4. Arquivos alterados / criados

### Criados
- `backend/motores/bancario/contracts/SaldoBancarioNormalizado.js`
- `backend/motores/bancario/providers/itau/ItauApiClient.js`
- `backend/motores/bancario/providers/itau/ItauMapper.js`
- `backend/motores/bancario/services/ItauOperacaoService.js`
- `tests/bancario/motor-bancario-itau-02.test.js`
- `docs/bancario/MBC-ITAU-02-RELATORIO.md`

### Evoluídos
- `ItauBankProvider.js` — saldo/extrato + `suportaSincronizacao=true`
- `ItauConstants.js` — paths/URLs configuráveis; `EXTERNAL_SOURCE=ITAU`
- `ItauOAuthClient.js` — reutilizado (agent mTLS / classificação TLS)
- `SincronizacaoBancariaService.js` — ramo ITAU sem OF consent; auth via SecretStore
- `MotorBancarioService.js` — `consultarSaldoReal` / `consultarExtratoConta`
- `backend/rotas/bancario.js` — `GET .../saldo-real`; extrato com `fonte=PROVIDER`
- `TransacaoBancariaNormalizada.js` — aliases CREDIT/DEBIT → entrada/saida
- Frontend Contas Bancárias — botões saldo/extrato/sync Itaú
- `version.js` → `MBC-ITAU-02`
- Docs de configuração Itaú

---

## 5. Arquitetura

```
MBC CORE
  → IBankProvider
      → ItauBankProvider (OAuth + mTLS + GET saldo/extrato)
      → OpenFinanceReal / Mercado Pago (intactos)
  → SincronizacaoBancariaService (persistência + checkpoint)
  → TransacaoBancariaService (idempotência)
```

O core **não** conhece URLs, headers Bearer nem certificados Itaú.

---

## 6. Contrato IBankProvider

Compatível. Sem método `sincronizar` no provider (permanece no serviço).  
Itaú: `suportaSincronizacao = true`.

---

## 7. Adapter Itaú

| Peça | Função |
|------|--------|
| `ItauOAuthClient` | Token Client Credentials + cache |
| `ItauApiClient` | GET autenticado; mTLS; `rejectUnauthorized: true` |
| `ItauMapper` | Payload → DTO MBC |
| `ItauOperacaoService` | Carrega secrets + orquestra consulta live |
| `ItauBankProvider` | `consultarSaldo` / `listarTransacoes` |

---

## 8. Saldo real

DTO: `SaldoBancarioNormalizado`  
Campos: `available_balance`, `current_balance`, `currency`, `as_of`, `source=PROVIDER`, `natureza=informado_banco`, `valor` (compat sync).

Rotas:
- `GET /api/bancario/contas/:id/saldo-real` — consulta live (Itaú)
- `GET /api/bancario/contas/:id/saldo-bancario` — último saldo sincronizado + conceitual

**Não** substitui saldo conceitual.

---

## 9. Extrato

Mapper normaliza direção para CREDIT/DEBIT → `entrada`/`saida` (padrão interno MBC).  
Valor absoluto positivo. Exige `external_id`.

- Live (sem persistir): `GET .../extrato?fonte=PROVIDER`
- Persistido: `GET .../extrato` (MBC)

---

## 10. Sincronização

`POST .../sincronizar` para provider ITAU:

1. valida credenciais SecretStore  
2. **não** exige consentimento OF  
3. OAuth → saldo → páginas de extrato  
4. `registrar` (idempotente)  
5. atualiza `saldo_bancario` + cursor  

Mercado Pago: ramo Settlement Report preservado.

---

## 11. Idempotência

Canônica: `empresa_id + conta_bancaria_id + external_source(ITAU) + external_id`  
1ª: `CRIADA` · 2ª: `JÁ EXISTENTE`

---

## 12. Persistência / Checkpoint

Tabela `transacao_bancaria` e `sincronizacao_bancaria` reutilizadas. Sem tabela paralela. Sem migration nova.

---

## 13. Frontend

- Botões: **Consultar saldo real**, **Consultar extrato**, **Sincronizar**
- Itaú habilitado por credenciais (não OAuth MP)
- Sem credenciais: **“Credenciais Itaú não configuradas”** (nunca R$ 0,00 falso)
- Rótulos: Saldo real do banco × Saldo conceitual MBC

---

## 14. Segurança

- Sem secrets/tokens/PEMs em logs/respostas/UI
- Sem `rejectUnauthorized: false`
- Sanitizer de erros de sync reforçado (`private_key`, `authorization`)

---

## 15. Endpoints (configuração)

**Não inventados.** Obrigatório configurar após confirmação no portal:

| Env | Uso |
|-----|-----|
| `ITAU_PATH_SALDO` / `ITAU_SALDO_URL` | Saldo |
| `ITAU_PATH_EXTRATO` / `ITAU_EXTRATO_URL` | Extrato |
| `ITAU_API_BASE_*` / `ITAU_TOKEN_URL_*` | Base/OAuth já existentes |
| `ITAU_TLS_CA` | CA opcional |

Sem path/URL → `ENDPOINT_NAO_CONFIGURADO`.

---

## 16. Testes

| Suíte | Resultado |
|-------|-----------|
| `motor-bancario-itau-02.test.js` | OK (MOCK / integração simulada) |
| Itaú 01 + 01.1 | OK |
| Regressão `motor-bancario-*.test.js` | **747 / 747 OK** · **0 falhas** |

Cobertura 02: DTO saldo, CREDIT/DEBIT, valores/datas/external_id, endpoint não inventado, saldo+extrato mock, sync+idempotência, erros auth/TLS/timeout/credencial, MP preservado.

---

## 17. E2E real

**E2E REAL = BLOQUEADO POR CREDENCIAL/ACESSO AO PORTAL**

Não há Client ID/Secret/certificado oficiais neste ambiente.  
Testes mock **não** são “conexão real Itaú”.

---

## 18. Limitações

1. Paths de saldo/extrato dependem de confirmação oficial no portal.  
2. Sem E2E real.  
3. Sem scheduler, webhook, conciliação automática.  
4. Extrato live não persiste (só sync persiste).  
5. Lista de contas Itaú ainda 501.

---

## 19. Critério de aceite

| Critério | Status |
|----------|--------|
| Provider Itaú sem contaminar core | OK |
| IBankProvider compatível | OK |
| Mercado Pago preservado | OK |
| DTO saldo / movimentação | OK |
| Consulta saldo / extrato preparadas | OK |
| Sync + idempotência + checkpoint | OK |
| Saldo real ≠ conceitual | OK |
| Rotas / UI / secrets / TLS | OK |
| Testes + regressão | OK (747/747) |
| Docs | OK |
| Sem falso E2E | OK |

---

## 20. Próximo sprint recomendado

**MBC-ITAU-02.1 / MBC-ITAU-03 — Homologação real**

1. Liberar credenciais + certificado no portal Itaú.  
2. Configurar `ITAU_PATH_SALDO` / `ITAU_PATH_EXTRATO` (ou URLs oficiais).  
3. Executar `POST .../conexao/testar` → `GET .../saldo-real` → sync.  
4. Só então evoluir conciliação/scheduler se necessário.

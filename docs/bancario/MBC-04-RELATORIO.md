# MBC-04 — Hardening Sync + Homologação Itaú

**STATUS: CONCLUÍDO COM RESSALVAS** (E2E Itaú continua bloqueado por portal)

Sprint de hardening dos achados A01, A02, A08 e preparação A03 da auditoria MBC-03.  
Sem scheduler, webhook, conciliação automática ou novos providers.

---

## 1. Objetivo

Corrigir:

| ID | Tema |
|----|------|
| A01 | Soft-lock sync sem TTL/reclaim |
| A02 | `MAX_PAGINAS` gerando `SUCESSO` falso com dados parciais |
| A08 | `obterCredenciaisProvider` no contrato público do Motor |
| A03 | Paths Itaú configuráveis + diagnóstico tipado (sem inventar endpoint) |

---

## 2. Estado Antes

- Lock = status `SINCRONIZANDO` sem timestamp dedicado; crash podia bloquear conta indefinidamente.
- Loop de páginas com `MAX_PAGINAS=50` podia terminar em `SUCESSO` com `has_more=true`.
- `obterCredenciaisProvider` listado em `Motor.CONTRATO` (sem rota HTTP, mas superfície pública).
- Paths Itaú já exigiam env; mensagem genérica sem campo `operacao`.

---

## 3. A01 — Lock TTL/Reclaim

**Implementação**

- Coluna `lock_iniciado_em` em `sincronizacao_bancaria` (DDL + migration `ALTER` compatível).
- Config central: `backend/motores/bancario/services/syncConfig.js`
  - `SYNC_LOCK_TTL_MS` (default **15 min**)
  - `resolverSyncLockTtlMs` / `lockExpirado`
- `adquirirExecucao`: se `SINCRONIZANDO` e TTL expirado → reclaim; senão → 409.
- Mantém `BEGIN IMMEDIATE` + fila por `db`.
- `liberarLock` em `SUCESSO` / `PARCIAL` / `ERRO` (limpa `lock_iniciado_em`).
- Eventos: `SYNC_LOCK_ACQUIRED`, `SYNC_LOCK_RECLAIMED`, `SYNC_LOCK_RELEASED` (sem secrets).

**Comportamento**

| Cenário | Resultado |
|---------|-----------|
| Lock ativo dentro do TTL | 409 |
| Lock expirado | reclaim + nova execução |
| Contas diferentes | paralelo OK |
| Empresas diferentes | independente |

---

## 4. A02 — Sync Parcial

**Implementação**

- Status novo: `STATUS_SINCRONIZACAO.PARCIAL`
- `SYNC_MAX_PAGINAS` (default 50) via `syncConfig`
- Se atingir limite e `has_more === true`:
  - `status = PARCIAL`
  - `truncated = true`
  - `has_more = true`
  - cursor = última página **persistida**
  - lock liberado
  - evento `SYNC_PARTIAL`
- Não marca `SUCESSO` completo.
- Retomada: próxima sync continua do `cursor_atual` (sem `reprocessarCatalogo`).
- Idempotência preservada (UNIQUE + `JA_EXISTENTE`).

---

## 5. A08 — Contrato Público

- Removido `obterCredenciaisProvider` de `Motor.CONTRATO` e do método público do Motor.
- Mantido **apenas** em `ConfiguracaoIntegracaoBancariaService` (uso interno OAuth MP / provider OF).
- Teste MBC-14.4 T22 atualizado para chamar o service, não o Motor.

---

## 6. A03 — Itaú

- Paths continuam **somente** via env:
  - `ITAU_PATH_SALDO` / `ITAU_SALDO_URL`
  - `ITAU_PATH_EXTRATO` / `ITAU_EXTRATO_URL`
- **Nenhum path inventado.**
- Erro tipado: `errorCode = ENDPOINT_NAO_CONFIGURADO`, `operacao = SALDO|EXTRATO`, mensagem sem secret.
- E2E real: **BLOQUEADO** até portal liberar credenciais, certificado e paths oficiais.

---

## 7. Segurança

- Credenciais não retornam na API de status (inalterado).
- Lock/reclaim/partial não logam tokens/PEM/secrets.
- `obterCredenciaisProvider` fora da superfície pública do Motor.

---

## 8. Mercado Pago

- Ramo Settlement Report preservado.
- Sync MP libera lock via `liberarLock` em sucesso.
- Regressão incluída na suíte completa (0 falhas).

---

## 9. Multiempresa

- Lock e sync isolados por `(empresa_id, conta_bancaria_id, provider)`.
- Empresa B não acessa conta da empresa A (404/CONTA_NAO_ENCONTRADA).
- Testes de paralelismo multiempresa OK.

---

## 10. Concorrência

| Cenário | Resultado |
|---------|-----------|
| A: mesma conta 2× | 1ª executa / 2ª 409 |
| B: contas diferentes | paralelo OK |
| C: empresas diferentes | independente OK |

---

## 11. Banco de Dados

- `lock_iniciado_em TEXT` em `sincronizacao_bancaria`
- Migration via `garantirColunasSincronizacao` (SQLite `ALTER TABLE`)
- `foreign_keys = ON` preservado
- Sem tabela paralela

---

## 12. Observabilidade

Eventos seguros:

- `SYNC_LOCK_ACQUIRED`
- `SYNC_LOCK_RECLAIMED`
- `SYNC_LOCK_RELEASED`
- `SYNC_PARTIAL`
- `SYNC_COMPLETED`
- `SYNC_FAILED`

UI: status `PARCIAL` exibido como “Parcial (continuar sync)”.

---

## 13. Testes

Nova suíte: `tests/bancario/motor-bancario-04-hardening.test.js` (10 testes).

Cobertura: TTL, reclaim, 409, paralelo, erro libera lock, multiempresa, PARCIAL/truncated, retomada, idempotência, A03/A08.

---

## 14. Regressão

```
node --test tests/bancario/motor-bancario-*.test.js
```

| Métrica | Valor |
|---------|-------|
| PASS | **757** |
| FAIL | **0** |
| SKIP | **0** |

Comparação com referência pós-auditoria **747/747**:

- **+10 testes** (suíte MBC-04 hardening)
- Nenhuma falha / nenhum skip
- Mercado Pago + Itaú mock + multiempresa preservados

---

## 15. E2E Itaú

**BLOQUEADO** — portal sem credenciais/certificado/paths oficiais neste ambiente.  
Infraestrutura e diagnóstico prontos; sucesso real **não** foi simulado.

---

## 16. Limitações

1. E2E Itaú pendente de portal.
2. Soft-lock continua em processo único + SQLite (adequado ao deployment atual; multi-processo futuro pode exigir lock distribuído).
3. Achados MÉDIOS da auditoria MBC-03 (ex.: rename `OPEN_FINANCE_REAL` → MP) **fora deste sprint**.

---

## 17. Próximo Sprint

**MBC-05 — Homologação Itaú real (ops)** *quando o portal liberar material*:

1. Configurar `ITAU_PATH_*` / `ITAU_*_URL` oficiais.
2. Credenciais + certificado no SecretStore.
3. `conexao/testar` → `saldo-real` → sync → conferir PARCIAL/retomada se volume alto.
4. Opcional: backlog A04 (subtipo Mercado Pago) e A05 (escopo `todas`).

Não iniciar scheduler/webhook/conciliação automática sem sprint dedicado.

---

## Checklist de aceite

| Item | Status |
|------|--------|
| A01 TTL + reclaim | [x] |
| Lock liberado sucesso/erro/parcial | [x] |
| Concorrência validada | [x] |
| A02 PARCIAL + truncated | [x] |
| Checkpoint preservado + retomada | [x] |
| A08 fora do contrato público | [x] |
| A03 configurável + ENDPOINT_NAO_CONFIGURADO | [x] |
| Sem endpoint inventado | [x] |
| Mercado Pago / multiempresa / segurança | [x] |
| 0 FAIL / 0 SKIP | [x] |
| Relatório | [x] |

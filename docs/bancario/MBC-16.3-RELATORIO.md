# IMPLEMENTAÇÃO MBC-16.3

SPRINT: MBC-16.3

## 1. STATUS

**CONCLUÍDA COM RESSALVAS**

## 2. CLASSIFICAÇÃO

**SINCRONIZAÇÃO REAL IMPLEMENTADA — HOMOLOGAÇÃO E2E PENDENTE**

Não declarar: “Mercado Pago homologado.”  
Não declarar: “integração de produção concluída.”

## 3. OBJETIVO

Sincronização operacional do Settlement Report real com:

- sequência de arquivos/relatórios;
- checkpoint interno seguro;
- persistência via MBC-16.2 → MBC-03;
- continuidade após falha;
- concorrência MBC-07;
- sem scheduler / webhook / conciliação automática.

## 4. CONTRATO MERCADO PAGO UTILIZADO

Reutilizado do MBC-16.1:

| Método | Path |
|--------|------|
| GET/POST/PUT | `/v1/account/settlement_report/config` |
| POST | `/v1/account/settlement_report` |
| GET | `/v1/account/settlement_report/list` |
| GET | `/v1/account/settlement_report/:file_name` |

Autenticação: `Authorization: Bearer <ACCESS_TOKEN>` (SecretStore MBC-15).

Limite oficial de período do relatório: **60 dias**.

## 5. PAGINAÇÃO

O Settlement Report **não** oferece cursor tradicional de transações (`next_cursor` / `has_more` de extrato).

A “paginação” modelada é a **sequência de arquivos/relatórios** retornados por `/list` com `status=processed`, ordenados por data de geração.

Não inventamos `page=1..n` nem offset de movimentos.

## 6. CURSOR/CHECKPOINT

Checkpoint **interno CDS** (não é cursor oficial Mercado Pago):

- Campo reutilizado: `sincronizacao_bancaria.cursor_atual`
- Formato JSON `kind: mp_settlement_checkpoint_v1`
- Contém: `last_safe_report_key`, `processed_report_keys`, `last_file_name`, `last_end_date`
- Isolado por `empresa_id + conta_bancaria_id + provider`

Nomenclatura: **checkpoint_interno / cursor_interno**.

## 7. FLUXO DE SINCRONIZAÇÃO

```
POST /api/bancario/contas/:id/sincronizar
  → valida conta/config/provider
  → OAuth AUTORIZADO (MBC-15)
  → lock MBC-07 (SINCRONIZANDO / 409)
  → Settlement Report (criar/listar/baixar)
  → Mapper 16.1 → Persistencia 16.2 → MBC-03
  → atualiza checkpoint SOMENTE após persistir
  → SUCESSO | ERRO
```

## 8. IDEMPOTÊNCIA

Exclusivamente MBC-03:

`empresa_id + conta_bancaria_id + MERCADO_PAGO_SETTLEMENT_REPORT + SOURCE_ID`

## 9. CONTINUIDADE APÓS FALHA

- Página/arquivo 1 persistido → checkpoint seguro
- Falha no arquivo 2 → status ERRO; 10 registros permanecem
- Nova sync → reprocessa ponto seguro (JA_EXISTENTE) + processa restante
- Total final sem duplicata

## 10. CONCORRÊNCIA

Reutiliza soft-lock MBC-07:

- mesma conta → HTTP 409 / `SINCRONIZACAO_EM_ANDAMENTO`
- contas distintas → permitido

## 11. RETRY

Orquestração com taxonomia do Client 16.1:

- Retry limitado (máx. 2 extras): timeout, 429, indisponibilidade
- Respeita `Retry-After` (cap seguro)
- Sem retry: 401, 403, OAuth inválido, dados inválidos

## 12. MULTIEMPRESA

Isolamento por empresa/conta; `empresa_id` de body/query não transfere propriedade.

## 13. SEGURANÇA

Token somente no SecretStore. Sem token em resposta, checkpoint, raw_reference ou logs de operação.

## 14. PERSISTÊNCIA

Somente via `MercadoPagoPersistenciaService` → `TransacaoBancariaService.registrar`.  
Provider/client **não** fazem INSERT.

## 15. FINANCEIRO

Não cria financeiro / CR / CP / venda / compra / caixa.

## 16. CONCILIAÇÃO

MBC-04 e MBC-08 intocados. Sem matching automático.

## 17. TESTES

`tests/bancario/motor-bancario-16-3.test.js` — **11/11 pass** (T01–T45 cobertos).

## 18. REGRESSÕES

| Suite | Resultado |
|-------|-----------|
| MBC-01 … MBC-16.3 (`tests/bancario/*.test.js`) | **688/688 pass** |
| Financeiro 05.38.D / 05.41, Caixa 05.38.C, Vendas 05.40, Compras 05.64 | **5/5 pass** |

## 19. HOMOLOGAÇÃO REAL

**Pendente** até execução E2E com OAuth + Settlement Report reais.

## 20. LIMITAÇÕES

- Sem scheduler / cron / sync automática
- Sem webhook
- Sem refresh automático de token
- Sem UI operacional completa (MBC-16.4)
- Saldo síncrono continua indisponível neste contrato

## 21. PRÓXIMO MARCO

**MBC-16.4** — UI operacional, status, “Sincronizar agora”, extrato, tratamento visual PROCESSANDO/ERRO/CONCLUÍDO, homologação E2E.

# Relatório — Implementação 03.12
## Porta pública intacta + fundação de acesso a estoque_empresa

**Data:** 2026-08-21 · **Status:** concluída (camada isolada)

---

## 1. Auditoria

Schema 03.11 confirmado em `estoqueEmpresaSchema.js`:

`id`, `produto_id`, `empresa_id`, `saldo_fiscal`, `saldo_nao_fiscal`, `estoque_atual`, `reservado_fiscal`, `reservado_nao_fiscal`, `created_at`, `updated_at`.  
`UNIQUE(produto_id, empresa_id)`.

Porta pública real: `backend/services/fiscalNaoFiscal/estoqueSaldosPublico.js` — ainda lê `produtos`. Não foi alterada.

---

## 2. Arquivos

| Arquivo | Ação |
|---|---|
| `backend/services/estoque/EstoqueEmpresaService.js` | criado |
| `tests/estoque/estoque-empresa-service-03-12.test.js` | criado |
| `tests/estoque/estoque-empresa-schema.test.js` | ajuste: porta não usa o service (Windows case-insensitive) |
| `docs/arquitetura/IMPLEMENTACAO_03_12_ACESSO_ESTOQUE_EMPRESA.md` | criado |
| `docs/arquitetura/IMPLEMENTACAO_03_12_RELATORIO.md` | criado |

Nenhum arquivo operacional alterado (porta, motores, compras, vendas, PDV, CREATE, Repair, COMPAT).

---

## 3. Testes

| # | Cenário |
|---|---|
| 01 | Schema disponível |
| 02 | Consulta exige empresaId |
| 03 | Consulta sem registro |
| 04 | Criar registro explicitamente (zeros; produtos intacto) |
| 05 | Não duplicar produto + empresa |
| 06 | Empresas independentes |
| 07 | db injetável |
| 08 | Consulta não cria registro; porta continua em produtos |

---

## 4. Regressão

| Suite | Resultado |
|---|---|
| `estoque-empresa-service-03-12.test.js` | 8/8 OK |
| `estoque-empresa-schema.test.js` (03.11) | 8/8 OK |
| `porta-publica-saldos-multiempresa.test.js` | 17/17 OK |
| `create-produto-saldo-inicial-porta-publica.test.js` (03.8) | 10/10 OK |
| `reserva-repair-porta-publica.test.js` (03.7) | 10/10 OK |
| `consumo-reserva-pedido-porta-publica.test.js` (03.6) | 10/10 OK |
| `revert-devolucao-venda-porta-publica.test.js` (03.5) | 10/10 OK |
| `muc-public-contract.test.js` | 20/20 OK |

O teste 07 da 03.11 passou a verificar que a **porta** não usa `EstoqueEmpresaService` (em vez de proibir o arquivo da camada isolada).

---

## 5. Limitações

- Tabela pode continuar vazia em produção.
- Sem backfill.
- Sem fallback para `produtos`.
- Porta pública **não** usa esta camada.
- Sem operações de débito/crédito nesta Sprint.

---

## 6. Próximo passo recomendado

Não iniciar nesta entrega. Quando autorizado: dual-write opcional ou backfill explícito **depois** de contrato estável — ainda sem desligar `produtos`.

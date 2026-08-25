# AUDITORIA 05.38.G.A — Schema de Vendas

**Classificação:** SOMENTE LEITURA  
**Data:** 2026-08-24  
**Fonte:** `backend/database.js`, `backend/services/vendas/*`, `backend/motores/muv/*`, tabelas relacionadas

---

## 1. Pergunta central

### A tabela `vendas` possui `empresa_id`?

**NÃO.**

Evidência:

- DDL inicial (`database.js` ~L1838): colunas `codigo`, `data_venda`, `cliente_id`, `total`, `caixa_id`, etc. — **sem `empresa_id`**.
- Lista de `ALTER TABLE vendas` em `database.js` (L145–151, L345–368, L430–440): inclui `caixa_sessao_id`, `origem`, `valor_fiscal`, `pedido_id`, etc. — **nenhum `ADD COLUMN empresa_id`**.
- Índice `idx_vendas_empresa_id`: **AUSENTE**.

### Onde a empresa existe hoje?

| Camada | Persistência | Evidência |
|--------|--------------|-----------|
| **Venda (`vendas`)** | **Não** | INSERTs não incluem `empresa_id` |
| **Atendimento MUV** | **Sim** | `atendimento_operacoes.empresa_id` + `venda_id` |
| **Caixa sessão** | **Sim** | `caixa_sessoes.empresa_id` (05.38.C); venda guarda `caixa_sessao_id` |
| **Financeiro** | **Sim** | `financeiro.empresa_id` no INSERT (05.38.D) |
| **Contas a receber** | **Sim** | `contas_receber.empresa_id` no INSERT |
| **NFC-e** | **Parcial** | `nfce_notas.empresa_id` (coluna garantida); preenchida só se emissor receber `empresaId` |
| **Estoque** | **Operacional** | `estoque_empresa` via `req.empresaId`; senão COMPAT→`produtos` |
| **Pagamentos** | **Não** | `venda_pagamentos` sem `empresa_id` |
| **Itens** | **Não** | `vendas_itens` sem `empresa_id` |
| **Devoluções** | **Não** | `vendas_devolucoes` sem `empresa_id` |

**Conclusão:** empresa é **contexto temporário da requisição** + **colunas em entidades satélite**, não **identidade persistida da venda**.

---

## 2. Tabela `vendas`

| Campo | Evidência |
|-------|-----------|
| PK | `id INTEGER PRIMARY KEY AUTOINCREMENT` |
| FKs declaradas | `cliente_id → clientes`, `caixa_id → caixa` |
| **`empresa_id`** | **AUSENTE** |
| Vínculo caixa | `caixa_sessao_id`, `caixa_id`, `terminal_id`, `operador_id` |
| Fiscal comercial | `valor_fiscal`, `valor_nao_fiscal`, `status_pagamento` |
| Origem | `origem TEXT DEFAULT 'PDV'` |
| Pedido | `pedido_id` |
| Entrega | `tipo_venda`, `status_entrega`, campos de endereço |
| Cancelamento | `cancelada`, `data_cancelamento`, `status` |

**INSERT oficial (produção):** ver seção Writers — **nenhum inclui `empresa_id`**.

---

## 3. Tabelas relacionadas (matriz)

| Tabela | `empresa_id`? | FK empresas? | Origem do contexto | Persistência na operação | Risco |
|--------|---------------|--------------|--------------------|--------------------------|-------|
| `vendas` | **Não** | — | `req.empresaId` (não gravado) | **Não** | **P0** |
| `vendas_itens` | **Não** | — | Herdaria venda (inexistente) | — | P2 |
| `venda_pagamentos` | **Não** | — | Caixa/sessão/contexto HTTP | **Não** | P1 |
| `venda_recebimentos` | **Não** | — | Idem | **Não** | P1 |
| `vendas_devolucoes` | **Não** | — | `req.empresaId` no estorno | **Não** | P1 |
| `vendas_canceladas` | **Não** | — | — | — | P2 |
| `financeiro` | **Sim** (05.38.D) | Sim | `req.empresaId` na criação | **Sim** | P1 se ≠ venda futura |
| `contas_receber` | **Sim** | Sim | `req.empresaId \|\| null` | **Sim** | P1 |
| `caixa_sessoes` | **Sim** (05.38.C) | Sim | Abertura caixa | **Sim** | P1 indireto |
| `estoque_empresa` | **Sim** | Sim | `req.empresaId` ou COMPAT | **Sim** (movimento) | P0 se COMPAT |
| `produtos` | **Não** (global) | — | Fallback COMPAT | Legado | P1 |
| `nfce_notas` | **Sim** (coluna) | Parcial | `opcoes.empresaId` no emissor | **Parcial** | **P0** se null |
| `nfe_notas` | Verificar uso | — | Emissão NF-e | Parcial | P1 |
| `atendimentos` | **Não** | — | Modo operacional | — | — |
| `atendimento_operacoes` | **Sim** | — | Item/reserva MUV | **Sim** | Ponte MUV→venda |
| `atendimento_operacao_reservas` | **Sim** | — | MUV | **Sim** | — |
| `pedidos` | Fora escopo detalhado | — | Reserva RC4.1.2 | — | P2 |

---

## 4. Writers de `vendas` (produção)

| # | Arquivo | Função / contexto | `empresa_id` no INSERT? |
|---|---------|-------------------|-------------------------|
| W1 | `backend/services/vendas/VendaPagamentoService.js` | `criarVenda` — fluxo principal e a prazo (~L1069, ~L1391) | **Não** |
| W2 | `backend/motores/muv/MaterializarOperacoesAtendimento.js` | `persistirVendaOperacao` — materialização MULTI (~L177) | **Não** |
| W3 | `backend/services/entrega/CriarVendaEntregaService.js` | Venda ENTREGA (~L261) | **Não** |

**Classificação:** **múltiplos writers** (3), porém **W1 concentra ~95%** do tráfego ERP/PDV via `POST /api/vendas`. W2 é exclusivo MUV/materializar. W3 é ramo `tipo_venda=ENTREGA`.

**Código legado morto / testes:** diversos `INSERT INTO vendas` em `tests/**` — não são writers de produção.

**Wrappers (não duplicam INSERT):**

- `VendaApplicationService.criarVenda` → delega W1 ou atendimento MUV (sem INSERT em MULTI preview).
- `PDVUniversalApplicationService.finalizarCheckout` → EmpresaUnicaAdapter → `POST /api/vendas` → W1.
- `MultiempresaAdapter` → atendimento → materializar → W2.

---

## 5. Backfill

**Não existe** migration/backfill para `vendas.empresa_id` (coluna inexistente).

Fontes **potenciais seguras** para futura 05.38.G.B (somente mapeamento, sem implementar):

| Prioridade | Fonte | Condição |
|------------|-------|----------|
| 1 | `caixa_sessoes.empresa_id` via `vendas.caixa_sessao_id` | Sessão com empresa definida |
| 2 | `atendimento_operacoes.empresa_id` via `venda_id` | Vendas originadas MUV |
| 3 | `financeiro.empresa_id` WHERE `venda_id` | Todos lançamentos da mesma venda apontarem mesma empresa |
| 4 | `nfce_notas.empresa_id` WHERE `venda_id` | Documento fiscal emitido |
| 5 | EMPRESA_SIMPLES | `ContratoOperacionalService` — apenas se determinístico |
| — | MULTI ambíguo | **Manter NULL** — não inventar |

---

## 6. Índices

| Índice | Status |
|--------|--------|
| `idx_vendas_empresa_id` | **AUSENTE** |
| Outros em `vendas` | `idx_vendas_pedido_id`, `idx_vendas_data_venda`, etc. (sem empresa) |

---

## 7. Declaração de escopo

Esta auditoria **não alterou** schema, código, migrations ou testes.

# AUDITORIA 05.38.F.A — Schema de Compras

**Classificação:** SOMENTE LEITURA  
**Data:** 2026-08-24  
**Fonte:** `backend/database.js`, `backend/rotas/compras.js`, tabelas relacionadas

---

## 1. Tabela `compras`

| Campo | Evidência |
|-------|-----------|
| PK | `id INTEGER PRIMARY KEY AUTOINCREMENT` |
| FKs | Nenhuma FK declarada para `empresas` |
| `empresa_id` | **AUSENTE** (DDL inicial + lista de `ALTER TABLE compras` sem `empresa_id`) |
| CNPJ | `fornecedor_cnpj` (fornecedor, não empresa operacional) |
| Chave fiscal | `chave_acesso` (UNIQUE implícito via erro de insert) |
| Status | `status` (`concluida` / `cancelada` / legado `pendente`) |
| Cancelamento | `cancelada_em`, `motivo_cancelamento` |

Colunas relevantes (além do núcleo financeiro/fiscal): `tipo_entrada`, escrituração NF-e, `nota_fiscal_avulsa`, totais, parcelas.

**INSERT oficial (único no backend):** `backend/rotas/compras.js` ~L1470 — **não inclui `empresa_id`**.

---

## 2. Tabela `compras_itens`

| Campo | Evidência |
|-------|-----------|
| PK | `id` |
| FKs | `compra_id → compras(id) ON DELETE CASCADE`, `produto_id → produtos(id)` |
| `empresa_id` | **AUSENTE** |
| Relação produto | Sim (`produto_id`) — catálogo compartilhado |
| Relação estoque | Indireta: crédito/débito via porta pública no momento da compra/cancel/devolver |

---

## 3. Tabela `compras_devolucoes`

| Campo | Evidência |
|-------|-----------|
| PK | `id` |
| FKs | Lógicas: `compra_id`, `compra_item_id`, `produto_id` (sem FK formal no DDL base) |
| `empresa_id` | **AUSENTE** |

---

## 4. Tabela `fornecedores`

| Campo | Evidência |
|-------|-----------|
| PK | `id` |
| CNPJ | `cpf_cnpj` |
| `empresa_id` | **AUSENTE** (cadastro global compartilhado) |

Compras também gravam `fornecedor` / `fornecedor_cnpj` textuais na própria linha.

---

## 5. Documento fiscal / Central

| Tabela | `empresa_id` | Relação com compra |
|--------|--------------|--------------------|
| `central_entradas_documentos` | **PRESENTE** (05.38.E) | `compra_id` FK → `compras(id)` |
| `central_entradas_historico` | Não | Via `documento_id` |
| `central_entradas_nsu` | Não (chave CNPJ+ambiente) | Sem FK compra |

---

## 6. Financeiro vinculado

| Tabela | `empresa_id` | Relação |
|--------|--------------|---------|
| `financeiro` | **PRESENTE** (05.38.D) | `compra_id` |
| `contas_receber` | PRESENTE | Vendas (não compra AP) |
| Contas a pagar | Vivem em `financeiro` (`tipo=despesa`) | Via `criarFinanceiroCompra` |

---

## 7. Estoque

| Tabela | `empresa_id` | Relação |
|--------|--------------|---------|
| `estoque_empresa` | **PRESENTE** | `produto_id + empresa_id` |
| `produtos` | Não | Saldos legados + dual-write |

Entrada/saída de compra **não** grava `empresa_id` na compra; usa `req.empresaId` na porta.

---

## 8. NF-e devolução de compra / auditoria

| Entidade | Observação |
|----------|------------|
| `nfe_devolucoes_compra` (+ itens) | Garantidas em runtime (`garantirTabelas`); vínculo `compra_id`; sem evidência de `empresa_id` na auditoria desta sprint (fora do DDL principal de `compras`) |
| `auditoria` | `modulo='compras'`, `referencia_tipo='compra'` — sem `empresa_id` obrigatório |

---

## 9. Matriz resumida

| TABELA | COLUNA EMPRESA_ID | ORIGEM DO CONTEXTO HOJE | RISCO MULTIEMPRESA | DEPENDÊNCIAS |
|--------|-------------------|-------------------------|--------------------|--------------|
| `compras` | **AUSENTE** | Nenhum persistido | **P0** — compra órfã de empresa | itens, financeiro, central, devoluções |
| `compras_itens` | AUSENTE | Herda da operação HTTP | Médio (via compra) | produtos, estoque |
| `compras_devolucoes` | AUSENTE | HTTP `req.empresaId` no débito | Alto se contexto divergir | estoque |
| `fornecedores` | AUSENTE | N/A (compartilhado) | Baixo | texto na compra |
| `central_entradas_documentos` | PRESENTE | Sync/upload 05.38.E | Parcial se compra sem id | `compra_id` |
| `financeiro` | PRESENTE | `FinanceiroEmpresaContextoService` / req | Parcial — pode ≠ “empresa da compra” | `compra_id` |
| `estoque_empresa` | PRESENTE | `empresaId` da porta | Parcial — depende do req | produto |
| `produtos` | N/A | COMPAT legado sem empresa | Alto se MULTI sem header | saldos globais |

---

## 10. Conclusão do schema

A entidade **compra não possui `empresa_id`**. Isolamento multiempresa atual é **somente operacional** (request → estoque/financeiro), não estrutural na linha da compra.

# RISCOS 05.38.F.A — Compras por Empresa

**Classificação:** SOMENTE LEITURA  
**Regra:** apenas riscos comprovados no código auditado

---

## P0 — BLOQUEADORES

### R-P0-01 — Compra sem `empresa_id` persistido
**Evidência:** DDL `compras` + `INSERT INTO compras` sem coluna/valor `empresa_id`.  
**Efeito:** impossível filtrar, auditar ou proteger ownership pela própria entidade.

### R-P0-02 — Listagem global de compras
**Evidência:** `GET /api/compras` → `SELECT ... FROM compras c ORDER BY ...` sem `empresa_id`.  
**Efeito:** MULTIEMPRESA vê/opera lista cruzada.

### R-P0-03 — Operações por `id` sem ownership
**Evidência:** `GET /:id`, `POST /:id/cancelar`, `POST /:id/devolver` carregam compra só por `id`.  
**Efeito:** usuário em empresa B pode cancelar compra lançada sob contexto A (estoque debita B se header B — ou legado).

### R-P0-04 — Cadeia Central → Compra quebrável
**Evidência:**  
- Bridge coloca `empresaId` no payload.  
- `compras.js` **não** referencia `empresaId`.  
- `vincularDocumentoCentralAposCompra` chama `vincularCompra` **sem** `empresaId`.  
- Validação usa `compraEmpresaId || documento.empresaId` → auto-comparação.  
**Efeito:** documento A pode vincular-se a compra cujo estoque/financeiro foram creditados em B.

---

## P1 — ALTO RISCO

### R-P1-01 — Estoque COMPAT sem empresa
**Evidência:** `montarOptsPortaCreditoCompra` permite `modoLegadoSemEmpresa` se `empresaId` null e `exigirEmpresa` não true.  
**Efeito:** MULTI sem header escreve `produtos`, não `estoque_empresa`.

### R-P1-02 — Divergência estoque × financeiro
**Evidência:** estoque usa só `req.empresaId`; financeiro pode resolver via `ContratoOperacionalService` se header ausente (SIMPLES).  
**Efeito:** mesmo POST pode gravar financeiro na empresa operacional e estoque no legado global.

### R-P1-03 — Middleware `obrigatorio: false`
**Evidência:** `router.use(criarMiddlewareContextoEmpresa(db))` sem `{ obrigatorio: true }`.  
**Efeito:** MULTI não é forçado no nível do router (só o financeiro exige indiretamente).

### R-P1-04 — Cancelamento financeiro sem filtro empresa
**Evidência:** `UPDATE financeiro SET status='cancelado' WHERE compra_id=?` (sem `empresa_id`).  
**Efeito:** aceitável se 1:N compra→lançamentos corretos; não valida se o usuário “pertence” à empresa do lançamento.

---

## P2 — MÉDIO

### R-P2-01 — Relatório uso/consumo sem filtro empresa
**Evidência:** `GET /relatorio/uso-consumo` filtra só tipo/data.

### R-P2-02 — Filhos sem empresa
`compras_itens`, `compras_devolucoes` — risco residual se compra permanecer sem coluna.

### R-P2-03 — Validação de estoque em cancelamento
Já migrada parcialmente (03.33) para `estoqueAtualParaValidacaoCompra` com `req.empresaId`; ainda depende do header correto.

---

## P3 — BAIXO

### R-P3-01 — Fornecedores compartilhados
Cadastro global; alinhado ao catálogo compartilhado.

### R-P3-02 — `parse-xml` 410
Sem risco operacional ativo.

---

## Matriz rápida

| ID | Risco | Fronteira | Classificação fronteira |
|----|-------|-----------|-------------------------|
| R-P0-01 | Sem persistência | ORIGEM→COMPRA | AUSENTE / INSEGURO |
| R-P0-02 | Listagem cruzada | CONSULTA | AUSENTE |
| R-P0-03 | Cancel cruzado | CANCELAMENTO | INSEGURO |
| R-P0-04 | Doc≠estoque/fin | CENTRAL→COMPRA | INSEGURO |
| R-P1-01 | Legado estoque | COMPRA→ESTOQUE | PARCIAL |
| R-P1-02 | Fontes diferentes | ESTOQUE×FINANCEIRO | PARCIAL |

---

## O que NÃO foi classificado como risco (sem evidência)

- Segundo motor de compras paralelo (não encontrado).  
- Uso atual de `configuracoes.cnpj` como empresa do INSERT (não encontrado no fluxo atual).  
- Heurística `empresas.length` no router de compras (não encontrada).

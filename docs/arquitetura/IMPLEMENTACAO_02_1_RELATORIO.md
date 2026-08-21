# Relatório — Implementação 02.1
## Migração do Ajuste de Estoque para a Porta Pública

**Data:** 2026-08-12 · **Status:** APROVADA (critérios da Sprint)

---

## 1. Resumo

O mutador de ajuste e o fluxo de saldos iniciais (PUT) deixaram de fazer `UPDATE produtos` de saldo e passaram a usar `estoqueSaldosPublico`. Comportamento F×NF, histórico e storage em `produtos` preservados.

---

## 2. Arquivos alterados

- `backend/services/ajusteEstoqueService.js`
- `backend/rotas/produtos.js` (propaga `empresaId`; saldos iniciais via porta)

## 3. Arquivos criados

- `tests/estoque/ajuste-estoque-porta-publica.test.js`
- `docs/arquitetura/IMPLEMENTACAO_02_1_AJUSTE_ESTOQUE_PORTA_PUBLICA.md`
- `docs/arquitetura/IMPLEMENTACAO_02_1_RELATORIO.md` (este)

---

## 4. Métodos alterados / novos

| Método | Mudança |
|---|---|
| `aplicarAjusteEstoqueProduto` | Deltas via `creditarSaldo`/`debitarSaldo` |
| `aplicarSaldosIniciaisViaPorta` | **Novo** — substitui UPDATE do PUT |
| `montarOptsPortaAjuste` | **Novo** — empresa ou COMPAT |
| `executarAjusteEstoque` (rota) | Passa `empresaId` do body/user |
| `aplicarSaldosIniciaisSePermitido` | Chama porta |

---

## 5. SQL removido

Em `ajusteEstoqueService.js`: **nenhum** `UPDATE produtos` de saldo.  
Em `produtos.js` (PUT saldos iniciais): UPDATE de SF/SNF/EA **removido**.

SELECT de `controlar_validade` permanece (não muta saldo).

---

## 6. Porta utilizada

`backend/services/fiscalNaoFiscal/estoqueSaldosPublico.js`  
(`consultarSaldo`, `creditarSaldo`, `debitarSaldo`)

---

## 7. Como empresaId é obtido

1. Parâmetro explícito / body / `req.user`  
2. Senão → COMPAT `COMPAT_AJUSTE_ESTOQUE_PRE_MULTIEMPRESA`  
3. Com `exigirEmpresa: true` → `EMPRESA_OBRIGATORIA`

---

## 8. Compatibilidade utilizada

| Ponto | Motivo |
|---|---|
| Ajuste ERP sem JWT empresa | Pré-multiempresa |
| Importação quantidades / inicial | Sem empresa no fluxo |
| Saldos iniciais PUT sem empresa | Idem |

Identificada no retorno (`legado`, `motivo_compat`) e constante `MOTIVO_COMPAT_AJUSTE`.

---

## 9. Transação

Ajuste unitário mantém o modelo anterior (sem BEGIN próprio).  
Usa o mesmo `db` do caller — **TESTE 11** confirma rollback externo revertendo saldo da porta (importação continua atômica).

---

## 10. Histórico

`produtos_ajustes_estoque` intacto no ajuste. Saldos iniciais continuam **sem** histórico.

---

## 11–13. Testes

Criados: `tests/estoque/ajuste-estoque-porta-publica.test.js` (01–13 + saldos iniciais + scan SQL).

| Suite | Resultado |
|---|---|
| `ajuste-estoque-porta-publica` | **15/15 OK** |
| `porta-publica-saldos-multiempresa` | **17/17 OK** |
| `mts-v1` | **OK** |
| `rc3161-pedido-motor-comercial-mts` | **OK** |
| `rc80y-controla-estoque` | **4/4 OK** |

Regressões: nenhuma nestas suites.

---

## 14. Diff (escopo)

Alterações **desta Sprint** em `produtos.js`:
- import de `aplicarSaldosIniciaisViaPorta`
- `empresaId` em `executarAjusteEstoque`
- substituição do `UPDATE` de saldos iniciais pela porta

**Nota:** o working tree de `produtos.js` já continha outras mudanças pré-existentes (diff agregado vs HEAD maior). Apenas os trechos acima são da 02.1.

Escopo principal: `ajusteEstoqueService.js` + testes + docs.

---

## 15. Limitações

- Sem isolamento físico (`estoque_empresa` não criado).
- COMPAT ainda necessário no ERP até JWT/empresas.
- CREATE produto ainda seta saldos no INSERT.

---

## 16. Próxima Sprint

**02.2** — próximo mutador da ordem auditada: `recalcularSaldosProduto` **ou** crédito de compra (avaliar risco/testes).

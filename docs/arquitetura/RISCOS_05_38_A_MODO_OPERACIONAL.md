# RISCOS — Modo operacional global (05.38.A)

Riscos **confirmados no código auditado**. Classificação para planejamento 05.38.B.

---

## P0 — Bloqueador arquitetural

| ID | Risco | Evidência | Impacto |
|----|-------|-----------|---------|
| B1 | **Modo global inexistente** — módulos críticos ignoram `modo_operacao_venda` | Caixa, financeiro, relatórios não importam `modoOperacaoVenda` | MULTIEMPRESA “ligado” na config mas caixa/financeiro permanecem globais |
| B2 | **Caixa sem `empresa_id`** | `caixa_sessoes` DDL sem coluna; metadados de `configuracoes` | Duas empresas compartilham sessão/caixa lógico |
| B3 | **Financeiro sem `empresa_id`** | `financeiro`, `contas_receber` DDL | Conciliação e DRE incorretos em MULTIEMPRESA |

---

## P1 — Alto risco

| ID | Risco | Evidência |
|----|-------|-----------|
| A1 | Dual-write estoque (`produtos` + `estoque_empresa`) sem empresaId | `estoqueSaldosPublico` — ramo legado |
| A2 | CNPJ duplicado: `configuracoes` vs `empresas` | `caixa.js` `obterConfigsEmpresa` |
| A3 | EMPRESA_UNICA com N empresas exige seleção | `PDVUniversalContextService` — não é EMPRESA_SIMPLES |
| A4 | Vendas legado sem coluna empresa | `vendas` INSERT em VendaPagamentoService |
| A5 | Central documentos sem `empresa_id` | `CentralDocumentosRepository` |

---

## P2 — Médio risco

| ID | Risco | Evidência |
|----|-------|-----------|
| M1 | NSU multi-CNPJ na tabela, orquestração single-CNPJ | `CentralConfiguracaoService` + dashboard `obterUltimaSincronizacao` |
| M2 | PDV Universal MULTI sem TEF/PIX/entrega | Gates em `pdv-universal-tef.js`, `-pix.js`, `-entrega.js` |
| M3 | Promoção/atacado por produto sem empresa | API produtos — alinhado ao catálogo, risco de expectativa |
| M4 | JWT sem claim empresa — dependência total de header | `empresaContexto.js` comentário |

---

## P3 — Baixo risco

| ID | Risco | Evidência |
|----|-------|-----------|
| L1 | Nomenclatura EMPRESA_SIMPLES vs EMPRESA_UNICA | Documentação vs código |
| L2 | UI ERP sem toggle modo na config avançada | grep `modo_operacao_venda` frontend |
| L3 | Materialização MUV sem TEF na confirmação pagamento | Comentário `confirmarPagamentoAtendimento` |

---

## Mitigações recomendadas (documentar apenas — não implementar)

- **B1:** estender leitura de modo antes de qualquer sprint MULTI em caixa/financeiro.
- **B2/B3:** migrations futuras + backfill empresa operacional única em EMPRESA_SIMPLES.
- **A1:** exigir `empresaId` quando modo ≠ legado COMPAT.
- **A3:** flag EMPRESA_SIMPLES = auto-bind empresa única operacional + hide UI multi.

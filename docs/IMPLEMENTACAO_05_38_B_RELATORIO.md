# Relatório — Implementação 05.38.B

**Sprint:** Fundação do Modo Operacional Global  
**Classificação:** ESTADO B (código + testes automatizados)  
**Data:** 2026-08-23

---

## Objetivo

Criar a fonte oficial única do modo operacional de toda a instalação CDS (`EMPRESA_SIMPLES` | `MULTIEMPRESA`), com compatibilidade ao `modo_operacao_venda` legado, sem converter caixa/financeiro/central nesta sprint.

---

## Arquivos criados

| Arquivo | Função |
|---------|--------|
| `backend/core/modo-operacional/contratos.js` | Valores, validação, capacidades |
| `backend/core/modo-operacional/modoOperacionalGlobal.js` | Resolver central |
| `backend/core/modo-operacional/compatibilidadeModoVenda.js` | Ponte global ↔ MUV |
| `backend/core/modo-operacional/PoliticaEmpresaSimples.js` | Empresa operacional única |
| `backend/core/modo-operacional/PoliticaMultiempresa.js` | Marcador MULTIEMPRESA |
| `backend/core/modo-operacional/ContratoOperacionalService.js` | DTO operacional |
| `backend/core/modo-operacional/index.js` | Export único |
| `tests/modo-operacional-global-05-38-b.test.js` | 17 casos obrigatórios |
| `docs/arquitetura/MODO_OPERACIONAL_GLOBAL_V1.md` | Especificação V1 |

## Arquivos alterados

| Arquivo | Alteração |
|---------|-----------|
| `backend/services/configuracaoService.js` | Chaves, bootstrap, save com confirmação |
| `backend/motores/muv/modoOperacaoVenda.js` | Deriva modo venda do global |
| `backend/services/pdv-universal/PDVUniversalContextService.js` | Contrato no contexto PDV |
| `backend/rotas/configuracoes_avancadas.js` | GET contrato-operacional |
| `frontend/erp/js/cds-centro-configuracoes.js` | UI modo operacional |
| `frontend/erp/js/configuracoes.js` | Save com confirmação |
| `frontend/pdv-universal/pdv-universal.js` | Rótulo modo global |

## Não alterados (conforme escopo)

MUV, checkout, TEF, PIX, entrega, caixa, financeiro, Central de Entradas, estoque_empresa, motor fiscal.

---

## Testes

### Novos — `tests/modo-operacional-global-05-38-b.test.js`

**17/17 OK**

Casos: bootstrap, resolução, capacidades, PDV compat, falha empresa operacional, confirmação de mudança, legado.

### Regressão

| Suite | Resultado |
|-------|-----------|
| `tests/muv/modo-operacao-venda-04-02.test.js` | 14/14 OK |
| `tests/pdv-universal/contexto-operacional-05-02.test.js` | 25/25 OK |
| `tests/pdv-universal/*.test.js` (todas) | OK |

---

## Critérios de conclusão

| # | Critério | Status |
|---|----------|--------|
| 1 | Modo operacional global oficial | ✅ |
| 2 | EMPRESA_SIMPLES e MULTIEMPRESA explícitos | ✅ |
| 3 | Sem decisão por empresas.length | ✅ |
| 4 | EMPRESA_SIMPLES com resolução segura | ✅ |
| 5 | MULTIEMPRESA reutiliza fundação existente | ✅ |
| 6 | PDV Universal continua funcionando | ✅ |
| 7 | MUV não alterado | ✅ |
| 8 | Módulos críticos não convertidos parcialmente | ✅ |
| 9 | Caixa e financeiro intactos | ✅ |
| 10 | Testes novos e regressões passam | ✅ |

---

## Próximas sprints sugeridas

1. **05.38.C** — Propagação para caixa (`empresa_id` em sessões)
2. **05.38.D** — Propagação financeiro
3. **05.38.E** — Central de Entradas multi-CNPJ
4. **05.38** — Pagamento misto EMPRESA_SIMPLES (auditoria 05.37)

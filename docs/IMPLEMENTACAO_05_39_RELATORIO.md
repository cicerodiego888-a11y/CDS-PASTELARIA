# SPRINT 05.39

## OBJETIVO

Auditoria técnica final de ownership e writers: descobrir e documentar onde o `empresaId` nasce, como percorre o sistema, onde se perde, quais writers o recebem/persistem/fazem fallback, e quais operações não isolam empresas.

**Esta sprint não implementou correções.** Nenhum código de produção, migration, coluna, rota ou regra de negócio foi alterado.

## ESCOPO AUDITADO

22/22 domínios obrigatórios:

01 Contexto empresarial · 02 Vendas · 03 PDV Universal · 04 PDV Express · 05 Motor Universal de Vendas · 06 Materialização · 07 Estoque · 08 Reservas · 09 Consumo de reservas · 10 Financeiro · 11 Caixa · 12 Fiscal · 13 NFC-e · 14 Cancelamento · 15 Devolução · 16 Produtos · 17 Saldo inicial · 18 Lotes · 19 Compras · 20 Central de Entradas · 21 MIIP · 22 SEFAZ/DF-e

## QUANTIDADE DE FLUXOS AUDITADOS

- Domínios: **22 de 22**
- Operações classificadas na matriz: **80**
- Writers inventariados: **60+**
- ⚫ Não auditado: **1** (expiração de reservas — fluxo inexistente no código)

## MATRIZ DE CLASSIFICAÇÃO

🟢 SEGUROS: **26**  
🟡 PARCIAIS: **26**  
🟠 COMPATIBILIDADE: **7**  
🔴 RISCOS CONFIRMADOS: **20** operações (15 IDs no relatório de riscos)  
⚫ NÃO AUDITADOS: **1**

Fonte: `docs/arquitetura/MATRIZ_OWNERSHIP_EMPRESARIAL_05_39.md`

## PRINCIPAIS RISCOS

1. **`vendas` sem `empresa_id`** — gap estrutural. Cancelamento, devolução, listagem e fiscal legado não têm de onde ler a empresa da operação (`database.js:1838-1858`).
2. **Listagem de vendas sem filtro** — `GET /api/vendas` lê todas as empresas (`rotas/vendas.js:50-134`).
3. **Cancelamento/devolução usam o contexto HTTP atual** (ou COMPAT global), não a empresa da venda (`VendaCancelamentoService.js:52`, `VendaDevolucaoService.js:239`).
4. **NFC-e legado com config GLOBAL** — `VendaFiscalService.js:211` e `cancelarNfce.js:10` usam certificado/CSC da instalação, não da empresa.
5. **INSERT `financeiro` sem `empresa_id`** na materialização MUV (`MaterializarOperacoesAtendimento.js:226-231`) e no estorno de cancelamento (`VendaCancelamentoService.js:117`).
6. **Caixa `LIMIT 1` global** quando `empresaId` ausente (`caixaSessaoHelpers.js:37-39`).
7. **Reservas de pedido sem dual-write** em `estoque_empresa` (`reservasPublico.js:354-365`, `:425`).
8. **Lotes FEFO globais** por `produto_id` (`lotesService.js:121-148`) — pool compartilhado entre empresas.
9. **Bug `deps` em DistDFe** — `persistirDocumentosRetorno` referencia variável inexistente (`distribuicaoDFe.js:323`).
10. **Rotas Central por ID sem ownership** (`central-entradas.js:695`, `:1007`).

## FLUXOS MAIS CRÍTICOS

| Prioridade | Fluxo | Por quê |
|------------|-------|---------|
| 1 | Cancelamento / devolução de venda | Pode creditar estoque da empresa errada |
| 2 | Emissão e cancelamento NFC-e legado | Certificado/CSC/CNPJ globais |
| 3 | Persistência da venda | Sem ownership, nenhum fluxo posterior é auditável |
| 4 | Financeiro satélite (MUV / estorno) | Rotas ERP já isolam; writers de venda furam o isolamento |
| 5 | Caixa LIMIT 1 | Sessão/turno da outra empresa |
| 6 | Lotes FEFO | Consumo cruzado do mesmo SKU |
| 7 | Ingestão DF-e (`deps`) | Inbox pode ignorar documentos |

## DEPENDÊNCIAS ARQUITETURAIS

- **Dois caminhos de venda:** legado (`VendaPagamentoService`) vs MUV (`AtendimentoMultiempresaService` → materialização). O MUV isola bem o **atendimento**; a **venda materializada** volta ao schema legado sem `empresa_id`.
- **Modo operacional global** (`EMPRESA_SIMPLES` / `MULTIEMPRESA`) é a fonte do modo de venda (`modoOperacaoVenda.js:45-54`). SIMPLES resolve empresa no contrato; MULTI exige header por operação.
- **Dual-write de estoque:** `produtos` permanece storage oficial; `estoque_empresa` é espelho. COMPAT e bypass de lote escrevem só o global.
- **Produto compartilhado** é regra oficial — ausência de `empresa_id` em `produtos` **não** é erro. Lotes e reservas de pedido **não** herdaram essa nuance: operam como globais onde o estoque já é empresarial.
- **Caixa 05.38.C e Financeiro/Compras 05.38.D/F** já isolam **rotas** migradas. O núcleo transacional de venda/fiscal/lotes **não** foi migrado.
- **PDV Express** não é um módulo nomeado: é `frontend/pdv` → `POST /api/vendas`. Não usa o pipeline Universal/MUV.

## TESTES EXECUTADOS

Ambiente íntegro nas suítes de isolamento já existentes. **Teste passando não reclassifica fluxo não coberto.**

| Suite | Executados | OK | Falha |
|-------|------------|----|-------|
| `tests/modo-operacional-global-05-38-b.test.js` | 17 | 17 | 0 |
| `tests/caixa/caixa-multiempresa-05-38-c.test.js` | 17 | 17 | 0 |
| `tests/financeiro/financeiro-multiempresa-05-38-d.test.js` | 20 | 20 | 0 |
| `tests/central-entradas-multiempresa-05-38-e.test.js` | 19 | 19 | 0 |
| `tests/compras-multiempresa-05-38-f-b.test.js` | 16 | 16 | 0 |
| `tests/empresas/consolidacao-operacional-multiempresa-05-19.test.js` | 6 | 6 | 0 |
| `tests/configuracao-fiscal-csc-urls-correcao.test.js` | 13 | 13 | 0 |
| **Total** | **108** | **108** | **0** |

Falhas pré-existentes nesta amostra: **nenhuma**.  
Cobertura **não** inclui: listagem vendas, cancel/devolução, NFC-e legado, FEFO, reservas de pedido, `distribuicaoDFe.persistirDocumentosRetorno`.

## RECOMENDAÇÃO PARA PRÓXIMA SPRINT

**NÃO IMPLEMENTAR NADA AUTOMATICAMENTE.** Aguardar análise arquitetural.

Ordem sugerida de correção (apenas indicação):

1. **Decidir persistência de `vendas.empresa_id`** (fundação). Sem isso, cancelamento/devolução/fiscal legado continuam cegos.
2. **Corrigir writers satélites que já têm coluna e não gravam:** financeiro MUV, estorno cancelamento, estorno devolução.
3. **Bug pontual DistDFe `deps`** — ingestão DF-e quebrada de forma comprovada.
4. **Proibir LIMIT 1 global de caixa em MULTIEMPRESA.**
5. **Amarrar emissão/cancelamento NFC-e à empresa da operação** (o MUV já é o modelo).
6. **Ownership nas rotas Central por ID** (espelhar `exigirCompraDaEmpresa`).
7. **Unificar reserva de pedido no dual-write** (`ajustarReservado`).
8. **Decisão de lotes:** por empresa vs pool compartilhado explícito.
9. Só então: filtro de listagem de vendas, tracking de reservas, `nfe_notas`.

Critério: cada correção deve nascer de um ID `R-05.39-*` com evidência, não de refatoração preventiva.

## CHECKLIST DE CONCLUSÃO

- [x] Nenhum código de produção foi alterado
- [x] Todos os domínios obrigatórios foram investigados
- [x] Todos receberam classificação
- [x] Evidência de arquivo/função/linha para cada risco confirmado
- [x] Matriz de ownership criada
- [x] Mapa de fluxos reais criado
- [x] Inventário de writers criado
- [x] Relatório de riscos criado
- [x] Testes existentes executados
- [x] Recomendação arquitetural para a próxima sprint (sem implementar)

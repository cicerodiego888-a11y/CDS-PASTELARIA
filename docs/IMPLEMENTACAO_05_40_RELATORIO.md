# SPRINT 05.40

## OBJETIVO

Estabelecer `vendas.empresa_id` como ownership explícito, persistido e consultável da venda. Fundação para o saneamento multiempresa — sem corrigir cancelamento, devolução, NFC-e, financeiro satélite, lotes, reservas ou DistDFe.

## ARQUIVOS ALTERADOS

| Arquivo | Papel |
|---------|--------|
| `backend/database.js` | Coluna no CREATE, ALTER + índice, chain da migration |
| `backend/utils/vendasEmpresaHelpers.js` | **Novo** — ALTER/backfill/log/filtro SQL |
| `backend/services/vendas/VendaEmpresaContextoService.js` | **Novo** — resolver / invariante / caixa / 404 |
| `backend/services/vendas/VendaPagamentoService.js` | INSERT com `empresa_id`; bloqueio caixa; GET pagamento NF |
| `backend/services/entrega/CriarVendaEntregaService.js` | INSERT com `empresa_id` |
| `backend/motores/muv/MaterializarOperacoesAtendimento.js` | INSERT com `empresa_id`; ALTER auxiliar |
| `backend/rotas/vendas.js` | Listagem, detalhe, delete, relatórios filtrados |
| `tests/vendas/ownership-vendas-05-40.test.js` | **Novo** |

## MIGRATIONS

- `ALTER TABLE vendas ADD COLUMN empresa_id INTEGER REFERENCES empresas(id)`
- `CREATE INDEX IF NOT EXISTS idx_vendas_empresa_id ON vendas(empresa_id)`
- Backfill P1 caixa_sessoes → P2 atendimento_operacoes → restante NULL
- Idempotente; não recria tabela; não apaga vendas

Log em runtime: `[05.40] MIGRATION_VENDAS_EMPRESA_05_40 | TOTAL=… | CLASSIFICADAS_VIA_CAIXA=… | CLASSIFICADAS_VIA_MUV=… | NÃO_CLASSIFICADAS=…`

A classificação no **banco oficial do operador** só ocorre na inicialização do app. Nos testes isolados: TOTAL 3 / CAIXA 1 / MUV 1 / NÃO_CLASSIFICADAS 1.

## WRITERS AUDITADOS (`INSERT INTO vendas`)

| Writer | Arquivo | Fluxo | Origem empresa_id | Status |
|--------|---------|-------|-------------------|--------|
| W1 prazo | `VendaPagamentoService.js` ~1088 | PDV Express / ERP / Universal EU | `exigirEmpresaDaOperacao(req)` após contexto financeiro | **OK** |
| W1 à vista | `VendaPagamentoService.js` ~1410 | idem | idem | **OK** |
| W2 MUV | `MaterializarOperacoesAtendimento.js` ~179 | Materialização atendimento | `operacao.empresaId` | **OK** |
| W3 entrega | `CriarVendaEntregaService.js` ~273 | `tipo_venda=ENTREGA` | `exigirEmpresaDaOperacao(req)` | **OK** |

Busca global em `backend/`: apenas esses quatro INSERTs (W1 aparece duas vezes). Testes e fixtures não são writers de produção.

## LEITURA

- `GET /api/vendas` → `WHERE v.empresa_id = ?` (exclui NULL)
- `GET /api/vendas/:id` e `/detalhes` → `id + empresa_id`; cruzado = 404
- Relatórios da mesma rota filtrados por empresa
- `query.empresa_id` **não** substitui o contexto

## CAIXA

Se a requisição tem sessão de caixa e `sessao.empresa_id != empresa da venda` → `CAIXA_SESSAO_EMPRESA_DIVERGENTE`. Não altera `empresa_id`.

## TESTES

| Suite | Executados | OK | Falha |
|-------|------------|----|-------|
| `tests/vendas/ownership-vendas-05-40.test.js` | 13 | 13 | 0 |
| `tests/financeiro/financeiro-multiempresa-05-38-d.test.js` | 20 | 20 | 0 |
| `tests/modo-operacional-global-05-38-b.test.js` | 17 | 17 | 0 |
| `tests/muv/materializacao-operacoes-multiempresa-04-06.test.js` | 32 | 32 | 0 |
| **Total desta verificação** | **82** | **82** | **0** |

Cobertura 05.40: empresas A/B, listagem isolada, 404 cruzado, criar sem contexto, caixa divergente, fiscal/NF/mista, legado NULL oculto, writers com `empresa_id`, backfill.

## GAPS (não ocultados — fora desta sprint)

- `VendaCancelamentoService` / `VendaDevolucaoService` ainda localizam venda só por `id`
- Rotas `/:id/nfe-devolucao/*` sem filtro `empresa_id`
- INSERT `financeiro` na materialização MUV continua sem `empresa_id`
- Estorno de cancelamento/devolução sem `empresa_id`
- NFC-e legado ainda usa config global
- PDV Express depende do header/`EMPRESA_SIMPLES`; em MULTI sem `X-Empresa-Id` a criação falha com `EMPRESA_CONTEXT_REQUIRED` (comportamento desejado)

## CRITÉRIOS DE ACEITE

- [x] tabela `vendas` possui `empresa_id`
- [x] migration segura + índice
- [x] backfill só quando auditável; demais NULL
- [x] venda nova exige `empresa_id`
- [x] `GET /api/vendas` filtra empresa
- [x] consulta individual valida ownership (404)
- [x] PDV Express / demais writers conhecidos gravam `empresa_id`
- [x] caixa incompatível bloqueia
- [x] fiscal / não fiscal / mista com `empresa_id` (arquitetura F×NF preservada)
- [x] legado NULL fora da listagem
- [x] testes de isolamento
- [x] busca global `INSERT INTO vendas` auditada
- [x] documentação criada

## PRÓXIMA SPRINT SUGERIDA

05.41 — writers satélites e consistência financeira empresarial (após auditoria positiva desta fundação).

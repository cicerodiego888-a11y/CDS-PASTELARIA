# SPRINT 05.44

## OBJETIVO

Eliminar leitura e seleção cruzada de sessões de caixa. Uma sessão pertence a uma empresa; nenhum fluxo empresarial pode descobrir, reutilizar ou operar a sessão de outra empresa.

## ARQUIVOS ALTERADOS

| Arquivo | Papel |
|---------|--------|
| `backend/utils/caixaSessaoHelpers.js` | Helper único: exige empresa; `obterSessaoAtivaDaEmpresa`; SQL de histórico/turno |
| `backend/services/caixa/CaixaEmpresaContextoService.js` | Legado NULL → `EMPRESA_OWNERSHIP_REQUIRED`; DIVERGENTE sem vazar empresa da sessão |
| `backend/middleware/validarCaixaAberto.js` | Resolve empresa antes; SQL com `empresa_id`; não copia empresa da sessão |
| `backend/rotas/caixa.js` | Abertura/fechamento/listagens via helper; remove LIMIT 1 global de `caixa` |
| `tests/caixa/ownership-caixa-sessao-05-44.test.js` | **Novo** |
| `docs/arquitetura/ISOLAMENTO_CAIXA_SESSAO_05_44.md` | **Novo** |
| `docs/IMPLEMENTACAO_05_44_RELATORIO.md` | **Novo** |

Não alterados: Motor Comercial, TEF, regras fiscais, MUV, `CaixaProvider` (monitoramento D), cadastro `rotas/caixas.js` (E).

## CAUSA DO RISCO

`montarSqlSessaoAberta` caía em `ORDER BY id DESC LIMIT 1` **sem** `empresa_id` quando o contexto faltava, e o acesso por `sessaoId` não filtrava empresa no SQL. A empresa B, ao abrir caixa depois, virava “a sessão ativa” de todo o sistema.

## CORREÇÃO

1. Toda descoberta operacional exige `empresaId` e inclui `WHERE empresa_id = ?` na SQL.
2. Acesso por ID: `id + status + empresa_id`. Cruzado = não encontrado.
3. `validarCaixaAberto` resolve empresa (header/contrato) **antes** de buscar sessão; não infere empresa a partir do caixa.
4. Histórico, por-data e detalhe de fechamento filtram pela sessão da empresa. Legado NULL não lista.
5. Sem migration nova: `caixa_sessoes.empresa_id` já existia.

## TESTES

| Suite | Executados | OK | Falha |
|-------|------------|----|-------|
| `tests/caixa/ownership-caixa-sessao-05-44.test.js` | 10 | 10 | 0 |
| `tests/caixa/caixa-multiempresa-05-38-c.test.js` | 17 | 17 | 0 |
| `tests/vendas/ownership-vendas-05-40.test.js` | 13 | 13 | 0 |
| `tests/financeiro/ownership-financeiro-05-41.test.js` | 14 | 14 | 0 |
| `tests/vendas/ownership-cancelamento-devolucao-05-42.test.js` | 9 | 9 | 0 |
| `tests/pdv-universal/caixa-operacional-05-23.test.js` | 8 | 8 | 0 |
| `tests/pdv-universal/caixa-operacional-acoes-05-33.test.js` | 12 | 12 | 0 |
| `tests/vendas/entrega-caixa-turno-fk.test.js` | 3 | 3 | 0 |
| **Total desta verificação** | **86** | **86** | **0** |

## RISCOS REMANESCENTES

- `CaixaProvider` ainda usa última sessão global (monitoramento sem `empresaId`).
- Cadastro administrativo `caixas` / relatório por `operador_id` fora do fluxo de sessão ativa.
- Turno e movimentação herdam ownership só via `sessao_id` (sem coluna própria).

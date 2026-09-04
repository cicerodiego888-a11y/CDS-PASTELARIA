# ISOLAMENTO DE CAIXA E SESSÃO ATIVA — Sprint 05.44

**Status:** implementado  
**Data:** 2026-08-25  
**Dependência:** Sprint 05.38.C (`caixa_sessoes.empresa_id`) e 05.40 (`vendas.empresa_id`)

## 1. Estrutura encontrada

| Tabela | `empresa_id`? | Papel | Classificação |
|--------|---------------|-------|---------------|
| `caixa_sessoes` | sim (05.38.C) | sessão operacional | A — fonte de ownership |
| `caixa` | **não** | turno financeiro | ownership via sessão (`caixa_turno_id`) |
| `caixa_movimentacoes` | **não** | sangria/suprimento/abertura | ownership via `sessao_id` |
| `caixa_fechamentos` | **não** | registro de fechamento | ownership via `sessao_id` |
| `auditoria_caixa` | **não** | auditoria da sessão | ownership via `sessao_id` |
| `caixas` | **não** | cadastro administrativo | E — fora de escopo |
| `terminais` | **não** | vínculo admin caixa ↔ terminal | E |

Não foi criada coluna nova. `caixa_sessoes.empresa_id` já existia, com índice `idx_caixa_sessoes_empresa_status`.

Status real da sessão: `'aberto'` / `'fechado'`.

## 2. Inventário de readers / writers

| Ponto | Tipo | Antes | Classe | Depois |
|-------|------|-------|--------|--------|
| `montarSqlSessaoAberta` sem empresa | reader | `ORDER BY id DESC LIMIT 1` global | **C** | exige `empresa_id` no SQL |
| `montarSqlSessaoAberta({ sessaoId })` | reader | `WHERE id = ?` sem empresa | **C** | `id + status + empresa_id` |
| `obterSessaoAtivaDaEmpresa` | reader | (novo caminho público) | A | SQL com `empresa_id = ?` |
| `GET /caixa/aberto` | reader | já passava empresa (05.38.C) | A | via helper novo |
| `POST /caixa/abrir` | writer | grava `empresa_id` | A | inalterado na gravação |
| `POST /sangria` `/suprimento` `/fechar` | writer | `exigirSessaoDaEmpresa` | A | descoberta só da empresa |
| `UPDATE caixa_sessoes` no fechar | writer | já filtrava `empresa_id` | A | inalterado |
| `encerrarSessaoOrfa` | writer | `WHERE id = ?` | C | `AND empresa_id = ?` |
| `validarCaixaAberto` | reader | LIMIT 1 sem empresa; copiava `sessao.empresa_id` → `req.empresaId` | **C** | resolve empresa antes; SQL filtrado; não infere empresa da sessão |
| `GET /historico` `/por-data` | reader | todos os turnos | **C** | JOIN/EXISTS por `s.empresa_id` |
| `GET /fechamento/:id` reimpressão | reader | turno por id global | **C** | EXISTS da empresa |
| `VendaPagamentoService.criarVenda` | writer | `exigirCaixaCompativelComVenda` | A | inalterado (já bloqueava) |
| `CaixaProvider.collect` | reader | LIMIT 1 global | **D** | não alterado (monitoramento sem contexto) |
| `rotas/caixas.js` cadastro | admin | sessão aberta por `caixa_id` | **E** | não alterado |
| `usuarioRelatorioService` | relatório usuário | sessões por `operador_id` | **D** | não alterado |

## 3. Pontos globais encontrados

Confirmados no código:

```
SELECT * FROM caixa_sessoes WHERE status = 'aberto' ORDER BY id DESC LIMIT 1
SELECT * FROM caixa WHERE status = 'aberto' ORDER BY id DESC LIMIT 1
SELECT * FROM caixa_sessoes WHERE id = ? AND status = 'aberto'   -- sem empresa
```

Efeito: empresa B abre caixa depois → operação da empresa A podia receber a sessão B.

## 4. Pontos corrigidos

- Helper operacional exige empresa; filtro na SQL, não só em memória.
- Acesso por ID: sessão de outra empresa = não encontrado.
- Middleware de venda/PDV não escolhe última sessão global e não copia empresa da sessão.
- Listagens de histórico/por-data/fechamento isoladas.
- Encerramento de sessão órfã inclui `empresa_id`.
- Função morta `obterCaixaAberto` (LIMIT 1 em `caixa`) removida.

## 5. Ownership de cada entidade

```
EMPRESA
  ↓
caixa_sessoes.empresa_id     ← fonte da sessão
  ↓
turno `caixa` via caixa_turno_id
  ↓
movimentações / fechamento / auditoria via sessao_id
  ↓
venda.empresa_id deve coincidir com a sessão (exigirCaixaCompativelComVenda)
```

É proibido: última sessão global, último caixa global, COMPAT, empresa do último usuário, sessão de outra empresa como fallback.

## 6. Tratamento de legado

Sessão com `empresa_id IS NULL`:

- não recebe empresa inventada;
- operação empresarial → `EMPRESA_OWNERSHIP_REQUIRED`;
- não entra em listagens empresariais (`s.empresa_id = ?`).

Backfill 05.38.C permanece: só preenche NULL quando há fonte confiável (empresa operacional única / config). Esta sprint não reprocessa histórico.

## 7. Contratos de erro

| Código | Uso |
|--------|-----|
| `CAIXA_EMPRESA_OBRIGATORIA` | descoberta sem empresa |
| `CAIXA_NAO_ENCONTRADO` | sessão/turno inexistente no contexto (inclui cruzado por ID) |
| `CAIXA_SESSAO_EMPRESA_DIVERGENTE` | sessão carregada × empresa da operação (venda) |
| `EMPRESA_OWNERSHIP_REQUIRED` | sessão legada sem `empresa_id` |
| `CAIXA_SESSAO_AUSENTE` | nenhuma sessão para a empresa (helper `exigirSessaoDaEmpresa(null)`) |

Não se devolve “esta sessão pertence à empresa X”.

## 8. Fluxos bloqueados

- Descobrir sessão de B no contexto de A.
- Usar `sessaoId` de A no contexto de B (SQL não retorna a linha).
- Fechar sessão de A com `empresa_id` de B (`UPDATE` 0 linhas).
- Criar venda da empresa A com `req.caixaSessao` da empresa B.

## 9. Riscos remanescentes

- `CaixaProvider` (dashboard de monitoramento) ainda lê a última sessão aberta **global** — ponto D, sem contexto empresarial na coleta.
- Cadastro `GET/DELETE /api/caixas` não é sessão operacional; `caixas` sem `empresa_id`.
- Relatório de usuário soma sessões por `operador_id` (não é descoberta de sessão ativa).
- Tabelas `caixa` / `caixa_movimentacoes` / `caixa_fechamentos` continuam sem `empresa_id` próprio; o vínculo pela sessão é o isolamento desta sprint.

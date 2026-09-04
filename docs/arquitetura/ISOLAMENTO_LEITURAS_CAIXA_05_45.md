# ISOLAMENTO DAS LEITURAS OPERACIONAIS DE CAIXA — Sprint 05.45

**Status:** implementado  
**Data:** 2026-08-25  
**Dependência:** Sprint 05.44 (sessão ativa) e 05.38.C (`caixa_sessoes.empresa_id`)

Fecha o risco remanescente da 05.44: o dashboard / `CaixaProvider` ainda podia descobrir a última sessão aberta **global**.

## Invariante

Nenhuma leitura operacional empresarial pode descobrir ou utilizar uma sessão de caixa fora da empresa do contexto.

A empresa nunca é descoberta pela última sessão global.

```
CONTEXTO EMPRESARIAL
        ↓
empresaId
        ↓
consulta filtrada pela empresa
        ↓
sessão pertencente à empresa
        ↓
turnos / movimentações / saldo / fechamento daquela empresa
```

Fonte oficial de ownership: `caixa_sessoes.empresa_id`.  
Não foi criada coluna `empresa_id` em `caixa`, `caixa_movimentacoes`, `caixa_fechamentos` ou `auditoria_caixa`. Essas tabelas herdam o escopo via `sessao_id` (JOIN ou validação prévia da sessão).

---

## 1. Inventário das leituras encontradas

| # | Ponto | Query / comportamento | Classe | Ação 05.45 |
|---|--------|----------------------|--------|------------|
| 1 | `CaixaProvider.collect` — sessão | `FROM caixa_sessoes WHERE status='aberto' ORDER BY id DESC LIMIT 1` | **D** | corrigido: `obterSessaoAtivaDaEmpresa` com `empresa_id` |
| 2 | `CaixaProvider.collect` — fallback `caixa` | `FROM caixa WHERE status='aberto' ORDER BY id DESC LIMIT 1` | **D** | **eliminado** |
| 3 | `CaixaProvider` — sangria/suprimento | `caixa_movimentacoes` por `sessao_id` sem JOIN | **D** | JOIN `caixa_sessoes.empresa_id` |
| 4 | `CaixaProvider` — vendas da sessão | `vendas` por `caixa_sessao_id` sem JOIN | **D** | JOIN `caixa_sessoes.empresa_id` |
| 5 | `MonitoringContext` | sem `empresaId` | **D** | passa `req.empresaId` / header / user |
| 6 | `MonitoringEngine` cache | chave só por competência | **D** | inclui `emp:{empresaId\|none}` |
| 7 | `CaixaWidget` | só renderiza payload do provider | **A** | sem SQL; não alterado |
| 8 | `GET /api/monitoring/summary` | consome provider | **A** (após correção) | isolamento no provider + contexto |
| 9 | `GET /caixa/aberto` | helper 05.44 | **A** | inalterado nesta sprint |
| 10 | `POST /caixa/abrir` `/sangria` `/suprimento` `/fechar` | writers 05.44 | **A** | inalterado |
| 11 | `validarCaixaAberto` | 05.44 | **A** | inalterado |
| 12 | `GET /caixa/historico` | EXISTS `s.empresa_id` | **A** | inalterado |
| 13 | `GET /caixa/por-data` — lista de turnos | helper histórico | **A** | inalterado |
| 14 | `GET /caixa/por-data` — movimentações | `WHERE cm.sessao_id = ?` após sessão já filtrada | **B** | não reescrito (validação prévia) |
| 15 | `GET /caixa/fechamento/:caixa_id` — turno | EXISTS sessão da empresa | **A** | inalterado |
| 16 | `obterDetalhesCaixa` — fechamento/mov/auditoria | por `sessao_id` após `montarSqlUltimaSessaoDoTurnoDaEmpresa` | **B** | não reescrito |
| 17 | `FechamentoCaixaResumoService` | SUM movimentações por `sessao_id` | **B** | sessão já scoped pelo caller |
| 18 | `GET /caixa/movimentacoes/:caixa_id` | sessão ativa + listagem sem JOIN | **D** | turno da empresa + JOIN |
| 19 | Acesso por `sessaoId` | inexistente / sem filtro | **D** | `GET /caixa/sessoes/:sessao_id` + helper 404 |
| 20 | Acesso por `movimentacaoId` | inexistente / sem filtro | **D** | `GET /caixa/movimentacao/:id` + JOIN 404 |
| 21 | `exigirCaixaCompativelComVenda` | 05.40/05.44 | **A** | inalterado (T12/T13) |
| 22 | `usuarioRelatorioService` | sessões/movimentações por `operador_id` | **D** residual | **não alterado** (não é dashboard) |
| 23 | `rotas/caixas.js` cadastro admin | `caixa_sessoes` por `caixa_id` | **E** | **não alterado** |
| 24 | `backend/teste_cancelar.js` | LIMIT 1 global | **E** | **não alterado** (script de debug) |
| 25 | Frontend `caixa.js` / PDV | consomem `/caixa/aberto` | **A** | sem SQL; não alterado |

Não se alterou código classificado como **C** (nenhuma leitura operacional global intencional neste domínio) nem **E**.

---

## 2. Queries globais eliminadas

```sql
-- CaixaProvider (antes)
SELECT * FROM caixa_sessoes WHERE status = 'aberto' ORDER BY id DESC LIMIT 1;
SELECT * FROM caixa WHERE status = 'aberto' ORDER BY id DESC LIMIT 1;
SELECT COALESCE(SUM(valor), 0) FROM caixa_movimentacoes
  WHERE sessao_id = ? AND tipo = ?;   -- sem JOIN empresarial
```

Substituídas por:

```sql
SELECT * FROM caixa_sessoes
 WHERE status = 'aberto' AND empresa_id = ?
 ORDER BY id DESC LIMIT 1;

SELECT COALESCE(SUM(cm.valor), 0) AS total
  FROM caixa_movimentacoes cm
  INNER JOIN caixa_sessoes cs ON cs.id = cm.sessao_id
 WHERE cs.empresa_id = ? AND cm.sessao_id = ? AND cm.tipo = ?;
```

Não existe mais descoberta operacional de sessão sem `empresa_id` no SQL do provider nem do helper.

---

## 3. Queries mantidas (B) e justificativa

| Query | Onde | Por que permanece |
|-------|------|-------------------|
| `caixa_fechamentos WHERE sessao_id = ? ORDER BY id DESC LIMIT 1` | `obterDetalhesCaixa` | `sessao_id` veio de `montarSqlUltimaSessaoDoTurnoDaEmpresa` (`empresa_id` no SQL). Isolamento por validação prévia, não por descoberta. |
| `caixa_movimentacoes WHERE cm.sessao_id = ?` | `GET /por-data`, `obterDetalhesCaixa` | Idem. Sprint admite JOIN **ou** validação prévia. |
| `auditoria_caixa WHERE sessao_id = ?` | `obterDetalhesCaixa` | Idem. |
| SUM `caixa_movimentacoes` por `sessao_id` | `FechamentoCaixaResumoService` | Caller já carregou sessão da empresa (fechamento / reimpressão). |

Não foi feito refactor cosmético dessas queries B.

---

## 4. Fluxo correto de ownership

```
EMPRESA
  ↓
caixa_sessoes.empresa_id     ← única fonte
  ↓
turno `caixa` via caixa_turno_id / caixa_id da sessão
  ↓
movimentações / fechamento / auditoria via sessao_id
  ↓
dashboard (CaixaProvider) usa a mesma sessão da empresa
  ↓
venda.empresa_id deve coincidir (exigirCaixaCompativelComVenda)
```

Proibido: última sessão global, fallback `caixa` aberto, empresa do usuário, última empresa, COMPAT, inferir empresa a partir da sessão retornada.

---

## 5. Endpoints auditados

| Endpoint | Isolamento |
|----------|------------|
| `GET /api/monitoring/summary` | contexto `empresaId` → `CaixaProvider` |
| `GET /api/caixa/aberto` | 05.44 (`empresa_id`) |
| `GET /api/caixa/historico` | EXISTS sessão da empresa |
| `GET /api/caixa/por-data` | lista A + mov B |
| `GET /api/caixa/fechamento/:caixa_id` | turno EXISTS + sessão da empresa |
| `GET /api/caixa/movimentacoes/:caixa_id` | turno da empresa + JOIN nas movimentações |
| `GET /api/caixa/sessoes/:sessao_id` | `id + empresa_id`; cruzado = 404 |
| `GET /api/caixa/movimentacao/:id` | JOIN sessão; cruzado = 404 |
| `POST /api/caixa/:caixa_id/reimprimir` | detalhes já scoped; sessão do fechamento com `empresa_id` |

---

## 6. Acesso cruzado

Empresa A tenta `sessaoId` / `movimentacaoId` / turno da Empresa B:

- HTTP **404**
- códigos: `CAIXA_SESSAO_NAO_ENCONTRADA`, `CAIXA_MOVIMENTACAO_NAO_ENCONTRADA`, `CAIXA_NAO_ENCONTRADO`
- não retorna 403 (não revela existência do recurso)

Sessão ausente para a empresa do contexto (dashboard): warning `CAIXA_SESSAO_NAO_ENCONTRADA`, indicadores vazios (`status: fechado`, `sessaoId: null`). **Não** busca outra sessão.

MULTIEMPRESA sem header no monitoring: caixa vazio; **não** cai em LIMIT 1 global.

---

## 7. Legado (`empresa_id IS NULL`)

- não recebe ownership inventado
- `empresa_id = NULL` não satisfaz `empresa_id = ?`
- não aparece no dashboard de A nem de B
- não entra em histórico empresarial
- backfill 05.38.C permanece o único caminho de preenchimento (fonte confiável); esta sprint não reprocessa histórico

---

## 8. Comportamento do CaixaProvider

1. Resolve `empresaId` de `context.empresaId` ou do contrato operacional (`resolverEmpresaIdParaCaixa`). Sem empresa → bloco vazio.
2. `obterSessaoAtivaDaEmpresa(db, { empresaId })`.
3. Sem sessão → warning `CAIXA_SESSAO_NAO_ENCONTRADA`, saldo/entradas zerados.
4. Totais de vendas e movimentações sempre com JOIN `caixa_sessoes.empresa_id`.
5. Widgets (`caixa.fiscal` / `caixa.nao_fiscal`) só exibem o payload já isolado.

---

## 9. Riscos remanescentes

- Relatório de usuário (`usuarioRelatorioService`) soma sessões/movimentações por `operador_id` — não é descoberta de sessão ativa nem dashboard; fora desta sprint.
- Cadastro administrativo `GET/DELETE /api/caixas` (`rotas/caixas.js`) não é sessão operacional; `caixas` sem `empresa_id`.
- Script morto `backend/teste_cancelar.js` ainda contém LIMIT 1 global (não é rota).
- Tabelas `caixa` / `caixa_movimentacoes` / `caixa_fechamentos` continuam sem coluna própria; isolamento por sessão.
- Monitoring HTTP não usa `anexarEmpresaCaixa`; depende de `req.empresaId` já anexado, header `X-Empresa-Id` ou contrato EMPRESA_SIMPLES. Sem contexto, retorna vazio — não mistura empresas.

Fora de escopo (inalterado): NFC-e, certificado, CSC, lotes/FEFO, reservas, `estoque_empresa`, arquitetura financeira, vendas, migration estrutural de caixa.

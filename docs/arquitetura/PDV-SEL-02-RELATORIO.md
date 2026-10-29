# PDV-SEL-02 — Relatório: homologação E2E do seletor automático

**Data:** 2026-10-26  
**Pré-requisito:** PDV-SEL-01 aprovada  
**Resultado final:** **APROVADA** (com limitações documentadas na §8)

## 1. Objetivo

Validar o fluxo completo do seletor automático no PDV oficial (`POST /api/vendas`), da requisição HTTP até a persistência da venda, **sem** alterar regras de negócio homologadas na PDV-SEL-01 e **sem** efeitos em ambiente oficial/cliente/SEFAZ.

## 2. Escopo executado

| ID | Cenário | Resultado |
|---|---|---|
| T01 | HTTP completo: servidor seleciona matriz; `vendas.empresa_id` e estoque da matriz coerentes; header divergente não troca empresa | OK |
| T01b | Bloqueio `NENHUMA_EMPRESA_ATENDE` não cria venda parcial | OK |
| T02 | Integridade multiempresa: venda/estoque/caixa da filial selecionada; financeiro/`venda_pagamentos` quando possuem `empresa_id` | OK |
| T03 | Duas `POST /api/vendas` concorrentes no mesmo estoque unitário → 1 sucesso + 1 falha; saldo residual ≤ 0; no máximo 1 venda persistida | OK |
| T04 | `venda_fiscal=true` com só saldo não fiscal → 409; `venda_fiscal=false` consome não fiscal | OK (limitação misto item-a-item: §8) |
| T05 | Caixa compatível / só outra empresa / ausente / header divergente — sem troca silenciosa | OK |
| T06 | Hash/snapshot antigo não autoriza carrinho alterado; servidor reavalia | OK |
| T07 | Regressão SEL-01 + CAP-01 + SEL-02 sequencial | OK |

## 3. Isolamento e restrições

- Banco: `DB_DIR` = diretório temporário (`os.tmpdir()/pdv-sel-02-*`); assert `db.dbPath` inicia em `DB_DIR` e não contém `ProgramData`.
- Flags: `CDS_TEST_ISOLATION=1`, `CDS_BLOQUEAR_BANCO_OFICIAL=1`, `CDS_FORCAR_LOCAL=1`.
- **Não** definido `CDS_ALLOW_OFFICIAL_DB`.
- Sem SEFAZ: payload usa `emitir_fiscal: false` e `venda_fiscal` para o Motor F×NF / capacidade (contrato RC3.15.11 — emissão ≠ tipo de saldo).
- Sem PDV Universal, sem instalador, sem schema/contratos fiscais alterados nesta sprint.
- Sem vendas/pagamentos/baixas em base de cliente.

## 4. Arquivos

| Arquivo | Ação |
|---|---|
| `tests/pdv/pdv-sel-02-e2e-selecao-empresa.test.js` | Novo — harness HTTP Express + `VendaApplicationService.criarVenda` (MULTIEMPRESA) |
| `docs/arquitetura/PDV-SEL-02-RELATORIO.md` | Este relatório |

**Produção:** nenhuma alteração estrutural nesta sprint. Correções ficaram restritas ao harness de teste (seed de `caixa`/`caixa_sessoes`, agregação de `produtos` no helper `setEstoque`).

## 5. Harness E2E

- `express` + `http.createServer` em `127.0.0.1:0`.
- Middleware de teste injeta `req.user`, `req.empresaId` (header simulado), `req.caixaSessao`.
- `POST /api/vendas` → `VendaApplicationService.criarVenda(..., { obterModoOperacaoVenda: () => 'MULTIEMPRESA', db, usarAutorizacaoUsuario: false, verificarFiscalValido: async () => true })`.
- `POST /api/vendas/selecao-empresa` → preview `avaliarSelecaoEmpresaPdv` (T06).
- Fixtures: matriz CNPJ `…0001…` + 2 filiais; estoque via `estoque_empresa`; caixa por empresa (`caixa` + `caixa_sessoes` sem `caixa_id` → FK `caixas`).

## 6. Comandos e resultados (sequenciais)

```text
node --test tests/pdv/pdv-sel-01-selecao-empresa.test.js
→ 18 pass / 0 fail

node --test tests/muv/muv-cap-01-capacidade-selecao.test.js
→ 10 pass / 0 fail

node --test tests/pdv/pdv-sel-02-e2e-selecao-empresa.test.js
→ 7 pass / 0 fail
```

### Evidência T03 (concorrência HTTP)

Duas requisições `Promise.all` sobre o mesmo produto com saldo fiscal unitário na matriz:

- Respostas: exatamente **1** status `< 400` e **1** status `≥ 400` (falha de persistência por saldo insuficiente).
- `estoque_empresa.saldo_fiscal` residual ≤ 0.
- No máximo **uma** venda com id retornado persistida.

Isso demonstra atomicidade efetiva sob concorrência HTTP real — não apenas uma segunda consulta sequencial.

## 7. Critérios de aceite

| Critério | Status |
|---|---|
| Fluxo HTTP completo em ambiente isolado | Atendido |
| Empresa selecionada = venda persistida | Atendido |
| Ausência de efeitos parciais após falha | Atendido (T01b) |
| Concorrência sem consumo duplicado inconsistente | Atendido (T03) |
| Compatibilidade fiscal/não fiscal nos cenários suportados | Atendido (T04) |
| Caixa compatível com empresa selecionada | Atendido (T05) |
| Snapshot invalidado após alteração do carrinho | Atendido (T06) |
| Sem regressão SEL-01 / CAP-01 | Atendido |
| Sem acesso/efeito em ambiente oficial ou cliente | Atendido |

## 8. Limitações

1. **Carrinho misto item-a-item (fiscal + não fiscal no mesmo request):** o seletor avalia **um** `tipoSaldo` por operação (`venda_fiscal` / `emitir_fiscal`). Não há contrato atual de capacidade granular por item com tipos distintos no mesmo carrinho. Motor fiscal **não** foi alterado; cenário estrutural além do escopo — documentado, sem bloqueio dos cenários suportados (operação inteira fiscal **ou** não fiscal).
2. **Emissão NFC-e:** deliberadamente desligada (`emitir_fiscal: false`) para cumprir a restrição de não transmitir à SEFAZ. Capacidade e baixa usam `venda_fiscal`.
3. **Schema heterogêneo:** ownership de itens/pagamentos/financeiro só é assertado quando a coluna `empresa_id` existe e está preenchida; a âncora obrigatória é `vendas.empresa_id` + `caixa_sessao_id` + `estoque_empresa`.

## 9. Conclusão

Homologação E2E do seletor automático **APROVADA**. Escopo funcional do CDS não foi ampliado; produção permanece no estado PDV-SEL-01; evidências isoladas cobrem HTTP, multiempresa, concorrência, caixa, snapshot e regressão.

# PDV-SEL-03 — Diagnóstico do HTTP 409 em `POST /api/vendas/selecao-empresa`

**Data:** 2026-10-26  
**Tipo:** diagnóstico direcionado (somente leitura — sem correção nesta entrega)  
**Pré-requisitos:** MUV-CAP-01, PDV-SEL-01, PDV-SEL-02  
**Estado final:** **CONCLUÍDA** (mecanismo do 409 comprovado; código de bloqueio da ocorrência de campo exige captura Network)

> Nota de nomenclatura: uma entrega anterior no worktree, também rotulada PDV-SEL-03, tratou desalinhamento capacidade-ficha × saldo F+NF (`ServicoCapacidadeCarrinhoEmpresa` + testes `pdv-sel-03-capacidade-ficha-saldo`). Este relatório **substitui** o arquivo de relatório na mesma path conforme a sprint atual (HTTP 409) e referencia aquele trabalho apenas como evidência correlata. Nenhuma alteração de produção foi feita **nesta** sprint.

---

## 1. Objetivo

Identificar por que `POST /api/vendas/selecao-empresa` retorna HTTP 409 no PDV oficial e delimitar a menor correção possível para sprint posterior (sem implementá-la aqui).

---

## 2. Mecanismo comprovado do HTTP 409

### 2.1 Endpoint

`backend/rotas/vendas.js` — `router.post('/selecao-empresa', ...)`:

1. Resolve modo de operação. Se **não** `MULTIEMPRESA` → **200** com `aplicada: false` / `motivo: 'EMPRESA_SIMPLES'` (não é 409).
2. Chama `avaliarSelecaoEmpresaPdv({ body, itens, usuarioId })`.
3. Se `out.bloqueio` → **`res.status(409).json({ success:false, code, error, mensagem, selecao, venda_concluida:false })`**.
4. Caso contrário → **200** com `empresa_id`, `hash_carrinho`, `tipo_saldo`, etc.
5. Em `catch`, se `err.code` → `responderBloqueioSelecao` (default status **409**).

**Fato:** o 409 deste preview é o contrato deliberado de **bloqueio do seletor** (PDV-SEL-01), não um “Conflict” genérico de concorrência HTTP.

### 2.2 Condições que produzem `bloqueio` no preview

Fonte: `SelecaoEmpresaVendaPdvService.avaliarSelecaoEmpresaPdv` + `ServicoCapacidadeCarrinhoEmpresa` + `selecionarEmpresaCapacidade`.

| Código (`code` / `bloqueio.codigo`) | Quando |
|---|---|
| `TIPO_SALDO_INDETERMINADO` | Body sem `emitir_fiscal` **e** sem `venda_fiscal` |
| `CARRINHO_INVALIDO` | Itens vazios / inválidos após normalização |
| `MATRIZ_AMBIGUA` | Mais de uma matriz CNPJ 0001 sem desempate |
| `MATRIZ_AUSENTE` | Sem matriz ativa elegível |
| `SELETOR_AUTOMATICO_NAO_APLICA` | Capacidade em modo simples (no preview HTTP, o gate de modo costuma devolver 200 antes) |
| `NENHUMA_EMPRESA_ATENDE` | Há elegíveis, nenhuma atende o carrinho integral (estoque/ficha/gargalos) |
| `NENHUMA_EMPRESA_ELEGIVEL` | Nenhuma empresa elegível (ex.: sem acesso do usuário) |

Gargalos típicos dentro de `NENHUMA_EMPRESA_ATENDE` (mensagem montada por `montarMensagemBloqueio`):

- `ESTOQUE_INSUFICIENTE` (produto sem ficha)
- `INSUMO_INSUFICIENTE` (ficha)
- `PRODUTO_INDISPONIVEL` / `FICHA_*` / `ERRO_CONSULTA_*`

### 2.3 O que o preview **não** valida

`CAIXA_INCOMPATIVEL` só é lançado em `aplicarSelecaoEmpresaNaVendaPdv` → `validarCaixaDaEmpresaSelecionada` na **finalização** (`POST /api/vendas`), não no preview `selecao-empresa`.

Portanto: **409 no preview ≠ conflito de caixa** (pelo código atual).

---

## 3. Contrato da requisição (PDV → API)

### 3.1 Frontend (`frontend/pdv/js/pdv.js` → `atualizarSelecaoEmpresaPdv`)

Payload enviado:

```json
{
  "itens": [{ "produto_id": <number>, "quantidade": <number>, "unidade": <opcional> }],
  "emitir_fiscal": <true somente se pdvEmitirFiscalNaVenda === true>,
  "origem": "PDV"
}
```

Headers: `Authorization: Bearer …`, opcionalmente `X-Empresa-Id` via `CdsEmpresaContexto.headersJson()`.

**Fato:** o preview **sempre** envia `emitir_fiscal` (boolean). Logo `TIPO_SALDO_INDETERMINADO` é **improvável** neste caminho de UI (ainda possível se outro cliente omitir o campo).

`emitir_fiscal: false` (padrão quando a flag de emissão não está true) → capacidade usa `tipoSaldo = NAO_FISCAL` para itens **sem** ficha; insumos de ficha, após a correção correlata no worktree, usam total F+NF no motor de capacidade.

### 3.2 Resposta 409 (contrato)

```json
{
  "success": false,
  "code": "<CODIGO_BLOQUEIO>",
  "error": "<mensagem>",
  "mensagem": "<mensagem com gargalos opcionais>",
  "selecao": { "bloqueio", "capacidade", "hashCarrinho", "tipoSaldo", ... },
  "venda_concluida": false
}
```

### 3.3 Tratamento no frontend

- Banner vermelho: `data.mensagem || data.error`.
- `showNotification(...)` **somente** se `opcoes.silencioso` for falso.
- Debounce do carrinho chama `atualizarSelecaoEmpresaPdv({ silencioso: true })` → o 409 aparece no Network/console e no banner, **sem** toast em muitos casos.
- O corpo já carrega `code` e `selecao.capacidade.porEmpresa` — suficientes para diagnóstico se capturados.

---

## 4. Relação com `[PDV] Identificação: MIP oficial → fallback legado`

### Evidência estática

O log está em `loadPDV()`, no **sucesso** de `GET /api/produtos?...`:

```text
produtosDisponiveis = normalizarProdutoPdvLista(produtos);
console.log('[PDV] Identificação: MIP oficial → fallback legado');
inicializarPDV();
```

É mensagem informativa do carregamento de catálogo / política MIP no PDV (`carregarFlagMipPdv` / identificação de produto). **Não** chama `selecao-empresa`, **não** altera o seletor e **não** participa do fluxo de capacidade.

### Conclusão causal

**Relação causal entre o log MIP e o HTTP 409: não comprovada; pelo fluxo estático, são eventos independentes** que podem aparecer na mesma sessão do console.

---

## 5. Comparação com contratos aprovados

| Sprint | Relevância para este 409 |
|---|---|
| MUV-CAP-01 | Capacidade por empresa; bloqueio sem somar CNPJs |
| PDV-SEL-01 | Preview `selecao-empresa` + 409 com mensagem clara; revalidação na finalização |
| PDV-SEL-02 | E2E isola 409 em bloqueio / caixa / snapshot |
| Correção correlata (worktree) | Ficha: capacidade alinhada a total F+NF — reduz falsos `INSUMO_INSUFICIENTE` quando só há saldo não fiscal |

O 409 em si **não é regressão**: é o sinal de “nenhuma empresa pode assumir a venda integral”. A pergunta operacional é **qual `code`/gargalo** está sendo retornado na sessão observada.

---

## 6. Causa da ocorrência de campo

| Afirmação | Status |
|---|---|
| Origem do status 409 = `out.bloqueio` no preview | **Comprovada** (código da rota) |
| Código exato (`NENHUMA_EMPRESA_ATENDE`, `MATRIZ_AUSENTE`, …) nesta sessão Electron | **Não comprovado** (sem corpo Network) |
| MIP como causa do 409 | **Refutada** pelo rastreamento estático |
| Estoque/ficha realmente insuficiente vs falso positivo de saldo | **Indeterminado** sem `code` + gargalos + estado de estoque (banco cliente fora de escopo) |

### Dados ainda necessários (Network)

Para a ocorrência concreta, capturar **uma** resposta 409 de `POST /api/vendas/selecao-empresa`:

1. Request body: `itens[]` (`produto_id`, `quantidade`, `unidade`), `emitir_fiscal`, `venda_fiscal` se houver.
2. Response JSON: `code`, `mensagem`, e se presente `selecao.capacidade.porEmpresa[].gargalos` / `motivosInelegibilidade`.
3. Headers relevantes **sem** token: `X-Empresa-Id` (se enviado).

Com isso discrimina-se: matriz ausente vs capacidade vs elegibilidade vs carrinho inválido.

---

## 7. Testes existentes relevantes (não executados nesta sprint — restrição)

Leitura estática dos contratos de teste:

- `tests/pdv/pdv-sel-01-selecao-empresa.test.js` — bloqueios `NENHUMA_EMPRESA_*`, `TIPO_SALDO_INDETERMINADO`, caixa na finalização.
- `tests/pdv/pdv-sel-02-e2e-selecao-empresa.test.js` — HTTP 409 no harness E2E.
- `tests/pdv/pdv-sel-03-capacidade-ficha-saldo.test.js` — ficha + saldo não fiscal / não-soma entre CNPJs.
- `tests/muv/muv-cap-01-capacidade-selecao.test.js` — capacidade pura.

Nenhuma suíte ampla foi executada nesta entrega.

---

## 8. Menor correção recomendada (próxima sprint — **não implementar agora**)

Depende do `code` capturado:

| Se Network mostrar | Menor ação candidata |
|---|---|
| `NENHUMA_EMPRESA_ATENDE` + gargalos reais de estoque/ficha | **Não alterar seletor** — corrigir estoque/ficha operacional ou UX da mensagem; garantir deploy da correção F+NF de ficha se ainda não estiver no binário em uso |
| `MATRIZ_AUSENTE` / `MATRIZ_AMBIGUA` | Corrigir cadastro de empresas (CNPJ 0001 / operacional) |
| `NENHUMA_EMPRESA_ELEGIVEL` | Revisar vínculo usuário↔empresas |
| Mensagem pobre no UI apesar de `code` rico | Melhoria mínima de UX: exibir `code` + primeiros gargalos no banner (sem mudar regras) |
| Falso positivo de capacidade ainda reproduzível após F+NF | Nova sprint de correção mínima **com** teste isolado — só após autorização |

**Não recomendado:** remover o 409, somar CNPJs, escolher empresa sem capacidade, contornar o seletor.

---

## 9. Arquivos

### Inspecionados

- `backend/rotas/vendas.js` (`POST /selecao-empresa`)
- `backend/services/vendas/SelecaoEmpresaVendaPdvService.js`
- `backend/motores/muv/capacidade/ServicoCapacidadeCarrinhoEmpresa.js`
- `backend/motores/muv/capacidade/selecionarEmpresaCapacidade.js`
- `frontend/pdv/js/pdv.js` (`atualizarSelecaoEmpresaPdv`, `loadPDV`, MIP)
- Testes `tests/pdv/pdv-sel-0{1,2,3}-*.js`, `tests/muv/muv-cap-01-*.js` (leitura)

### Alterados nesta sprint

- **Somente** `docs/arquitetura/PDV-SEL-03-RELATORIO.md` (este arquivo).

### Confirmação

**Nenhuma alteração de produção, schema, motor fiscal, regras de estoque, PDV Universal ou banco foi realizada nesta sprint.**

---

## 10. Encerramento

| Item | Valor |
|---|---|
| Estado | **CONCLUÍDA** |
| Origem do HTTP 409 | Comprovada: bloqueio do seletor (`out.bloqueio` → 409) |
| Código de bloqueio da sessão observada | Pendente de Network (`code` + gargalos) |
| MIP ↔ 409 | Sem relação causal (eventos independentes) |
| Próxima ação | Capturar corpo 409 → PO autoriza correção mínima alinhada à tabela do §8 |

**Não implementar correção sem nova autorização.**

# RELATÓRIO — Sprint 07 · S07-1 — Interface Visual do Painel KDS

**Data:** 2026-11-17  
**Responsável implementação:** Cursor  
**Status:** ENTREGUE PARA AUDITORIA DO TECH LEAD  
**Escopo:** somente interface + consulta `GET /api/cozinha/preparacao/painel`

---

## 1. Arquivos criados e alterados

### Criados
| Arquivo | Função |
|---------|--------|
| `frontend/erp/js/cozinha-kds.js` | UI KDS, poll 5s, render, consumo API |
| `frontend/css/cozinha-kds.css` | Tema escuro operacional (TV/monitor) |
| `tests/cozinha/sprint07-s07-1-painel-kds-ui.test.js` | Testes direcionados S07-1 |
| `Agent/LOG-SPRINT07-S07-1.txt` | Log dos testes |
| `Agent/EVIDENCIA-S07-1-KDS-VISUAL.html` | Evidência visual estática (HTML real do renderer) |
| `Agent/_gen-evidencia-s07-1-visual.js` | Gerador da evidência visual |
| `Agent/RELATORIO-SPRINT07-S07-1.md` | Este relatório |

### Alterados (registro ERP apenas)
| Arquivo | Mudança |
|---------|---------|
| `frontend/erp/index.html` | Menu **Cozinha (KDS)** + CSS |
| `frontend/erp/js/app.js` | `CDS_ERP_PAGE_SCRIPTS` + `case 'cozinha-kds'` |
| `frontend/shared/js/access-control.js` | `'cozinha-kds': 'vendas'` |
| `frontend/shared/js/core.js` | Catálogo de pesquisa + gate `pedidos` |

### Não alterados (confirmado)
- Backend S07-0 (`CozinhaKdsPainelService.js`, contrato painel)
- Sprint 06 (worker/fila/Electron impressão)
- PDV
- Login / autenticação
- Schema v3 / banco

---

## 2. Interface implementada

- Tema escuro para monitor/TV.
- Cabeçalho: **Cozinha (KDS)**, empresa, unidade (`unidade_id` da API), última atualização, status e botão **Atualizar agora**.
- Três colunas: **Aguardando** (amarelo), **Em preparação** (azul), **Prontos** (verde) com contadores.
- Cartões grandes: mesa, comanda, rodada, sequência, horário, produtos, quantidades, tipo e observações.
- Distribuição por `item.estado_preparacao`; FIFO por `sequencia_global`.
- Polling 5s sem sobreposição; erro preserva últimos dados válidos.
- Estados: carregamento, vazio, erro.
- Idioma: português brasileiro.
- **Sem** botões de iniciar/pronto/cancelar (somente consulta).

Entrada: menu Comercial → **Cozinha (KDS)** (`data-page="cozinha-kds"`, recurso `pedidos`).

---

## 3. Evidência visual

- HTML gerado pelo renderer real: `Agent/EVIDENCIA-S07-1-KDS-VISUAL.html`
- Captura de tela no browser de evidência (viewport do IDE pode estreitar colunas; o CSS de produção usa 3 colunas acima de 900px).
- Conteúdo visível validado: cabeçalho, colunas coloridas, cartões Mesa 01/05, observações, contadores.

---

## 4. Consumo da API S07-0

Endpoint exclusivo:

`GET /api/cozinha/preparacao/painel?limite=100&offset=0`

- Headers via `CdsEmpresaContexto.headersAuth()` (Bearer + `X-Empresa-Id`).
- Campos usados do contrato real: `empresa_id`, `unidade_id`, `total`, `ordenacao`, `rodadas[]` com `mesa_numero`, `numero_rodada`, `sequencia_global`, `enviada_em`, `itens[]` (`qty_solicitada`, `produto_nome_snapshot`, `observacoes_snapshot`, `tipo_item`, `estado_preparacao`, `numero_comanda`, `sequencia_global`).
- Nenhum campo inventado; nenhuma mutação.

---

## 5. Testes

Comando:

```
CDS_BLOQUEAR_BANCO_OFICIAL=1
CDS_TEST_ISOLATION=1
node --test --test-concurrency=1 tests/cozinha/sprint07-s07-1-painel-kds-ui.test.js
```

Resultado (`Agent/LOG-SPRINT07-S07-1.txt`):

| Métrica | Valor |
|---------|------:|
| tests | 10 |
| pass | 10 |
| fail | 0 |
| skipped | 0 |

Cobertura: renderização, distribuição de estados, itens/obs, FIFO, consumo API, poll 5s, atualização manual, anti-sobreposição, erro com preservação, lista vazia, registro ERP, ausência de mutações/S06.

---

## 6. Sprint 06 intacta

Mtimes inalterados nesta entrega:

- `CozinhaImpressaoWorkerService.js` — 17/11/2026 16:57
- `CozinhaImpressaoFilaService.js` — 16/11/2026 23:56
- `electron-cozinha-impressao.js` — 17/11/2026 15:35

`CozinhaKdsPainelService.js` (S07-0) sem alteração nesta entrega.

---

## 7. Banco oficial

- Testes S07-1 são unitários de UI (sem abrir SQLite).
- `CDS_BLOQUEAR_BANCO_OFICIAL=1` / `CDS_TEST_ISOLATION=1`.
- Sem `CDS_ALLOW_OFFICIAL_DB`.
- Sem impressão física.

---

## 8. Pendências e limitações

1. **Abastecimento:** a tela fica vazia sem despacho real (`POST /api/cozinha/despacho`); dual-write ERP→Cozinha continua fora de escopo.
2. **Unidade:** exibe `Unidade #id` retornado pela API; login ainda não coleta rótulo amigável da unidade (alteração de login proibida).
3. **Ações KDS (iniciar/pronto):** deliberadamente **não** implementadas (S07-1 = consulta).
4. **Nome da unidade / estação:** sem endpoint novo nesta entrega.
5. Referência visual do PO citada na ordem não estava anexada como arquivo de mockup KDS nesta mensagem; a UI seguiu a direção visual escrita do escopo (tema escuro, 3 colunas amarelo/azul/verde).

---

## Veredito

**S07-1 concluída conforme escopo. Parar. Aguardar auditoria do Tech Lead. Não iniciar S07-2.**

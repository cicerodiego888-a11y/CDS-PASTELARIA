# RELATÓRIO — S07-3B Correção finally após HTTP 503

**Data:** 2026-11-18  
**Escopo:** estados de botão após 503 + regressão  
**S07-3C:** não iniciado

---

## Correção

Nos três `finally` de `salvarModo`, `salvarPadrao` e `salvarSegmento`:

```js
if (btn) btn.disabled = !!estado.schemaIndisponivel;
```

Assim o botão **não** é reabilitado quando a API responde `503 SCHEMA_ROTEAMENTO_INDISPONIVEL`.  
Guardas iniciais `if (estado.schemaIndisponivel)` preservadas.

---

## Testes

`sprint07-s07-3b-roteamento-ui.test.js` — **12/12 PASS**

Novo: `UI: PUT 503 mantém gravação desabilitada após finally (modo/padrão/segmento)` — cobre os **três** caminhos:

| Verificação | Resultado |
|-------------|-----------|
| PUT → 503 | 1 chamada por caminho |
| Painel visível | ✔ |
| Banner prévia | ✔ |
| Botão acionado disabled após finally | ✔ |
| Demais controles de gravação disabled | ✔ |
| 2ª tentativa sem novo PUT | ✔ |

Flags: isolamento + DB temp. Sem migration/DDL no oficial.

---

## Artefatos

- Diff: `Agent/DIFF-S07-3B-FINALLY-503.patch`
- Log: `Agent/LOG-S07-3B-FINALLY-503.txt`
- Este relatório: `Agent/RELATORIO-S07-3B-FINALLY-503.md`

## Confirmações

- Três botões de gravação permanecem desabilitados após 503.  
- S06 / S07-2 / S07-3A / APIs de roteamento não alterados.  
- S07-3C não iniciado.

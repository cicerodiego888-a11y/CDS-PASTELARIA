# RELATÓRIO — S07-3B Ajuste visual sem migration (503)

**Data:** 2026-11-18  
**Escopo:** somente correção de apresentação no 503  
**S07-3C:** não iniciado

---

## Correção

Quando a API retorna `503 SCHEMA_ROTEAMENTO_INDISPONIVEL`:

1. Painel **permanece visível** (não usa mais `d-none` no conteúdo).
2. Alerta de schema / migration controlada é exibido.
3. Banner **Prévia visual apenas** — deixa claro que não há config carregada do servidor.
4. Controles de gravação (`data-coz-rot-gravacao`) e radios ficam **disabled**.
5. Modos, cozinha padrão e tabela de segmentos continuam legíveis.
6. Sem associação inventada como “salva”; selects vazios; unidades reais (ou `[DEMO]` se não houver unidades).

Em `200`: dados reais + gravação habilitada.  
Em `403`: bloqueio de acesso permanece (painel oculto + alerta).

---

## Testes

`tests/cozinha/sprint07-s07-3b-roteamento-ui.test.js` — **11/11 PASS**  
Flags de isolamento + DB temp. Sem DDL/migration no oficial.

---

## Artefatos

- Diff: `Agent/DIFF-S07-3B-AJUSTE-PREVIA-503.patch`
- Log: `Agent/LOG-S07-3B-AJUSTE-PREVIA-503.txt`
- Capturas (módulo real `cozinha-roteamento.js` + 503 simulado):
  - `Agent/EVIDENCIA-S07-3B-PREVIA-503.png`
  - `Agent/EVIDENCIA-S07-3B-PREVIA-503-FORM.png`
  - `Agent/EVIDENCIA-S07-3B-PREVIA-503.html`

ERP oficial (porta 3001) estava fora do ar no momento da captura; a evidência usa o **mesmo JS de produção** montado em `#page-content` com fetch 503 — sem banco oficial.

---

## Confirmações

- Sem migration / sem DDL no oficial.  
- S06, S07-2 e S07-3A preservados.  
- S07-3C não iniciado.

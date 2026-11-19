# PENDÊNCIA INDEPENDENTE — Dependência circular (`recalcularEstoqueConsolidado`)

**Status:** ABERTA  
**Escopo:** **fora do Sprint 06** (não incorpora nem reabre a impressão de cozinha)  
**Registrada em:** 2026-11-17  
**Origem da observação:** logs de validação automatizada (Node.js warning)  

---

## Advertência observada

Durante a execução de testes (incluindo a validação final do Sprint 06), o runtime Node emitiu:

```text
Warning: Accessing non-existent property 'recalcularEstoqueConsolidado'
of module exports inside circular dependency
```

A advertência aparece em suítes que carregam módulos de estoque/financeiro do ERP; **não** é um critério de falha da impressão de cozinha e **não** bloqueou a aprovação técnica do Sprint 06.

---

## Decisão do Tech Lead

- Registrar como **pendência independente**.
- **Não** incorporar ao Sprint 06.
- **Não** alterar blocos aprovados da impressão de cozinha para “corrigir” este aviso.
- Tratar em trabalho futuro, se/quando o Product Owner priorizar (ex.: refatoração de grafo de `require` no módulo de estoque).

---

## Restrições até priorização

- Não misturar com homologação física de cozinha.
- Não usar como pretexto para reabrir A–E do Sprint 06.
- Qualquer correção futura deve ter escopo, causa e arquivo afetados apresentados antes da mudança.

**Próxima ação:** aguardar priorização do Product Owner.

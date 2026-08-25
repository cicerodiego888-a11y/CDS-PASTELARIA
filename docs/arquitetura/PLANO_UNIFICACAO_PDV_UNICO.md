# PLANO DE UNIFICAÇÃO — ÚNICO PDV OFICIAL (CDS)

**Sprint 05.19.1 — somente plano.**  
Não implementar remoção, não deletar `/pdv`, não alterar MUV, VAS, `POST /api/vendas`, fiscal, estoque.

## Fórmula (regra absoluta)

```
Interface operacional madura do legado
+ Arquitetura do PDV Universal
+ MUV
+ Multiempresa / Empresa Única
+ Motor fiscal
+ Motor de pagamento (existente)
+ Motor Equipamentos (existente)
= ÚNICO PDV OFICIAL
```

**Proibido:** Universal + legado = terceiro PDV.

## FASE 1 — Shell visual no Universal

- Replicar **densidade** do `pdv.html` (header / 2 colunas / rodapé de chips) em `pdv-universal.css` + `index.html` do Universal.
- Manter estados LOADING/ERROR/READY e contexto empresa.
- Não importar `pdv.js`.

## FASE 2 — Layout (sem motor)

Migrar só apresentação:

- header (marca, operador, relógio, modo, empresa)
- busca (label + dropdown)
- tabela de itens
- resumo (TOTAL grande)
- painel de ações
- chips de atalhos **oficiais Universal** (F1, ESC) + placeholders só se já houver ação Universal

Não ligar F10 a `/api/vendas`.

## FASE 3 — Bind no atendimento Universal

- Busca/dropdown → `consulta-pdv` + `identificar` (API já existente) → cart Universal.
- Quantidade/remoção → `PdvUniversalCart`.
- Finalizar → `POST /api/pdv-universal/checkout`.
- Desconto/acréscimo: só se o **contrato atual** de checkout/MUV já aceitar; senão sprint de contrato (não inventar API paralela).

## FASE 4 — Inventário do que ainda é exclusivo

Usar `LISTA_FUNCIONALIDADES_EXCLUSIVAS_LEGADO.md`. Agrupar:

1. Visual já coberto  
2. Domínio já no VAS/MUV sem UI  
3. Domínio só no legado (entrega, caixa UI, TEF, PIX, prazo)

## FASE 5 — Absorver só o que falta (sem duplicar serviço)

Ordem sugerida (depende de operação):

1. Paridade busca (identificar / PLU / ENTER leitor)  
2. UX pagamento (troco, misto) **reusando** `/api/tef` e `/api/pix` — não novo motor  
3. Desconto/acréscimo/atacado via contratos oficiais  
4. Etiqueta/peso via Motor Equipamentos (já usado pelo legado)  
5. UI de caixa apontando para `/api/caixa/*` existentes  
6. Entrega apontando para APIs `/api/vendas/entregas*` e criação via **porta Universal** (adaptador), **nunca** terceiro checkout

Não migrar lógica de empresa fixa.

## FASE 6 — Testes

Critério da seção 8 da auditoria (25 itens): testes unitários + HTTP + visual assistido.  
**Não** declarar 100% só com Node.

## FASE 7 — Desativar rota `/pdv` (só depois do critério)

Documental: `server.js` deixa de servir `frontend/pdv/index.html` (redirect para `/pdv-universal/`).  
**Ainda não executar.**

## FASE 8 — Remover menu “PDV legado”

ERP `#nav-abrir-pdv-legado` e link no header Universal.  
**Ainda não executar.**

## FASE 9 — Arquivar código morto

Após regressão total: `frontend/pdv/**` sem referências.  
`POST /api/vendas` **permanece** para outros clientes (ERP, entrega histórica, integrações) até auditoria própria.

## Atalhos — política

| Atalho | Legado | Universal hoje | Unificação |
|--------|--------|----------------|------------|
| F1 | Consulta modal | Foco busca | **Manter contrato Universal** (foco). Modal consulta = feature extra, outro atalho ou F1 longo — decidir em sprint de UX, não restaurar às cegas |
| F2 | Foco busca | — | Conflito com F1 Universal; não portar |
| F4 | Qtd último | — | Só após tabela; opcional |
| F7 | Fechar caixa | — | Só com UI caixa; **não** peso |
| F8 | Desconto | — | Após desconto existir |
| F9 | Entrega | — | Após entrega existir |
| F10 | Finalizar | — | Pode mapear para FINALIZAR ATENDIMENTO (mesmo pipeline Universal) |
| F11 | Aparência | — | Opcional |
| ESC | Cancela venda | Fecha modal | **Preservar regra Universal** no pagamento; cancelar venda = botão explícito |

## Quando o legado pode ser removido

Somente quando os 25 critérios de `AUDITORIA_PROFUNDA_PDV_LEGADO_VS_UNIVERSAL.md` §8 estiverem **comprovados** (não só planejados).

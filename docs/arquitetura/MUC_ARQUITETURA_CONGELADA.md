# MUC — Arquitetura Congelada e Consolidada (RC3.0)

**Tag Git:** `MUC_RC3.0_CONSOLIDADO`  
**Fronteira da API pública:** congelada em RC2.1 (7 métodos + DTOs 1.0.0)  
**Data de consolidação:** 2026-09-03  
**Sprint:** MUC-08 — Limpeza residual e fechamento  
**Status:** CONSOLIDADO  

---

## Declaração

A partir de **RC2.1**, a fronteira da API pública está congelada. Módulos externos devem consumir exclusivamente [`docs/contratos/MUC_PUBLIC_API.md`](../contratos/MUC_PUBLIC_API.md).

**RC3.0** declara o motor **consolidado**: conversão operacional de quantidade ocorre somente via MUC (`obterMuc(db).converterQuantidade` / `processarItemCompra` / pipeline). Não há conversor paralelo de estoque. Novas sprints MUC só com requisito, bug ou evidência arquitetural.

---

## Arquitetura

```
┌─────────────────────────────────────────────────────────┐
│              MÓDULOS EXTERNOS (compras, produtos…)       │
│         require('motores/muc') → obterMuc(db)            │
└───────────────────────────┬─────────────────────────────┘
                            │ API PÚBLICA (7 métodos)
┌───────────────────────────▼─────────────────────────────┐
│              MotorUniversalConversao (Facade)              │
└───────────────────────────┬─────────────────────────────┘
                            │ INTERNO (protegido)
┌───────────────────────────▼─────────────────────────────┐
│  PipelineMuc → Parser → Validação → Normalização →       │
│  Inferência → Conversão → Auditoria → ResultadoConversaoDTO│
└─────────────────────────────────────────────────────────┘
```

---

## Pipeline (interno — congelado estruturalmente)

1. `MotorParser`
2. `MotorValidacao`
3. `MotorNormalizacao`
4. `MotorInferenciaEtapa`
5. `MotorConversaoCalculo`
6. `MotorAuditoriaEtapa`
7. `ResultadoConversaoDTO`

Orquestração: `pipeline/PipelineMuc.js`

---

## Contratos Públicos

| Artefato | Versão |
|----------|--------|
| API pública | RC2.1 |
| Contrato DTO | 1.0.0 |
| Eventos | 1.0.0 |

### DTOs

- `ConversaoDTO`
- `ResultadoConversaoDTO`
- `ProdutoApresentacaoDTO`
- `RegraConversaoDTO`

### Facade — métodos públicos

1. `converter()`
2. `processarItemCompra()`
3. `simular()`
4. `buscarApresentacao()`
5. `aprender()`
6. `exportarMetricas()`
7. `obterVersao()`

---

## Eventos (v1.0.0)

- `MUC_CONVERSAO_EXECUTADA`
- `MUC_CONVERSAO_CONFIRMADA`
- `MUC_CONVERSAO_MANUAL`
- `MUC_APRESENTACAO_APRENDIDA`
- `MUC_ERRO`
- `MUC_INFERENCIA_FALHOU`

---

## Versionamento

| Versão | Sprint | Marco |
|--------|--------|-------|
| RC1 | MUC-25 | Motor funcional unificado |
| RC2 | MUC-26 | Pipeline enterprise |
| **RC2.1** | **MUC-27** | **Governança + congelamento da API** |
| RC2.2+ | — | Minor (novos métodos públicos) |
| **RC3.0** | **MUC-08** | **Consolidado** (sem breaking de DTO; status operacional) |

Política completa: [`MUC_PUBLIC_API.md`](../contratos/MUC_PUBLIC_API.md) §10.

---

## Políticas

1. **Importação:** somente `obterMuc()` e factories de DTO públicos.
2. **Conversão:** proibida lógica paralela fora do MUC.
3. **Evolução interna:** permitida sem bump de versão pública.
4. **Evolução pública:** exige RFC + atualização de contrato + testes.

Checklist PR: [`docs/governanca/MUC_PR_CHECKLIST.md`](../governanca/MUC_PR_CHECKLIST.md)

---

## Certificação

```bash
node tests/muc/muc-rc1-certificacao.test.js      # compat funcional
node tests/muc/muc-rc2-certificacao.test.js      # arquitetura pipeline
node tests/muc/muc-public-contract.test.js       # contrato público RC3.0 (API RC2.1)
```

---

## Histórico

| Data | Versão | Evento |
|------|--------|--------|
| 2026-07 | RC1 | Motor Universal de Conversão — primeira versão oficial |
| 2026-07 | RC2 | Pipeline desacoplado, eventos, métricas, cache |
| 2026-07-31 | RC2.1 | Contrato público formalizado, arquitetura congelada |
| 2026-09-03 | RC3.0 | Consolidação operacional (MUC-08); DTO 1.0.0 preservado |

---

## Assinatura da Arquitetura

```
Motor:     MUC RC3.0
Contrato:  1.0.0
Eventos:   1.0.0
Tag:       MUC_RC3.0_CONSOLIDADO
Status:    CONSOLIDADO
```

**CDS Sistemas — Plataforma Mult-Caixas Inteligente**

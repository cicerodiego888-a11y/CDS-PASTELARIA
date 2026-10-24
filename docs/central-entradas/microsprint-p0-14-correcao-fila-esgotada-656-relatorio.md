# Microsprint P0.14 — Correção fail-closed de fila esgotada após cStat 656

**Tipo:** correção de decisão local (sem operação SEFAZ)  
**Data:** 18/10/2026  
**Veredito:** **APROVADO COM RESSALVAS**

---

## 1. Objetivo e escopo

Corrigir a lacuna da P0.13: após `cStat 656` com `ultNSU=maxNSU`, a expiração de `cooldown_ate` (1 h) fazia `CentralConsultaDistDfeDecisaoService` emitir `PRONTO_PARA_CONSULTA`, permitindo DistDFe que a SEFAZ ainda classifica como consumo indevido.

**Feito:** alteração da decisão/cooldown local, proteção do probe de diagnóstico, testes isolados, relatório.  
**Não feito:** SOAP, alteração do banco oficial/NSU/flags de produção, commit/push, consulta real de validação.

---

## 2. Causa local corrigida

| Antes (P0.11–P0.13) | Depois (P0.14) |
|---|---|
| `FILA_ESGOTADA` só com cStat **137/138** | Também com **656** quando `ultNSU=maxNSU` |
| Janela FILA = **1 h** desde `data_sincronizacao` (coincidia com fim do cooldown 656) | Janela de **reavaliação = 24 h** (`INTERVALO_REEVALIACAO_FILA_ESGOTADA_MS`), independente do cooldown explícito |
| Cooldown 656 expirado + ult=max → `PRONTO_PARA_CONSULTA` | → bloqueio `FILA_ESGOTADA` até reavaliação ou avanço do cursor |
| Probe diagnóstico: catch engolia falha do Gate | Fail-closed + decisão centralizada antes do SOAP |

---

## 3. Arquivos e funções alterados

| Arquivo | Mudança |
|---|---|
| `backend/motores/central-entradas/services/CentralNsuService.js` | `avaliarCooldown`, `montarMensagemCooldown`, constantes `CSTAT_FILA_ESGOTADA` / `INTERVALO_REEVALIACAO_FILA_ESGOTADA_MS` |
| `…/CentralConsultaDistDfeDecisaoService.js` | Códigos `FILA_ESGOTADA`, `ESTADO_NSU_INCONSISTENTE`; mapeamento do motivo NSU |
| `…/CentralSincronizacaoService.js` | Compat `AGUARDAR_JANELA_DFE` para os novos códigos |
| `…/CentralSyncExecucaoService.js` | `codigoDecisao` distingue FILA / inconsistência / cooldown |
| `…/CentralOperacaoFiscalRealService.js` | Pré-voo e `etapaPorCodigoPreVoo` reconhecem FILA/inconsistência |
| `…/CentralDiagnosticoService.js` | Probe: Gate fail-closed + decisão DistDFe antes de `enviarDistribuicaoDfe` |
| `tests/central-entradas/microsprint-p0-14-correcao-fila-esgotada-656.test.js` | Suíte nova (14 testes) |
| Testes P0.11 / auditoria cooldown / nfe-nao-localizada | Expectativas alinhadas à nova semântica |

**Não alterado nesta sprint:** `empresa_id` em auditoria; unificação de correlation IDs; boot/`database.js`.

---

## 4. Regra anterior × regra nova

### Cooldown explícito (`COOLDOWN_EXPLICITO`)

- **Inalterado:** `cooldown_ate` de 1 h em `aplicarRetornoDistDfe` para cStat 656.
- Prioridade máxima na avaliação (avaliado antes da fila).

### Fila esgotada (`FILA_ESGOTADA`)

**Antes:** `ult=max` + cStat ∈ {137,138} + &lt;1 h desde `data_sincronizacao`.  
**Depois:** `ult=max` + cStat ∈ {137,138,**656**} + &lt;**24 h** desde `data_sincronizacao`.

A expiração do cooldown de 1 h **não** basta para liberar.

### Estado inconsistente (`ESTADO_NSU_INCONSISTENTE`)

Fail-closed quando: `ult > max`, NSU não parseável, ou evidência de fila (cStat no conjunto + ult=max) **sem** `data_sincronizacao` válida.

---

## 5. Comportamento por cStat

| cStat | Significado (SEFAZ / uso local) | Proteção P0.14 |
|---|---|---|
| **137** | Nenhum documento localizado | Se `ult=max` → FILA (24 h reavaliação). Não avança cursor além do par persistido. |
| **138** | Documento(s) localizado(s) | Se `ult < max` → **não** é FILA (ainda há o que buscar). Se `ult=max` → FILA (cursor no topo). Documentos já recebidos não são apagados. |
| **656** | Consumo indevido | NSU **preservado**; `maxNSU=0` remoto **não** redefine cursor; cooldown 1 h explícito; após expirar, FILA se ainda `ult=max`. |

Os três códigos **não** são tratados como semanticamente idênticos: 138 com documentos pendentes (`ult < max`) continua elegível; só o topo do cursor compartilha o bloqueio de fila.

---

## 6. Estratégia de reavaliação

| Condição | Efeito |
|---|---|
| `ultNSU !== maxNSU` (avanço legítimo persistido) | FILA deixa de aplicar imediatamente |
| `data_sincronizacao` + 24 h | Reavaliação local — pode voltar a `PRONTO_PARA_CONSULTA` **sem** provar que a SEFAZ aceitará |
| Só expirar `cooldown_ate` (1 h) | **Não** libera se FILA ainda ativa |
| `forcar` / `ignorarCooldown` | **Não** contornam |
| Consulta automática para “descobrir” se a fila encheu | **Não** introduzida |

**Distinção diagnóstica preservada**

| Motivo / código | Significado |
|---|---|
| `COOLDOWN_EXPLICITO` / `COOLDOWN_ATIVO` | Timer `cooldown_ate` (656) |
| `FILA_ESGOTADA` | Cursor no topo com evidência 137/138/656 |
| Gate 656 | Bloqueio progressivo do Gate |
| `CONSULTA_EM_ANDAMENTO` | Mutex / sync em curso |
| `RATE_LIMIT_ATIVO` | Anti-rajada local 30 s |
| `ESTADO_NSU_INCONSISTENTE` / `NSU_INDISPONIVEL` | Estado ausente ou falha de leitura |

---

## 7. Caminhos de transmissão protegidos

| Caminho | Proteção |
|---|---|
| Consulta real / pré-voo OPERACAO_REAL | Decisão unificada (códigos FILA/cooldown) |
| Sync orquestrado / BACKGROUND / abrir Central | Decisão em `CentralSincronizacaoService` + check em `CentralSyncExecucaoService` |
| Probe `CentralDiagnosticoService.testarConexaoSefaz` (`forcarProbeDistDfe`) | Gate fail-closed + decisão NSU/FILA antes do SOAP |
| Recuperação XML | Continua sem autorizar DistDFe própria (legado) |

---

## 8. Testes

### Executados (isolados: preload + `:memory:` / temp `DB_DIR`; sem SOAP; sem banco oficial)

| Suíte | Resultado |
|---|---|
| `microsprint-p0-14-correcao-fila-esgotada-656.test.js` | **14/14 OK** |
| `microsprint-p0-11-normalizacao-cooldown-consulta-controlada.test.js` | **OK** (expectativa pós-cooldown 656 alinhada) |
| `nfe-nao-localizada-sync.test.js` | **OK** |
| `microsprint-auditoria-cooldown-distdfe.test.js` | **12/12 OK** (execução isolada do arquivo) |

Cobertura P0.14: cooldown expirado+656 bloqueia; cooldown ativo; 137; 138 ult&lt;/ =max; avanço de cursor; inconsistência; forcar/ignorar; SyncExecucao sem SOAP; empresa explícita; motivo/etapa; NSU preservado em 656; probe fail-closed (inspeção de código); janela 24 h.

### Não executados / limitações

- Consulta DistDFe real (proibida nesta sprint).
- Teste de integração multi-arquivo no mesmo processo Node pode falhar por contaminação de `DB_DIR`/schema entre suítes que abrem `database.js` — cada arquivo foi validado isoladamente quando necessário.
- Probe DistDFe end-to-end com mock de rede: coberto por inspeção de código + decisão unitária (evitar carregar fluxo completo com side-effects de schema além do necessário).

---

## 9. Confirmações de proteção

- Nenhuma operação fiscal remota / SOAP nesta microsprint.
- Nenhuma escrita no banco oficial; NSU/cooldown/flags de produção **não** alterados.
- Sem `CDS_ALLOW_OFFICIAL_DB=1`, sem Electron/`server.js` para validar.
- Sem commit/push/merge.

---

## 10. Riscos residuais

1. **Janela de 24 h ainda é um timer local** — após 24 h com `ult=max`, `PRONTO` pode voltar sem garantia SEFAZ (documentado; não é o cooldown de 1 h).
2. **Mutex continua in-process** (P0.13) — duas instâncias Electron não compartilham lock.
3. **`empresa_id` nulo na auditoria** — item separado; não corrigido aqui.
4. **Reavaliação por evidência externa** (upload/import que só avance `max_nsu`) depende de fluxos autorizados existentes; não há botão “liberar fila” novo.
5. Esta correção **não prova** que a SEFAZ aceitará a próxima DistDFe autorizada.

---

## 11. Veredito

### **APROVADO COM RESSALVAS**

Ressalvas: reavaliação ainda pode liberar após 24 h sem evidência SEFAZ; mutex multi-processo e `empresa_id` em auditoria fora do escopo.

**Regra implementada:** com `ultNSU=maxNSU` e último cStat ∈ {137,138,656}, a expiração do cooldown explícito de 1 h **não** autoriza nova DistDFe; bloqueio `FILA_ESGOTADA` até avanço do cursor ou janela de reavaliação de 24 h.

**Próximo passo operacional:** qualquer DistDFe real exige autorização específica posterior; não repetir consulta só para “testar” a correção.

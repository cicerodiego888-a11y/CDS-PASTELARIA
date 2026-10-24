# CE-MANIFESTACAO-01 — Alinhamento UX e auditoria de escopo multiempresa

**Tipo:** Fase 1 implementada (UX) · Fase 2 diagnóstico/proposta (sem mudança de persistência)  
**Data:** 2026-10-18  
**Base:** `diagnostico-manifestacao-somente-leitura-relatorio.md`

> **Confirmação expressa:** não houve operação real na SEFAZ (SOAP / DistDFe / 210210), nem alteração do banco oficial (`ProgramData\MercantilFiscal\dados\mercadao.db`). Valor `AUTOMATICA_CIENCIA` **não** foi alterado. Scheduler e regras fiscais **não** foram modificados. Sem commit/push/merge/migração.

---

## 1. Fase 1 — Correção UX (implementada)

### 1.1 Arquivos alterados

| Arquivo | Alteração |
|---|---|
| `frontend/erp/js/central-entradas.js` | Texto de origem → `Centro de Configurações → Diagnóstico → Manifestação do Destinatário` (card + status); `__CDS_CFG_FORCE_TAB = 'diagnostico'`; âncora `manifestacao` mantida; card permanece somente leitura |
| `frontend/erp/js/cds-centro-configuracoes.js` | FORCE_TAB passa por mapa legado + validação de categoria; `focarCardManifestacao` avisa se o card não existir (UI fiscal off) — **sem** ampliar acesso |
| `tests/central-entradas/rc43-consolidacao-manifestacao-ux.test.js` | Asserts de deep-link `diagnostico`, âncora e texto de origem |

### 1.2 Deep-link — confirmação por código

Fluxo após o botão “Abrir Configuração Fiscal” da Manifestação:

1. `abrirConfigFiscalManifestacaoCentral()` define `__CDS_CFG_FORCE_TAB = 'diagnostico'` e `__CDS_CFG_FORCE_ANCHOR = 'manifestacao'`.
2. `loadPage('configuracoes-avancadas')` → init do Centro aplica FORCE_TAB (agora validado contra `CATEGORIAS` / legado `fiscal→diagnostico`).
3. `ativarCategoria('diagnostico')` + `focarCardManifestacao()` destaca `#cdsCfgCardManifestacao`.

Card da Central permanece RO (badge + sem radios); edição continua só no Centro.

### 1.3 Interface fiscal desabilitada

| Fato | Evidência |
|---|---|
| Categoria `diagnostico` é `fiscal: true` | `CATEGORIAS` em `cds-centro-configuracoes.js` |
| Pane/card de Manifestação só renderiza com `configPermiteFiscalUi()` | Template `${fiscalUi ? \`...\`}` |
| Sem UI fiscal, deep-link **não** amplia acesso | `ativarCategoria` cai na 1ª categoria visível; card ausente no DOM |
| Comportamento nesta microsprint | Notificação warning ao falhar o foco do card — operador informado, permissões intactas |

---

## 2. Testes executados

Ambiente isolado (temp DB via harness dos testes). Sem SEFAZ.

| Suite | Resultado |
|---|---|
| `tests/central-entradas/rc43-consolidacao-manifestacao-ux.test.js` | **OK** |
| `tests/central-entradas/rc41-endpoints-ux.test.js` | **3 ok, 0 falha** |
| `tests/central-entradas/rc4-configuracao.test.js` | **16 ok, 0 falhou** |

Testes novos de escopo por empresa **não** foram acrescentados (modelo de persistência não mudou nesta etapa).

---

## 3. Fase 2 — Mapa de leitores e escritores

Chave atual: `manifestacao_destinatario_politica` em `central_entradas_config` (KV global, `chave UNIQUE`, sem `empresa_id`).

### 3.1 Escritores

| Origem | Caminho | Escopo |
|---|---|---|
| UI Centro | `salvarPoliticaManifestacaoCentro` → `PUT /api/central-entradas/configuracao` `{ sefaz: { politicaManifestacao } }` | Global |
| Service | `CentralConfiguracaoService.atualizar` → `repository.salvar(CHAVES.POLITICA_MANIFESTACAO, …)` | Global |
| Seed | `CentralConfiguracaoRepository.ensureDefaults` INSERT OR IGNORE default `MANUAL` | Global (não sobrescreve) |
| Restore API | `POST .../configuracao/restaurar` (fluxo de restore do controller) | Global |

`PUT` **não** exige `empresa_id` para gravar a política (diferente de período padrão).

### 3.2 Leitores (painel / API)

| Origem | Método |
|---|---|
| `CentralConfiguracaoService.obterPainelCompleto` / resumo | `mapa[manifestacao_destinatario_politica]` → `sefaz.politicaManifestacao` |
| `CentralConfiguracaoService.obterPoliticaManifestacao()` | Único getter tipado usado pelos motores |
| UI Central | GET painel — somente exibição |
| UI Centro | GET painel → hidrata radios |

### 3.3 Consumidores do ciclo DF-e / manifestação

| Caminho que inicia ciclo | Como obtém política | Como obtém `empresa_id` |
|---|---|---|
| `CentralManifestacaoScheduler.executarCiclo` | `processarCandidatos` → `obterPoliticaManifestacao()` **global** (uma vez por ciclo) | Candidatos carregam `empresaId` do documento; Gate/contexto por empresa no envio |
| Pós-sync Orchestrator | `sincronizar` → `processarCandidatos` (mesma política global), salvo `pularManifestacaoAutomatica` / OPERACAO_REAL | Sync DistDFe é por alvo/`empresaId`; ciclo de ciência varre candidatos multiempresa com **uma** política |
| `processarDocumento` (manual/API) | `obterPoliticaManifestacao()` global (ou `opcoes.politica` se não automático) | `obterContextoOperacionalDoDocumento` / `resolverEmpresaIdDocumento` |
| `MotorRecuperacaoXmlService` | `_obterPoliticaManifestacaoSegura` → dep ou `obterPoliticaManifestacao()` global | Item da fila tem empresa; política **não** é por empresa |

**Achado crítico:** o motor já isola **certificado/CNPJ/Gate/cooldown** por empresa no envio, mas a **decisão** AUTOMATICA vs MANUAL vs CONFIRMAR é lida **uma vez, globalmente**, no início de `processarCandidatos`. Em banco com 3+ CNPJs, a política de um cliente afeta todos.

---

## 4. Compatibilidade atual (1 empresa vs 3+ CNPJs)

| Cenário | Comportamento atual |
|---|---|
| Instalação monoempresa | Global ≡ política da única empresa — aceitável operacionalmente |
| MULTIEMPRESA 3+ CNPJs | Uma chave serve a todos; UI do Centro não mostra “empresa da política” |
| Empresa não identificada no GET painel | Identidade fiscal pode falhar amigável; política global ainda é retornada |
| Empresa não identificada no motor | Documento sem `empresa_id` já é bloqueado em trechos de seleção; política global ainda decide o modo automático do ciclo |

---

## 5. Proposta de modelo por empresa (não implementada)

Referência: `periodo_padrao_empresa_<id>` (`CentralPeriodoPadraoService`) — **não copiar sem adaptação**.

### 5.1 Por que adaptar

| Período padrão | Política de manifestação |
|---|---|
| Só UX de filtro de datas | Afeta envio SEFAZ 210210 |
| Serviço dedicado + rotas `/periodo-padrao` | Hoje embutida em `/configuracao` enterprise |
| Default se ausente: `MES_VIGENTE` (não lê “global legado”) | Precisa de **compat** com chave global existente |
| Sem consumidor em scheduler de ciência | Consumida por scheduler + pós-sync + recuperação XML |

### 5.2 Modelo proposto

```
manifestacao_destinatario_politica_empresa_<id>   // canônico por empresa
manifestacao_destinatario_politica                // legado global (somente leitura na transição)
```

API sugerida (contrato futuro — **não** nesta microsprint):

- `obterPoliticaManifestacao(empresaId)` — exige `empresaId` inteiro > 0; erro `EMPRESA_CENTRAL_AUSENTE` se ausente (**sem** fallback para outra empresa).
- Resolução: (1) chave por empresa se válida; (2) se inexistente **e** chave global legada válida → usar legado + marcar `origem: 'LEGADO_GLOBAL'`; (3) senão default `MANUAL` + `origem: 'PADRAO'`.
- Escrita: **somente** chave por empresa; PUT exige empresa do contexto; **proibido** gravar na chave global após cutover (ou gravar global só se flag de compat monoempresa).
- Ciclo `processarCandidatos`: resolver política **por candidato/empresa** (ou agrupar por `empresaId` e processar sublotes) — não uma política única no início do ciclo.
- Scheduler: inalterado em intervalo; muda só a resolução da política por empresa no serviço.

### 5.3 Sem empresa identificada

| Operação | Comportamento proposto |
|---|---|
| GET painel sem empresa | Não inventar política de “outra” empresa; exibir aviso + opcionalmente legado global só como “legado instalação” com label explícito |
| PUT sem empresa | **400** — não gravar |
| Motor sem `empresa_id` no documento | Não enviar ciência; não usar política de outra empresa |

**Proibido:** fallback silencioso empresa A → política da empresa B ou “primeira ativa”.

---

## 6. Plano de migração / reversão / testes (futuro)

### 6.1 Migração (não executar agora)

1. Para cada `empresa.id` ativa com fiscal:  
   `INSERT OR IGNORE ... politica_empresa_<id> = valor da chave global` (se global válida), senão `MANUAL`.
2. Não apagar a chave global na mesma janela (janela de compat).
3. Deploy código que lê por empresa com fallback legado documentado.
4. Após validação em campo: parar escritas na global; opcionalmente remover global em microsprint seguinte.

### 6.2 Reversão

1. Reverter código para `obterPoliticaManifestacao()` global.
2. Chaves `*_empresa_*` podem permanecer órfãs (inofensivas) ou ser ignoradas.
3. Valor global permanece a fonte (não foi apagado na fase 1 da migração).

### 6.3 Testes futuros (ambiente isolado)

- Monoempresa: legado global → mesma política na chave empresa após migrate.
- 3 empresas: A=`MANUAL`, B=`AUTOMATICA_CIENCIA`, C=`CONFIRMAR_OPERADOR` — ciclo só envia ciência para B.
- PUT sem empresa → 400.
- GET/PUT empresa 2 não altera chave da empresa 3.
- Scheduler mock: zero SOAP; assert da política escolhida por `empresaId`.

---

## 7. Riscos residuais

| Risco | Severidade | Mitigação futura |
|---|---|---|
| Política global atual compartilha AUTOMATICA entre CNPJs | Alta em MULTIEMPRESA | Migração por empresa (Fase 2 implementação) |
| Deep-link inútil se UI fiscal off | Média (UX) | Já avisado; habilitar fiscal só por config de implantação |
| `btnCentralAbrirConfigFiscal` ainda usa FORCE_TAB `fiscal` | Baixa | Mapa legado `fiscal→diagnostico` cobre; opcional alinhar depois |
| Contrato API PUT sem `empresaId` | Alta se migrar sem versionar | Exigir empresa + testes de regressão |
| Ciclo único com política global embutida | Alta | Refatorar `processarCandidatos` para política por empresa |

---

## 8. Escopo cumprido vs fora

| Item | Status |
|---|---|
| Fase 1 UX | **Feito** |
| Fase 2 mapa + proposta | **Feito** |
| Alterar persistência / migrar DB | **Fora** (propositadamente) |
| Alterar `AUTOMATICA_CIENCIA` no oficial | **Não** |
| SEFAZ / scheduler / commit | **Não** |

---

*Fim CE-MANIFESTACAO-01.*

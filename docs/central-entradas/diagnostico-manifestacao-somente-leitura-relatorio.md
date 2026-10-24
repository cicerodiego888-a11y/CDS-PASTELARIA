# Diagnóstico — Manifestação do Destinatário “Somente leitura”

**Tipo:** auditoria somente leitura (UI + API + persistência)  
**Data:** 2026-10-18  
**Escopo:** Central Inteligente de Entradas → aba SEFAZ / Manifestação  
**Veredito:** o selo **Somente leitura** na Central é **intencional (RC4.3)**; a edição existe no Centro de Configurações. Há lacuna de **escopo multiempresa** na chave de política (global, não por empresa).

> Nesta etapa: sem SEFAZ, sem 210210, sem mutação de flags/config, sem scheduler, sem migração, sem commit.

---

## 1. Arquivos e componentes responsáveis

| Camada | Arquivo | Papel |
|---|---|---|
| UI Central (RO) | `frontend/erp/js/central-entradas.js` | `renderAbaSefazCfg` — card “Manifestação do Destinatário” + badge hardcoded `Somente leitura`; deep-link `#btnCentralAbrirConfigManifestacao` → `abrirConfigFiscalManifestacaoCentral()` |
| UI edição | `frontend/erp/js/cds-centro-configuracoes.js` | Card `#cdsCfgCardManifestacao` (pane `diagnostico`) com radios `cdsPoliticaManifestacao` + `#btnSalvarPoliticaManifestacao` → `salvarPoliticaManifestacaoCentro()` |
| Contrato UX | `tests/central-entradas/rc43-consolidacao-manifestacao-ux.test.js` | Garante que a Central **não** edita política e que o Centro tem radios/salvar/API |
| API | `backend/rotas/central-entradas.js` | `GET/PUT /api/central-entradas/configuracao` |
| Controller | `backend/motores/central-entradas/controllers/CentralConfiguracaoController.js` | `obter` (com contexto de empresa no painel); `atualizar` (body → service) |
| Service | `backend/motores/central-entradas/services/CentralConfiguracaoService.js` | Chave `manifestacao_destinatario_politica`; valores `MANUAL` \| `AUTOMATICA_CIENCIA` \| `CONFIRMAR_OPERADOR` |
| Persistência | `CentralConfiguracaoRepository` / `CentralConfigRepository` | Tabela KV `central_entradas_config` (sem `empresa_id`) |
| Schema | `backend/database.js` (~2414) | `chave TEXT NOT NULL UNIQUE` — uma linha por chave global |

---

## 2. Origem e valor atual da política

### Persistência

| Campo | Valor observado |
|---|---|
| Tabela | `central_entradas_config` |
| Chave | `manifestacao_destinatario_politica` |
| Valor | **`AUTOMATICA_CIENCIA`** |
| `updated_at` | `2026-10-18 12:57:45` |
| Default de seed | `MANUAL` (DEFAULTS em `CentralConfiguracaoRepository`) |
| Escopo | **Global do banco** (não há sufixo `empresa_<id>` nem coluna de empresa) |

Leitura: SQLite `OPEN_READONLY` em `C:\ProgramData\MercantilFiscal\dados\mercadao.db`. Sem tokens/segredos.

### Como a Central exibe

- Lê o painel de configuração (`politicaManifestacao` / `plataformaFiscal.modoCodigo`).
- Badge de política reflete o valor persistido (hoje: Automática / Ciência).
- Badge **“Somente leitura”** é string fixa no HTML do card — **não** vem de flag de API nem de permissão.

### Endpoints

| Método | Rota | Uso |
|---|---|---|
| GET | `/api/central-entradas/configuracao` | Painel completo (inclui `sefaz.politicaManifestacao`); GET resolve contexto de empresa para identidade fiscal do painel |
| PUT | `/api/central-entradas/configuracao` | Escrita: body `{ sefaz: { politicaManifestacao } }` — usado pelo Centro |
| POST | `/api/central-entradas/configuracao/restaurar` | Restaura defaults (inclui política se aplicável ao fluxo de restore) |

A API **oferece escrita**. A Central **não chama PUT** para esta política; só o Centro.

---

## 3. Motivo comprovado do modo somente leitura

1. **Decisão de produto RC4.3 (consolidação UX):** a Central deixou de ter select editável (`cfgPoliticaManifestacao` removido). O teste `rc43-consolidacao-manifestacao-ux.test.js` falha se a edição voltar à Central.
2. **UI da Central:** badge `Somente leitura` + nota “sem edição na Central” + botão “Abrir Configuração Fiscal” que navega para `configuracoes-avancadas` com âncora `manifestacao`.
3. **UI de edição:** radios + “Salvar política” no Centro (`cds-centro-configuracoes.js`), pane **Diagnóstico** (categoria `fiscal: true` — visível só com UI fiscal habilitada).
4. **Não é** bloqueio da API, ausência de endpoint, nem valor especial no banco que force RO.

**Conclusão do RO na Central:** intencional e documentado no código/teste. Não é bug de “esquecimento” dos controles na aba SEFAZ da Central.

---

## 4. Edição: prevista, bloqueada ou faltando?

| Pergunta | Resposta |
|---|---|
| Edição prevista no produto? | **Sim** — no Centro de Configurações |
| Bloqueada intencionalmente na Central? | **Sim** — RC4.3 |
| Falta edição em todo o sistema? | **Não** — PUT + UI no Centro existem |
| Usuário pode achar que “não dá para editar”? | **Sim** — se não seguir o deep-link / não achar Diagnóstico |

### Inconsistências de UX (não alteram o veredito RO)

1. Texto na Central: “Origem: Centro de Configurações → **Fiscal**”, mas o card editável está no pane **Diagnóstico** (não há categoria “Fiscal”).
2. Deep-link define `__CDS_CFG_FORCE_TAB = 'fiscal'`, que **não** é id de categoria; o foco real depende de `focarCardManifestacao()` → `ativarCategoria('diagnostico')`. Funciona por âncora, mas o tab force é legado/confuso.
3. Pane Diagnóstico só aparece com `configPermiteFiscalUi()` (ERP_FISCAL / ERP_MULTICAIXA / `fiscalHabilitado()`). Em implantação sem fiscal UI, a edição some do Centro enquanto a Central ainda mostra o card RO.

### Multiempresa / isolamento

| Aspecto | Situação |
|---|---|
| Política por empresa | **Não** — chave única global |
| Contraste | `periodo_padrao_empresa_<id>` já é por empresa na mesma tabela |
| Fallback sem empresa | GET do painel pode sinalizar empresa ausente; a **política** ainda é a linha global — não há “política da empresa X” |
| Risco | Em MULTIEMPRESA, alterar a política no Centro afeta **todas** as empresas do mesmo banco |

Isso **não** explica o selo RO da Central, mas viola a expectativa de isolamento quando a empresa não está (ou está) identificada: a config não é escopada.

---

## 5. Correção mínima recomendada (não implementada)

Ordem sugerida; **fora do escopo deste diagnóstico**.

### A) UX (baixo risco, alinha expectativa do operador)

1. Corrigir rótulo de origem na Central: “Centro de Configurações → **Diagnóstico**”.
2. Deep-link: `__CDS_CFG_FORCE_TAB = 'diagnostico'` (em vez de `'fiscal'`), mantendo `__CDS_CFG_FORCE_ANCHOR = 'manifestacao'`.
3. Opcional: no card RO, linha explícita “Para alterar: Configurações → Diagnóstico → Manifestação do Destinatário”.

### B) Multiempresa (correção de modelo — se a política deve ser por empresa)

1. Persistir `manifestacao_destinatario_politica_empresa_<id>` (padrão já usado em período padrão) **ou** coluna/escopo equivalente.
2. `GET/PUT configuracao`: ler/gravar só com `empresa_id` explícito; **recusar** escrita sem empresa (sem fallback para a chave global).
3. Migrar valor atual global uma vez por empresa ativa (procedimento controlado; não nesta microsprint).
4. Scheduler / motor de manifestação: resolver política pela empresa do ciclo DF-e.

### C) Não fazer nesta linha

- Reintroduzir edição completa na Central (contradiz RC4.3), salvo decisão de produto explícita.
- Alterar valor atual `AUTOMATICA_CIENCIA` ou disparar 210210 como parte do “fix”.

---

## 6. Resumo executivo

| Item | Resultado |
|---|---|
| Por que aparece “Somente leitura”? | Badge fixo RC4.3 — edição consolidada no Centro |
| API permite escrita? | Sim (`PUT .../configuracao`) |
| Valor atual (DB RO) | `AUTOMATICA_CIENCIA` |
| Edição faltando? | Não no sistema; ausente só na Central (de propósito) |
| Multiempresa | Política **global** — risco real de isolamento |
| Próximo passo | Aprovar A e/ou B; só então implementar |

---

*Fim do diagnóstico. Nenhuma correção aplicada.*

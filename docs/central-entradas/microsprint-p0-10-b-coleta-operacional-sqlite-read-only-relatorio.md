# Microsprint P0.10-B — Coleta operacional SQLite somente leitura

**Prioridade:** P0  
**Data da coleta:** 18/10/2026  
**Horário (UTC):** `2026-10-18T23:08:10.544Z`  
**Horário local:** `18/10/2026, 20:08:10` (**America/Fortaleza**)  
**Dependência:** P0.10-A  
**Veredito:** **APROVADO**

---

## 1. Resumo executivo

A coleta somente leitura em `mercadao.db` mostrou:

| Achado | Evidência |
|---|---|
| Sync automática **ligada** | `sync_automatica_habilitada = true` (**não** é o seed `false`) |
| Background **ciclando** | Eventos `SYNC_INICIADA`/`SYNC_CONCLUIDA` origem `background` (~15 min) |
| Três empresas ativas | `empresaId` 1, 2, 3 (`ativo=1`); 4 e 5 inativas |
| OPERACAO_REAL **ativa** nas três | Config JSON sanitizado (`ativa: true`, sem token) |
| Produção: **cooldown ativo** nas três | `ultimo_cstat=656`, `cooldown_ate` futuro na coleta |
| NSU preservado pós-656 | E1 `196/196` · E2 `45/45` · E3 `35/35` (histórico E3 `max=0` **não** é o estado atual) |
| Motivo atual de não trazer NF-e | **COOLDOWN** após consumo indevido; ciclos BACKGROUND posteriores **não enviam** DistDFe |

**Nenhuma consulta SOAP/SEFAZ foi realizada nesta sprint.**  
**Nenhuma alteração intencional no banco oficial.**  
**Nenhuma flag, NSU ou cooldown foi alterado.**  
**Nenhuma sincronização foi executada.**

---

## 2. Identificação do banco e procedimento

| Item | Valor |
|---|---|
| Diretório | `C:\ProgramData\MercantilFiscal\dados` |
| Arquivo | `mercadao.db` (16 158 720 bytes) |
| mtime arquivo | `2026-10-18T22:55:02.847Z` |
| Irmãos `mercadao.db*` | somente `mercadao.db` (**sem** `-wal`/`-shm` listados no momento) |
| Método | `node` + `sqlite3` nativo do projeto com `OPEN_READONLY` (flag `1`) |
| URI `mode=ro` | tentada; Windows retornou `CANTOPEN` → fallback path + `OPEN_READONLY` |
| `PRAGMA journal_mode` | `wal` |
| `PRAGMA query_only` | forçado `ON` após abrir |
| Prova de escrita | `UPDATE … WHERE 1=0` → `SQLITE_READONLY: attempt to write a readonly database` |
| App / `database.js` | **não** carregados |
| Script coletor | `%TEMP%\cds-p010b-ro-collect.js` (fora do repo; resultado em `%TEMP%\cds-p010b-ro-result.json`) |

**Ressalva WAL:** modo journal `wal` sem arquivo `-wal` visível sugere checkpoint prévio. Se o processo CDS estivesse com WAL sujo não listado, a leitura RO poderia atrasar o estado — na listagem do diretório só havia `mercadao.db`. Classificação: **COMPROVADO POR REGISTRO OPERACIONAL** com ressalva de concorrência.

---

## 3. Proteções respeitadas

- [x] Sem Electron / `server.js` / `database.js`  
- [x] Sem `CDS_ALLOW_OFFICIAL_DB=1`  
- [x] Sem SOAP / `consultar-dfe` / sync disparada por esta sprint  
- [x] Sem INSERT/UPDATE/DELETE/DDL intencionais (probe UPDATE falhou em RO)  
- [x] Sem cópia do banco  
- [x] Sem commit/push/merge  
- [x] CNPJs mascarados; tokens OPERACAO_REAL não expostos (`temTokenSeed` booleano apenas)

---

## 4. Flags operacionais atuais

| Chave | Valor atual | Origem | Efeito no fluxo | Classificação |
|---|---|---|---|---|
| `sync_automatica_habilitada` | **`true`** | `central_entradas_config.valor` | Timer DistDFe periódico ativo | Registro operacional |
| `sync_ao_abrir` | `true` | idem | Sync ao abrir Central | Registro |
| `sync_intervalo_minutos` | `15` | idem | Intervalo ~15 min | Registro |
| `sync_max_documentos` | `50` | idem | Cap iterações | Registro |
| `sync_horario_permitido_inicio` | `06:00` | idem | Janela BACKGROUND | Registro |
| `sync_horario_permitido_fim` | `23:59` | idem | Janela BACKGROUND | Registro |
| `sync_horario_bloqueado_*` | vazio | idem | Bloqueio horário off | Registro |
| `sync_notificar_novas_notas` | `true` | idem | Notificações | Registro |
| `recuperacao_xml_ativa` | **`true`** | idem | Motor XML pode gerar carga SEFAZ adicional | Registro |
| `operacao_fiscal_real_empresa_1` | ativa=`true` (seed token **não** exibido) | JSON config | Autoriza fluxo OPERACAO_REAL emp. 1 | Registro sanitizado |
| `operacao_fiscal_real_empresa_2` | ativa=`true` | JSON | Idem emp. 2 | Registro sanitizado |
| `operacao_fiscal_real_empresa_3` | ativa=`true` | JSON | Idem emp. 3 | Registro sanitizado |

**Seed vs atual:** o seed de código é `sync_automatica_habilitada=false`; o valor **operacional atual é `true`**.

---

## 5. Empresas (mascaradas)

| empresaId | Identificação | CNPJ | Ativo | Ambiente na tabela `empresas` |
|---|---|---|---|---|
| 1 | PAS… | `**.***.***/****-15` | sim | coluna ausente/null |
| 2 | PAS… | `**.***.***/****-87` | sim | null |
| 3 | PAS… | `**.***.***/****-04` | sim | null |
| 4 | Emp… | `**.***.***/****-91` | **não** | — |
| 5 | Emp… | `**.***.***/****-82` | **não** | — |

As **três empresas** do diagnóstico = ids **1, 2 e 3**. Ambiente fiscal de operação DistDFe inferido pelos cursores **`ambiente = 1` (produção)**.

Nenhum CNPJ compartilhado entre as três ativas → **sem cursor compartilhado** entre elas (COMPROVADO POR REGISTRO).

---

## 6. NSU e cooldown (produção, ambiente 1)

Coleta: **20:08:10 America/Fortaleza** (`2026-10-18T23:08:10Z`).

| Campo | Empresa 1 | Empresa 2 | Empresa 3 |
|---|---|---|---|
| Identificação | PAS… / `****-15` | PAS… / `****-87` | PAS… / `****-04` |
| Ambiente cursor | 1 | 1 | 1 |
| `ult_nsu` | `000000000000196` | `000000000000045` | `000000000000035` |
| `max_nsu` | `000000000000196` | `000000000000045` | `000000000000035` |
| Última sync registrada | `2026-10-18T22:17:04.375Z` | `2026-10-18T22:31:27.283Z` | `2026-10-18T22:31:28.357Z` |
| Último cStat | **656** | **656** | **656** |
| Cooldown até | `2026-10-18T23:17:04.375Z` (~**20:17** Fortaleza) | `2026-10-18T23:31:27.283Z` (~**20:31**) | `2026-10-18T23:31:28.357Z` (~**20:31**) |
| Cooldown ativo na coleta? | **Sim** | **Sim** | **Sim** |

Cursores homologação (`ambiente=2`) existem zerados/antigos — não são o foco operacional de produção.

**Anomalia histórica resolvida no estado atual:** Empresa 3 não está mais com `max_nsu=0`; está `35/35`.

**Auditoria DFe:** registros `NSU_PRESERVADO` com motivo `cStat 656 — Cursor atualizado=FALSE` para os três CNPJs — alinhado à correção de não avanço.

---

## 7. Eventos e auditoria (amostra)

### `central_entradas_eventos` (últimos relevantes na janela coletada)

| Padrão | Observação |
|---|---|
| Origem `background` | Ciclos ~15 min: `SYNC_INICIADA` → `SYNC_CONCLUIDA` com texto **“Consulta DF-e não enviada… cooldown… 656”** (ex.: 22:37, 22:52) |
| Origem `CONSULTA_DFE_REAL` | Syncs controladas ~18:39–18:41 com **cStat 137** (sem notas novas); depois emp. 1 **656** às 22:17 |
| `SYNC_ERRO` | Emp. 1 (22:17) e emp. 2 (22:31) — rejeição consumo indevido 656 |
| Tipos na amostra | `SYNC_*`, `CONSULTA_DFE_POS_MANIFESTACAO`, `RECUPERACAO_XML_CONSULTA` |

### `dfe_auditoria` (100 mais recentes)

- Vários `SYNC_RESUMO` / `CONSUMO_INDEVIDO` + `NSU_PRESERVADO` (656).  
- Também `NSU_AVANCO` com `Cursor atualizado=TRUE` em momentos anteriores (avanço legítimo pré-656).  
- `empresa_id` frequentemente **null** na auditoria (lacuna de observabilidade).

`SefazConsultaTrace` (RAM): **não** recuperável pelo banco.

---

## 8. Diagnóstico individual

| Empresa | Classificação | Base |
|---|---|---|
| **1** | **COOLDOWN BLOQUEIA** | Registro: `cooldown_ate` futuro + eventos BACKGROUND “não enviada”; último cStat 656; NSU 196/196 preservado |
| **2** | **COOLDOWN BLOQUEIA** | Idem; NSU 45/45; sync erro 656 22:31 |
| **3** | **COOLDOWN BLOQUEIA** | Idem; NSU 35/35; cooldown até ~20:31 |

| Hipótese | Status |
|---|---|
| CONFIGURAÇÃO BLOQUEIA (`sync_automatica=false`) | **Refutada** pelo registro (`true`) |
| AUTORIZAÇÃO BLOQUEIA (BACKGROUND sem auth) | **Não é o bloqueio atual** — há DistDFe recente com 656 e ciclos posteriores só cooldown. Código P0.8 ainda é barreira estrutural; estado operacional mostra SOAP já ocorreu via fluxos ativos (incl. `CONSULTA_DFE_REAL` / sync). |
| CONTEXTO INVÁLIDO | **Não indicado** — três empresas ativas com cursores produção |
| SEM BLOQUEIO IDENTIFICADO | **Não** — cooldown vigente |

### Separação fato / código / inferência

1. **Fatos (banco):** flags, NSUs, cooldowns, eventos acima.  
2. **Código:** BACKGROUND respeita cooldown NSU; 656 não avança cursor; DistDFe exige auth no código atual.  
3. **Inferência:** após expirar cooldown, BACKGROUND ou `consultar-dfe` poderá tentar DistDFe de novo; risco de novo 656 se houver rajada.  
4. **Exige execução para confirmar:** se há documentos novos na SEFAZ além do cursor atual (só SOAP autorizado futuro).

---

## 9. Divergências e anomalias

| Item | Detalhe |
|---|---|
| Seed vs operacional | Sync automática **true** no cliente (seed código = false) |
| Histórico E3 `max_nsu=0` | **Obsoleto** — atual `35` |
| `recuperacao_xml_ativa=true` | Pode competir por cota SEFAZ — observação, não alterado |
| Auditoria sem `empresa_id` | Dificulta filtro por empresa |
| WAL sem `-wal` em disco | Ver ressalva §2 |

---

## 10. Recomendação (sem implementação)

### Curto prazo (agora → pós-cooldown)

1. **Não** forçar novas consultas enquanto `cooldown_ate` for futuro.  
2. Após liberação (~20:17 emp.1; ~20:31 emp.2/3, Fortaleza), preferir **`consultar-dfe` OPERACAO_REAL** **uma empresa por vez**, com intervalo, para reduzir novo 656.  
3. Manter expectativa: cStat **137** = sem documento novo naquele retorno (já ocorreu hoje ~18:39–18:41).

### Decisão de produto (aguardando aprovação)

| Opção | Recomendação desta coleta |
|---|---|
| **A — Fluxo controlado** | **Recomendada como padrão operacional imediato:** BACKGROUND pode continuar reagendando, mas a operação humana/controlada deve ser `consultar-dfe`; evita rajadas. |
| **B — BACKGROUND autorizado** | Sprint futura: auth explícita por empresa + rate limit + telemetria `empresa_id` + coordenação com `recuperacao_xml`. |

**Não ativar mudanças nesta sprint.**

---

## 11. Limitações

- Ambiente fiscal não está na linha `empresas` (null) — vínculo via CNPJ + cursor `ambiente=1`.  
- Trace RAM não lido.  
- Amostra de eventos limitada (últimos ~100 filtrados).  
- Detalhes de auditoria podem conter CNPJ completo no DB — **não** reproduzidos neste relatório.

---

## 12. Critérios de aceitação

- [x] Banco correto (`mercadao.db`)  
- [x] Método RO comprovado (`OPEN_READONLY` + probe UPDATE falhou)  
- [x] App/`database.js` não inicializados  
- [x] Flags atuais consultadas  
- [x] NSUs/cooldowns ligados às 3 empresas  
- [x] Eventos/auditoria no escopo  
- [x] Dados sensíveis mascarados  
- [x] Sem operação fiscal nesta sprint  
- [x] Sem escrita intencional  
- [x] Relatório criado  
- [x] Recomendação A/B sem implementação  

---

## 13. Veredito final

### **APROVADO**

Coleta concluída com segurança e evidências suficientes para explicar o estado atual: **sincronização automática ligada e ciclando, porém as três empresas em cooldown pós-656 com NSU preservado; portanto novas NF-e não entram até a liberação (e só se existirem na SEFAZ além do cursor).**

Aguardar autorização para qualquer alteração operacional ou sprint da opção B.

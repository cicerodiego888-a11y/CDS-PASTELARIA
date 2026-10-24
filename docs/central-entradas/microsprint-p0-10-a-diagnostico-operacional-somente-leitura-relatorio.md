# Microsprint P0.10-A — Diagnóstico operacional somente leitura

**Prioridade:** P0  
**Data:** 18/10/2026  
**Tipo:** diagnóstico operacional, leitura estrita  
**Dependência:** P0.9 — Auditoria sincronização automática  
**Veredito:** **APROVADO COM RESSALVAS**

---

## 1. Resumo executivo

Esta sprint **não** abriu o banco oficial, **não** iniciou a aplicação/`database.js`, **não** executou SOAP/SEFAZ, **não** invocou `consultar-dfe` nem sincronização, **não** alterou flags/NSU/cooldown e **não** usou `CDS_ALLOW_OFFICIAL_DB=1`.

| Objetivo | Resultado |
|---|---|
| Flags operacionais atuais das 3 empresas | **NÃO VERIFICADO** — sem procedimento de leitura aprovado |
| NSU/cooldown atuais | **NÃO VERIFICADO** |
| Últimos eventos por empresa | **NÃO VERIFICADO** (persistidos) / BACKGROUND em RAM = **volátil** |
| Mapa estático (onde ler / o que bloqueia) | **COMPROVADO POR CÓDIGO** |
| Por que sync pode não trazer NF-e | **COMPROVADO POR CÓDIGO** (flag seed + barreira P0.8); estado cliente **NÃO VERIFICADO** |

Os valores históricos (196/196, 45/45, 35/0) **não** foram usados como estado atual.

---

## 2. Procedimento utilizado

### Etapa A — Inspeção estática (executada)

Revisão de código e esquema em:

- `CentralSyncBackgroundService.js`
- `CentralSyncExecucaoService.js`
- `CentralSincronizacaoService.js`
- `CentralEntradasEmpresaContextoService.js`
- `CentralNsuService.js` / `CentralNsuRepository.js`
- `CentralConfigService.js` / `CentralConfigRepository.js`
- `centralEntradasFlags.js`
- `autorizacaoTransmissaoSefaz.js`
- `distribuicaoDFe.js`
- `backend/server.js` / `backend/database.js`
- `centralEventosTipos.js`, `SefazConsultaTrace.js`, `CentralEventosRepository.js`

### Etapa B — Leitura operacional (não executada)

| Critério | Avaliação |
|---|---|
| Script de leitura somente-leitura no repositório | **Não existe** (`scripts/` sem procedimento aprovado) |
| Abrir via app / Electron / `database.js` | **Proibido** — `ensureSchema`, seeds `INSERT OR IGNORE`, migrações RC3.7.1 |
| Abrir ProgramData sem autorização explícita de procedimento | **Proibido** pela regra absoluta desta sprint |
| Improvisar `sqlite3` CLI / cópia do DB | **Não feito** — exigiria aprovação de procedimento controlado |

**Decisão:** interromper coleta operacional e entregar evidências estáticas + proposta de procedimento (seção 12), conforme o enunciado.

### Confirmações de segurança

| Declaração | Status |
|---|---|
| Nenhuma consulta SOAP / SEFAZ | **Confirmado** |
| Nenhum dado alterado | **Confirmado** |
| Banco oficial não aberto por este agente | **Confirmado** |
| Sem commit/push/merge | **Confirmado** |

---

## 3. Fontes e arquivos inspecionados

| Fonte | Papel |
|---|---|
| `central_entradas_config` | Flags sync (chave/valor) |
| `central_entradas_nsu` | Cursor NSU + cooldown (`UNIQUE(cnpj, ambiente)`) |
| `central_entradas_eventos` | Eventos SYNC_*/NSU_*/bloqueios (quando emitidos para DB) |
| `dfe_auditoria` | Auditoria DistDFe (correlation, cStat, NSU) |
| `empresas` (via `EmpresaService`) | Lista alvos MULTIEMPRESA (`id`, `cnpj`, `ativo`) |
| `SefazConsultaTrace` (RAM) | `BLOQUEADA_*` / consulta executada — **perdido no restart** |
| Logs `[Central Entradas][BACKGROUND]` | Console do processo — não persistidos nesta sprint |

### Esquema relevante (COMPROVADO POR CÓDIGO — `database.js`)

**`central_entradas_config`:** `chave`, `valor`, `tipo`, `descricao`, `updated_at`

**`central_entradas_nsu`:** `cnpj`, `ambiente`, `ult_nsu`, `max_nsu`, `data_sincronizacao`, `cooldown_ate`, `ultimo_cstat`, `updated_at`  
(ALTER adiciona `max_nsu`, `data_sincronizacao`, `cooldown_ate`, `ultimo_cstat`)

**`central_entradas_eventos`:** `tipo`, `origem`, `descricao`, `resultado`, `sucesso`, `documento_id`, `notas_novas`, `notas_duplicadas`, `duracao_ms`, `detalhe_json`, `created_at`

**`dfe_auditoria`:** `empresa_id`, `cnpj`, `ambiente`, `nsu`, `resultado`, `motivo`, `detalhe_json`, `created_at`, …

### Como relacionar cursor → empresa (COMPROVADO POR CÓDIGO)

1. Listar empresas ativas → `empresaId` + CNPJ.  
2. Resolver ambiente fiscal da empresa (contexto operacional).  
3. Ler `central_entradas_nsu` por **`(cnpj, ambiente)`** — **não** há `empresa_id` na tabela NSU.  
4. Risco: dois `empresaId` com mesmo CNPJ+ambiente compartilham cursor.

### Dados sensíveis a ocultar em qualquer leitura futura

- Senhas de certificado, paths PFX com segredo, `tokenSeed` de OPERACAO_REAL, conteúdo completo de XML fiscal se a política de privacidade exigir mascaramento de CNPJ/chave.

---

## 4. Flags operacionais

### Seeds (NÃO são valores do cliente)

| Configuração | Seed (`INSERT OR IGNORE`) | Impacto se ainda for o valor |
|---|---|---|
| `sync_automatica_habilitada` | `false` | Timer DistDFe **não** agenda |
| `sync_ao_abrir` | `true` | Abertura pode tentar sync (cai na barreira auth) |
| `sync_intervalo_minutos` | `15` | Intervalo do ciclo |
| `sync_horario_permitido_inicio/fim` | `06:00` / `23:59` | Restringe origem BACKGROUND |
| `sync_horario_bloqueado_*` | vazio | Desligado |
| Módulo Central (`centralEntradasFlags.estaHabilitado`) | default memória `true` | Off ⇒ sem DistDFe periódico |

### Valores atuais no ambiente do cliente

| Configuração | Valor atual | Origem | Impacto | Evidência |
|---|---|---|---|---|
| Módulo Central habilitado | **NÃO VERIFICADO** | — | — | Leitura operacional não autorizada |
| `sync_automatica_habilitada` | **NÃO VERIFICADO** | `central_entradas_config.chave` | Liga/desliga timer | Idem |
| `sync_ao_abrir` | **NÃO VERIFICADO** | idem | Sync na abertura | Idem |
| `sync_intervalo_minutos` | **NÃO VERIFICADO** | idem | Intervalo | Idem |
| Horário BACKGROUND | **NÃO VERIFICADO** | idem | Bloqueio por janela | Idem |
| OPERACAO_REAL ativa (por empresa) | **NÃO VERIFICADO** | `operacao_fiscal_real_empresa_<id>` em config | Autoriza DistDFe controlado | Idem |

**COMPROVADO POR CÓDIGO:** seed ≠ valor atual se alguém já alterou no painel (`INSERT OR IGNORE` não sobrescreve).

---

## 5. NSU e cooldown por empresa

| Campo | Empresa 1 | Empresa 2 | Empresa 3 |
|---|---|---|---|
| `empresaId` | **NÃO VERIFICADO** | **NÃO VERIFICADO** | **NÃO VERIFICADO** |
| Identificação (CNPJ mascarado) | **NÃO VERIFICADO** | **NÃO VERIFICADO** | **NÃO VERIFICADO** |
| Ambiente fiscal | **NÃO VERIFICADO** | **NÃO VERIFICADO** | **NÃO VERIFICADO** |
| `ult_nsu` atual | **NÃO VERIFICADO** | **NÃO VERIFICADO** | **NÃO VERIFICADO** |
| `max_nsu` atual | **NÃO VERIFICADO** | **NÃO VERIFICADO** | **NÃO VERIFICADO** |
| Cooldown ativo | **NÃO VERIFICADO** | **NÃO VERIFICADO** | **NÃO VERIFICADO** |
| Expiração cooldown | **NÃO VERIFICADO** | **NÃO VERIFICADO** | **NÃO VERIFICADO** |
| Última consulta registrada | **NÃO VERIFICADO** | **NÃO VERIFICADO** | **NÃO VERIFICADO** |
| Último cStat | **NÃO VERIFICADO** | **NÃO VERIFICADO** | **NÃO VERIFICADO** |
| Último avanço NSU | **NÃO VERIFICADO** | **NÃO VERIFICADO** | **NÃO VERIFICADO** |

Referência histórica **não revalidada:** E1 196/196 · E2 45/45 · E3 35/0.

**COMPROVADO POR CÓDIGO:** colunas e chave `(cnpj, ambiente)`; risco de cursor compartilhado se CNPJ duplicado.

---

## 6. Últimos eventos

| Tipo de evidência | Status |
|---|---|
| `SYNC_INICIADA` / `SYNC_CONCLUIDA` / `SYNC_ERRO` em `central_entradas_eventos` | **NÃO VERIFICADO** (fonte DB não lida) |
| `BLOQUEADA_AUTORIZACAO` / `TRANSMISSAO_SEFAZ_NAO_AUTORIZADA` | Tipicamente em **trace RAM** + retorno de serviço; persistência em eventos/auditoria **NÃO VERIFICADA** |
| `BLOQUEADA_COOLDOWN` / `BLOQUEADA_GATE` | Idem |
| `NSU_PRESERVADO_656` / `AUTO_SYNC_NSU` | Podem estar em eventos/auditoria — **NÃO VERIFICADO** |
| `BACKGROUND START/SLEEP/WAKE/DISTDFE` | Console do processo — **fonte indisponível** nesta sprint |
| Trace pós-restart | **Histórico volátil perdido** (COMPROVADO POR CÓDIGO) |

Ausência de log **não** prova que a execução nunca ocorreu.

---

## 7. Diagnóstico individual das três empresas

Sem registros operacionais, a classificação por empresa é a mesma, baseada só no código (não equivale a estado do cliente):

| Empresa | Conclusão | Classificação |
|---|---|---|
| Empresa 1 | **EXECUÇÃO NÃO COMPROVADA** + bloqueios estruturais possíveis (flag off e/ou AUTORIZAÇÃO) | Código: bloqueios possíveis · Operacional: NÃO VERIFICADO |
| Empresa 2 | Idem | Idem |
| Empresa 3 | Idem (+ atenção histórica a `max_nsu=0` — **não** revalidado) | Idem |

| Hipótese | Status |
|---|---|
| CONFIGURAÇÃO BLOQUEIA (`sync_automatica=false`) | **INFERÊNCIA** se seed ainda vigente; valor atual **NÃO VERIFICADO** |
| AUTORIZAÇÃO BLOQUEIA (P0.8 / sem OPERACAO_REAL no background) | **COMPROVADO POR CÓDIGO** para qualquer ciclo DistDFe sem auth |
| COOLDOWN BLOQUEIA | **NÃO VERIFICADO** por empresa |
| CONTEXTO INVÁLIDO | **NÃO VERIFICADO** |
| SEM BLOQUEIO IDENTIFICADO | **Não aplicável** — faltam evidências operacionais |

---

## 8. Lacunas da P0.9 (revisão — sem correção)

| # | Lacuna | Presente? | Impacto | Prioridade proposta |
|---|---|---|---|---|
| G1 | `catch { /* ignore */ }` no gate (`CentralSyncExecucaoService.js` ~173, também ~269/277) | **Sim** (COMPROVADO POR CÓDIGO) | Gate quebrado pode não bloquear | Alta |
| G2 | Cooldown NSU (~1h) vs Gate progressivo | **Sim** | Diagnóstico divergente | Média |
| G3 | Falha init `central-sync` engolida no Grupo B | **Sim** | Sync morta sem alarme forte | Média |
| G4 | Cursor por CNPJ+ambiente sem `empresa_id` | **Sim** | Compartilhamento se CNPJ repetido | Média |
| G5 | `SefazConsultaTrace` só em RAM | **Sim** | Perde no restart | Média |
| G6 | Teste guardião com regex desatualizada | **Sim** (P0.9) | Ruído CI; guard ok | Baixa |

**Não implementado nesta sprint.** Correções exigem sprint autorizada.

---

## 9. Limitações de acesso e evidências indisponíveis

1. Sem procedimento de leitura controlada aprovado → **zero** linhas de flags/NSU/eventos do cliente.  
2. Abrir via aplicação é inseguro (`ensureSchema`, seeds, migração de status).  
3. Logs de console do Electron em execução não foram coletados (evitaria risco de efeitos colaterais / ambiguidade).  
4. Não foi listado nem aberto `C:\ProgramData\MercantilFiscal\dados`.

---

## 10. Plano recomendado para restabelecer sync de novas NF-e

**Somente após aprovação — não executar agora.**

### Passo 0 — Procedimento de leitura controlada (proposta)

Sujeito a aprovação explícita do responsável:

1. Uso de ferramenta CLI SQLite em **modo somente leitura** (`mode=ro` / equivalente), **sem** carregar `backend/database.js`.  
2. Queries SELECT limitadas em: `central_entradas_config`, `central_entradas_nsu`, `empresas`, `central_entradas_eventos` (últimos N), `dfe_auditoria` (últimos N).  
3. Mascarar CNPJ (ex.: `**.***.***/****-XX`) e omitir segredos.  
4. Registrar horário da coleta e hash/path do arquivo **sem** copiar o DB para rede.  
5. **Proibido:** `ensureSchema`, app, Electron, sync, SOAP, UPDATE/DELETE.

### Passo 1 — Interpretar resultados da leitura

- Se `sync_automatica_habilitada=false` → timer DistDFe off (esperado pelo seed).  
- Se ciclos BACKGROUND existem mas só `BLOQUEADA_AUTORIZACAO` → timer “vivo”, SOAP bloqueado (P0.8).  
- Cooldown/gate por CNPJ → aguardar janela; não zerar.  
- OPERACAO_REAL + `consultar-dfe` = caminho já autorizado na auditoria P0.8/P0.9 fiscal.

### Passo 2 — Decisão de produto (aguardar aprovação)

| Opção | Descrição |
|---|---|
| **A** | Manter background **sem** DistDFe; novas NF-e só via fluxo OPERACAO_REAL `consultar-dfe` (e/ou upload). |
| **B** | Implementar autorização explícita, auditável, **por empresa**, para o BACKGROUND (sprint de implementação futura). |

**Nenhuma das opções foi implementada nesta sprint.**

---

## 11. Decisões de produto que ainda exigem aprovação

1. Autorizar procedimento de leitura controlada (Passo 0).  
2. Escolher opção A ou B para sync automática.  
3. Autorizar (ou não) sprints de correção G1–G6.  
4. Autorizar (ou não) validação operacional futura com SOAP — **fora** desta sprint.

---

## 12. Critérios de aceitação

- [x] Nenhuma consulta real à SEFAZ  
- [x] Nenhuma transmissão/manifestação  
- [x] Nenhuma escrita no banco oficial  
- [x] Nenhuma alteração de flags/NSU/cooldown  
- [x] Método seguro **ou** limitação documentada (**limitação documentada**)  
- [x] Configuração seed separada de valores atuais  
- [x] NSU/cooldown por empresa sem inferência (**NÃO VERIFICADO**)  
- [x] Eventos com limitações explícitas  
- [x] Diagnóstico individual das três empresas  
- [x] Lacunas priorizadas sem implementação  
- [x] Relatório criado  

---

## 13. Veredito final

### **APROVADO COM RESSALVAS**

O diagnóstico **estático** está completo e as proteções foram respeitadas. As evidências **operacionais** (flags atuais, NSU, cooldown, eventos por empresa) permanecem **NÃO VERIFICADAS** por ausência de procedimento de leitura controlada aprovado — não por falha de segurança ou improvisação.

Para um veredito **APROVADO** pleno (evidências operacionais suficientes), é necessária a **aprovação expressa** do Passo 0 (leitura SQLite `mode=ro` sem app) e uma sprint de coleta P0.10-B.

---

## 14. Próximo passo

Apresentar este relatório e aguardar:

1. Autorização do procedimento de leitura controlada; e/ou  
2. Decisão de produto A (só OPERACAO_REAL) vs B (auth BACKGROUND por empresa).

**Não implementar nenhuma alternativa até aprovação expressa.**

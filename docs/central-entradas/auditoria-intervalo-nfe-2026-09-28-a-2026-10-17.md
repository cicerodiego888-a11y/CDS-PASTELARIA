# Auditoria do intervalo sem NF-e — 28/09 a 17/10/2026

**Prioridade:** P0 — Fiscal / Central de Entradas  
**Tipo:** auditoria técnica **somente leitura**  
**Leitura dos registros:** 18/10/2026 00:52:23 UTC (17/10/2026 21:52 BRT, UTC−3), a partir de dump gerado com `sqlite3.OPEN_READONLY` + `PRAGMA query_only=ON`  
**Estado dos cursores de produção (referência cruzada):** leitura operacional de 17/10/2026 21:19 BRT — `docs/central-entradas/verificacao-operacional-fila-distdfe-relatorio.md`  
**Resultado desta sprint:** diagnóstico com evidências. **Nenhuma correção foi implementada. Nenhuma NF-e foi recuperada.**

---

## Isolamento

| Controle | Evidência |
|---|---|
| Banco oficial | `C:\ProgramData\MercantilFiscal\dados\mercadao.db` aberto `OPEN_READONLY` + `query_only=ON` |
| `database.js` / migrations / recálculos | **não** carregados |
| `UPDATE` / `INSERT` / `DELETE` | **não** executados nesta sprint |
| SOAP DistDFe / `consChNFe` | **não** executados |
| Certificado PFX | **não** aberto |
| NSU | **não** alterado, recuado, zerado nem avançado por esta auditoria |
| Cooldown / Gate / mutex / rate limiter | **não** forçados nem contornados |
| Manifestação 210210 | **não** enviada |
| Git commit / push / merge | **não** executados |
| Código da aplicação | **não** modificado nesta sprint |

Horários de `dfe_auditoria.created_at` e `central_entradas_eventos.created_at` estão em UTC. BRT = UTC−3. CNPJs aparecem mascarados no sufixo quando o contexto já identifica a empresa.

---

## 1. Resumo executivo

Não há NF-e de outubro/2026 na inbox da Central (**0** chaves com AAMM `2610`). Isso é **CONFIRMADO** localmente. Não comprova, sozinho, que a SEFAZ não tenha emitido documentos no período.

O que o banco e o código comprovam:

1. **Última recepção durável com lotes** ocorreu em **27/09/2026**. Último `ZIP` / `PARSER` / `PERSISTENCIA` = 27/09/2026 22:42:14 UTC. De 28/09 a 17/10: **0** linhas desses tipos; **0** `ERRO_BANCO`.
2. Entre **28/09 e 03/10** não houve DistDFe local: **0** `CONSULTA` em `dfe_auditoria` e **0** `SYNC_INICIADA`.
3. A partir de **04/10**, as DistDFe de produção foram predominantemente **cStat 656**, sem lotes. Em **11** desses retornos o produto **avançou o cursor** via `AUTO_SYNC_NSU` (`NsuRecoveryService.tentarRecuperar`), porque o `ultNSU` parseado do XML 656 era **maior** que o cursor local — mesmo com `maxNSU=000…000` e **sem** ZIP/PARSER/PERSISTENCIA.
4. Saltos locais sem consumo DistDFe intermediário (**CONFIRMADO**): Matriz **+69** NSUs (127→196); Filial 2 **+20** (025→045); Filial 3 **+18** (017→035).
5. As 137 de 12/10 e 17/10 (`ultNSU=maxNSU`, `lotes=0`) só descrevem a fila **a partir do cursor já saltado**. Não provam que os NSUs intermediários estavam vazios na SEFAZ.
6. **Não há evidência** de documento DistDFe **recebido e não persistido** neste intervalo. Há evidência de cursor avançado **sem recepção local de lote**.

**Causa local da lista vazia em outubro:** nenhum lote DistDFe com documentos chegou a ser gravado depois de 27/09, e o cursor foi adiante nas respostas 656.  
**Causa SEFAZ (haver ou não NF-e nos NSUs pulados):** **INCONCLUSIVO** — depende de consulta autorizada (`consChNFe` com chaves do cliente, ou DistDFe a partir do cursor atual apenas para o que ainda estiver pendente no topo). **Não** retroceder NSU.

---

## 2. Empresas e cursores no fim do intervalo

Instalação **MULTIEMPRESA**, três empresas ativas, DistDFe em **produção** (`empresas_configuracao_fiscal.ambiente=1`). Painel global `fiscal_ambiente=2` e `configuracoes.cnpj` vazio **não** são a identidade DistDFe.

| empresaId | Fantasia | CNPJ | ult_nsu (fim 17/10) | max_nsu | ultimo_cstat | data_sincronizacao UTC |
|---|---|---|---|---|---|---|
| 1 | PASTELARIA DO CHEFF - Matriz | 38.204.469/0001-15 | 000000000000196 | 000000000000196 | 137 | 2026-10-17T21:50:55Z |
| 2 | PASTELARIA DO CHEFF - Filial 2 | 38.204.469/0003-87 | 000000000000045 | 000000000000045 | 137 | 2026-10-17T21:50:56Z |
| 3 | PASTELARIA DO CHEFF - Filial 3 | 38.204.469/0002-04 | 000000000000035 | 000000000000000 | 656 | 2026-10-17T21:50:57Z |

Linhas `ambiente=2` em `central_entradas_nsu` permanecem zeradas desde 30/08/2026 — resíduo; **não** são o cursor investigado.

Inbox: **0** chaves AAMM `2610`. Documentos criados a partir de 27/09: 18 NF-e operacionais AAMM `2609` (emp.1=11, emp.2=4, emp.3=3) + 2 linhas sem `empresa_id` (fixture/teste, não DistDFe de outubro).

---

## 3. Linha do tempo por empresa

Convenção: `CONSULTA.motivo` registra o **ultNSU enviado** (cursor local no SOAP), não o `ultNSU` remoto usado depois no `AUTO_SYNC`. O remoto está em `central_entradas_eventos` tipo `AUTO_SYNC_NSU` e em `dfe_auditoria` tipo `NSU`.

### 3.1 Matriz (…0001-15)

| UTC | BRT | Classificação | Evidência |
|---|---|---|---|
| 27/09 17:29:17 | 14:29 | **138 com lotes** | CONSULTA id 403: enviado 107, max 118, cStat 138, **lotes=11**. NSU 107→118. ZIP/PARSER/PERSISTENCIA no mesmo segundo. Documentos AAMM `2609` gravados. |
| 27/09 20:11:35 | 17:11 | **137 sem lotes** | id 484: 118=118, lotes=0. Fila no topo **naquele instante**. |
| 27/09 21:14:50 | 18:14 | **138 com lotes** | id 493: 118→124, lotes=6. Persistência no mesmo ciclo. |
| 27/09 22:42:14 | 19:42 | **138 com lotes** | id 538: 124→127, lotes=3. Último ZIP/PARSER/PERSISTENCIA da Matriz (NSU 125, XML aplicado a documento existente). |
| 28/09–03/10 | — | **Consulta não enviada** | 0 CONSULTA DistDFe, 0 SYNC_INICIADA. Motivo do ócio (processo parado, scheduler, etc.): **INCONCLUSIVO**. |
| 04/10 18:09:28 | 15:09 | **656 + avanço AUTO_SYNC** | CONSULTA id 552: enviado **127**, max **0**, lotes=0, xMotivo *utilizar o ultNSU nas solicitações subsequentes*. Evento **2313** `AUTO_SYNC_NSU`: local 127 → remoto **148** (Δ21). `dfe_auditoria` NSU id 553. `origemUltNsu=Parser`. Sem ZIP/PARSER. |
| 05/10–11/10 | — | **Consulta não enviada** | 0 DistDFe local. Cooldown de 1 h do 656 já teria expirado em 04/10 19:09 UTC. |
| 12/10 01:15:01 | 11/10 22:15 | **656 + avanço AUTO_SYNC** | id 561: enviado **148**, max 0. Evento **2378**: 148→**176** (Δ28). NSU auditoria id 562. |
| 12/10 10:11:21 | 07:11 | **137 sem lotes** | id 570: 176=176, lotes=0. Não prova vazio nos NSUs 128–175. |
| 12/10 21:59:44 | 18:59 | **656 + avanço AUTO_SYNC** | id 579: enviado 176, max 0. Evento **2421**: 176→**178** (Δ2). |
| 13/10 14:09:35 | 11:09 | **137 sem lotes** | id 588: 178=178, lotes=0. |
| 13/10 15:43:38 e 20:41:28 | 12:43 / 17:41 | **656 preservado** | ids 597, 606. xMotivo *aguardar 1 hora caso não existam mais documentos*. NSU_PRESERVADO (178). Eventos `SYNC_ERRO` empresa 1 com o mesmo texto. |
| 14/10 | — | **Consulta DistDFe não enviada** | `SYNC_INICIADA` + `SYNC_ERRO` *CNPJ do emitente não configurado* (origem `background` / `abrir_central`). Sem linha CONSULTA. |
| 15/10 22:49:47 | 19:49 | **656 + avanço AUTO_SYNC** | id 615: enviado 178. Evento **2459**: 178→**180** (Δ2). |
| 16/10 | — | **Consulta não enviada** | 0 CONSULTA, 0 SYNC. |
| 17/10 20:26:42 | 17:26 | **656 + avanço AUTO_SYNC** | id 624: enviado 180. Evento **2469**: 180→**196** (Δ16). `dfe_auditoria` NSU id 625. Resumo `CONSUMO_INDEVIDO_NSU_RECUPERADO`. |
| 17/10 21:50:55 | 18:50 | **137 sem lotes** | id 633: 196=196, lotes=0. |
| 17/10 22:45 UTC | 19:45 | **Consulta não enviada (Gate/fila)** | eventos `ignorado` `FILA_ESGOTADA` (`abrir_central` / `background`). Sem CONSULTA SOAP. |

**Cursor reconstruído (produção, ambiente=1):**  
107 →118 (138) →124 (138) →**127** (138, última persistência) →**148** (656 AUTO_SYNC) →**176** (656) →**178** (656) →**180** (656) →**196** (656) →196 (137, delta 0).

NSUs locais sem lote DistDFe correspondente neste banco: **128–147, 149–175, 177, 179, 181–195**. Existência de documento nesses NSUs na SEFAZ: **INCONCLUSIVO**.

### 3.2 Filial 2 (…0003-87)

| UTC | BRT | Classificação | Evidência |
|---|---|---|---|
| 27/09 17:29:18 | 14:29 | **138 com lotes** | id 439: 015→021, lotes=6. Persistência no ciclo. |
| 27/09 20:11:36 | 17:11 | **137 sem lotes** | id 487: 021=021. |
| 27/09 21:21:11 | 18:21 | **138 com lotes** | id 523: 021→025, lotes=4. |
| 27/09 22:42:15 | 19:42 | **137 sem lotes** | id 546: 025=025. Último DistDFe com persistência associada ao dia. |
| 28/09–03/10 | — | **Consulta não enviada** | igual à Matriz. |
| 04/10 18:09:30 | 15:09 | **656 + avanço AUTO_SYNC** | id 555: enviado 025. Evento **2314**: 025→**029** (Δ4). |
| 12/10 01:15:56 | 11/10 22:15 | **656 + avanço AUTO_SYNC** | id 564: enviado 029. Evento **2399**: 029→**041** (Δ12). |
| 12/10 10:11:59 | 07:11 | **137 sem lotes** | id 573: 041=041. |
| 12/10 21:59:46 | 18:59 | **137 sem lotes** | id 582: 041=041. Sem AUTO_SYNC. |
| 13/10 14:09:36, 15:43:39, 20:41:29 | — | **656 preservado** | ids 591, 600, 609. Cursor 041. |
| 15/10 22:49:49 | 19:49 | **656 + avanço AUTO_SYNC** | id 618: enviado 041. Evento **2460**: 041→**045** (Δ4). |
| 17/10 20:26:43 | 17:26 | **656 preservado** | id 627: enviado 045, xMotivo *aguardar 1 hora*. NSU id 628 PRESERVADO. Sem salto. |
| 17/10 21:50:56 | 18:50 | **137 sem lotes** | id 636: 045=045. |

**Cursor:** 015→021→**025** (última 138) →**029** →**041** →**045**.  
NSUs sem lote local: **026–028, 030–040, 042–044**. Conteúdo SEFAZ: **INCONCLUSIVO**.

### 3.3 Filial 3 (…0002-04)

| UTC | BRT | Classificação | Evidência |
|---|---|---|---|
| 27/09 17:29:20 | 14:29 | **138 com lotes** | id 460: 008→015, lotes=7. |
| 27/09 20:11:37 | 17:11 | **137 sem lotes** | id 490: 015=015. |
| 27/09 21:15:02 | 18:15 | **138 com lotes** | id 514: 015→017, lotes=2. |
| 27/09 22:42:16 | 19:42 | **137 sem lotes** | id 549: 017=017. |
| 28/09–03/10 | — | **Consulta não enviada** | igual às demais. |
| 04/10 18:09:31 | 15:09 | **656 + avanço AUTO_SYNC** | id 558: enviado 017. Evento **2315**: 017→**023** (Δ6). |
| 12/10 01:15:58 | 11/10 22:15 | **656 + avanço AUTO_SYNC** | id 567: enviado 023. Evento **2400**: 023→**031** (Δ8). |
| 12/10 10:12:00 | 07:12 | **137 sem lotes** | id 576: 031=031 (max restaurado no 137). |
| 12/10 21:59:48 | 18:59 | **656 preservado** | id 585: enviado 031, xMotivo *aguardar 1 hora*. NSU_PRESERVADO. |
| 13/10 (3 consultas) | — | **656 preservado** | ids 594, 603, 612. Cursor 031. |
| 15/10 22:49:50 | 19:49 | **656 + avanço AUTO_SYNC** | id 621: enviado 031. Evento **2461**: 031→**035** (Δ4). `maxNsu` gravado **0**. |
| 17/10 20:26:44 e 21:50:57 | 17:26 / 18:50 | **656 preservado** | ids 630, 639. Cursor 035, max 0. Sem 137 no dia. Cooldown 656 vigente até 22:50:57 UTC. |

**Cursor:** 008→015→**017** (última 138) →**023** →**031** →**035** (656, max=0).  
NSUs sem lote local: **018–022, 024–030, 032–034**. Conteúdo SEFAZ: **INCONCLUSIVO**.

O `max_nsu=0` da Filial 3 no fim do intervalo é o valor persistido pelo `AUTO_SYNC` de 15/10 (e reforçado nos 656 seguintes). Não é evidência de fila vazia; é efeito da regra `CASE` descrita na seção 5.

---

## 4. Histórico de NSU e respostas 656

### 4.1 Todos os `AUTO_SYNC_NSU` do intervalo (11 eventos)

Fonte: `central_entradas_eventos.tipo=AUTO_SYNC_NSU`, `resultado=ATUALIZADO`, `origemUltNsu=Parser`, `maxNsu=000…000` em todos.

| id | UTC | CNPJ | nsuLocal → nsuRemoto | Δ |
|---|---|---|---|---|
| 2313 | 04/10 18:09:28 | …0001-15 | 127 → 148 | 21 |
| 2314 | 04/10 18:09:30 | …0003-87 | 025 → 029 | 4 |
| 2315 | 04/10 18:09:31 | …0002-04 | 017 → 023 | 6 |
| 2378 | 12/10 01:15:01 | …0001-15 | 148 → 176 | 28 |
| 2399 | 12/10 01:15:56 | …0003-87 | 029 → 041 | 12 |
| 2400 | 12/10 01:15:58 | …0002-04 | 023 → 031 | 8 |
| 2421 | 12/10 21:59:44 | …0001-15 | 176 → 178 | 2 |
| 2459 | 15/10 22:49:47 | …0001-15 | 178 → 180 | 2 |
| 2460 | 15/10 22:49:49 | …0003-87 | 041 → 045 | 4 |
| 2461 | 15/10 22:49:50 | …0002-04 | 031 → 035 | 4 |
| 2469 | 17/10 20:26:42 | …0001-15 | 180 → 196 | 16 |

Não há evento `AUTO_SYNC_NSU` com `resultado` diferente de `ATUALIZADO` neste recorte. Quando o 656 **não** saltou, a auditoria DistDFe gravou `NSU_PRESERVADO` (não `AUTO_SYNC`).

### 4.2 Dois textos de 656, duas condutas

| xMotivo (prefixo) | Conduta observada | Exemplos |
|---|---|---|
| *Deve ser utilizado o ultNSU nas solicitações subsequentes* | `AUTO_SYNC` **quando** o parser entrega `ultNSU` remoto > local | 04/10 (3 CNPJs), 12/10 01:15 (3), 12/10 21:59 Matriz, 15/10 (3), 17/10 Matriz |
| *Deve ser aguardado 1 hora … caso não existam mais documentos* | `NSU_PRESERVADO` (remoto ≤ local **ou** remoto igual ao enviado) | 12/10 21:59 Filial 3; 13/10 (vários); 17/10 Filial 2 e Filial 3 |

A diferença **não** está em um flag de operador. Está em `NsuRecoveryService`: só grava salto se `nsuNumerico(nsuRemoto) > nsuNumerico(nsuLocal)` após resolver `ultNSU`/`maxNSU` do parser/XML.

### 4.3 O `ultNSU` do `CONSULTA.motivo` não é o cursor gravado no salto

Exemplo 17/10 Matriz: CONSULTA id 624 motivo `ultNSU=000…180` (enviado). Evento 2469 `nsuRemoto=000…196` (persistido). O SOAP 656 **não** devolveu lote; o produto mesmo assim gravou 196.

---

## 5. Correlação consulta × lote × parser × persistência

### 5.1 Caminho 137/138 (documentos)

Em `distribuicaoDFe.js`, para cStat ≠ 656:

1. `persistirDocumentosRetorno` (ZIP → parser → persistência);
2. se `errosPersistencia` ≠ vazio: retorna `PERSISTENCIA_DFE_INCOMPLETA` e **não** chama `aplicarRetornoDistDfe` — NSU preservado;
3. só então `CentralNsuService.aplicarRetornoDistDfe` com 137/138.

Em 27/09 esse caminho ocorreu. Contagens do dia: ZIP PROCESSADO = PARSER PROCESSADO (Matriz 18, Filial 2 10, Filial 3 9). Última persistência 22:42:14 UTC, motivo *XML completo aplicado ao documento existente* (NSU 125).

### 5.2 Caminho 656 (sem lote)

O ramo `cStat === '656'` em `distribuicaoDFe.js` (aprox. linhas 820–905):

- salva XML 656 em disco (auditoria de arquivo; **não** lido nesta sprint);
- chama `aplicarRetornoDistDfe` **antes** de qualquer persistência de lote;
- telemetria `persistidos: 0`;
- `registrarNsuAvanco` com motivo `AUTO_SYNC_NSU` se `atualizouNsu`;
- `registrarResumoSync` motivo `CONSUMO_INDEVIDO_NSU_RECUPERADO` ou `CONSUMO_INDEVIDO`;
- **return** — não entra em `persistirDocumentosRetorno`.

**CONFIRMADO:** existe caminho em que o cursor é persistido **sem** que documentos do retorno estejam duravelmente registrados, porque o retorno 656 **não traz lotes** e o código **não exige** 138 para avançar.

### 5.3 Classificação das tentativas 28/09–17/10

| Classe | O que está comprovado |
|---|---|
| Consulta não enviada (sem SYNC) | 28/09–03/10, 05/10–11/10, 16/10 |
| Consulta não enviada (SYNC sem SOAP) | 14/10 (CNPJ emitente); 17/10 parte dos `SYNC_INICIADA` com `FILA_ESGOTADA` / cooldown / mesmo erro de CNPJ |
| Enviada, resposta 656, cursor avançado | 11 `AUTO_SYNC_NSU` da tabela 4.1 |
| Enviada, resposta 656, cursor preservado | 12/10 21:59 Filial 3; 13/10 (quase todas); 17/10 Filiais 2 e 3 (20:26); Filial 3 21:50 |
| 137/138 sem lotes | 12/10 10:11 (3 CNPJs); 12/10 21:59 Filial 2; 13/10 14:09 Matriz; 17/10 21:50 Matriz e Filial 2 |
| 138 com documentos/lotes | **nenhuma** após 27/09 22:42 |
| Erro de parser, ZIP ou persistência | **0** linhas `ZIP`/`PARSER`/`PERSISTENCIA` após 27/09; `persistErr=[]`; `ERRO_BANCO=0` |
| Avanço de NSU com evidência incompleta de documento | os 11 `AUTO_SYNC` (salto sem lote) |
| Ausência de registros para concluir o ócio | por que o processo não DistDFeou em 28/09–03/10 e 05/10–11/10 |

### 5.4 Persistência explícita vs documento nunca recebido

- **DESCARTADO** neste intervalo: lote DistDFe chegou, ZIP/parser rodou, e a gravação falhou (`ERRO_BANCO` / `PERSISTENCIA_DFE_INCOMPLETA`). Não há linha.
- **CONFIRMADO:** após 27/09 o produto **não recebeu** lote DistDFe persistível (656/137 com `lotes=0`).
- **Não se conclui** “não houve falha” só pela ausência de `ERRO_BANCO`. A falha observada é de **política de cursor** (avançar em 656), não de SQLITE.

`consChNFe` de recuperação XML em 12/10 (documentos antigos AAMM `2608`/`2609`, já na inbox) **não** insere NF-e de outubro. Consome cota SEFAZ e aparece misturado aos 656 DistDFe do mesmo dia — contribuição **PROVÁVEL** para reiteração de 656, não prova de NF-e de outubro.

---

## 6. Arquivos e funções que alteram o cursor após 656

### 6.1 Cadeia

| Etapa | Arquivo | Função | Efeito |
|---|---|---|---|
| Detectar 656 | `backend/services/fiscal/distribuicaoDFe.js` | ramo `cStat === '656'` (~820) | Não persiste lote; delega NSU; registra auditoria |
| Orquestrar 656 | `backend/motores/central-entradas/services/CentralNsuService.js` | `aplicarRetornoDistDfe` (~114) | Sempre `cooldown_ate = agora + 1 h`; chama recovery; depois `preservarNsu: true` (grava cooldown/cStat sem segundo salto) |
| Decidir salto | `backend/motores/central-entradas/services/NsuRecoveryService.js` | `tentarRecuperar` | Único autor de `AUTO_SYNC_NSU` |
| Persistir cursor | `backend/motores/central-entradas/repositories/CentralNsuRepository.js` | `atualizarSincronizacaoSegura` (~277–283) | `CASE` lexicográfico; **não** impede `max_nsu=0` |
| Auditar salto | `NsuRecoveryService._auditar` + `distribuicaoDFe.registrarNsuAvanco` / `registrarResumoSync` | eventos `AUTO_SYNC_NSU`; NSU_AVANCO; motivo `CONSUMO_INDEVIDO_NSU_RECUPERADO` | Rastro usado nesta auditoria |

Comentário em `CentralNsuService.js` (cabeçalho): recuperação 656 somente quando a SEFAZ informar **ultNSU e maxNSU maiores** que o local. A implementação **não** exige `maxNSU > local` nem `maxNSU ≥ ultNSU`. Exige apenas tags resolvidas (string não vazia) e `ultNSU` remoto > local.

### 6.2 Respostas objetivas

**1. Qual condição permite alterar o cursor após 656?**

`tentarRecuperar` só segue se `cStat === '656'`, controle existe, `resolverNsu` devolve valor para `ultNSU` **e** `maxNSU`, e `nsuNumerico(nsuRemoto) > nsuNumerico(nsuLocal)`. Então chama `atualizarSincronizacaoSegura({ ultNsu: nsuRemoto, maxNsu: maxRemoto, ultimoCstat: '656' })`.

`resolverNsu` aceita o campo do parser (origem `Parser`) ou tag XML. `000000000000000` é string informada: passa em `if (!resolucaoUlt.valor || !resolucaoMax.valor)` porque é truthy. Zeros **não** bloqueiam o salto.

**2. Essa condição está respaldada por resposta válida 137/138 ou só por recuperação interna?**

Só recuperação interna sobre o XML/parser do **656**. Não há 138, não há lote, não há persistência de documento. O produto trata o `ultNSU` do 656 como cursor SEFAZ (cenário RC3.7.5.1 “banco restaurado”). Nesta instalação o banco **não** mostra restore: a última 138 é contínua em 27/09 no mesmo arquivo.

O `ultNSU` remoto veio do **Parser** (campo da resposta SOAP), não foi fabricado como zero. Isso **não** equivale a uma DistDFe 138 com documentos.

**3. Existe risco de pular NSUs ainda não processados?**

**Sim, risco local CONFIRMADO.** O DistDFe `distNSU` deste banco nunca processou os NSUs intermediários listados na seção 3. Depois do salto, a próxima consulta parte do novo `ult_nsu`. A SEFAZ não reenvia NSUs anteriores por `distNSU`.

**4. Quais evidências afirmam ou descartam o risco?**

- Afirmam o **pulo local:** 11 `AUTO_SYNC` com Δ>0, `lotes=0`, 0 ZIP/PARSER no mesmo segundo, NSU_AVANCO `cStat=656`.
- **Não** afirmam que cada NSU pulado continha NF-e. 137 posterior no **novo** topo (`lotes=0`) não inspeciona o intervalo pulado.
- **Não** descartam terceiro consumidor do mesmo certificado (outro sistema DistDFe) — explicaria `ultNSU` SEFAZ > local após dias sem consulta daqui. **INCONCLUSIVO.**

**5. Como corrigir o risco sem retroceder NSU automaticamente? (não executado)**

- Em 656: persistir só cooldown + `ultimo_cstat`; **não** copiar `ultNSU` remoto quando `maxNSU` for 0/inválido ou quando não houver 138 com persistência completa.
- Impedir `max_nsu=0` após já haver progresso (`CASE` atual compara o bind de `ultNsu` também no `max_nsu`, então um salto de ult com max=0 **zera** max).
- Recuperação de documentos possivelmente pulados: **`consChNFe` com chaves fornecidas pelo cliente** (DANFE/XML), sem `distNSU` para trás.
- DistDFe autorizado daqui para a frente: apenas a partir do cursor atual, para o que ainda estiver pendente no topo.
- Não implementar essas mudanças nesta sprint.

### 6.3 Como uma nova consulta ocorre após 656

`INTERVALO_COOLDOWN_MS = 1 h` → `cooldown_ate`. Gate, mutex e `FILA_ESGOTADA` (este último só 137/138 com `ult=max`) continuam válidos. Nada nesta sprint desarmou esses controles. Após 04/10 o cooldown de 1 h **não** explica a ausência até 12/10: o processo simplesmente **não enviou** DistDFe (lacuna operacional).

---

## 7. Classificação das hipóteses

| Hipótese | Classificação | Evidência |
|---|---|---|
| Não há NF-e de outubro na inbox local | **CONFIRMADO** | 0 chaves AAMM `2610` |
| Última persistência DistDFe com documentos foi 27/09 | **CONFIRMADO** | último ZIP/PARSER/PERSISTENCIA 22:42:14 UTC; 0 depois |
| Falha SQLITE / `ERRO_BANCO` comeu os lotes de outubro | **DESCARTADO** | 0 `ERRO_BANCO`; 0 `PERSISTENCIA` no intervalo |
| Documentos DistDFe foram recebidos (ZIP) e não gravados | **DESCARTADO** neste intervalo | 0 ZIP/PARSER após 27/09 |
| O cursor avançou após 656 | **CONFIRMADO** | 11 `AUTO_SYNC_NSU` + NSU_AVANCO `cStat=656` |
| A regra do salto é recovery interno (RC3.7.5.1), não 138 | **CONFIRMADO** | `NsuRecoveryService.tentarRecuperar` |
| NSUs intermediários não foram consumidos por `distNSU` neste banco | **CONFIRMADO** | deltas sem lote |
| Esses NSUs intermediários continham NF-e na SEFAZ | **INCONCLUSIVO** | 137 no topo novo não inspeciona o intervalo; XML 656 não foi reaberto nesta sprint |
| A SEFAZ não emitiu nenhuma NF-e de outubro para os três CNPJs | **INCONCLUSIVO** | DistDFe de outubro não devolveu 138; pulos impedem afirmar vazio histórico |
| 137 de 17/10 (Matriz/Filial 2) prova fila historicamente vazia | **DESCARTADO** | prova só “nada a partir de 196/045 naquele instante” |
| Terceiro consumidor DistDFe no mesmo certificado | **INCONCLUSIVO** | compatível com 656 “use ultNSU” após 6 dias ociosos, sem prova |
| Restore de banco (cenário original do AUTO_SYNC) | **INCONCLUSIVO** (sem indício local) | série 27/09 contínua no mesmo arquivo; nenhum truncate visível |
| `max_nsu=0` na Filial 3 é efeito do `CASE` + 656 | **CONFIRMADO** | AUTO_SYNC 15/10 `maxNsu=0`; 137 de 12/10 ainda tinha max=031 |
| Ócio 28/09–03/10 e 05/10–11/10 = cooldown 656 | **DESCARTADO** | cooldown é 1 h; o vão é de dias |
| Causa do ócio de dias | **INCONCLUSIVO** | sem SYNC_INICIADA; processo/scheduler/operação não auditáveis só pelo SQLite |
| Erro “CNPJ do emitente não configurado” (14/10, 17/10) | **CONFIRMADO** como bloqueio **pré-SOAP** | SYNC_ERRO sem CONSULTA; não altera NSU |
| Lista vazia na UI por filtro “mês vigente” | **PROVÁVEL** como efeito de UX | há dezenas de 2608/2609; 2610=0. Não explica a ausência de 2610 |

### Por empresa, o que se sabe

**Matriz.** Última 138 durável em 127 (27/09 22:42 UTC). Cinco saltos 656 até 196. Duas 137 vazias no topo novo (12/10 e 17/10). Sem NF-e 2610. Intervalo 128–195 sem lote local, **exceto** os pontos 148, 176, 178, 180, 196 que são só cursores, não documentos.

**Filial 2.** Última 138 em 025. Três saltos até 045. 137 vazia em 045 em 17/10. Sem 2610.

**Filial 3.** Última 138 em 017. Três saltos até 035. Sem 137 em 17/10; permanece 656 com max=0. Sem 2610.

Onde a série de `dfe_auditoria` não tem CONSULTA, **não** foi inventada sequência de NSU. Os únicos NSUs anteriores/posteriores com prova são os das tabelas acima.

---

## 8. Riscos confirmados, lacunas e próxima ação

### 8.1 Riscos confirmados (código + registros)

1. **Pulo de NSU em 656** sem lote persistido — `AUTO_SYNC_NSU`.
2. **Persistência de `max_nsu=0`** quando o 656 traz max zerado e o `CASE` aplica o max remoto porque o ult remoto ≥ ult local.
3. **DistDFe a partir do cursor atual não recupera** os NSUs pulados.
4. Retrasar DistDFe por dias (ócio) **acumula** atraso; o primeiro 656 seguinte pode saltar o atraso inteiro.

### 8.2 Lacunas (não inventar)

- Conteúdo real dos NSUs pulados na SEFAZ.
- XML 656 em disco (não aberto: evitaria XML fiscal completo no relatório e não muda a regra já vista no parser).
- Por que não houve `SYNC_INICIADA` em vários dias.
- Se outro software usou o mesmo certificado DistDFe.
- NF-e de outubro existentes só no DANFE do cliente / portal, nunca vistas por este banco.

### 8.3 O que ainda depende de consulta real autorizada ou de chaves do cliente

- Confirmar NF-e de outubro: o cliente fornece **chaves de acesso** (44 dígitos) dos DANFEs do período → `consChNFe` **autorizado**, uma a uma, sem mexer em NSU.
- Ver se o **topo atual** ainda tem documento novo: DistDFe **autorizada** a partir de 196 / 045 / 035, respeitando Gate, cooldown e 656, **sem** `AUTO_SYNC` novo até a regra ser corrigida em sprint posterior.
- **Não** recuar `ult_nsu`. **Não** zerar NSU. **Não** reprocessar 28/09–17/10 via `distNSU`.

### 8.4 Próxima ação recomendada (não executada)

1. Sprint de correção da regra 656: não avançar cursor quando maxNSU for 0/inválido; não gravar max=0; 656 = cooldown + preservar, salvo decisão explícita e auditável.
2. Operação: colher chaves de outubro com o cliente e planejar `consChNFe` controlado.
3. Só depois, DistDFe no topo atual, com a correção já em produção, para não repetir o salto.

---

## Critério de aceitação

| Pergunta | Resposta com evidência |
|---|---|
| O que aconteceu desde 28/09 em cada empresa? | Seção 3: ócio DistDFe, depois 656 com e sem salto, 137 vazias no topo novo, Filial 3 ainda em 656. |
| Houve avanço de NSU após 656? | **Sim.** 11 eventos `AUTO_SYNC_NSU` (tabela 4.1). Regra: `NsuRecoveryService.tentarRecuperar` se `ultNSU` parser > local. |
| Documentos recebidos e não persistidos? | **Não neste intervalo.** 0 ZIP/PARSER/PERSISTENCIA após 27/09. O que faltou foi **recepção de lote**, não gravação de lote. |
| Risco demonstrável de NSUs pulados? | **Sim, no cursor local.** Conteúdo SEFAZ dos pulos: **INCONCLUSIVO**. |
| O que depende de SEFAZ/chaves? | Existência de NF-e 2610; recuperação pontual por chave; DistDFe só do topo atual. |

---

## Encerramento

Relatório: `docs/central-entradas/auditoria-intervalo-nfe-2026-09-28-a-2026-10-17.md`.

Leituras: SELECT em `dfe_auditoria`, `central_entradas_eventos`, `central_entradas_documentos`, `central_entradas_nsu` (esta última na verificação operacional do mesmo dia); análise estática de `NsuRecoveryService.js`, `CentralNsuService.js`, `CentralNsuRepository.js`, `distribuicaoDFe.js`. Nenhum teste automatizado foi alterado ou executado como correção.

**Nenhum código, dado oficial, NSU ou estado da SEFAZ foi alterado nesta sprint.**

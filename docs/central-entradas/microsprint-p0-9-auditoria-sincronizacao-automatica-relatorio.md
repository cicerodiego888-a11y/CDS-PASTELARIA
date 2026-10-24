# Microsprint P0.9 — Auditoria e validação da sincronização automática da Central de Entradas

**Prioridade:** P0  
**Data:** 18/10/2026  
**Tipo:** auditoria e validação (sem implementação de recuperação histórica)  
**Veredito:** **APROVADO COM RESSALVAS**

Nesta sprint **não** houve consulta DistDFe real à SEFAZ, transmissão fiscal, uso de certificado/senha de produção, abertura ou alteração do banco oficial em `C:\ProgramData\MercantilFiscal\dados`, `CDS_ALLOW_OFFICIAL_DB=1`, alteração/zeramento/retrocesso de NSU, sincronização real “para ver se funciona”, commit, push ou merge.

Os valores históricos de NSU (Empresa 1: 196/196; Empresa 2: 45/45; Empresa 3: 35/0) são **apenas referência de auditoria anterior**. Não foram tratados como estado atual.

---

## 1. Resumo executivo

| Pergunta | Resposta (evidência) |
|---|---|
| Sync automática habilitada? | **Por código/seed: não.** Flag `sync_automatica_habilitada` default `false`. Estado real no DB do cliente: **não comprovado** nesta sprint. |
| Existe agendamento? | **Sim.** `CentralSyncBackgroundService` com `setTimeout` reentrante, iniciado no Grupo B de `backend/server.js` (também via Electron → mesmo backend). |
| Executa para cada empresa? | **No código, sim** (loop MULTIEMPRESA / alvo único EMPRESA_SIMPLES). **Operação real: não comprovada.** |
| NSU individual por empresa? | **Cursor por CNPJ+ambiente** (`central_entradas_nsu`), não por `empresa_id`. Isolamento depende de CNPJ distintos. |
| Retornos SEFAZ tratados? | **137/138/656 tratados no código**; 656 **não avança** NSU; persistência antes do avanço em 137/138. |
| Documentos persistidos? | **Fluxo de código:** `central_entradas_documentos` com `empresa_id` + idempotência por chave. **Operação: não comprovada.** |
| Bloqueios que impedem novas NF-e? | **Sim, estruturais:** (1) sync automática off por default; (2) **barreira P0.8** — DistDFe sem `autorizacaoTransmissaoSefaz`/`OPERACAO_REAL` retorna consulta não executada; (3) cooldown/gate; (4) horário BACKGROUND. |

Conclusão objetiva: o **mecanismo** de sync automática existe e o tratamento de cursor/656 está coerente nos testes isolados, mas a **chegada automática de novas NF-e via DistDFe em produção está bloqueada por desenho** (flag + barreira de autorização). O caminho operacional autorizado atual é `POST /operacao-fiscal-real/consultar-dfe` (ativação controlada), não o timer de background.

---

## 2. Arquivos e funções auditados

| Área | Arquivo | Funções / pontos |
|---|---|---|
| Boot | `backend/server.js` | `inicializarCentralSync`, `iniciarServicosBackgroundGrupoB`, `executarPassoBackground` |
| Timer | `.../CentralSyncBackgroundService.js` | `iniciar`, `_agendarCiclo`, `_executarCiclo`, `parar`, `reiniciar` |
| Execução | `.../CentralSyncExecucaoService.js` | `executar`, cooldown/gate/horário, `catch` silencioso no gate |
| Loop empresas | `.../CentralSincronizacaoService.js` | `sincronizar`, `_sincronizarEmpresa` |
| Alvos | `.../CentralEntradasEmpresaContextoService.js` | `listarAlvosSincronizacaoCentral` |
| DistDFe | `backend/services/fiscal/distribuicaoDFe.js` | `sincronizarDistribuicaoDFe`, auth, 656, persistência, NSU |
| NSU | `.../CentralNsuService.js`, `CentralNsuRepository.js` | `aplicarRetornoDistDfe`, `avaliarCooldown`, tabela `central_entradas_nsu` |
| Auth | `autorizacaoTransmissaoSefaz.js` | barreira TESTE_ISOLADO / OPERACAO_REAL |
| Flags | `centralEntradasFlags.js`, `CentralConfigService.js`, seeds `database.js` | `sync_automatica_*`, `sync_ao_abrir` |
| Facade | `CentralEntradasOrchestrator.js` | `executarSincronizacao`, `sincronizarAoAbrir` |
| Electron | `electron.js` / `electron-common.js` | sobe `backend/server` (herda Grupo B) |

---

## 3. Fluxo de execução da sincronização

```
Electron/npm → backend/server.listen
  → setImmediate Grupo B → CentralSyncBackgroundService.iniciar()
      → hidratarFlags()
      → [módulo off OU sync_automatica=false] → BACKGROUND SLEEP (sem DistDFe periódico)
      → [sync_automatica=true] → setTimeout(3s) → _executarCiclo
          → Orchestrator.executarSincronizacao(origem=BACKGROUND)
              → SyncExecucao (gate / cooldown SIMPLES / horário / mutex)
              → Sincronizacao.sincronizar
                  → listarAlvosSincronizacaoCentral()
                  → para cada empresa:
                      contexto (empresaId, CNPJ, ambiente, cert)
                      → cooldown/gate por empresa
                      → sincronizarDistribuicaoDFe(...)
                          → avaliarAutorizacaoTransmissao  ← sem auth: BLOQUEADA (sem SOAP)
                          → [se autorizado] ler NSU → SOAP → 137|138|656
                          → 138/137: persistir docs → só então avançar NSU
                          → 656: preservar NSU + cooldown
              → eventos / notificações
          → reagenda intervalo (default 15 min)
```

### Onde a execução pode parar

| Etapa | Efeito | Evidência de log/evento |
|---|---|---|
| Módulo Central off | Sem timer DistDFe | `BACKGROUND SLEEP` / `modulo_central_desabilitado` |
| `sync_automatica_habilitada=false` | Sem DistDFe periódico | `sync_automatica_desabilitada_xml_wait_ativo` |
| Sem autorização SOAP | Consulta não enviada | `BLOQUEADA_AUTORIZACAO` / `TRANSMISSAO_SEFAZ_NAO_AUTORIZADA` |
| Cooldown NSU/Gate | Sem SOAP | `BLOQUEADA_COOLDOWN` / `BLOQUEADA_GATE` |
| Horário BACKGROUND | Ignorado | retorno `ignorado` |
| Contexto empresa inválido | Empresa pulada; demais seguem | `pulado` + `codigoErro` |
| cStat 656 | SOAP ocorreu; NSU **não** avança | `NSU_PRESERVAR_656`, `CONSUMO_INDEVIDO` |
| Persistência incompleta | NSU **não** avança | `PERSISTENCIA_DFE_INCOMPLETA` |
| 137/138 OK | Docs + NSU | `NSU_ATUALIZAR`, docs em `central_entradas_documentos` |

---

## 4. Configurações necessárias

| Chave (`central_entradas_config`) | Seed | Papel |
|---|---|---|
| `sync_automatica_habilitada` | **`false`** | Liga o timer DistDFe periódico |
| `sync_intervalo_minutos` | `15` | Intervalo entre ciclos |
| `sync_ao_abrir` | `true` | Dispara sync ao abrir Central (também cai na barreira de auth) |
| `sync_max_documentos` | `50` | Max iterações DistDFe |
| `sync_horario_permitido_*` | 06:00–23:59 | Restrição origem BACKGROUND |

**ASSISTIDO vs AUTOMÁTICO:** não há enum DistDFe com esses nomes. Existem origens (`BACKGROUND`, `MANUAL`, `ABRIR_CENTRAL`) e, à parte, política de manifestação (`MANUAL` / automática ciência). Homologação “assistida” é painel de leitura.

**Reinício:** timer é recriado no boot se a flag estiver true; NSU/cooldown NSU persistem no DB; `SefazConsultaTrace` em RAM **não** sobrevive ao restart.

---

## 5. Análise das três empresas (evidências seguras)

| Item | Empresa 1 | Empresa 2 | Empresa 3 |
|---|---|---|---|
| NSU histórico (auditoria anterior) | ult=196, max=196 | ult=45, max=45 | ult=35, max=0 |
| Estado atual no DB oficial | **Não lido** (proibido nesta sprint) | Idem | Idem |
| Processamento no código MULTIEMPRESA | Alvo se `ativo=1` | Idem | Idem |
| Cursor | Por CNPJ+ambiente da empresa | Idem | Idem |
| Risco `max_nsu=0` histórico | — | — | Anômalo; exige validação operacional autorizada (pode afetar lógica ult/max) |

**Comprovado pelo código:** o loop não usa estado global mutável entre empresas; falha de uma não aborta as demais; `empresaId` é passado à persistência e ao DistDFe.

**Não comprovado sem operação:** se as três empresas ativas do cliente entram no lote, se certificados/CNPJ estão ok, se cooldown está ativo por CNPJ, quais `ult_nsu`/`max_nsu` atuais.

**Fallback global:** proibido em MULTIEMPRESA (`permitirFallbackGlobal` só em EMPRESA_SIMPLES). NSU sem coluna `empresa_id` — isolamento por CNPJ.

---

## 6. Tratamento dos retornos da SEFAZ

| cStat | Comportamento no código | Avanço NSU |
|---|---|---|
| **137** | Sucesso DistDFe; persistência (pode ser vazia); `aplicarRetornoDistDfe` se par ult/max válido | Sim, após persistência OK |
| **138** | Docs no ZIP → `persistirDocumentosRetorno` → só então NSU; loop enquanto ult &lt; max | Sim, após persistência OK |
| **656** | Cooldown; auditoria; **cursor preservado** mesmo com ult remoto maior | **Não** (`preservarNsu: true`) |

Ordem obrigatória em `sincronizarDistribuicaoDFe`: **persistir → depois NSU**. Erros de persistência → `PERSISTENCIA_DFE_INCOMPLETA` sem avanço.

**Cooldown dual (ressalva):** NSU usa ~1h fixo; Gate operacional usa escala progressiva (10→120 min). Podem divergir no diagnóstico.

---

## 7. Persistência dos documentos

| Aspecto | Evidência de código |
|---|---|
| Tabela | `central_entradas_documentos` |
| Serviço | `CentralDfePersistenciaService.persistirDocumentoDfe` |
| Empresa | `empresa_id` da sync |
| Idempotência | `buscarPorChave(chave, empresaId)`; upgrade resumo→XML |
| Inbox | APIs da Central leem a mesma base filtrada por empresa |
| 138 sem persistência | NSU não confirma avanço |

Diferença “recebido / processado / visível”: documento pode existir como resumo (`RES_NFE`) aguardando XML; processamento MIIP/compras é etapa posterior — **não auditada como falha de DistDFe nesta sprint**.

---

## 8. Observabilidade

| Evento | Fonte |
|---|---|
| Background start/sleep/wake | `logCentral('BACKGROUND', …)` |
| DistDFe ciclo | `BACKGROUND DISTDFE` |
| Bloqueio auth/cooldown/gate | `SefazConsultaTrace` (`BLOQUEADA_*`) |
| NSU 656 / avanço | `logOperacaoCentral` / auditoria DFe |
| Config | `central_entradas_config`, `central_entradas_eventos` |

**Lacunas:** (1) `catch { /* ignore */ }` no Gate em `CentralSyncExecucaoService.executar` (~173) — falha do gate não bloqueia; (2) trace volátil; (3) init de `central-sync` pode falhar sem derrubar o server; (4) agregados multiempresa podem mascarar detalhe (detalhe em `porEmpresa`).

**Proposta mínima (não implementada):** logar falha do gate em nível ERROR e falhar fechado; métrica persistida `ultima_sync_por_empresa` com cStat/auth/cooldown.

---

## 9. Testes executados e resultados

Isolamento: `-r tests/central-entradas/helpers/preloadIsolamentoBanco.js` (Temp; sem `CDS_ALLOW_OFFICIAL_DB`).

| Suite | Resultado |
|---|---|
| `microsprint-correcao-segura-cursor-656.test.js` | Suítes 656/137-138/isolamento/persistência **OK**; 1 assert de mensagem do guardião de DB oficial falhou por texto esperado desatualizado (`/recusou abrir/` vs mensagem atual do guard) — **o bloqueio ao ProgramData funcionou** |
| `microsprint-p0-8-bloqueio-transmissoes-sefaz.test.js` | **Pass** (barreira SOAP) |
| `nfe-nao-localizada-sync.test.js` | **Pass** |
| `rc731-background-smoke.test.js` | **Pass** |

Agregado desta batelada: **37 pass / 1 fail** (fail = expectativa de string do guardião, não regressão de NSU/sync).

**Não declarar sync real operacional só porque testes passaram.**

---

## 10. Problemas encontrados e severidade

| # | Severidade | Problema | Impacto |
|---|---|---|---|
| P1 | **Crítica (produto)** | DistDFe automático/background **sem** `autorizacaoTransmissaoSefaz` / OPERACAO_REAL → consulta **não enviada** (P0.8) | Timer pode “rodar” sem trazer NF-e |
| P2 | **Alta** | `sync_automatica_habilitada` default **false** | Sync periódica off até ativação explícita no painel |
| P3 | **Alta** | Gate engolido em `catch { ignore }` na execução | Gate quebrado pode não bloquear |
| P4 | **Média** | Cooldown dual NSU (1h) vs Gate (progressivo) | Diagnóstico/UX inconsistente |
| P5 | **Média** | NSU por CNPJ+ambiente sem `empresa_id` | Risco se dois registros compartilharem CNPJ |
| P6 | **Média** | Empresa 3 histórica `max_nsu=0` | Requer validação operacional autorizada |
| P7 | **Baixa** | Falha init `central-sync` não derruba boot | Sync pode ficar morta sem alarme forte |
| P8 | **Baixa** | Teste do guardião com regex de mensagem desatualizada | Ruído em CI; guard ok |

---

## 11. Limitações da auditoria

- Sem leitura do banco oficial → sem NSU/config atuais das 3 empresas.
- Sem SOAP real → sem prova de 137/138/656 em produção nesta data.
- Sem alterar flags/NSU/cooldown de produção.
- Valores históricos de NSU não revalidados.

---

## 12. Critérios de aceitação (checklist)

- [x] Localização do mecanismo de sync automática  
- [x] Condições para execução  
- [x] Como as três empresas seriam processadas (código; estado atual não lido)  
- [x] Bloqueios/config (flag, auth, cooldown, gate, horário)  
- [x] Fluxo consulta → persistência → NSU  
- [x] Auditoria 137 / 138 / 656  
- [x] Testes isolados executados  
- [x] Problemas + prioridade  
- [x] O que está comprovado vs o que exige validação operacional  

---

## 13. Veredito final

### **APROVADO COM RESSALVAS**

**Comprovado pelo código**

- Timer e boot (`CentralSyncBackgroundService` + Grupo B).  
- Loop por empresa com `empresaId` explícito; sem fallback global em MULTIEMPRESA.  
- 656 não avança NSU; 137/138 avançam só após persistência.  
- Barreira: DistDFe sem autorização não chama SOAP.

**Comprovado por testes isolados**

- Preservação de cursor 656, isolamento 137/138, cooldown, barreira P0.8, smoke de background.

**Comprovado por registros históricos (só referência)**

- NSUs 196/196, 45/45, 35/0 — não revalidados.

**Não comprovado sem execução operacional autorizada**

- Flag sync ligada no cliente.  
- Ciclos BACKGROUND realmente trazendo NF-e (hoje o caminho SOAP real autorizado é OPERACAO_REAL).  
- Estado atual de NSU/cooldown/certificado das 3 empresas.

---

## 14. Recomendação para a próxima sprint

1. **Validação operacional autorizada (leitura):** com procedimento seguro, inspecionar `sync_automatica_habilitada`, NSU/cooldown por CNPJ das 3 empresas e últimos eventos `BLOQUEADA_AUTORIZACAO` / `BACKGROUND *` — **sem** SOAP e sem mutar NSU.  
2. **Decisão de produto:** sync automática DistDFe deve (a) permanecer desligada e usar só `consultar-dfe` OPERACAO_REAL, ou (b) emitir autorização controlada por ciclo BACKGROUND por empresa (escopo de sprint de implementação, não desta auditoria).  
3. **Correções mínimas candidatas (após aprovação):** remover swallow do Gate; alinhar mensagens do teste do guardião; unificar diagnóstico de cooldown NSU/Gate.  
4. **Fora de escopo (mantido):** recuperação histórica por chave, reprocessar intervalos de NSU, zerar cursores.

---

*Fim do relatório P0.9 — auditoria sincronização automática.*

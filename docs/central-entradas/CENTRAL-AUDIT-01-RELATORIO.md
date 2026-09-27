# CENTRAL-AUDIT-01 — Auditoria profunda da Central de Entradas

**Modo:** SOMENTE LEITURA
**Data:** 27/09/2026
**Banco auditado:** `C:\ProgramData\MercantilFiscal\dados\mercadao.db`, aberto com `OPEN_READONLY` e apenas `SELECT`.

Nesta auditoria **nada foi alterado**: código, banco, configuração, ambiente, scheduler, filas e testes ficaram intactos. Também não houve envio de manifestação, consulta à SEFAZ nem reprocessamento. Os horários do banco (`created_at`) estão em **UTC**; a hora local é UTC−3.

---

## 1. Resumo executivo

A Central **opera em PRODUÇÃO** para as três empresas. A evidência:
- cursores NSU com `ambiente=1` para os três CNPJs;
- eventos enviados ao endpoint de produção do Ambiente Nacional (`www.nfe.fazenda.gov.br/NFeRecepcaoEvento4`);
- o motor de recuperação registrando `ambiente:1`.

O **"Homologação"** exibido na tela da Central vem de um **leitor global** (`configuracoes.fiscal_ambiente='2'`). Esse leitor não participa das chamadas SOAP das empresas. Portanto a tela de Empresas está correta e o painel da Central está errado. As chamadas reais estão corretas enquanto a configuração de cada empresa estiver completa.

O problema operacional grave é outro: **a ciência automática não chega às notas novas**.
- A seleção de candidatos pega os 10 documentos `RESUMO_RECEBIDO` mais antigos, **de todas as empresas juntas**.
- Esses 10 são sempre as mesmas notas de agosto, que já receberam 596 (prazo expirado).
- A cada sincronização, inclusive a disparada ao abrir a tela, essas 10 notas geram um `consChNFe`. Isso consome a cota e provoca **656 (Consumo Indevido)**.
- As 18 notas novas, incluindo a NF 1315265, **nunca foram manifestadas**. O prazo de ciência das notas emitidas em 17/09 está vencendo agora.

Problemas encontrados: **19**. Por severidade: **3 críticos, 6 altos, 7 médios, 3 baixos** (seção 25).

## 2. Arquitetura

| Camada | Componente | Arquivo |
|---|---|---|
| Rotas | `/api/central-entradas/*` (sincronizar, sincronizar-ao-abrir, buscar-chave, ciclo-dfe, solicitar-xml-completo, configuracao, diagnostico) | `backend/rotas/central-entradas.js` |
| Orquestração | `CentralEntradasOrchestrator.executarSincronizacao` (448) → `processarCandidatos` pós-sync (469) | `services/CentralEntradasOrchestrator.js` |
| Sincronização DF-e | `CentralSyncExecucaoService` → `CentralSincronizacaoService._sincronizarEmpresa` (63–72) → `sincronizarDistribuicaoDFe` | `services/`, `backend/services/fiscal/distribuicaoDFe.js` |
| Manifestação | `CentralManifestacaoDfeService` (`processarCandidatos` 194–252, `processarDocumento` 254–459, `_enviarCiencia` 461+, `_resolverAposEvento596` 1179+) | `services/CentralManifestacaoDfeService.js` |
| Contexto fiscal | `CentralConfiguracaoService.obterContextoOperacional` (256–390), `_obterSnapshotFiscal` (562–572), `_obterVisaoCertificado` (753–835); `resolverContextoDocumentoCentral` (60–95) | `services/` |
| Scheduler DF-e | `CentralSyncBackgroundService` (`iniciar` 81–153, `parar` 155+, ciclo 290–372) | `services/CentralSyncBackgroundService.js` |
| XML Wait / MIRX | `CentralXmlWaitScheduler` (fachada), `MirxService`, `MirxWorker` (→ `processarCicloDfeDocumento` com `modoRecuperacaoXml`) | `services/`, `mirx/` |
| Motor de recuperação XML (RC3.7.5) | `MotorRecuperacaoXmlService` (`executarCiclo`, ordenação 347–358, `_consultarDocumento` 461+) | `recuperacao-xml/` |
| Gate SEFAZ | `CentralSefazOperationalGate` (fingerprint global 80–120; estados NORMAL/WARNING/BLOCKED/RECOVERING/CONFIG_ERROR) | `services/` |
| Saúde | `CentralHealth` / `HealthRules` → `central_health_state` | `health/` |
| Endpoints | `RegistryBuilder` (constantes fixas; DFE 77–81, AN_RECEPCAO_EVENTO 73–76), resolvidos por `FiscalWebServices`/`UrlResolver` | `backend/services/fiscal/core/` |

## 3. Fluxo real (reconstruído a partir dos eventos)

1. O operador abre a Central, o que dispara `POST /sincronizar-ao-abrir` (`sync_ao_abrir=true`).
2. `executarSincronizacao` percorre as empresas-alvo e faz distNSU por CNPJ, com `ambiente` e certificado de cada empresa.
3. Os documentos novos são gravados como `RESUMO_RECEBIDO` (RES_NFE).
4. Em seguida, `processarCandidatos` roda com a política `AUTOMATICA_CIENCIA`, com `limite=10`, `created_at ASC` e sem filtro de empresa.
5. Cada candidato passa por `processarDocumento`:
   - sem evento anterior: ciência 210210;
   - com 596 já registrado: `_resolverAposEvento596`, que faz `consChNFe`.
6. Em paralelo, independentes da sincronização, rodam o motor de recuperação (a cada 60 min, lote de 5) e o MIRX.

## 4. Matriz por empresa

| id | CNPJ (banco) | Nome | IE | Ambiente (empresa) | Certificado | ultNSU prod |
|---|---|---|---|---|---|---|
| 1 | 38.204.469/0001-15 | PASTELARIA DO CHEFF - Matriz | 061672793 | 1 (Produção) | `certificado-empresa-1.pfx` (existe, 9.554 B, sha256 85ad72aa…) | 118 |
| 2 | 38.204.469/**0003-87** | Filial 2 | 072532793 | 1 (Produção) | `certificado-empresa-2.pfx` (existe, 9.546 B, sha256 83e23c06…) | 21 |
| 3 | 38.204.469/**0002-04** | Filial 3 | 072405309 | 1 (Produção) | `certificado-empresa-3.pfx` (existe, 9.546 B, sha256 df1630e4…) | 15 |

**Divergência:** o enunciado da auditoria diz que a empresa 2 é 0002-04 e a empresa 3 é 0003-87. O banco diz o contrário. O sistema usa o CNPJ do banco de forma consistente: NSU, consultas e eventos batem com esse mapeamento.

## 5. Origem do ambiente (todos os pontos que definem ou sobrescrevem)

| Ponto | Arquivo:linha | Efeito |
|---|---|---|
| `empresas_configuracao_fiscal.ambiente` | `empresasConfiguracaoFiscal.js` `montarConfigEmpresa` 193–197 | **Fonte das chamadas SOAP por empresa** (valor 1) |
| `configuracoes.fiscal_ambiente` | semeado em `database.js` 3071/3116 (`'2'`) e lido por `configService.getFiscalConfig()` 98–153 | **Fonte do painel**; também é fallback |
| Fallback empresa → global | `CentralConfiguracaoService.js` 262 (`permitirFallbackGlobal` padrão `true`) e 306–309 | Usado em EMPRESA_SIMPLES e por chamadores que não passam `empresaId` |
| Documento sem `empresa_id` | `resolverContextoDocumentoCentral.js` 69–74 | Sempre global, em qualquer modo |
| Normalização | `CentralConfiguracaoService.js` 579–582; `distribuicaoDFe.js` 495/832; `CentralManifestacaoDfeService.js` 483/745 | Qualquer valor diferente de 1 vira 2 |
| Padrão do painel em erro | `CentralConfiguracaoService.js` 570 (`{ambiente:2,...}`) | Só exibição |
| Padrões dos runtimes | `distribuicaoDfeRuntime.js` 346–348; `manifestacaoRuntime.js` 306; `manifestacaoLegado.js` 33/57 | Homologação apenas quando a entrada é inválida |
| Diagnóstico "testar SEFAZ" | `CentralDiagnosticoService.js` 186, 219–240 | **Envia um distNSU real** com ambiente, certificado e CNPJ **globais** |
| `sefaz_url_*` em `central_entradas_config` | `CentralConfiguracaoService.js` 374–375 | Vazias e não lidas (código morto) |
| Variáveis de ambiente | nenhuma `process.env` define ambiente ou SEFAZ em `backend/**` | — |

## 6. Produção × Homologação

| Onde | Valor | Fonte |
|---|---|---|
| Tela Empresas → Configuração Fiscal | Produção (1) para as 3 | `empresas_configuracao_fiscal` |
| Painel da Central, "AMBIENTE (SOMENTE LEITURA)" / "SEFAZ" | **Homologação** | `configuracoes.fiscal_ambiente='2'` (atualizado em 20/08/2026) via `_obterSnapshotFiscal` → `getFiscalConfig()` **sem empresaId**. O rótulo fixo diz "Centro de Configurações (fonte oficial)" |
| distNSU real | Produção | `central_entradas_nsu` linhas 4–6, `ambiente=1`, cStat 138 em 27/09 17:29 |
| Evento 210210 real | Produção | endpoint `https://www.nfe.fazenda.gov.br/NFeRecepcaoEvento4/NFeRecepcaoEvento4.asmx` nos eventos de 27/09 |
| consChNFe do motor | Produção | `ambiente:1` nos detalhes dos eventos |

**Causa da divergência:** o painel lê a configuração global. As operações leem a configuração da empresa. A configuração global continua com '2', CNPJ vazio e um certificado próprio (`certificado.pfx`, 3.671 B, sha256 47ecec96…, arquivo diferente dos três PFX das empresas).

## 7. DF-e (distNSU)

- O cursor é mantido por CNPJ + ambiente (`nsuService.obterOuCriar(cnpj, ambiente)`). As linhas 1–3 (ambiente 2, NSU 0) são resíduo antigo e não são usadas.
- Em MULTIEMPRESA, `permitirFallbackGlobal=false`: uma empresa com configuração incompleta é pulada, sem cair para o global. Em EMPRESA_SIMPLES o fallback é `true`.
- Na sincronização de 27/09 17:29:16–20 chegaram 18 `DOCUMENTO_RECEBIDO` (docs 110–127). Os docs 31–39 passaram a `XML_COMPLETO` via PROC_NFE.
- **Ramo morto:** `distribuicaoDFe.js` 497–499 (sem `contextoCentral`) usa o global com padrão 2. Só é alcançável por `distribuirDocumentosRecebidos`, sem chamadores fora de testes.

## 8. Manifestação (respostas às perguntas 1–15)

1. **A política está automática?** Sim: `manifestacao_destinatario_politica=AUTOMATICA_CIENCIA`. Ciências foram enviadas às 17:29:24. O evento 1963 (`CONFIG_ALTERADA`, 17:30:19, campos `["sefaz"]`) é posterior e não mudou a política efetiva.
2. **Quem dispara a ciência automática?** Três caminhos:
   - `processarCandidatos`, ao fim de cada sincronização (`Orchestrator` 469);
   - o motor de recuperação (`MotorRecuperacaoXmlService` 499–515);
   - a rota manual `POST /:id/ciclo-dfe`.
3. **Critério de seleção:** `listarPorStatus('RESUMO_RECEBIDO', 10)`, que chama `listar({ordenarPor:'created_at', ordenarDirecao:'ASC'})` (`CentralDocumentosRepository.js` 670–672). **É global (todas as empresas), limitado a 10, dos mais antigos para os mais novos.** O filtro `RES_NFE` é aplicado **depois** do limite (219–221).
4. **Quais documentos são selecionados hoje?** Os 10 mais antigos: docs 45–54, todos da empresa 1, criados em 15/09 16:05 e emitidos em agosto. Os docs 45–50 já têm 596 registrado.
5. **Documento com 596 sai da lista?** **Não.** Continua `RESUMO_RECEBIDO` e volta a ser candidato em toda sincronização.
6. **O que acontece com ele?** `_resolverAposEvento596` (1179–1249) executa `consChNFe` **sem checar `proximaConsultaEm`**. Só encerra com cStat 137. Com 138 (só resumo) ou 656, devolve `encerrado:false`.
7. **Quantas vezes isso ocorreu?** Docs 47–50: 9 `consChNFe` cada desde 17/09. Docs 45, 46 e 75–78: 4 cada, somente em 27/09.
8. **Isso causou 656?** Sim. Às 17:33 e às 17:47 as mesmas 10 notas foram reconsultadas e retornaram 656 ("Ultrapassou o limite de 20 consultas por hora").
9. **As 18 notas novas foram manifestadas?** **Não.** Nenhum `CIENCIA_ENVIADA` para os docs 110–127.
10. **Por quê?** Starvation: elas nunca entram nos 10 primeiros (P01). O motor de recuperação também não chega a elas (P07).
11. **O endpoint e o tpAmb estavam corretos?** Sim: produção AN, `cOrgao=91`, CNPJ e certificado da empresa do documento (empresa 1).
12. **A ciência respeita a política no motor?** **Não.** O motor chama `processarDocumento(id, {confirmado:true})` (511–515), o que envia ciência mesmo com a política MANUAL ou CONFIRMAR_OPERADOR (P08).
13. **Há proteção contra envio duplicado?** Sim: `_emExecucao` (Set em memória) e `_reclamarManifestacao` (claim), e `CIENCIA_ENVIADA` tem uma ocorrência por documento.
14. **O 596 é tratado como definitivo?** Não. O código só encerra com 137 após o `consChNFe` (P02).
15. **Existe teste do cenário real (mais de 10 candidatos, os primeiros com 596)?** Não. `processarCandidatos` aparece apenas em `rc33-fechamento-ciclo-dfe.test.js` (3 referências), sem esse cenário.

## 9. XML Wait / MIRX

- **O XML Wait desliga quando o scheduler DF-e está manual?** **Não.** `CentralSyncBackgroundService.iniciar()` (105–128) inicia o XML Wait e o motor de recuperação **antes** de checar `syncAutomaticaHabilitada()` (130). A evidência de que o MIRX segue ativo: `mirx_scheduler_state.atualizadoEm = 2026-09-27T18:23:04Z`, com `sync_automatica_habilitada=false`.
- **Exceção:** quando a flag é desligada **com o timer em andamento** (ciclo 292–307 e 363–369), `parar({pararXmlWait:false})` preserva o XML Wait, mas **para o motor de recuperação sempre** (178–181, incondicional) (P10). O motor só volta com um novo `iniciar()` (restart ou reinicialização do background).
- **MIRX:** 49 documentos, todos em `AGUARDANDO_JANELA_SEFAZ` (IDs 45–102, antigos). **Nenhuma das 18 notas novas está no MIRX.** Às 17:32 o MIRX recuperou os docs 31–39 via DistDFe.
- **Motor de recuperação:** 101 documentos monitorados. Docs 110–127 com `tentativas=0` e `motivo=monitoramento_ativo` desde 17:29:28. `proximaExecucao` às 18:30:44. As métricas acumuladas (`consultas 530, falhas 500, timeouts 10`) são históricas.
- **Inconsistência:** `ultimaExecucao` persistida é 2026-08-11, embora houvesse ciclos em 27/09 (P17).

## 10. Schedulers / workers (separados)

| Scheduler | Liga/desliga | Estado encontrado | Depende do scheduler DF-e? |
|---|---|---|---|
| Sync DF-e periódico (`CentralSyncBackgroundService`) | `sync_automatica_habilitada` | **Desligado** (Manual). Intervalo configurado de 15 min, sem efeito | — |
| Sync ao abrir a tela | `sync_ao_abrir=true` | **Ativo**: disparou às 17:29, 17:33 e 17:47 | Não |
| Ciência automática pós-sync | política `AUTOMATICA_CIENCIA` | Roda a cada sync, inclusive a disparada ao abrir a tela | Roda a cada sync |
| XML Wait / MIRX | módulo habilitado | Ativo (18:23) | Não |
| Motor de recuperação XML | `ativa=true`, intervalo 60 min, lote 5 | Ativo; próxima execução 18:30 | Não, exceto P10 |
| Health | `central-health` (server.js 405) | Gerado às 18:19 | Não |

**Consequência:** com o scheduler "Manual", **abrir a Central gera tráfego SEFAZ**. Cada abertura dispara distNSU e mais 10 `consChNFe` do loop 596.

## 11. Filas

- **Fila de ciência:** não é persistida. É recalculada por consulta a cada sincronização, com o viés do P01.
- **Fila do motor:** `recuperacao_xml_scheduler_state.docs` (101 documentos). A ordenação (347–358) coloca `XML_INDISPONIVEL` sempre primeiro, depois menos tentativas, depois empresa, depois id. Os 16 documentos `XML_INDISPONIVEL` monopolizam o lote de 5 por hora; o ciclo de 27/09 consultou os docs 4, 5, 6 e 15–19 (P07).
- **MIRX:** `mirx_scheduler_state.documentos` (49).

## 12. Locks

- **Motor de recuperação:** `_cicloEmExecucao` é marcado antes do primeiro `await` (corrigido na CENTRAL-ENTRADAS-03).
- **Manifestação:** `_emExecucao` é um Set **por instância**. O motor cria uma **nova instância** de `CentralManifestacaoDfeService` (503–509), então o Set não protege entre o motor e a sincronização. O claim persistido (`_reclamarManifestacao`) cobre apenas a ciência; **não cobre o `consChNFe`** (P11).
- **Background:** `_cicloEmExecucao` em `CentralSyncBackgroundService`.

## 13. Retries

- **Ciência rejeitada (não 596):** bloqueio de 1 h (`_obterBloqueioRejeicao`, 376–385).
- **596:** retry infinito de `consChNFe` a cada chamada, sem backoff (P02).
- **Consulta pós-manifestação:** respeita `proximaConsultaEm` (431–452), **mas esse caminho não é atingido** para documentos com 596.
- **Motor:** limitado por `maxTentativas` e `maxDiasMonitoramento` (432–455).

## 14. Saúde (health)

- **`central_health_state` (18:19Z):** 18 saudáveis, 83 em atenção, 1 crítico, 0 bloqueados, 6 resolvidos.
- **O único crítico** é o doc 109, "Distribuidora Teste Ltda", fixture de testes de certificação (`MIIP_SEM_COMPRA`) (P05).
- **Estados de scheduler exigidos pela auditoria** (ATIVO / DESATIVADO POR CONFIGURAÇÃO / PARADO / ERRO / COOLDOWN / AGUARDANDO JANELA / SEM TRABALHO): **não existe um modelo unificado.**
  - O Gate usa NORMAL/WARNING/BLOCKED/RECOVERING/CONFIG_ERROR.
  - O MIRX usa `AGUARDANDO_JANELA_SEFAZ`.
  - O background só registra logs (`BACKGROUND SLEEP`, `motivo`).
  - Não há como distinguir "desativado por configuração" de "parado por falha", como no caso do P10 (P12).
- **O Gate está em `WARNING`,** com o último registro em 17/09, e **não reflete os 656 de hoje** (P03).

## 15. Status dos documentos

| Empresa | RESUMO_RECEBIDO | XML_INDISPONIVEL | EM_REVISAO | CANCELADA |
|---|---|---|---|---|
| 1 | 71 | 0 | 5 | 1 |
| 2 | 5 | 12 | 2 | 0 |
| 3 | 3 | 4 | 4 | 0 |
| sem empresa | docs 107/108 `IMPORTADA` (upload_manual, "Fornecedor Teste Sprint 2", chave duplicada); doc 109 `PRONTA_IMPORTACAO` (origem release-cert) | | | |

**Semântica:** `AGUARDANDO_XML_COMPLETO` é apenas um alias de `RESUMO_RECEBIDO` (`DocumentoFiscalStatus.js` 33/90). Com isso, "sem ciência", "ciência aceita aguardando XML" e "596 (prazo perdido)" ficam **no mesmo status** (P06). A UI mostra "Recuperação automática do XML agendada" para todos eles (`centralDocumentalInteligente.js` 26), o que é enganoso para documentos sem ciência ou com 596.

## 16. NF 1315265 — chave 23260907196033002141550090013152651839613616

| Item | Valor |
|---|---|
| Documento | id 120, empresa 1 (Matriz 38.204.469/0001-15) |
| Emitente | NORSA REFRIGERANTES, 07.196.033/0021-41 |
| Modelo / série / número | 55 / 9 / 1315265 |
| Emissão / valor | 24/09/2026 / R$ 1.316,67 |
| Origem | DF-e, NSU 000000000000118, RES_NFE |
| XML | apenas resNFe (528 bytes), gravado em 27/09 17:29:17 |
| Status | `RESUMO_RECEBIDO` — "Resumo DF-e recebido. Aguardando XML completo." |
| Eventos | `DOCUMENTO_RECEBIDO` 17:29:17 → `RECUPERACAO_XML_ENTROU_FILA` 17:29:28 → `CHAVE_COPIADA` 17:34:43 |
| Histórico | apenas null → `RESUMO_RECEBIDO` |
| Ciência / manifestação / consChNFe | **Nenhuma** |
| Motor | `tentativas=0`, `monitoramento_ativo` |
| Prazo | dentro da janela de ciência (vence por volta de 04/10, contando 10 dias como no 596 observado) |

**Por que não foi manifestada:** starvation na seleção pós-sync (P01) e na fila do motor (P07). Não há erro de ambiente, certificado ou CNPJ neste documento.

## 17. As 18 novas notas

Nenhuma tem ciência ou manifestação. Todas estão em `RESUMO_RECEBIDO`/RES_NFE e na fila do motor com zero tentativas. A notificação 127 ("18 novas notas fiscais foram recebidas") é **global** (`documento_id` null, sem empresa) (P13).

| Empresa | Docs | NF/série — emissão | Prazo de ciência (10 dias, conforme 596) |
|---|---|---|---|
| 1 | 110–114 | 543970/1, 185169/1, 16911/1, 520828/8, 520829/8 — 17/09 | **vencendo em 27/09 (hoje)** |
| 1 | 115 | 10872/1 — 18/09 | 28/09 |
| 1 | 116 | 7267/1 — 19/09 | 29/09 |
| 1 | 117 | 3339/1 — 22/09 | 02/10 |
| 1 | 118 | 35064/1 — 23/09 | 03/10 |
| 1 | 119, 120 | 185522/1, **1315265/9** — 24/09 | 04/10 |
| 2 | 121 | 38774/2 — 22/09 | 02/10 |
| 2 | 122–124 | 544579/1, 254581/300, 185527/1 — 24/09 | 04/10 |
| 3 | 125 | 226/1 — 17/09 | **vencendo em 27/09 (hoje)** |
| 3 | 126 | 10920/1 — 18/09 | 28/09 |
| 3 | 127 | 4435/1 — 23/09 | 03/10 |

A data exata de referência do prazo (data de emissão ou de autorização) deve ser confirmada. A mensagem SEFAZ observada diz apenas "[10 dias]".

## 18. Multiempresa

- **Sincronização:** itera as empresas com o contexto de cada uma (correto).
- **Manifestação e consChNFe:** usam o `empresa_id` do documento (correto nos casos observados).
- **Pontos globais que violam o isolamento:**
  - seleção de candidatos (P01);
  - painel de ambiente e certificado (P04, P09);
  - Gate de 656/593 (P03, P14);
  - notificação de novas notas (P13);
  - diagnóstico "testar SEFAZ" (P15);
  - documentos sem `empresa_id`, que caem no global (P05).

## 19. Certificados

| Empresa | Caminho | Existe | Tamanho | mtime | sha256 (16 primeiros) | Senha |
|---|---|---|---|---|---|---|
| 1 | `…\fiscal\certificados\certificado-empresa-1.pfx` | sim | 9.554 | 15/09/2026 | 85ad72aaf973c0d9 | preenchida (**texto puro no banco**) |
| 2 | `…\certificado-empresa-2.pfx` | sim | 9.546 | 26/08/2026 | 83e23c067fe6c06c | preenchida (texto puro) |
| 3 | `…\certificado-empresa-3.pfx` | sim | 9.546 | 26/08/2026 | df1630e49c2283ee | preenchida (texto puro) |
| global | `…\certificado.pfx` | sim | 3.671 | 18/08/2026 | 47ecec9680ec2c25 | preenchida; CNPJ global vazio |

- **Os certificados não são compartilhados:** são três arquivos distintos.
- **Subject, issuer, validade, fingerprint e CNPJ interno dos PFX: NÃO VERIFICADOS.** A leitura exige abrir o PFX com a senha armazenada, e esse procedimento foi bloqueado durante a auditoria por envolver material secreto.
- **Evidência indireta de CNPJ compatível:** a SEFAZ de produção aceitou distNSU (138) para os três CNPJs e processou eventos da empresa 1 (135 em 17/09 e 596 por prazo em 27/09), sem nenhum 593 registrado.
- **Achados:** a senha fica em texto puro em `empresas_configuracao_fiscal.certificado_senha` (P16). O painel da Central só enxerga o certificado global (P09).

## 20. Endpoints SEFAZ

| Operação | Produção | Homologação | Usado em 27/09 |
|---|---|---|---|
| NFeDistribuicaoDFe | `www1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx` | `hom1.nfe.fazenda.gov.br/...` | Produção |
| NFeRecepcaoEvento4 (AN) | `www.nfe.fazenda.gov.br/NFeRecepcaoEvento4/NFeRecepcaoEvento4.asmx` | `hom1.nfe.fazenda.gov.br/...` | Produção |

- As URLs são fixas em `RegistryBuilder.js`; o único override é `context.override`, que a Central não usa. As chaves `sefaz_url_*` estão vazias e não são lidas.
- **Fora da Central:** as colunas legadas `ws_autorizacao`/`ws_retorno` em `empresas_configuracao_fiscal` contêm **URLs de NFC-e de homologação**, apesar de `ambiente=1` (P18). O `configuracoes` global também guarda um token CSC em texto puro, que não é reproduzido aqui.

## 21. Banco

- **Tabelas envolvidas:** `central_entradas_documentos`, `central_entradas_eventos` (`detalhe_json`), `central_entradas_historico`, `central_entradas_nsu`, `central_entradas_config` (flags e estados serializados), `empresas`, `empresas_configuracao_fiscal`, `configuracoes`.
- **Estados operacionais:** ficam em blobs JSON dentro de `central_entradas_config` (`mirx_scheduler_state`, `recuperacao_xml_scheduler_state`, `xml_wait_scheduler_state`, `central_health_state`).
- **Resíduos:** linhas NSU 1–3 (ambiente 2) e fixtures de teste 107–109 **no banco oficial** (P05).

## 22. Restart e reidratação

- **Motor, MIRX e Gate:** o estado é recarregado do banco (`_carregarEstado`). Os documentos continuam na fila.
- **Background:** `iniciar()` chama `hidratarFlags()` e depois `parar()` antes de reiniciar. Como o XML Wait e o motor são iniciados antes da checagem da flag de sync, voltam após o restart.
- **Não persistidos:** `_emExecucao` da manifestação, `_cicloEmExecucao` e o cooldown local de consulta. Após um restart, apenas eventos e blobs garantem a continuidade.
- **Após restart, o loop 596 continua:** o próximo "sync ao abrir" reconsulta os mesmos 10 documentos.

## 23. Testes existentes

| Item | Quantidade |
|---|---|
| Arquivos em `tests/central-entradas` | 78 |
| Passam (última execução, CENTRAL-ENTRADAS-03) | 49 |
| Falham | 29, **todas pré-existentes**: falham igual com as alterações da sprint revertidas (lista na seção 7 do relatório CENTRAL-ENTRADAS-03) |

Essa execução não foi repetida aqui para não abrir conexões de escrita.

**Cobertura real de produção:** nenhuma suíte chama a SEFAZ (correto). **Sem cobertura:**
- starvation com mais de 10 candidatos (P01);
- loop 596 × `proximaConsultaEm` (P02);
- 656 no caminho de manifestação alimentando o Gate (P03);
- ambiente do painel por empresa (P04);
- motor ignorando a política (P08);
- `parar()` derrubando o motor (P10).

A suíte `auditoria-leitores-globais-05-73`, que deveria detectar leitores globais, está entre as que falham.

## 24. Legado e duplicado

- `distribuicaoDFe.js` 497–499 e 834–835: ramos sem contexto (globais, padrão 2), alcançáveis apenas por funções sem chamadores.
- `backend/rotas/dfe.js` só devolve 410.
- `manifestacaoLegado.getManifestacaoUrl` tem fallback para homologação; a Central rejeita respostas vindas desse fallback (501–542).
- `CentralImportacaoXmlLegadoService.js` 247 usa o contexto global para obter o CNPJ.
- `contexto.urls.consultaChave`/`manifestacao` (374–375) são mortos.
- **Defeito latente:** `distribuicaoDFe.js` usa `empresaIdPersistencia` na linha 288 antes da declaração `const` (347). Isso gera um `ReferenceError`, engolido pelo `try` da linha 304. Consequência provável: eventos de cancelamento 110111/110112 recebidos via DistDFe não são aplicados (P19). Identificado pela leitura do código, não executado.

## 25. Problemas

Todos os caminhos de arquivo são relativos a `backend/motores/central-entradas/`, exceto quando indicado.

### P01 — Starvation na seleção da ciência automática
- **Severidade:** CRÍTICO
- **Local:** `services/CentralManifestacaoDfeService.js` `processarCandidatos`, 211–221; `repositories/CentralDocumentosRepository.js` `listarPorStatus`, 670–672
- **Causa:** seleciona os 10 `RESUMO_RECEBIDO` mais antigos, globalmente, sem excluir documentos com 596, com ciência aceita ou com prazo vencido. O filtro RES_NFE é aplicado depois do limite.
- **Impacto:** notas novas de todas as empresas **nunca recebem ciência**. O prazo de 10 dias vence e o XML completo não é liberado.
- **Evidência:** as 18 notas novas estão sem ciência; os 10 selecionados são os docs 45–54 (15/09).
- **Como reproduzir:** banco com mais de 10 RES_NFE antigos com 596 e 1 novo; rodar `processarCandidatos`; o novo não é processado.
- **Correção proposta:** excluir documentos com 596, com ciência aceita ou com prazo vencido; priorizar os que estão dentro do prazo (os mais novos primeiro), com limite por empresa; aplicar o filtro de tipo na consulta SQL.

### P02 — Loop de consChNFe após 596
- **Severidade:** CRÍTICO
- **Local:** `CentralManifestacaoDfeService.js` `_resolverAposEvento596`, 1179–1249; chamada em 366–374
- **Causa:** não verifica `proximaConsultaEm` nem o Gate, e só encerra com 137. Documentos com 596 continuam `RESUMO_RECEBIDO`.
- **Impacto:** 10 `consChNFe` a cada sincronização ou abertura de tela, gerando **656** e prejudicando todas as consultas da empresa.
- **Evidência:** docs 47–50 com 9 consultas cada; 656 às 17:33 e 17:47.
- **Como reproduzir:** documento com `MANIFESTACAO_REJEITADA` 596; chamar `processarDocumento` duas vezes seguidas; ocorrem 2 `consChNFe`.
- **Correção proposta:** respeitar `proximaConsultaEm` e o Gate; após N tentativas sem XML, levar o documento a um status terminal próprio (por exemplo `XML_INDISPONIVEL`, com motivo "prazo de ciência expirado") e tirá-lo da lista de candidatos.

### P03 — 656 do caminho de manifestação não alimenta o Gate
- **Severidade:** CRÍTICO
- **Local:** `CentralManifestacaoDfeService.js` (sem referência ao Gate; 656 tratado localmente em 815–888); `backend/services/fiscal/distribuicaoDFe.js` (sem Gate)
- **Causa:** o cooldown de 656 só existe no Gate usado pelo MIRX e pelo motor.
- **Impacto:** o sistema continua consultando após 656 e prolonga o bloqueio da SEFAZ.
- **Evidência:** `xml_wait_scheduler_state`: `contador656=0`, `bloqueio656=null`, atualizado em 17/09, apesar dos 656 de 27/09.
- **Como reproduzir:** simular um `consChNFe` com retorno 656 via `_resolverAposEvento596`; o estado do Gate fica inalterado.
- **Correção proposta:** registrar todo cStat SOAP no Gate (por CNPJ) e consultá-lo antes de qualquer `consChNFe` ou distNSU.

### P04 — Painel mostra o ambiente global ("Homologação")
- **Severidade:** ALTO
- **Local:** `services/CentralConfiguracaoService.js` `_obterSnapshotFiscal`, 562–572; `_ambienteDeFiscal`, 579–582; frontend `frontend/erp/js/central-entradas.js` (~2135–2186, 2206–2211, 2382, 2445–2478)
- **Causa:** `getFiscalConfig()` é chamado sem `empresaId` e lê `configuracoes.fiscal_ambiente='2'`. O rótulo "fonte oficial" é fixo.
- **Impacto:** o operador vê Homologação enquanto a Central opera em Produção, o que induz decisões erradas.
- **Evidência:** configuração global `'2'` contra `ambiente=1` nas empresas e endpoints de produção nos eventos.
- **Como reproduzir:** abrir a Central com as empresas em ambiente 1 e o global em 2.
- **Correção proposta:** o painel deve exibir o ambiente **por empresa**, pela mesma fonte das operações (`obterContextoOperacional({empresaId, permitirFallbackGlobal:false})`), com a origem real. Se houver divergência entre as empresas, sinalizar.

### P05 — Fixtures de teste e documentos sem empresa no banco oficial
- **Severidade:** ALTO
- **Local:** dados (docs 107, 108, 109); `services/resolverContextoDocumentoCentral.js` 69–74
- **Causa:** testes rodaram contra o banco oficial em algum momento. Documentos sem `empresa_id` usam o contexto global.
- **Impacto:** Health "Crítico" falso (doc 109); qualquer ação SEFAZ sobre esses documentos usa ambiente 2 e o certificado global.
- **Evidência:** `empresa_id` NULL, "Fornecedor Teste Sprint 2", origem release-cert.
- **Como reproduzir:** consultar `central_entradas_documentos WHERE empresa_id IS NULL`.
- **Correção proposta:** saneamento controlado e autorizado (não nesta etapa); bloquear operações SEFAZ para documentos sem empresa; isolar o banco nos testes (`DB_DIR` temporário).

### P06 — Status único para situações distintas
- **Severidade:** ALTO
- **Local:** `core/DocumentoFiscalStatus.js` 33/90; `utils/centralDocumentalInteligente.js` 26
- **Causa:** `AGUARDANDO_XML_COMPLETO` é um alias de `RESUMO_RECEBIDO`.
- **Impacto:** "sem ciência", "aguardando XML após ciência" e "596" aparecem iguais na UI ("Recuperação automática agendada") e na seleção.
- **Evidência:** os 10 documentos com 596 continuam `RESUMO_RECEBIDO`.
- **Como reproduzir:** comparar o status do doc 45 (596) com o do doc 120 (sem ciência).
- **Correção proposta:** um sub-estado de manifestação derivado dos eventos (SEM_CIENCIA / CIENCIA_ACEITA / PRAZO_EXPIRADO) usado na seleção e na UI, sem migration nesta etapa.

### P07 — Starvation na fila do motor de recuperação
- **Severidade:** ALTO
- **Local:** `recuperacao-xml/MotorRecuperacaoXmlService.js` `executarCiclo`, ordenação 347–358; lote na 360
- **Causa:** `XML_INDISPONIVEL` sempre vem antes de `RESUMO_RECEBIDO`, independentemente das tentativas. O lote é de 5 por hora.
- **Impacto:** os documentos em `RESUMO_RECEBIDO` (entre eles as 18 notas novas) só seriam atendidos depois que os 16 `XML_INDISPONIVEL` esgotassem as tentativas. O prazo de ciência vence antes.
- **Evidência:** o ciclo de 27/09 consultou os docs 4–6 e 15–19; os docs 110–127 estão com `tentativas=0`.
- **Como reproduzir:** fila com mais de 5 `XML_INDISPONIVEL` e 1 RESUMO novo; o RESUMO não entra no lote.
- **Correção proposta:** priorizar documentos sem ciência e dentro do prazo; reservar vagas no lote por categoria e por empresa.

### P08 — Motor envia ciência ignorando a política
- **Severidade:** ALTO
- **Local:** `MotorRecuperacaoXmlService.js` `_consultarDocumento`, 499–515
- **Causa:** chama `processarDocumento` com `confirmado:true` sem ler a política.
- **Impacto:** com a política MANUAL ou CONFIRMAR_OPERADOR, o motor envia 210210 sem autorização.
- **Evidência:** leitura do código (`confirmado: true` fixo).
- **Como reproduzir:** política MANUAL e um RESUMO sem manifestação no lote do motor; o evento `CIENCIA_ENVIADA` é gerado.
- **Correção proposta:** o motor deve respeitar `obterPoliticaManifestacao()`.

### P09 — Painel do certificado é global
- **Severidade:** ALTO (somado ao P04, o painel inteiro exibe a identidade fiscal errada)
- **Local:** `CentralConfiguracaoService.js` `_obterVisaoCertificado`, 753–835; `certificadosFiliais`, 239–241
- **Causa:** `getFiscalConfig()` sem `empresaId`.
- **Impacto:** o painel mostra o `certificado.pfx` global (CNPJ vazio), não os três certificados em uso.
- **Evidência:** configuração global contra os três PFX distintos.
- **Como reproduzir:** abrir o painel de configuração da Central.
- **Correção proposta:** listar o certificado de cada empresa: validade, CNPJ e fingerprint, sem expor a senha.

### P10 — `parar({pararXmlWait:false})` derruba o motor de recuperação
- **Severidade:** MÉDIO
- **Local:** `services/CentralSyncBackgroundService.js` `parar`, 178–181; chamadas em 301–307 e 364–369
- **Causa:** a parada do motor é incondicional.
- **Impacto:** ao desligar a sync automática com o timer ativo, o motor para silenciosamente até o próximo restart.
- **Evidência:** leitura do código; o comentário na 300 diz "encerra apenas o loop DistDFe".
- **Como reproduzir:** ativar a sync automática e depois desligá-la durante o timer; o motor fica com `_ativo=false`.
- **Correção proposta:** a parada do motor deve obedecer ao mesmo flag do XML Wait.

### P11 — Locks não cobrem motor × sincronização no consChNFe
- **Severidade:** MÉDIO
- **Local:** `CentralManifestacaoDfeService.js` `_emExecucao`, 191/257; `MotorRecuperacaoXmlService.js` 503–509 (nova instância)
- **Causa:** o Set é mantido por instância.
- **Impacto:** o mesmo documento pode ser consultado ao mesmo tempo pelo motor e pela sincronização (consumo duplicado).
- **Evidência:** leitura do código.
- **Como reproduzir:** executar o ciclo do motor durante um "sync ao abrir" com o mesmo documento.
- **Correção proposta:** lock por documento em nível de módulo ou persistido.

### P12 — Não há estado semântico unificado dos schedulers
- **Severidade:** MÉDIO
- **Local:** `health/`, `services/CentralSyncBackgroundService.js`, `mirx/MirxEstados.js`, `services/CentralSefazOperationalGate.js`
- **Causa:** cada componente usa um vocabulário próprio.
- **Impacto:** não é possível distinguir DESATIVADO POR CONFIGURAÇÃO, PARADO, COOLDOWN e SEM TRABALHO.
- **Evidência:** estados distintos em cada blob e o caso do P10.
- **Como reproduzir:** comparar os blobs de estado de cada componente.
- **Correção proposta:** um contrato único de estado por scheduler, exposto no Health.

### P13 — Notificação de novas notas sem empresa
- **Severidade:** MÉDIO
- **Local:** geração da notificação pós-sync (notificação 127)
- **Causa:** agregado global, `documento_id` null.
- **Impacto:** o operador não sabe de qual empresa são as notas (11/4/3).
- **Evidência:** notificação 127.
- **Como reproduzir:** sincronizar com notas novas em mais de uma empresa.
- **Correção proposta:** notificação por empresa, ou com a quebra por empresa.

### P14 — Gate e fingerprint globais
- **Severidade:** MÉDIO
- **Local:** `CentralSefazOperationalGate.js` `fingerprintFiscalDetalhado`, 80–120
- **Causa:** `getFiscalConfig()` sem empresa, sobre o certificado global.
- **Impacto:** um 656 ou 593 de uma empresa bloqueia todas, e a detecção de troca de certificado observa o arquivo errado.
- **Evidência:** leitura do código; certificado global diferente dos três PFX.
- **Como reproduzir:** registrar 656 para a empresa 2 e observar o bloqueio da empresa 1.
- **Correção proposta:** estado do Gate por CNPJ, com o fingerprint do certificado da empresa.

### P15 — Diagnóstico "testar SEFAZ" usa o contexto global
- **Severidade:** MÉDIO
- **Local:** `services/CentralDiagnosticoService.js` 156, 186, 219–240
- **Causa:** chama sem `empresaId`; o `ultNSU` não é filtrado por CNPJ.
- **Impacto:** envia um distNSU **real** em homologação com o certificado e o CNPJ globais (vazio), e o resultado não diz nada sobre as empresas.
- **Evidência:** leitura do código.
- **Como reproduzir:** acionar o diagnóstico.
- **Correção proposta:** diagnóstico por empresa, com `permitirFallbackGlobal:false`.

### P16 — Senha do certificado em texto puro
- **Severidade:** BAIXO (segurança; fora do fluxo da Central)
- **Local:** `backend/services/fiscal/empresasConfiguracaoFiscal.js` 26/219; `configuracoes.fiscal_certificado_senha`
- **Causa:** armazenamento sem criptografia.
- **Impacto:** qualquer pessoa com leitura do banco obtém a senha dos PFX.
- **Evidência:** coluna `TEXT`, preenchida (valor não exibido).
- **Como reproduzir:** inspecionar o schema.
- **Correção proposta:** cofre de segredos, como o do MBC (`EncryptedLocalSecretStore`).

### P17 — Telemetria do motor inconsistente
- **Severidade:** BAIXO
- **Local:** `MotorRecuperacaoXmlService.js` (persistência de `ultimaExecucao` e `metricas.ciclos`)
- **Causa:** o estado persistido não reflete os ciclos executados.
- **Impacto:** o Health e a UI mostram uma última execução em 11/08.
- **Evidência:** `ultimaExecucao=2026-08-11`, `ciclos=1`, com eventos de ciclo em 27/09.
- **Como reproduzir:** comparar o blob com os eventos.
- **Correção proposta:** persistir o estado ao fim de cada ciclo.

### P18 — URLs de homologação nas colunas legadas `ws_*` das empresas
- **Severidade:** BAIXO (NFC-e, fora da Central)
- **Local:** `empresas_configuracao_fiscal.ws_autorizacao/ws_retorno`; `resolverUrlsEmpresa` (`usarLegado`)
- **Causa:** resíduo legado.
- **Impacto:** risco de emissão de NFC-e em homologação se o caminho legado for usado.
- **Evidência:** colunas preenchidas com `nfce-homologacao.svrs...` e `ambiente=1`.
- **Como reproduzir:** consultar as colunas.
- **Correção proposta:** auditar o `usarLegado` na trilha de emissão.

### P19 — `ReferenceError` latente no processamento de eventos DistDFe
- **Severidade:** MÉDIO
- **Local:** `backend/services/fiscal/distribuicaoDFe.js` 288 × 347 (catch na 304)
- **Causa:** a variável é usada antes da declaração `const`.
- **Impacto:** cancelamentos recebidos via DistDFe provavelmente não são aplicados.
- **Evidência:** leitura do código.
- **Como reproduzir:** teste unitário com um resEvento 110111.
- **Correção proposta:** declarar a variável antes do laço.

**Total por severidade:**

| Severidade | Qtde | Problemas |
|---|---|---|
| Crítico | 3 | P01, P02, P03 |
| Alto | 6 | P04, P05, P06, P07, P08, P09 |
| Médio | 7 | P10, P11, P12, P13, P14, P15, P19 |
| Baixo | 3 | P16, P17, P18 |
## 26. O que está correto

- Ambiente, certificado, CNPJ e endpoint **por empresa** nas chamadas SOAP de sincronização, manifestação e consChNFe (MULTIEMPRESA).
- NSU isolado por CNPJ + ambiente, com os três cursores de produção avançando.
- `tpAmb` e endpoint sempre coerentes; `cOrgao=91`; rejeição das respostas vindas do fallback legado.
- Claim contra ciência duplicada (uma `CIENCIA_ENVIADA` por documento).
- MIRX e motor independentes do scheduler DF-e manual.
- MIRX recuperando XML via DistDFe (docs 31–39).
- Três certificados distintos, todos existentes.

## 27. O que não está correto

- Painel de ambiente e certificado (global).
- Seleção da ciência (starvation global).
- Loop 596 → consChNFe → 656.
- Gate sem visibilidade dos 656 da manifestação.
- Fila do motor (starvation).
- Motor ignorando a política.
- Status ambíguo.
- Fixtures no banco oficial.
- Notificação global.
- Diagnóstico global.
- `parar()` derrubando o motor.

## 28. O que não deve ser alterado

- `empresas_configuracao_fiscal.ambiente=1` e os três PFX: estão corretos.
- `RegistryBuilder` (URLs oficiais).
- Os cursores NSU (linhas 4–6). As linhas 1–3 não devem ser reaproveitadas.
- O isolamento de contexto em `CentralSincronizacaoService._sincronizarEmpresa`.
- A regra "recuperação não remanifesta" (RC3.3.6).
- O claim de ciência.
- O lock do motor (CENTRAL-ENTRADAS-03).
- **Não alterar `configuracoes.fiscal_ambiente` para "corrigir" o painel.** A chave é usada pela emissão global de NFC-e; a correção é o painel ler por empresa.

## 29. Plano de correção (ordem recomendada, nada executado)

1. **Urgente (operacional, com autorização):** avaliar a ciência manual das notas dentro do prazo, começando pelas emitidas em 17–19/09 (docs 110–116, 125, 126) e depois as demais, incluindo o doc 120. É uma decisão do operador, fora desta auditoria.
2. **P02 + P03:** parar o loop 596 e ligar o 656 ao Gate. Isso elimina o consumo indevido.
3. **P01:** seleção de candidatos correta, dentro do prazo e por empresa.
4. **P07 + P08:** priorização e respeito à política no motor.
5. **P06:** sub-estado de manifestação na seleção e na UI.
6. **P04 + P09 + P15 + P14:** painel, diagnóstico e Gate por empresa.
7. **P10, P11, P12, P13, P17, P19.**
8. **P05** (saneamento autorizado e isolamento de testes), **P16**, **P18**.

## 30. Testes necessários

| Problema | Teste |
|---|---|
| P01 | Mais de 10 RES_NFE antigos com 596 e N novos: os novos recebem ciência; limite por empresa |
| P02 | Documento com 596: `processarDocumento` repetido não reconsulta antes de `proximaConsultaEm`; encerra após N tentativas |
| P03 | 656 na manifestação ou no consChNFe gera bloqueio no Gate por CNPJ e impede novas consultas |
| P04, P09 | Painel com o global = 2 e as empresas = 1 exibe Produção por empresa, com a origem correta |
| P07 | Fila com mais de 5 `XML_INDISPONIVEL`: um RESUMO sem ciência entra no lote |
| P08 | Política MANUAL: o motor não envia 210210 |
| P10 | Desligar a flag durante o timer mantém o motor ativo |
| P11 | Motor e sync concorrentes geram um único consChNFe por documento |
| P14 | 656 da empresa 2 não bloqueia a empresa 1 |
| P15 | Diagnóstico por empresa sem fallback global |
| P19 | resEvento 110111 via DistDFe aplica o cancelamento |
| Regressão | Suíte completa da Central sem banco oficial (`DB_DIR` temporário); corrigir as 29 falhas pré-existentes em sprint própria |

---

## Matrizes finais

### Configuração por componente e empresa

| Componente | Empresa | Configuração esperada | Configuração encontrada | Fonte | Status |
|---|---|---|---|---|---|
| Ambiente fiscal | 1 (0001-15) | Produção | 1 | `empresas_configuracao_fiscal` | OK |
| Ambiente fiscal | 2 (0003-87) | Produção | 1 | `empresas_configuracao_fiscal` | OK (CNPJ diverge do enunciado) |
| Ambiente fiscal | 3 (0002-04) | Produção | 1 | `empresas_configuracao_fiscal` | OK (CNPJ diverge do enunciado) |
| Ambiente exibido na Central | todas | Produção por empresa | Homologação | `configuracoes.fiscal_ambiente='2'` | **ERRO (P04)** |
| Certificado | 1 / 2 / 3 | PFX próprio | `certificado-empresa-{1,2,3}.pfx`, existentes e distintos | `empresas_configuracao_fiscal` | OK (validade e CNPJ interno não verificados) |
| Certificado exibido na Central | todas | Um por empresa | `certificado.pfx` global, CNPJ vazio | `configuracoes` | **ERRO (P09)** |
| NSU | 1 / 2 / 3 | Produção por CNPJ | ult 118 / 21 / 15, ambiente 1 | `central_entradas_nsu` | OK |
| Endpoint DF-e / evento | todas | Produção AN | `www1…DistribuicaoDFe` / `www…RecepcaoEvento4` | `RegistryBuilder` | OK |
| Política de manifestação | todas | Automática | `AUTOMATICA_CIENCIA` | `central_entradas_config` | OK (execução com defeito: P01) |
| Scheduler DF-e | todas | Manual | `sync_automatica_habilitada=false`; `sync_ao_abrir=true` | `central_entradas_config` | OK (abrir a tela gera tráfego) |
| XML Wait / MIRX | todas | Ativo | ativo, 49 docs antigos | `mirx_scheduler_state` | Parcial |
| Motor de recuperação | todas | Ativo, atendendo notas novas | ativo, starvation | `recuperacao_xml_scheduler_state` | **ERRO (P07)** |
| Gate 656 | por CNPJ | Refletir 656 | global, sem os 656 de hoje | `xml_wait_scheduler_state` | **ERRO (P03/P14)** |

### Fluxos

| Fluxo | Esperado | Encontrado | Problema | Evidência |
|---|---|---|---|---|
| Recebimento DF-e | distNSU por empresa em produção | Correto | — | 18 `DOCUMENTO_RECEBIDO`, NSU ambiente 1 |
| Ciência automática | Notas novas manifestadas | Só as 10 mais antigas (já 596) | P01 | 0 ciência nos docs 110–127 |
| Pós-596 | Encerrar ou aguardar janela | consChNFe a cada sync | P02 | 9 consultas nos docs 47–50 |
| Cooldown 656 | Bloquear consultas | Não bloqueia | P03 | 656 às 17:33 e 17:47; Gate sem registro |
| Recuperação XML | Atender RESUMO sem ciência | Só `XML_INDISPONIVEL` | P07 | lote com docs 4–6 e 15–19 |
| Painel de ambiente | Produção | Homologação | P04 | global = 2 |
| NF 1315265 | Ciência e XML completo | Só resumo, sem ciência | P01/P07 | doc 120, eventos |
| Notificação | Por empresa | Global | P13 | notificação 127 |

### Problemas

| Problema | Severidade | Causa raiz | Arquivo/Função | Correção proposta |
|---|---|---|---|---|
| P01 Starvation da ciência | Crítico | Top 10 global por `created_at ASC`, sem excluir 596 | `CentralManifestacaoDfeService.processarCandidatos` / `listarPorStatus` | Filtrar elegíveis e priorizar os que estão no prazo, por empresa |
| P02 Loop pós-596 | Crítico | Sem `proximaConsultaEm`; só encerra com 137 | `_resolverAposEvento596` | Respeitar a janela e o Gate; status terminal |
| P03 656 fora do Gate | Crítico | Manifestação e distribuição não usam o Gate | `CentralManifestacaoDfeService`, `distribuicaoDFe` | Registrar e consultar o Gate por CNPJ |
| P04 Painel "Homologação" | Alto | Leitor global | `_obterSnapshotFiscal` | Ler por empresa |
| P05 Fixtures no banco oficial | Alto | Testes contra o banco oficial | dados / `resolverContextoDocumentoCentral` | Saneamento autorizado; `DB_DIR` isolado |
| P06 Status ambíguo | Alto | Alias `AGUARDANDO_XML_COMPLETO` | `DocumentoFiscalStatus` | Sub-estado de manifestação |
| P07 Starvation do motor | Alto | `XML_INDISPONIVEL` sempre primeiro | `MotorRecuperacaoXmlService.executarCiclo` | Priorização e cotas |
| P08 Motor ignora política | Alto | `confirmado:true` fixo | `_consultarDocumento` | Ler a política |
| P09 Certificado global no painel | Alto | Leitor global | `_obterVisaoCertificado` | Por empresa |
| P10 `parar` derruba o motor | Médio | Parada incondicional | `CentralSyncBackgroundService.parar` | Condicionar ao flag |
| P11 Locks por instância | Médio | Set local | `processarDocumento` / motor | Lock de módulo |
| P12 Estados não unificados | Médio | Vocabulários distintos | health / mirx / gate / background | Contrato único |
| P13 Notificação global | Médio | Agregado sem empresa | notificação pós-sync | Por empresa |
| P14 Gate global | Médio | Fingerprint do certificado global | `fingerprintFiscalDetalhado` | Gate por CNPJ |
| P15 Diagnóstico global | Médio | Sem `empresaId` | `CentralDiagnosticoService` | Por empresa |
| P19 `ReferenceError` DistDFe | Médio | Variável usada antes da declaração | `distribuicaoDFe.js` 288/347 | Declarar antes |
| P16 Senha em texto puro | Baixo | Sem cofre | `empresas_configuracao_fiscal` | Cofre de segredos |
| P17 Telemetria do motor | Baixo | Estado não persistido | `MotorRecuperacaoXmlService` | Persistir por ciclo |
| P18 URLs de homologação no legado | Baixo | Resíduo | `ws_*` / `resolverUrlsEmpresa` | Auditar a emissão |
